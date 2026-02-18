import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { getProjectRoot } from '@command-post/core';

// ── Local topology types (subset of @command-post/core TopologyConfig) ────

interface TopologyAgent {
  id: string;
  role: string;
  domain: string | null;
  assigned_features?: string[];
  model_preference?: string | null;
}

interface TopologyDomain {
  name: string;
  agents: TopologyAgent[];
}

interface TopologyConfig {
  domains: TopologyDomain[];
  [key: string]: unknown;
}

/**
 * Queue entry for a pending agent spawn request.
 * Tracks status, dependencies, and budget information throughout its lifecycle.
 */
export interface SpawnQueueEntry {
  /** Unique queue entry ID: sq-{uuid} */
  id: string;
  /** Agent ID of the requesting agent (must be a PO for the domain) */
  requestedBy: string;
  /** Domain where the new agent should be spawned */
  domain: string;
  /** Role of the new agent: 'worker' or 'audit' */
  role: 'worker' | 'audit';
  /** Human-readable reason for spawn request */
  reason: string;
  /** Current status in the spawn lifecycle */
  status: 'pending' | 'dependency_wait' | 'queued' | 'spawning' | 'spawned' | 'rejected';
  /** Task IDs that must complete before this agent spawns */
  taskDependencies: string[];
  /** Domains that must reach threshold before this agent spawns */
  domainDependencies: string[];
  /** Fraction of domain agents that must complete (0.0 - 1.0), default 1.0 (all) */
  domainDependencyThreshold: number;
  /** Recommended features for the new agent */
  suggestedFeatures: string[];
  /** ISO timestamp when entry was created */
  createdAt: string;
  /** ISO timestamp when entry was resolved (spawned or rejected) */
  resolvedAt?: string;
  /** Agent ID of the spawned agent (set when status === 'spawned') */
  spawnedAgentId?: string;
  /** Rejection reason if status === 'rejected' */
  rejectionReason?: string;
}

/**
 * Result of a budget validation check.
 * Determines whether a spawn request can proceed immediately or must queue.
 */
export interface BudgetValidation {
  /** True if spawn is allowed to proceed immediately */
  allowed: boolean;
  /** Human-readable reason (for rejection, queuing decision, or context) */
  reason?: string;
  /** Current count of active agents in the instance */
  currentActiveAgents: number;
  /** Maximum allowed agents (default 25) */
  maxAgents: number;
  /** Maximum agents per domain (if configured) */
  maxPerDomain?: number;
  /** Current count of agents in the target domain */
  currentDomainAgents: number;
  /** Number of available slots before hitting budget ceiling */
  availableSlots: number;
  /** Current queue depth (entries not yet spawned) */
  queueDepth: number;
}

/**
 * Spawn Queue manages agent creation requests with budget enforcement,
 * dependency tracking, and queue-based backpressure.
 */
export class SpawnQueue {
  private maxAgents: number;
  private maxPerDomain?: number;
  private queue: SpawnQueueEntry[] = [];
  private topology?: TopologyConfig;
  private projectRoot: string;
  private taskResolver?: (taskId: string) => { status: string } | null;
  private domainProgressResolver?: (domain: string) => number;

  constructor(projectPath: string, maxAgents: number = 25, maxPerDomain?: number) {
    this.maxAgents = maxAgents;
    this.maxPerDomain = maxPerDomain;
    this.projectRoot = getProjectRoot(projectPath);

    // Ensure spawn-queue storage directory exists
    const queueDir = path.join(this.projectRoot, 'spawn-queue');
    if (!fs.existsSync(queueDir)) {
      fs.mkdirSync(queueDir, { recursive: true });
    }

    // Load existing queue entries from disk if present
    this.loadQueueFromDisk();
  }

