/**
 * TaskCompletionMonitor — periodically checks for task status changes and
 * coordinates the completion cascade: ready_for_review → audit_request →
 * approved/needs_revision → prepare_shutdown when all tasks are approved.
 *
 * Flow:
 * 1. Task moves to ready_for_review → send audit_request to audit agent
 * 2. Audit agent reviews and sends task_update with approved/needs_revision
 * 3. If needs_revision → send feedback to worker, worker re-submits
 * 4. If approved and all tasks are approved → send prepare_shutdown to agent
 * 5. When all agents shut down → emit project_complete event
 */

import { promises as fsPromises } from 'node:fs';
import YAML from 'yaml';
import { listTasks, getTopologyPath, writeToInbox, appendEvent, TopologyConfigSchema } from '@command-post/core';
import type { TaskObject, TopologyConfig, InboxMessage } from '@command-post/core';

// TODO: Move loadTopology to @command-post/core once config/parser.ts is extracted
async function loadTopology(projectPath: string): Promise<TopologyConfig> {
  const topologyPath = getTopologyPath(projectPath);
  const raw = await fsPromises.readFile(topologyPath, 'utf-8');
  const parsed = YAML.parse(raw) as unknown;
  return TopologyConfigSchema.parse(parsed);
}
import { v4 as uuidv4 } from 'uuid';
import { logLifecycleEvent } from '../utils/lifecycle-logger.js';
import type { DomainFinding } from './findings-registry.js';
import { FindingsRegistry } from './findings-registry.js';
import type { AgentRole } from '../types/index.js';

/** Configuration for TaskCompletionMonitor. */
export interface TaskCompletionMonitorConfig {
  /** Project root path. */
  projectPath: string;
  /** The orchestrator agent ID. Default: 'orchestrator-1'. */
  orchestratorId?: string;
  /** Task status poll interval in milliseconds. Default: 30_000 (30 sec). */
  pollIntervalMs?: number;
  /** Optional findings registry for cross-cutting shutdown gating. */
  findingsRegistry?: FindingsRegistry;
}

/** Topology index for fast lookups. */
interface TopologyIndex {
  agentRoles: Map<string, AgentRole>;
  domainAgents: Map<string, { workers: string[]; auditors: string[]; po: string | null }>;
  pos: string[];
  securityAgents: string[];
  contextMonitors: string[];
  orchestrators: string[];
  poDomains: Map<string, string[]>;
}

/**
 * TaskCompletionMonitor monitors task status changes and orchestrates
 * the completion cascade including audit routing and shutdown signaling.
 */
export class TaskCompletionMonitor {
  private readonly projectPath: string;
  private readonly orchestratorId: string;
  private readonly pollIntervalMs: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  /** Track previously seen task statuses to detect changes. */
  private taskStatusCache = new Map<string, string>();

  /** Track which agents have been sent shutdown commands. */
  private shutdownSentAgents = new Set<string>();

  /** Cached topology index for efficient role/domain lookups. */
  private topologyIndex: TopologyIndex | null = null;

  /** Optional findings registry for cross-cutting shutdown gating. */
  private readonly findingsRegistry: FindingsRegistry | null;

  /** Track domains that are blocked by cross-cutting findings. */
  private blockedDomains = new Map<string, { agentIds: string[]; since: string }>();

  /** Optional closeout trigger invoked at Tier 5→6 boundary instead of direct shutdown. */
  private onCloseoutTrigger: (() => Promise<void>) | null = null;

  constructor(config: TaskCompletionMonitorConfig) {
    this.projectPath = config.projectPath;
    this.orchestratorId = config.orchestratorId ?? 'orchestrator-1';
    this.pollIntervalMs = config.pollIntervalMs ?? 30_000;
    this.findingsRegistry = config.findingsRegistry ?? null;

    // Register callback: when a finding is resolved, re-evaluate blocked domains
    if (this.findingsRegistry) {
      this.findingsRegistry.onFindingResolved((finding) => {
        void this.onFindingResolved(finding);
      });
    }
  }

