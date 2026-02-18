/**
 * Context Monitor Daemon Core
 *
 * External Node.js process that monitors agent context usage by parsing
 * Claude Code JSONL transcript files. Zero token cost, zero context overhead.
 *
 * Architecture:
 *   Daemon reads transcript -> extracts usage -> compares to threshold ->
 *   triggers snapshot protocol -> monitors for snapshot response ->
 *   initiates replacement via existing ReplacementCoordinator pipeline
 */

import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { v4 as uuidv4 } from 'uuid';
import { writeToInbox, getProjectRoot, appendEvent } from '@command-post/core';
import type { InboxMessage, AgentRegistryEntry, AgentRegistry } from '@command-post/core';
import { createSnapshot } from './memory-snapshot.js';
import { logLifecycleEvent } from '../utils/lifecycle-logger.js';
import type {
  SnapshotData,
} from '../types/index.js';
import { DEFAULT_THRESHOLDS } from '../config/thresholds.js';

// ─── Interfaces ──────────────────────────────────────────────────────────

/**
 * Daemon configuration. All fields have sensible defaults.
 */
export interface DaemonConfig {
  /** Absolute path to the project root */
  projectRoot: string;
  /** Polling interval in milliseconds (default: 30000) */
  pollIntervalMs: number;
  /** Context usage threshold that triggers snapshot protocol (default: 0.80) */
  contextThreshold: number;
  /** Context usage threshold that emits a warning event (default: 0.70) */
  warningThreshold: number;
  /** Maximum context window tokens (default: 200000) */
  maxContextTokens: number;
  /** Auto-compact buffer in tokens — Claude reserves ~40-45K (default: 42000) */
  autocompactBuffer: number;
  /** Timeout for snapshot responses in milliseconds (default: 120000) */
  snapshotTimeoutMs: number;
  /** Delay before spawning replacement after snapshot received (default: 5000) */
  replacementDelayMs: number;
}

/**
 * Result of parsing a single transcript file for context usage.
 * Returned by getContextUsage().
 */
export interface ContextUsageReading {
  /** Total context tokens: input + cache_creation + cache_read */
  contextTokens: number;
  /** Maximum context window size */
  maxTokens: number;
  /** Context percentage as decimal (0.0 - 1.0) */
  percentage: number;
  /** Context percentage as integer for display (0 - 100) */
  percentageDisplay: number;
  /** Output tokens (not included in context percentage) */
  outputTokens: number;
  /** ISO 8601 timestamp of the usage reading */
  timestamp: string;
  /** Raw token counts from Claude API */
  raw: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
}

/**
 * Tracks a pending snapshot request.
 */
interface PendingSnapshot {
  requestedAt: number;
  snapshotPath: string;
  agentId: string;
  contextPercentage: number;
}

// ─── Default Configuration ───────────────────────────────────────────────

const DEFAULT_CONFIG: Omit<DaemonConfig, 'projectRoot'> = {
  pollIntervalMs: 30_000,
  contextThreshold: DEFAULT_THRESHOLDS.criticalThreshold,
  warningThreshold: DEFAULT_THRESHOLDS.warningThreshold,
  maxContextTokens: 200_000,
  autocompactBuffer: 48_000,
  snapshotTimeoutMs: 300_000,
  replacementDelayMs: 5_000,
};

// ─── JSONL Transcript Parser ─────────────────────────────────────────────

/**
 * Parse a Claude Code JSONL transcript file to extract the most recent
 * context usage data.
 *
 * This is the ONLY function coupled to Claude Code's file format.
 * All other daemon logic is format-agnostic.
 *
 * Reads the file backwards to find the most recent assistant message
 * with usage data. Returns null if:
 * - File doesn't exist
 * - File is empty
 * - No assistant messages with usage data found
 *
 * @param transcriptPath - Absolute path to the .jsonl transcript file
 * @param maxContextTokens - Maximum context window size (default: 200000)
 * @returns ContextUsageReading or null
 */
export function getContextUsage(
  transcriptPath: string,
  maxContextTokens: number = 200_000,
): ContextUsageReading | null {
  let content: string;
  try {
    content = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return null;
  }

  if (!content.trim()) return null;

  const lines = content.split('\n');

  // Walk BACKWARDS through lines to find most recent assistant usage
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // skip malformed lines silently
    }

    if (parsed.type === 'assistant') {
      const message = parsed.message as Record<string, unknown> | undefined;
      if (message?.usage) {
        const usage = message.usage as Record<string, number>;
        const input_tokens = usage.input_tokens ?? 0;
        const output_tokens = usage.output_tokens ?? 0;
        const cache_creation_input_tokens = usage.cache_creation_input_tokens ?? 0;
        const cache_read_input_tokens = usage.cache_read_input_tokens ?? 0;

        const contextTokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens;
        const percentage = contextTokens / maxContextTokens;
        const percentageDisplay = Math.round(percentage * 100);

        return {
          contextTokens,
          maxTokens: maxContextTokens,
          percentage,
          percentageDisplay,
          outputTokens: output_tokens,
          timestamp: new Date().toISOString(),
          raw: {
            input_tokens,
            output_tokens,
            cache_creation_input_tokens,
            cache_read_input_tokens,
          },
        };
      }
    }
  }

  return null;
}