  /**
   * Load queue entries from disk (.command-post/spawn-queue/ directory).
   * Entries persisted as {id}.json files.
   */
  private loadQueueFromDisk(): void {
    const queueDir = path.join(this.projectRoot, 'spawn-queue');
    if (!fs.existsSync(queueDir)) return;

    const files = fs.readdirSync(queueDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(queueDir, file), 'utf-8');
        const entry: SpawnQueueEntry = JSON.parse(content);
        // Only load entries that are not yet spawned or rejected
        if (!['spawned', 'rejected'].includes(entry.status)) {
          this.queue.push(entry);
        }
      } catch {
        // Silently skip malformed entries
      }
    }
  }

  /**
   * Persist a queue entry to disk.
   */
  private persistEntry(entry: SpawnQueueEntry): void {
    const queueDir = path.join(this.projectRoot, 'spawn-queue');
    const filePath = path.join(queueDir, `${entry.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8');
  }

  /**
   * Load topology configuration synchronously from topology.json.
   * Caches the result for subsequent calls.
   */
  private ensureTopology(): TopologyConfig {
    if (this.topology) return this.topology;

    const topologyPath = path.join(this.projectRoot, 'topology.json');
    if (fs.existsSync(topologyPath)) {
      const content = fs.readFileSync(topologyPath, 'utf-8');
      this.topology = JSON.parse(content);
      return this.topology!;
    }

    // Return empty topology if file doesn't exist
    return { domains: [] };
  }

  /**
   * Add a spawn request to the queue.
   * Performs initial validation and determines starting status.
   */
  public async enqueue(request: {
    requestedBy: string;
    domain: string;
    role: 'worker' | 'audit';
    reason: string;
    taskDependencies?: string[];
    domainDependencies?: string[];
    domainDependencyThreshold?: number;
    suggestedFeatures?: string[];
  }): Promise<SpawnQueueEntry> {
    const entry: SpawnQueueEntry = {
      id: `sq-${uuidv4()}`,
      requestedBy: request.requestedBy,
      domain: request.domain,
      role: request.role,
      reason: request.reason,
      status: 'pending',
      taskDependencies: request.taskDependencies ?? [],
      domainDependencies: request.domainDependencies ?? [],
      domainDependencyThreshold: request.domainDependencyThreshold ?? 1.0,
      suggestedFeatures: request.suggestedFeatures ?? [],
      createdAt: new Date().toISOString(),
    };

    this.queue.push(entry);
    this.persistEntry(entry);

    // Evaluate entry to determine initial status (updates entry in-place)
    await this.evaluateEntry(entry);

    return entry;
  }

  /**
   * Get the next queue entry that is ready to spawn.
   * Returns the first entry in 'queued' status, or null if none available.
   */
  public getNext(): SpawnQueueEntry | null {
    const queued = this.queue.find((e) => e.status === 'queued');
    return queued ?? null;
  }

  /**
   * Evaluate a queue entry to determine its current status.
   * Returns the appropriate status: 'ready', 'dependency_wait', or 'queued'.
   * Updates entry status in-place and persists to disk.
   */
  public async evaluateEntry(entryOrId: string | SpawnQueueEntry): Promise<'ready' | 'dependency_wait' | 'queued'> {
    const entry = typeof entryOrId === 'string'
      ? this.queue.find(e => e.id === entryOrId)!
      : entryOrId;

    // Check task dependencies
    if (!await this.checkDependencies(entry)) {
      entry.status = 'dependency_wait';
      this.persistEntry(entry);
      return 'dependency_wait';
    }

    // Check domain dependencies
    if (entry.domainDependencies.length > 0) {
      const allDependenciesMet = entry.domainDependencies.every((domain) => {
        const progress = this.domainProgressResolver?.(domain) ?? 0;
        return progress >= entry.domainDependencyThreshold;
      });
      if (!allDependenciesMet) {
        entry.status = 'dependency_wait';
        this.persistEntry(entry);
        return 'dependency_wait';
      }
    }

    // Check budget
    const validation = await this.validateBudget(entry.domain, entry.role, entry.requestedBy);
    if (validation.allowed) {
      entry.status = 'queued';
      this.persistEntry(entry);
      return 'ready';
    } else {
      entry.status = 'queued';
      this.persistEntry(entry);
      return 'queued';
    }
  }

  /**
   * Validate that a spawn request is within budget limits.
   * Checks domain existence, role validity, requesting agent authorization,
   * per-domain limits, and global agent limits.
   */
  public async validateBudget(
    domain: string,
    role: string,
    requestedBy: string,
  ): Promise<BudgetValidation> {
    const topology = this.ensureTopology();
    const currentActiveAgents = this.getActiveAgentCount();
    const currentDomainAgents = this.getDomainAgentCount(domain);
    const queueDepth = this.getQueuedCount();
    const availableSlots = Math.max(0, this.maxAgents - currentActiveAgents - queueDepth);

    // Check 1: Domain exists in topology
    const domainConfig = topology.domains.find((d) => d.name === domain);
    if (!domainConfig) {
      return {
        allowed: false,
        reason: `Domain '${domain}' not found in topology`,
        currentActiveAgents,
        maxAgents: this.maxAgents,
        maxPerDomain: this.maxPerDomain,
        currentDomainAgents,
        availableSlots,
        queueDepth,
      };
    }

    // Check 2: Role is valid for spawning (not orchestrator, PO, context-monitor, security)
    const validRoles = ['worker', 'audit'];
    if (!validRoles.includes(role)) {
      return {
        allowed: false,
        reason: `Role '${role}' cannot be spawned (only 'worker' and 'audit' roles are spawneable)`,
        currentActiveAgents,
        maxAgents: this.maxAgents,
        maxPerDomain: this.maxPerDomain,
        currentDomainAgents,
        availableSlots,
        queueDepth,
      };
    }

    // Check 3: Requesting agent is a PO for the domain
    const requestingAgent = domainConfig.agents.find((a) => a.id === requestedBy);
    if (!requestingAgent || requestingAgent.role !== 'po') {
      return {
        allowed: false,
        reason: `Agent '${requestedBy}' is not a PO (power-of-attorney) for domain '${domain}'`,
        currentActiveAgents,
        maxAgents: this.maxAgents,
        maxPerDomain: this.maxPerDomain,
        currentDomainAgents,
        availableSlots,
        queueDepth,
      };
    }

    // Check 4: Domain agent count < max_agents_per_domain (if configured)
    if (this.maxPerDomain && currentDomainAgents >= this.maxPerDomain) {
      return {
        allowed: false,
        reason: `Domain '${domain}' is at capacity (${currentDomainAgents}/${this.maxPerDomain})`,
        currentActiveAgents,
        maxAgents: this.maxAgents,
        maxPerDomain: this.maxPerDomain,
        currentDomainAgents,
        availableSlots,
        queueDepth,
      };
    }

    // Check 5: Total active agents < max total (default 25)
    if (currentActiveAgents >= this.maxAgents) {
      return {
        allowed: false,
        reason: `Instance at capacity; request will be queued (${currentActiveAgents}/${this.maxAgents})`,
        currentActiveAgents,
        maxAgents: this.maxAgents,
        maxPerDomain: this.maxPerDomain,
        currentDomainAgents,
        availableSlots,
        queueDepth,
      };
    }

    // All checks passed
    return {
      allowed: true,
      reason: `Budget check passed; spawning allowed`,
      currentActiveAgents,
      maxAgents: this.maxAgents,
      maxPerDomain: this.maxPerDomain,
      currentDomainAgents,
      availableSlots,
      queueDepth,
    };
  }

  /**
   * Mark a queue entry as spawned and record the spawned agent ID.
   * Transitions status to 'spawning' → 'spawned'.
   */
  public markSpawned(id: string, agentId: string): void {
    const entry = this.queue.find((e) => e.id === id);
    if (entry) {
      entry.status = 'spawning';
      this.persistEntry(entry);

      entry.status = 'spawned';
      entry.spawnedAgentId = agentId;
      entry.resolvedAt = new Date().toISOString();
      this.persistEntry(entry);
    }
  }

  /**
   * Mark a queue entry as rejected with a reason.
   * Transitions status to 'rejected'.
   */
  public markRejected(id: string, reason: string): void {
    const entry = this.queue.find((e) => e.id === id);
    if (entry) {
      entry.status = 'rejected';
      entry.rejectionReason = reason;
      entry.resolvedAt = new Date().toISOString();
      this.persistEntry(entry);
    }
  }

  /**
   * Re-evaluate the queue when an agent shuts down.
   * Frees capacity and returns entries that transition from 'dependency_wait' to a non-waiting state.
   */
  public async release(): Promise<SpawnQueueEntry[]> {
    const released: SpawnQueueEntry[] = [];

    for (const entry of this.queue) {
      if (entry.status === 'dependency_wait') {
        const newStatus = await this.evaluateEntry(entry);
        if (newStatus !== 'dependency_wait') {
          released.push(entry);
        }
      }
    }

    return released;
  }

  /**
   * Check if task dependencies are satisfied.
   * Returns true if all task IDs in taskDependencies are complete/resolved.
   */
  public async checkDependencies(entry: SpawnQueueEntry): Promise<boolean> {
    if (entry.taskDependencies.length === 0) {
      return true;
    }

    for (const taskId of entry.taskDependencies) {
      const task = this.taskResolver?.(taskId);
      if (!task) {
        return false; // Task not found or not resolved
      }
      if (task.status !== 'completed' && task.status !== 'resolved') {
        return false; // Task not complete
      }
    }

    return true;
  }

  /**
   * Get all queue entries.
   */
  public getQueue(): SpawnQueueEntry[] {
    return [...this.queue];
  }

  /**
   * Get count of queued entries (status !== 'spawned' and !== 'rejected').
   */
  public getQueuedCount(): number {
    return this.queue.filter((e) => !['spawned', 'rejected'].includes(e.status)).length;
  }

  /**
   * Get count of active agents (currently spawned).
   * Counts topology agents + entries with status 'spawned'.
   */
  public getActiveAgentCount(): number {
    const topology = this.ensureTopology();
    let count = 0;

    for (const domain of topology.domains) {
      count += domain.agents.length;
    }

    count += this.queue.filter((e) => e.status === 'spawned').length;

    return count;
  }

  /**
   * Get count of agents in a specific domain.
   * Counts topology agents in domain + spawned entries for that domain.
   */
  public getDomainAgentCount(domain: string): number {
    const topology = this.ensureTopology();
    let count = 0;

    const domainConfig = topology.domains.find((d) => d.name === domain);
    if (domainConfig) {
      count = domainConfig.agents.length;
    }

    count += this.queue.filter((e) => e.domain === domain && e.status === 'spawned').length;

    return count;
  }

  /**
   * Set a resolver function to fetch task state by task ID.
   * Used by checkDependencies to verify task completion.
   */
  public setTaskResolver(resolver: (taskId: string) => { status: string } | null): void {
    this.taskResolver = resolver;
  }

  /**
   * Set a resolver function to fetch domain progress (0.0 - 1.0).
   * Used by evaluateEntry to check domain-level dependencies.
   */
  public setDomainProgressResolver(resolver: (domain: string) => number): void {
    this.domainProgressResolver = resolver;
  }

  /**
   * Generate a new unique agent ID based on role and domain.
   * Format: {role}-{domain}-{nextNumber}
   * Scans existing agents and spawn queue to find the highest number.
   */
  public generateAgentId(role: 'worker' | 'audit', domain: string): string {
    const topology = this.ensureTopology();
    let maxNumber = 0;

    // Scan topology agents for this role+domain
    const domainConfig = topology.domains.find((d) => d.name === domain);
    if (domainConfig) {
      for (const agent of domainConfig.agents) {
        const match = agent.id.match(new RegExp(`^${role}-${domain}-(\\d+)$`));
        if (match) {
          const num = parseInt(match[1], 10);
          maxNumber = Math.max(maxNumber, num);
        }
      }
    }

    // Scan spawned queue entries for this role+domain
    for (const entry of this.queue.filter((e) => e.status === 'spawned' && e.domain === domain && e.role === role)) {
      if (entry.spawnedAgentId) {
        const match = entry.spawnedAgentId.match(new RegExp(`^${role}-${domain}-(\\d+)$`));
        if (match) {
          const num = parseInt(match[1], 10);
          maxNumber = Math.max(maxNumber, num);
        }
      }
    }

    return `${role}-${domain}-${maxNumber + 1}`;
  }

  /**
   * Get the 0-based queue position of an entry by ID.
   * Returns the index among non-terminal entries (status !== 'spawned' and !== 'rejected').
   * Returns -1 if entry not found.
   */
  public getQueuePosition(id: string): number {
    const nonTerminal = this.queue.filter((e) => !['spawned', 'rejected'].includes(e.status));
    const index = nonTerminal.findIndex((e) => e.id === id);
    return index;
  }
}
