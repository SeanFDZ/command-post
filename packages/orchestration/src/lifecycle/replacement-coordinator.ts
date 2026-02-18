/**
 * Replacement Coordinator — orchestrates the full Memory Snapshot Protocol
 * from PRD Section 5.2.
 *
 * The 4-step protocol:
 *   Step 1: Context Monitor sends lifecycle command (write_memory_snapshot)
 *   Step 2: Agent writes structured memory snapshot
 *   Step 3: Context Monitor spawns replacement agent
 *   Step 4: Original agent shuts down cleanly
 *
 * This coordinator ties together ContextDetector, MemorySnapshotManager,
 * HandoffManager, snapshot quality validation, and agent spawning into
 * a single orchestrated flow.
 */

import { v4 as uuidv4 } from 'uuid';
import { writeToInbox } from '@command-post/core';
import type { InboxMessage } from '@command-post/core';
import { getLatestSnapshot } from './memory-snapshot.js';
import { HandoffManager } from './handoff-manager.js';
import {
  prepareReplacement,
  writeSpawnRequest,
} from './agent-spawner.js';
import type { SpawnRequest, SpawnExecutor } from './agent-spawner.js';
import {
  validateOrchestrationSnapshotQuality,
  validateSnapshotQuality,
} from './snapshot-quality.js';
import type {
  SnapshotQualityResult,
  PrdMemorySnapshot,
} from './snapshot-quality.js';
import { logLifecycleEvent } from '../utils/lifecycle-logger.js';
import type { OrchestrationSnapshot } from '../types/index.js';

/** Configuration for the replacement coordinator. */
export interface ReplacementCoordinatorConfig {
  /** Project root path. */
  projectPath: string;
  /** Orchestrator agent ID to notify. */
  orchestratorId: string;
  /** Minimum snapshot quality score to accept (0-1). Default: 0.6 */
  minQualityScore?: number;
  /** Max seconds to wait for snapshot after sending command. Default: 120 */
  snapshotTimeoutSeconds?: number;
  /** Optional callback to execute the actual agent spawn (tmux, etc). */
  spawnExecutor?: SpawnExecutor;
  /** Maximum snapshot quality retries before forcing handoff. Default: 3 */
  maxSnapshotRetries?: number;
}

/** Status of a replacement flow. */
export type ReplacementPhase =
  | 'idle'
  | 'snapshot_requested'
  | 'snapshot_received'
  | 'snapshot_validated'
  | 'replacement_prepared'
  | 'replacement_spawned'
  | 'original_shutdown'
  | 'completed'
  | 'failed';

/** State of an active replacement flow. */
export interface ReplacementFlowState {
  flowId: string;
  agentId: string;
  phase: ReplacementPhase;
  reason: string;
  contextUsage: number;
  snapshotRequestedAt: string | null;
  snapshotReceivedAt: string | null;
  qualityResult: SnapshotQualityResult | null;
  spawnRequest: SpawnRequest | null;
  replacementAgentId: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  retryCount: number;
  bestQualityScore: number;
}

/**
 * ReplacementCoordinator — manages the end-to-end Memory Snapshot Protocol.
 */
export class ReplacementCoordinator {
  private readonly projectPath: string;
  private readonly orchestratorId: string;
  private readonly minQualityScore: number;
  private readonly maxSnapshotRetries: number;
  private readonly spawnExecutor?: SpawnExecutor;
  private readonly handoffManager: HandoffManager;
  private activeFlows = new Map<string, ReplacementFlowState>();
  private completedFlows: ReplacementFlowState[] = [];

  constructor(config: ReplacementCoordinatorConfig) {
    this.projectPath = config.projectPath;
    this.orchestratorId = config.orchestratorId;
    this.minQualityScore = config.minQualityScore ?? 0.6;
    this.maxSnapshotRetries = config.maxSnapshotRetries ?? 3;
    this.spawnExecutor = config.spawnExecutor;
    this.handoffManager = new HandoffManager(config.projectPath);
  }