// ─── Registry I/O ────────────────────────────────────────────────────────

/**
 * Load the agent registry from disk.
 * Returns { agents: {} } if the file doesn't exist.
 */
async function loadRegistry(projectRoot: string): Promise<AgentRegistry> {
  const registryPath = join(getProjectRoot(projectRoot), 'agent-registry.json');
  try {
    const data = await fs.readFile(registryPath, 'utf-8');
    return JSON.parse(data) as AgentRegistry;
  } catch {
    return { agents: {} };
  }
}

/**
 * Save the agent registry to disk with atomic write.
 * Writes to .tmp file first, then renames for crash safety.
 */
async function saveRegistry(projectRoot: string, registry: AgentRegistry): Promise<void> {
  const registryPath = join(getProjectRoot(projectRoot), 'agent-registry.json');
  const tmpPath = `${registryPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(registry, null, 2), 'utf-8');
  await fs.rename(tmpPath, registryPath);
}

// ─── tmux Session Detection ─────────────────────────────────────────────

/**
 * Check if a tmux session is still alive.
 * Uses `tmux has-session -t <name>` — returns true if the session exists.
 */
function isTmuxSessionAlive(sessionName: string): boolean {
  const result = spawnSync('tmux', ['has-session', '-t', sessionName]);
  return result.status === 0;
}

// ─── Snapshot Protocol ───────────────────────────────────────────────────

/**
 * Convert a ContextUsageReading into the SnapshotData format used by
 * the existing memory-snapshot system.
 *
 * The daemon has limited information — it only knows token usage.
 * Fields like decisionLog, taskStatus, memoryState are populated with
 * defaults and will be enriched by the agent during its snapshot write.
 */
function toSnapshotData(reading: ContextUsageReading, config: DaemonConfig): SnapshotData {
  return {
    contextUsage: {
      tokens: {
        prompt: reading.raw.input_tokens + reading.raw.cache_read_input_tokens,
        completion: reading.outputTokens,
        total: reading.contextTokens + reading.outputTokens,
      },
      percentageOfMax: reading.percentage * 100, // SnapshotData uses 0-100 scale
      maxTokens: reading.maxTokens,
      modelsUsed: ['claude-sonnet-4-20250514'],
    },
    decisionLog: [],
    taskStatus: {
      tasksCompleted: 0,
      tasksInProgress: 0,
      tasksFailed: 0,
      averageCompletionTime: 0,
    },
    handoffSignal: {
      active: reading.percentage >= config.contextThreshold,
      targetAgent: null,
      reason: reading.percentage >= config.contextThreshold
        ? 'context_usage_high'
        : null,
      readyToHandoff: reading.percentage >= config.contextThreshold,
    },
    memoryState: {
      conversationHistory: 0,
      retrievedDocuments: 0,
      activeContextSize: reading.contextTokens,
    },
    modelPerformance: {},
  };
}

// ─── Daemon Class ────────────────────────────────────────────────────────

/**
 * The Context Monitor Daemon.
 *
 * Monitors all active agents in a Command Post project by polling their
 * Claude Code transcript files for real token usage data.
 *
 * Lifecycle:
 *   new ContextMonitorDaemon(config) -> start() -> [polling loop] -> stop()
 *
 * The polling loop:
 *   1. Load registry
 *   2. For each active agent:
 *      a. Check tmux session alive (mark dead if not)
 *      b. Read transcript for usage data
 *      c. Compare to thresholds
 *      d. Emit warning event at warningThreshold (0.70)
 *      e. Initiate snapshot protocol at contextThreshold (0.80)
 *   3. Check for pending snapshot timeouts
 *   4. Sleep for pollIntervalMs
 */
export class ContextMonitorDaemon {
  private readonly config: DaemonConfig;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private readonly pendingSnapshots: Map<string, PendingSnapshot> = new Map();
  private running = false;

  constructor(config: DaemonConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the polling loop.
   * Runs the first check immediately, then sets up the interval.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Run first check immediately
    void this.runOnce();

    // Set up polling interval
    this.intervalHandle = setInterval(() => {
      void this.runOnce();
    }, this.config.pollIntervalMs);
  }

  /**
   * Stop the polling loop and clean up resources.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    this.pendingSnapshots.clear();
  }

  /**
   * Execute a single monitoring cycle.
   * Exposed publicly for testing — allows running one cycle without the interval.
   */
  async runOnce(): Promise<void> {
    const registry = await loadRegistry(this.config.projectRoot);
    let registryDirty = false;

    for (const [agentId, entry] of Object.entries(registry.agents)) {
      if (entry.status !== 'active') continue;

      // Check tmux session alive
      if (!isTmuxSessionAlive(entry.tmux_session)) {
        entry.status = 'dead';
        registryDirty = true;
        await logLifecycleEvent(
          this.config.projectRoot,
          agentId,
          'context_usage_warning',
          {
            reason: 'tmux_session_dead',
            tmuxSession: entry.tmux_session,
            source: 'daemon',
          },
        );
        continue;
      }

      // Skip if no transcript path
      if (!entry.transcript_path) continue;

      // Get context usage
      const reading = getContextUsage(entry.transcript_path, this.config.maxContextTokens);
      if (!reading) continue;

      // Emit context_metric event for dashboard history (persisted to events.jsonl)
      await appendEvent(this.config.projectRoot, {
        event_id: uuidv4(),
        timestamp: reading.timestamp,
        event_type: 'context_metric' as 'error_occurred',
        agent_id: agentId,
        data: {
          contextUsage: reading.percentage,
          contextTokens: reading.contextTokens,
          maxTokens: reading.maxTokens,
          percentageDisplay: reading.percentageDisplay,
          source: 'daemon',
        },
      });

      // Check warning threshold
      if (reading.percentage >= this.config.warningThreshold) {
        await logLifecycleEvent(
          this.config.projectRoot,
          agentId,
          'context_usage_warning',
          {
            contextPercentage: reading.percentageDisplay,
            contextTokens: reading.contextTokens,
            maxTokens: reading.maxTokens,
            source: 'daemon',
          },
        );
      }

      // Check critical threshold
      if (reading.percentage >= this.config.contextThreshold && !this.pendingSnapshots.has(agentId)) {
        await this.requestSnapshot(agentId, entry, reading);
      }
    }

    if (registryDirty) {
      await saveRegistry(this.config.projectRoot, registry);
    }

    // Check pending snapshot timeouts
    const now = Date.now();
    const timedOut: string[] = [];
    for (const [agentId, pending] of this.pendingSnapshots) {
      if ((now - pending.requestedAt) > this.config.snapshotTimeoutMs) {
        timedOut.push(agentId);
      }
    }

    for (const agentId of timedOut) {
      const entry = registry.agents[agentId];
      if (entry?.transcript_path) {
        const reading = getContextUsage(entry.transcript_path, this.config.maxContextTokens);
        if (reading) {
          this.pendingSnapshots.delete(agentId);
          await this.requestSnapshot(agentId, entry, reading);
        }
      }

      await logLifecycleEvent(
        this.config.projectRoot,
        agentId,
        'context_usage_critical',
        {
          reason: 'snapshot_timeout',
          timeoutMs: this.config.snapshotTimeoutMs,
          source: 'daemon',
        },
      );
    }
  }

  /**
   * Check if the daemon is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the current pending snapshot requests.
   * Used by tests and the API layer to check daemon state.
   */
  getPendingSnapshots(): Map<string, PendingSnapshot> {
    return new Map(this.pendingSnapshots);
  }

  /**
   * Send a snapshot request to an agent via the inbox system.
   */
  private async requestSnapshot(
    agentId: string,
    _entry: AgentRegistryEntry,
    reading: ContextUsageReading,
  ): Promise<void> {
    const snapshotData = toSnapshotData(reading, this.config);
    const snapshot = await createSnapshot(
      this.config.projectRoot,
      agentId,
      snapshotData,
    );

    const message: InboxMessage = {
      id: `msg-${uuidv4()}`,
      from: 'context-monitor-daemon',
      to: agentId,
      timestamp: new Date().toISOString(),
      type: 'lifecycle_command',
      priority: 'critical',
      body: {
        command: 'prepare_handoff',
        reason: 'context_usage_high',
        contextPercentage: reading.percentageDisplay,
        contextTokens: reading.contextTokens,
        maxTokens: reading.maxTokens,
        snapshotId: snapshot.snapshotId,
        snapshotPath: join(
          getProjectRoot(this.config.projectRoot),
          'memory-snapshots',
          `${agentId}-latest.json`,
        ),
      },
      read: false,
    };

    writeToInbox(this.config.projectRoot, agentId, message);

    this.pendingSnapshots.set(agentId, {
      requestedAt: Date.now(),
      snapshotPath: message.body.snapshotPath as string,
      agentId,
      contextPercentage: reading.percentage,
    });

    await logLifecycleEvent(
      this.config.projectRoot,
      agentId,
      'context_usage_critical',
      {
        contextPercentage: reading.percentageDisplay,
        contextTokens: reading.contextTokens,
        maxTokens: reading.maxTokens,
        snapshotId: snapshot.snapshotId,
        source: 'daemon',
      },
    );
  }
}

// ─── Factory Function ────────────────────────────────────────────────────

/**
 * Create a new ContextMonitorDaemon with merged defaults.
 *
 * @param config - Partial config; projectRoot is required, all others have defaults
 * @returns A new ContextMonitorDaemon instance (not yet started)
 *
 * @example
 * ```typescript
 * const daemon = createDaemon({ projectRoot: '/home/user/my-project' });
 * daemon.start();
 * // ... later
 * daemon.stop();
 * ```
 */
export function createDaemon(config: Partial<DaemonConfig> & { projectRoot: string }): ContextMonitorDaemon {
  const fullConfig: DaemonConfig = {
    ...DEFAULT_CONFIG,
    ...config,
  };
  return new ContextMonitorDaemon(fullConfig);
}