  /**
   * Start the monitor: runs an immediate poll then starts the timer.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Initial poll
    await this.poll();

    // Start recurring timer
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }

    await logLifecycleEvent(this.projectPath, this.orchestratorId, 'context_snapshot_created', {
      action: 'task_completion_monitor_started',
    });
  }

  /**
   * Stop monitoring.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    await logLifecycleEvent(this.projectPath, this.orchestratorId, 'context_snapshot_created', {
      action: 'task_completion_monitor_stopped',
    });
  }

  /**
   * Whether the monitor is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Manually trigger a single poll cycle.
   */
  async poll(): Promise<void> {
    try {
      // Load topology to find audit agents per domain
      let topology: TopologyConfig | null = null;
      try {
        topology = await loadTopology(this.projectPath);
        if (topology) {
          this.topologyIndex = this.buildTopologyIndex(topology);
        }
      } catch {
        // Topology may not exist yet
      }

      // Get all tasks
      const allTasks = await listTasks(this.projectPath);

      // Process status changes
      for (const task of allTasks) {
        await this.processTaskStatusChange(task, topology);
      }

      // Check if all agents are done (tiered shutdown cascade)
      await this.checkTieredShutdown();
    } catch (error) {
      try {
        await logLifecycleEvent(this.projectPath, this.orchestratorId, 'context_usage_warning', {
          action: 'task_monitor_poll_failed',
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // Ignore logging errors
      }
    }
  }

  /**
   * Process a single task's status change.
   */
  private async processTaskStatusChange(
    task: TaskObject,
    topology: TopologyConfig | null,
  ): Promise<void> {
    const previousStatus = this.taskStatusCache.get(task.id);
    const currentStatus = task.status;

    // Skip if status hasn't changed
    if (previousStatus === currentStatus) {
      return;
    }

    // Update cache
    this.taskStatusCache.set(task.id, currentStatus);

    // Task moved to ready_for_review → send to audit agent
    if (currentStatus === 'ready_for_review') {
      await this.handleReadyForReview(task, topology);
    }

    // Task is now approved → check if agent can shut down
    if (currentStatus === 'approved') {
      if (task.assigned_to) {
        await this.checkAgentCompletion(task.assigned_to);
      }
    }
  }

  /**
   * Handle task moving to ready_for_review: find audit agent and send audit_request.
   */
  private async handleReadyForReview(task: TaskObject, topology: TopologyConfig | null): Promise<void> {
    if (!topology) {
      await logLifecycleEvent(this.projectPath, this.orchestratorId, 'context_usage_warning', {
        action: 'audit_request_skipped',
        taskId: task.id,
        reason: 'topology_not_found',
      });
      return;
    }

    // Find audit agent for this task's domain
    const auditAgent = this.findAuditAgentForDomain(task.domain, topology);
    if (!auditAgent) {
      await logLifecycleEvent(this.projectPath, this.orchestratorId, 'context_usage_warning', {
        action: 'audit_agent_not_found',
        taskId: task.id,
        domain: task.domain,
      });
      return;
    }

    // Send audit_request message to audit agent
    const msg: InboxMessage = {
      id: `msg-${uuidv4()}`,
      from: this.orchestratorId,
      to: auditAgent,
      timestamp: new Date().toISOString(),
      type: 'task_assignment',
      priority: 'normal',
      body: {
        task_id: task.id,
        action: 'review',
        review_type: 'audit',
        task_title: task.title,
        feature: task.feature,
        domain: task.domain,
      },
      read: false,
    };

    try {
      await writeToInbox(this.projectPath, auditAgent, msg);
      await logLifecycleEvent(this.projectPath, this.orchestratorId, 'context_snapshot_created', {
        action: 'audit_request_sent',
        taskId: task.id,
        auditAgent,
      });
    } catch (error) {
      await logLifecycleEvent(this.projectPath, this.orchestratorId, 'context_usage_warning', {
        action: 'audit_request_failed',
        taskId: task.id,
        auditAgent,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check if an agent's all tasks are approved; if so, send prepare_shutdown.
   */
  private async checkAgentCompletion(agentId: string): Promise<void> {
    try {
      const agentTasks = await listTasks(this.projectPath, { assignee: agentId });

      const allDone = agentTasks.every(
        (t) => t.status === 'approved' || t.status === 'failed',
      );

      if (allDone && agentTasks.length > 0) {
        const allApproved = agentTasks.every((t) => t.status === 'approved');

        if (allApproved) {
          // Check for blocking findings before shutdown
          const domain = this.getAgentDomain(agentId);
          if (domain && this.findingsRegistry?.hasBlockingFindings(domain)) {
            // Domain is blocked — don't send shutdown, track it
            await this.blockDomain(domain, agentId);
            return;
          }

          await this.sendPrepareShutdown(agentId);
        }
      }
    } catch (error) {
      await logLifecycleEvent(this.projectPath, this.orchestratorId, 'context_usage_warning', {
        action: 'agent_completion_check_failed',
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Send prepare_shutdown lifecycle command to an agent.
   */
  private async sendPrepareShutdown(agentId: string): Promise<void> {
    // Idempotence: don't send twice
    if (this.shutdownSentAgents.has(agentId)) {
      return;
    }

    this.shutdownSentAgents.add(agentId);

    const msg: InboxMessage = {
      id: `msg-${uuidv4()}`,
      from: this.orchestratorId,
      to: agentId,
      timestamp: new Date().toISOString(),
      type: 'lifecycle_command',
      priority: 'high',
      body: {
        command: 'prepare_shutdown',
        reason: 'all_tasks_completed',
      },
      read: false,
    };

    try {
      await writeToInbox(this.projectPath, agentId, msg);
      await logLifecycleEvent(this.projectPath, this.orchestratorId, 'context_snapshot_created', {
        action: 'prepare_shutdown_sent',
        agentId,
      });

      // After shutdown sent, check tiered shutdown cascade
      await this.checkTieredShutdownForAgent(agentId);
    } catch (error) {
      await logLifecycleEvent(this.projectPath, this.orchestratorId, 'context_usage_warning', {
        action: 'prepare_shutdown_failed',
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check tiered shutdown cascade.
   * Tier 1: Workers shut down when all their tasks are approved.
   * Tier 2: Audit agents shut down when all workers in their domain are shut down.
   * Tier 3: Context monitors shut down when all workers and audit agents are shut down.
   * Tier 4: Orchestrator shuts down last after everyone else, then emits project_complete.
   */
  private async checkTieredShutdown(): Promise<void> {
    try {
      // If topology index isn't built yet, skip
      if (!this.topologyIndex) {
        return;
      }

      // Load topology to get list of all agents
      const topology = await loadTopology(this.projectPath);
      if (!topology?.domains) {
        return;
      }

      // Final check: orchestrator shuts down last after everyone else
      if (this.shouldShutdownOrchestrator()) {
        if (this.onCloseoutTrigger) {
          await this.onCloseoutTrigger();
          // CloseoutManager will call completeCloseoutAndShutdown() when done
        } else {
          // Backward compat: no closeout configured
          await this.sendPrepareShutdown(this.orchestratorId);
          if (this.shutdownSentAgents.has(this.orchestratorId)) {
            await this.emitProjectComplete();
          }
        }
      }
    } catch {
      // Topology may not exist or other error — continue polling
    }
  }

  /**
   * Check tiered shutdown cascade for a specific agent.
   * Tier 1: Workers shut down when all their tasks are approved
   * Tier 2: Audit agents shut down when all workers in domain done
   * Tier 3: Security agents shut down when all domain auditors done
   * Tier 4: POs shut down when all their domains' workers + auditors done, security done
   * Tier 5: Context monitor shut down when all POs done
   * Tier 6: Orchestrator shut down when everyone else done
   */
  private async checkTieredShutdownForAgent(agentId: string): Promise<void> {
    if (!this.topologyIndex) {
      return;
    }

    const agentRole = this.topologyIndex.agentRoles.get(agentId);

    // Tier 1 -> Tier 2: If a worker shuts down, check if all workers in its domain are shut down
    if (agentRole === 'worker') {
      // Find which domain this worker belongs to
      for (const [domainName, agents] of this.topologyIndex.domainAgents.entries()) {
        if (agents.workers.includes(agentId)) {
          // Check if all workers in this domain are shut down
          const allWorkersShutdown = agents.workers.every((wid) => this.shutdownSentAgents.has(wid));

          // Don't advance to auditor tier if domain is still blocked by findings
          const domainBlocked = this.blockedDomains.has(domainName);

          if (allWorkersShutdown && !domainBlocked && agents.auditors.length > 0) {
            // Send shutdown to all auditors in this domain
            for (const auditorId of agents.auditors) {
              await this.sendPrepareShutdown(auditorId);
            }
          }
          break;
        }
      }
    }

    // Tier 2 -> Tier 3: If an audit agent shuts down, check if all auditors are shut down
    if (agentRole === 'audit') {
      // Check if all audit agents are shut down so security agents can shut down
      if (this.shouldShutdownSecurityAgents()) {
        // Send shutdown to all security agents
        for (const securityId of this.topologyIndex.securityAgents) {
          await this.sendPrepareShutdown(securityId);
        }
      }
      // Also check if any POs can now shut down
      await this.checkPOShutdown();
      // Check if context monitors can shut down (if no POs exist)
      if (this.topologyIndex.pos.length === 0 && this.shouldShutdownContextMonitors()) {
        for (const contextMonitorId of this.topologyIndex.contextMonitors) {
          await this.sendPrepareShutdown(contextMonitorId);
        }
      }
    }

    // Tier 3 -> Tier 4: If a security agent shuts down, check if POs can shut down
    if (agentRole === 'security') {
      await this.checkPOShutdown();
    }

    // Tier 4 -> Tier 5: If a PO shuts down, check if all POs are shut down
    if (agentRole === 'po') {
      // Check if all POs are shut down so context monitors can shut down
      if (this.shouldShutdownContextMonitors()) {
        // Send shutdown to all context monitor agents
        for (const contextMonitorId of this.topologyIndex.contextMonitors) {
          await this.sendPrepareShutdown(contextMonitorId);
        }
      }
    }

    // Tier 5 -> Tier 6: If a context monitor shuts down, check if orchestrator can shut down
    if (agentRole === 'context-monitor') {
      // Check if all context monitors are shut down and all non-orchestrators are shutdown
      if (this.shouldShutdownOrchestrator()) {
        if (this.onCloseoutTrigger) {
          await this.onCloseoutTrigger();
          // CloseoutManager will call completeCloseoutAndShutdown() when done
        } else {
          // Backward compat: no closeout configured
          await this.sendPrepareShutdown(this.orchestratorId);
          if (this.shutdownSentAgents.has(this.orchestratorId)) {
            await this.emitProjectComplete();
          }
        }
      }
    }
  }

  /**
   * Check if all auditors across all domains are shut down so security agents can shut down.
   */
  private shouldShutdownSecurityAgents(): boolean {
    if (!this.topologyIndex) return false;

    // All auditors in all domains must be shut down
    for (const agents of this.topologyIndex.domainAgents.values()) {
      for (const auditorId of agents.auditors) {
        if (!this.shutdownSentAgents.has(auditorId)) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Check if a specific PO can shut down.
   * A PO can shut down when all workers and auditors in its domains are shut down,
   * and all security agents are also shut down.
   */
  private shouldShutdownPO(poId: string): boolean {
    if (!this.topologyIndex) return false;

    const domains = this.topologyIndex.poDomains.get(poId);
    if (!domains) return false;

    // All workers in this PO's domains must be shut down
    for (const domainName of domains) {
      const domainEntry = this.topologyIndex.domainAgents.get(domainName);
      if (!domainEntry) continue;

      const allWorkersShutdown = domainEntry.workers.every((id) => this.shutdownSentAgents.has(id));
      if (!allWorkersShutdown) return false;

      // All auditors in this domain must be shut down
      for (const auditorId of domainEntry.auditors) {
        if (!this.shutdownSentAgents.has(auditorId)) {
          return false;
        }
      }
    }

    // All security agents must be shut down
    const allSecurityShutdown = this.topologyIndex.securityAgents.every((id) =>
      this.shutdownSentAgents.has(id),
    );
    if (!allSecurityShutdown) return false;

    return true;
  }

  /**
   * Check if all POs are shut down.
   */
  private allPOsShutdown(): boolean {
    if (!this.topologyIndex) return false;
    return this.topologyIndex.pos.every((id) => this.shutdownSentAgents.has(id));
  }

  /**
   * Check and send shutdown to POs that qualify.
   */
  private async checkPOShutdown(): Promise<void> {
    if (!this.topologyIndex) return;

    for (const poId of this.topologyIndex.pos) {
      if (this.shouldShutdownPO(poId)) {
        await this.sendPrepareShutdown(poId);
      }
    }
  }

  /**
   * Check if all workers and auditors are shut down so context monitors can shut down.
   */
  private shouldShutdownContextMonitors(): boolean {
    if (!this.topologyIndex) return false;

    // All workers in all domains must be shut down
    for (const agents of this.topologyIndex.domainAgents.values()) {
      const allWorkersShutdown = agents.workers.every((id) => this.shutdownSentAgents.has(id));
      if (!allWorkersShutdown) return false;
    }

    // All auditors in all domains must be shut down
    for (const agents of this.topologyIndex.domainAgents.values()) {
      for (const auditorId of agents.auditors) {
        if (!this.shutdownSentAgents.has(auditorId)) {
          return false;
        }
      }
    }

    // All POs must be shut down (if any exist in topology)
    if (this.topologyIndex.pos.length > 0 && !this.allPOsShutdown()) return false;

    return true;
  }

  /**
   * Check if orchestrator can shut down (all other agents shut down).
   */
  private shouldShutdownOrchestrator(): boolean {
    if (!this.topologyIndex) return false;

    // All context monitors must be shut down
    const allContextMonitorsShutdown = this.topologyIndex.contextMonitors.every(
      (id) => this.shutdownSentAgents.has(id),
    );
    if (!allContextMonitorsShutdown) return false;

    // All workers in all domains must be shut down
    for (const agents of this.topologyIndex.domainAgents.values()) {
      const allWorkersShutdown = agents.workers.every((id) => this.shutdownSentAgents.has(id));
      if (!allWorkersShutdown) return false;
    }

    // All auditors in all domains must be shut down
    for (const agents of this.topologyIndex.domainAgents.values()) {
      for (const auditorId of agents.auditors) {
        if (!this.shutdownSentAgents.has(auditorId)) {
          return false;
        }
      }
    }

    // All POs must be shut down (if any exist in topology)
    if (this.topologyIndex.pos.length > 0 && !this.allPOsShutdown()) return false;

    // All security agents must be shut down (if any exist in topology)
    if (this.topologyIndex.securityAgents.length > 0) {
      const allSecurityShutdown = this.topologyIndex.securityAgents.every((id) =>
        this.shutdownSentAgents.has(id),
      );
      if (!allSecurityShutdown) return false;
    }

    return true;
  }

  /**
   * Emit a project_complete event to events.jsonl.
   */
  private async emitProjectComplete(): Promise<void> {
    try {
      await appendEvent(this.projectPath, {
        event_id: uuidv4(),
        timestamp: new Date().toISOString(),
        event_type: 'agent_shutdown', // Use agent_shutdown as closest fit for completion
        agent_id: this.orchestratorId,
        data: {
          action: 'project_complete',
          description: 'All agents have been sent prepare_shutdown commands',
        },
      });

      await logLifecycleEvent(this.projectPath, this.orchestratorId, 'context_snapshot_created', {
        action: 'project_complete_emitted',
      });
    } catch (error) {
      await logLifecycleEvent(this.projectPath, this.orchestratorId, 'context_usage_warning', {
        action: 'project_complete_emission_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Build a topology index for efficient role and domain lookups.
   */
  private buildTopologyIndex(topology: TopologyConfig): TopologyIndex {
    const agentRoles = new Map<string, AgentRole>();
    const domainAgents = new Map<string, { workers: string[]; auditors: string[]; po: string | null }>();
    const pos: string[] = [];
    const securityAgents: string[] = [];
    const contextMonitors: string[] = [];
    const orchestrators: string[] = [];
    const poDomains = new Map<string, string[]>();

    // Initialize domain agents map
    for (const domain of topology.domains) {
      domainAgents.set(domain.name, { workers: [], auditors: [], po: null });
    }

    // Populate maps
    for (const domain of topology.domains) {
      const domainEntry = domainAgents.get(domain.name)!;

      for (const agent of domain.agents) {
        const role = agent.role as AgentRole;
        agentRoles.set(agent.id, role);

        if (role === 'worker') {
          domainEntry.workers.push(agent.id);
        } else if (role === 'po') {
          domainEntry.po = agent.id;
          if (!pos.includes(agent.id)) {
            pos.push(agent.id);
          }
          // Build poDomains map
          if (!poDomains.has(agent.id)) {
            poDomains.set(agent.id, []);
          }
          poDomains.get(agent.id)!.push(domain.name);
        } else if (role === 'audit') {
          domainEntry.auditors.push(agent.id);
        } else if (role === 'security') {
          if (!securityAgents.includes(agent.id)) {
            securityAgents.push(agent.id);
          }
        } else if (role === 'context-monitor') {
          contextMonitors.push(agent.id);
        } else if (role === 'orchestrator') {
          orchestrators.push(agent.id);
        }
      }
    }

    return {
      agentRoles,
      domainAgents,
      pos,
      securityAgents,
      contextMonitors,
      orchestrators,
      poDomains,
    };
  }

  /**
   * Find the first available (not shut down) audit agent for a given domain from topology.
   * When multiple auditors exist per domain, round-robin or send to first available.
   */
  private findAuditAgentForDomain(domain: string, topology: TopologyConfig): string | null {
    for (const d of topology.domains) {
      if (d.name === domain) {
        for (const agent of d.agents) {
          if (agent.role === 'audit' && !this.shutdownSentAgents.has(agent.id)) {
            return agent.id;
          }
        }
      }
    }
    return null;
  }

  /**
   * Get the domain for an agent from the topology index.
   * Returns null if agent not found or topology not loaded.
   */
  private getAgentDomain(agentId: string): string | null {
    if (!this.topologyIndex) return null;

    for (const [domainName, agents] of this.topologyIndex.domainAgents.entries()) {
      if (
        agents.workers.includes(agentId) ||
        agents.auditors.includes(agentId) ||
        agents.po === agentId
      ) {
        return domainName;
      }
    }
    return null;
  }

  /**
   * Block a domain from shutdown due to unresolved findings.
   * Tracks the agent that was ready to shut down so it can be released later.
   */
  private async blockDomain(domain: string, agentId: string): Promise<void> {
    const existing = this.blockedDomains.get(domain);
    if (existing) {
      // Domain already blocked — just add this agent if not already tracked
      if (!existing.agentIds.includes(agentId)) {
        existing.agentIds.push(agentId);
      }
    } else {
      this.blockedDomains.set(domain, {
        agentIds: [agentId],
        since: new Date().toISOString(),
      });
    }

    await logLifecycleEvent(this.projectPath, this.orchestratorId, 'context_snapshot_created', {
      action: 'domain_blocked_by_findings',
      domain,
      agentId,
      blockingFindings: this.findingsRegistry?.getBlockingFindings(domain).length ?? 0,
    });
  }

  /**
   * Called when a finding is resolved. Re-evaluates whether blocked domains
   * can now proceed with shutdown.
   */
  private async onFindingResolved(finding: DomainFinding): Promise<void> {
    const domain = finding.domain;
    const blocked = this.blockedDomains.get(domain);

    if (!blocked) return; // Domain wasn't blocked, nothing to do

    // Check if domain still has blocking findings
    if (this.findingsRegistry?.hasBlockingFindings(domain)) {
      // Still blocked — log but don't release
      await logLifecycleEvent(this.projectPath, this.orchestratorId, 'context_snapshot_created', {
        action: 'domain_still_blocked',
        domain,
        remainingBlockingFindings: this.findingsRegistry.getBlockingFindings(domain).length,
        resolvedFindingId: finding.id,
      });
      return;
    }

    // Domain is unblocked! Release all pending agents for shutdown
    await logLifecycleEvent(this.projectPath, this.orchestratorId, 'context_snapshot_created', {
      action: 'domain_unblocked',
      domain,
      releasedAgents: blocked.agentIds,
      blockedSince: blocked.since,
    });

    this.blockedDomains.delete(domain);

    // Send prepare_shutdown to all agents that were waiting
    for (const agentId of blocked.agentIds) {
      await this.sendPrepareShutdown(agentId);
    }
  }

  /**
   * Get the current set of blocked domains and their details.
   * Used by the API layer to expose blocked state.
   */
  getBlockedDomains(): Map<string, { agentIds: string[]; since: string; findings: DomainFinding[] }> {
    const result = new Map<string, { agentIds: string[]; since: string; findings: DomainFinding[] }>();

    for (const [domain, info] of this.blockedDomains.entries()) {
      result.set(domain, {
        ...info,
        findings: this.findingsRegistry?.getBlockingFindings(domain) ?? [],
      });
    }

    return result;
  }

  /**
   * Set an optional closeout trigger that runs at the Tier 5→6 boundary.
   * When set, the closeout phase runs before the orchestrator shuts down.
   * When null (default), the existing direct shutdown path is used.
   */
  setCloseoutTrigger(trigger: (() => Promise<void>) | null): void {
    this.onCloseoutTrigger = trigger;
  }

  /**
   * Called by CloseoutManager when the closeout phase is done.
   * Proceeds with orchestrator shutdown and project completion.
   */
  async completeCloseoutAndShutdown(): Promise<void> {
    await this.sendPrepareShutdown(this.orchestratorId);
    if (this.shutdownSentAgents.has(this.orchestratorId)) {
      await this.emitProjectComplete();
    }
  }

  /**
   * Reset blocked domains tracking (useful for testing).
   */
  resetBlockedDomains(): void {
    this.blockedDomains.clear();
  }

  /**
   * Clear the task status cache (useful for testing).
   */
  clearCache(): void {
    this.taskStatusCache.clear();
  }

  /**
   * Reset shutdown tracking (useful for testing).
   */
  resetShutdownTracking(): void {
    this.shutdownSentAgents.clear();
  }

  /**
   * Reset topology index (useful for testing).
   */
  resetTopologyIndex(): void {
    this.topologyIndex = null;
  }
}