  /**
   * Step 1: Initiate the replacement flow.
   */
  async initiateReplacement(
    agentId: string,
    reason: string,
    contextUsage: number,
    agentInfo: { role: string; domain: string; taskIds: string[] },
  ): Promise<ReplacementFlowState> {
    const flowId = uuidv4();
    const timestamp = new Date().toISOString();

    const flow: ReplacementFlowState = {
      flowId,
      agentId,
      phase: 'snapshot_requested',
      reason,
      contextUsage,
      snapshotRequestedAt: timestamp,
      snapshotReceivedAt: null,
      qualityResult: null,
      spawnRequest: null,
      replacementAgentId: null,
      error: null,
      startedAt: timestamp,
      completedAt: null,
      retryCount: 0,
      bestQualityScore: 0,
    };
    this.activeFlows.set(agentId, flow);

    const snapshotCommand: InboxMessage = {
      id: `msg-${uuidv4()}`,
      from: 'context-monitor',
      to: agentId,
      timestamp,
      type: 'lifecycle_command',
      priority: 'critical',
      body: {
        command: 'write_memory_snapshot',
        reason: 'context_usage_high',
        current_usage: contextUsage,
        deadline: 'complete_current_atomic_operation',
        flow_id: flowId,
      },
      read: false,
    };
    await writeToInbox(this.projectPath, agentId, snapshotCommand);

    await logLifecycleEvent(this.projectPath, agentId, 'context_usage_critical', {
      flowId,
      contextUsage,
      reason,
      action: 'snapshot_requested',
    });

    const orchestratorNotification: InboxMessage = {
      id: `msg-${uuidv4()}`,
      from: 'context-monitor',
      to: this.orchestratorId,
      timestamp,
      type: 'lifecycle_command',
      priority: 'high',
      body: {
        command: 'agent_replacement_initiated',
        agentId,
        reason,
        contextUsage,
        flowId,
        taskIds: agentInfo.taskIds,
        message: `Agent ${agentId} has reached ${(contextUsage * 100).toFixed(1)}% context usage. ` +
          `Memory Snapshot Protocol initiated. Snapshot requested.`,
      },
      read: false,
    };
    await writeToInbox(this.projectPath, this.orchestratorId, orchestratorNotification);

    (flow as ReplacementFlowState & { _agentInfo: typeof agentInfo })._agentInfo = agentInfo;

    return flow;
  }

  /**
   * Steps 2-4: Process the snapshot and complete the replacement.
   */
  async processSnapshot(agentId: string): Promise<ReplacementFlowState> {
    const flow = this.activeFlows.get(agentId);
    if (!flow) {
      throw new Error(`No active replacement flow for agent "${agentId}"`);
    }

    const agentInfo = (flow as ReplacementFlowState & { _agentInfo?: { role: string; domain: string; taskIds: string[] } })._agentInfo;
    if (!agentInfo) {
      throw new Error(`Missing agent info for replacement flow "${flow.flowId}"`);
    }

    const timestamp = new Date().toISOString();

    try {
      flow.phase = 'snapshot_received';
      flow.snapshotReceivedAt = timestamp;

      const snapshot = await getLatestSnapshot(this.projectPath, agentId);
      if (!snapshot) {
        return this.failFlow(flow, 'No snapshot found for agent after request');
      }

      flow.phase = 'snapshot_validated';
      const qualityResult = validateOrchestrationSnapshotQuality(snapshot);
      flow.qualityResult = qualityResult;

      if (qualityResult.score < this.minQualityScore) {
        flow.retryCount++;
        flow.bestQualityScore = Math.max(flow.bestQualityScore, qualityResult.score);

        if (flow.retryCount >= this.maxSnapshotRetries) {
          await logLifecycleEvent(this.projectPath, agentId, 'context_snapshot_created', {
            flowId: flow.flowId,
            qualityScore: qualityResult.score,
            action: 'retry_limit_reached',
            retryCount: flow.retryCount,
            bestQualityScore: flow.bestQualityScore,
            maxSnapshotRetries: this.maxSnapshotRetries,
          });

          return this.forceHandoff(agentId, 'retry_limit_exhausted');
        }

        const retryMsg: InboxMessage = {
          id: `msg-${uuidv4()}`,
          from: 'context-monitor',
          to: agentId,
          timestamp,
          type: 'lifecycle_command',
          priority: 'critical',
          body: {
            command: 'write_memory_snapshot',
            reason: 'snapshot_quality_insufficient',
            current_usage: flow.contextUsage,
            quality_score: qualityResult.score,
            quality_findings: qualityResult.findings
              .filter((f) => !f.passed)
              .map((f) => f.message),
            message: `Snapshot quality score ${qualityResult.score.toFixed(2)} is below minimum ${this.minQualityScore}. Please write a more complete snapshot.`,
          },
          read: false,
        };
        await writeToInbox(this.projectPath, agentId, retryMsg);

        await logLifecycleEvent(this.projectPath, agentId, 'context_snapshot_created', {
          flowId: flow.flowId,
          qualityScore: qualityResult.score,
          action: 'retry_requested',
          retryCount: flow.retryCount,
          failedChecks: qualityResult.findings.filter((f) => !f.passed).length,
        });

        return flow;
      }

      return await this.executeReplacementAndShutdown(flow, agentInfo, snapshot, {
        qualityScore: qualityResult.score,
      });
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return this.failFlow(flow, errorMsg);
    }
  }

  /**
   * Force a handoff when retry/time limits are exhausted.
   */
  async forceHandoff(
    agentId: string,
    reason: 'retry_limit_exhausted' | 'snapshot_timeout',
  ): Promise<ReplacementFlowState> {
    const flow = this.activeFlows.get(agentId);
    if (!flow) {
      throw new Error(`No active replacement flow for agent "${agentId}"`);
    }

    const agentInfo = (flow as ReplacementFlowState & { _agentInfo?: { role: string; domain: string; taskIds: string[] } })._agentInfo;
    if (!agentInfo) {
      throw new Error(`Missing agent info for replacement flow "${flow.flowId}"`);
    }

    let snapshot = await getLatestSnapshot(this.projectPath, agentId);

    if (!snapshot) {
      snapshot = {
        snapshotId: uuidv4(),
        agentId,
        timestamp: new Date().toISOString(),
        contextUsage: {
          tokens: { prompt: 0, completion: 0, total: 0 },
          percentageOfMax: flow.contextUsage,
          maxTokens: 200_000,
          modelsUsed: [],
        },
        decisionLog: [],
        taskStatus: {
          tasksCompleted: 0,
          tasksInProgress: 0,
          tasksFailed: 0,
          averageCompletionTime: 0,
        },
        handoffSignal: {
          active: true,
          targetAgent: null,
          reason,
          readyToHandoff: false,
        },
        memoryState: {
          conversationHistory: 0,
          retrievedDocuments: 0,
          activeContextSize: 0,
        },
        modelPerformance: {},
      };
    }

    await logLifecycleEvent(this.projectPath, agentId, 'handoff_forced', {
      flowId: flow.flowId,
      reason,
      retryCount: flow.retryCount,
      bestQualityScore: flow.bestQualityScore,
    });

    return this.executeReplacementAndShutdown(flow, agentInfo, snapshot, {
      forced: true,
      reason,
      retryCount: flow.retryCount,
      bestQualityScore: flow.bestQualityScore,
    });
  }

  validatePrdSnapshot(snapshot: PrdMemorySnapshot): SnapshotQualityResult {
    return validateSnapshotQuality(snapshot);
  }

  getFlowState(agentId: string): ReplacementFlowState | null {
    return this.activeFlows.get(agentId) ?? null;
  }

  isReplacementActive(agentId: string): boolean {
    return this.activeFlows.has(agentId);
  }

  getCompletedFlows(): ReplacementFlowState[] {
    return [...this.completedFlows];
  }

  getActiveFlows(): ReplacementFlowState[] {
    return [...this.activeFlows.values()];
  }

  // ── Internal ──────────────────────────────────────────────────────

  private async executeReplacementAndShutdown(
    flow: ReplacementFlowState,
    agentInfo: { role: string; domain: string; taskIds: string[] },
    snapshot: OrchestrationSnapshot,
    meta: {
      qualityScore?: number;
      forced?: boolean;
      reason?: string;
      retryCount?: number;
      bestQualityScore?: number;
    } = {},
  ): Promise<ReplacementFlowState> {
    const agentId = flow.agentId;

    flow.phase = 'replacement_prepared';
    const handoffNumber = (snapshot.handoffSignal?.active ? 1 : 0) + 1;

    const handoffResult = await this.handoffManager.initiateHandoff(
      agentId,
      flow.reason,
      undefined,
      agentInfo.taskIds,
    );

    if (!handoffResult.success) {
      return this.failFlow(flow, `Handoff initiation failed: ${handoffResult.error}`);
    }

    const spawnResult = await prepareReplacement(
      this.projectPath,
      agentId,
      snapshot,
      agentInfo.taskIds,
      agentInfo.role,
      agentInfo.domain,
      handoffNumber,
    );

    if (!spawnResult.success) {
      return this.failFlow(flow, `Replacement preparation failed: ${spawnResult.error}`);
    }

    flow.spawnRequest = spawnResult.request;
    flow.replacementAgentId = spawnResult.request.replacementAgentId;

    await this.handoffManager.completeHandoff(
      agentId,
      spawnResult.request.replacementAgentId,
      agentInfo.taskIds,
    );

    await writeSpawnRequest(this.projectPath, spawnResult.request);

    if (this.spawnExecutor) {
      flow.phase = 'replacement_spawned';
      const spawned = await this.spawnExecutor(spawnResult.request);
      if (!spawned) {
        return this.failFlow(flow, 'Spawn executor returned false');
      }
    } else {
      flow.phase = 'replacement_prepared';
    }

    flow.phase = 'original_shutdown';
    const shutdownMsg: InboxMessage = {
      id: `msg-${uuidv4()}`,
      from: 'context-monitor',
      to: agentId,
      timestamp: new Date().toISOString(),
      type: 'lifecycle_command',
      priority: 'critical',
      body: {
        command: 'prepare_shutdown',
        reason: 'replacement_spawned',
        replacementAgentId: spawnResult.request.replacementAgentId,
        message: `Your replacement (${spawnResult.request.replacementAgentId}) has been ` +
          `prepared with your memory snapshot. You may now shut down gracefully.`,
      },
      read: false,
    };
    await writeToInbox(this.projectPath, agentId, shutdownMsg);

    const completeNotification: InboxMessage = {
      id: `msg-${uuidv4()}`,
      from: 'context-monitor',
      to: this.orchestratorId,
      timestamp: new Date().toISOString(),
      type: 'task_update',
      priority: 'normal',
      body: {
        report_type: 'agent_replacement_completed',
        originalAgent: agentId,
        replacementAgent: spawnResult.request.replacementAgentId,
        flowId: flow.flowId,
        handoffNumber,
        qualityScore: meta.qualityScore ?? meta.bestQualityScore ?? 0,
        taskIds: agentInfo.taskIds,
        forced: meta.forced ?? false,
        reason: meta.reason,
        retryCount: meta.retryCount,
        bestQualityScore: meta.bestQualityScore,
        message: meta.forced
          ? `Agent ${agentId} force-replaced by ${spawnResult.request.replacementAgentId} ` +
            `(handoff #${handoffNumber}, forced: ${meta.reason}, best quality: ${(meta.bestQualityScore ?? 0).toFixed(2)}).`
          : `Agent ${agentId} replaced by ${spawnResult.request.replacementAgentId} ` +
            `(handoff #${handoffNumber}, quality: ${(meta.qualityScore ?? 0).toFixed(2)}).`,
      },
      read: false,
    };
    await writeToInbox(this.projectPath, this.orchestratorId, completeNotification);

    flow.phase = 'completed';
    flow.completedAt = new Date().toISOString();
    this.activeFlows.delete(agentId);
    this.completedFlows.push(flow);

    await logLifecycleEvent(this.projectPath, agentId, 'handoff_completed', {
      flowId: flow.flowId,
      replacementAgentId: spawnResult.request.replacementAgentId,
      handoffNumber,
      qualityScore: meta.qualityScore ?? meta.bestQualityScore ?? 0,
      forced: meta.forced ?? false,
    });

    return flow;
  }

  private async failFlow(
    flow: ReplacementFlowState,
    error: string,
  ): Promise<ReplacementFlowState> {
    flow.phase = 'failed';
    flow.error = error;
    flow.completedAt = new Date().toISOString();

    this.activeFlows.delete(flow.agentId);
    this.completedFlows.push(flow);

    await logLifecycleEvent(this.projectPath, flow.agentId, 'handoff_failed', {
      flowId: flow.flowId,
      error,
      phase: flow.phase,
    });

    const failNotification: InboxMessage = {
      id: `msg-${uuidv4()}`,
      from: 'context-monitor',
      to: this.orchestratorId,
      timestamp: new Date().toISOString(),
      type: 'escalation',
      priority: 'critical',
      body: {
        event: 'agent_replacement_failed',
        agentId: flow.agentId,
        flowId: flow.flowId,
        error,
        contextUsage: flow.contextUsage,
        message: `Failed to replace agent ${flow.agentId}: ${error}. ` +
          `Agent is at ${(flow.contextUsage * 100).toFixed(1)}% context usage. ` +
          `Manual intervention may be needed.`,
      },
      read: false,
    };
    await writeToInbox(this.projectPath, this.orchestratorId, failNotification);

    return flow;
  }
}
