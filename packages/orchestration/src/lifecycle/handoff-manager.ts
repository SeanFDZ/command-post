/**
 * Handoff Manager — coordinates task/context transfers between agents.
 *
 * Ensures atomic, transactional handoffs with full audit trail.
 */

import { v4 as uuidv4 } from 'uuid';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  updateTask,
  getTask,
  writeToInbox,
  getProjectRoot,
} from '@command-post/core';
import type { InboxMessage } from '@command-post/core';
import { getLatestSnapshot } from './memory-snapshot.js';
import { validateHandoff, validateSnapshotCompleteness } from './handoff-validator.js';
import { logLifecycleEvent } from '../utils/lifecycle-logger.js';
import type {
  HandoffResult,
  HandoffStatus,
  HandoffEvent,
  TimeRange,
} from '../types/index.js';

/**
 * HandoffManager — manages the lifecycle of agent-to-agent handoffs.
 */
export class HandoffManager {
  /** Active handoffs: sourceAgent → HandoffStatus */
  private activeHandoffs = new Map<string, HandoffStatus>();

  /** Historical log of all handoff events. */
  private handoffHistory: HandoffEvent[] = [];

  constructor(private readonly projectPath: string) {}

  /**
   * Load persisted handoff state from disk.
   * Call after construction to restore state from a previous session.
   */
  async loadState(): Promise<void> {
    const statePath = join(getProjectRoot(this.projectPath), 'handoff-state.json');
    try {
      const content = await fs.readFile(statePath, 'utf-8');
      const state = JSON.parse(content) as {
        activeHandoffs: Array<[string, HandoffStatus]>;
        handoffHistory: HandoffEvent[];
      };
      this.activeHandoffs = new Map(state.activeHandoffs);
      this.handoffHistory = state.handoffHistory;
    } catch {
      // File doesn't exist or is corrupted — start fresh
    }
  }

  /**
   * Persist current handoff state to disk atomically.
   */
  private async saveState(): Promise<void> {
    const statePath = join(getProjectRoot(this.projectPath), 'handoff-state.json');
    const tmpPath = `${statePath}.tmp`;
    const state = {
      activeHandoffs: Array.from(this.activeHandoffs.entries()),
      handoffHistory: this.handoffHistory,
    };
    await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
    await fs.rename(tmpPath, statePath);
  }

  /**
   * Initiate a handoff from a source agent.
   */
  async initiateHandoff(
    sourceAgent: string,
    reason: string,
    targetAgent?: string,
    taskIds?: string[],
  ): Promise<HandoffResult> {
    const tasksToTransfer = taskIds ?? [];
    const target = targetAgent ?? null;

    // If we have a target, validate the handoff
    if (target) {
      const validation = await validateHandoff(
        this.projectPath,
        sourceAgent,
        target,
        tasksToTransfer,
        new Map(
          [...this.activeHandoffs].map(([_, s]) => [s.sourceAgent, s.targetAgent ?? '']),
        ),
      );

      if (!validation.valid) {
        const failEvent: HandoffEvent = {
          eventType: 'handoff_failed',
          sourceAgent,
          targetAgent: target,
          tasks: tasksToTransfer,
          snapshotId: '',
          reason,
          timestamp: new Date().toISOString(),
          error: validation.errors.join('; '),
        };
        this.handoffHistory.push(failEvent);

        await logLifecycleEvent(
          this.projectPath,
          sourceAgent,
          'handoff_failed',
          { targetAgent: target, reason, errors: validation.errors },
        );

        return {
          success: false,
          sourceAgent,
          targetAgent: target,
          tasksTransferred: [],
          snapshotId: '',
          error: validation.errors.join('; '),
        };
      }
    }

    // Get or create a snapshot for the source agent
    let snapshot = await getLatestSnapshot(this.projectPath, sourceAgent);
    const snapshotId = snapshot?.snapshotId ?? '';

    if (snapshot) {
      const completeness = validateSnapshotCompleteness(snapshot);
      if (!completeness.valid) {
        return {
          success: false,
          sourceAgent,
          targetAgent: target,
          tasksTransferred: [],
          snapshotId,
          error: `Snapshot incomplete: ${completeness.errors.join('; ')}`,
        };
      }
    }

    // Record the handoff status
    const status: HandoffStatus = {
      agentId: sourceAgent,
      phase: 'initiated',
      sourceAgent,
      targetAgent: target,
      tasksToTransfer: tasksToTransfer,
      initiatedAt: new Date().toISOString(),
      completedAt: null,
    };
    this.activeHandoffs.set(sourceAgent, status);

    const initEvent: HandoffEvent = {
      eventType: 'handoff_initiated',
      sourceAgent,
      targetAgent: target,
      tasks: tasksToTransfer,
      snapshotId,
      reason,
      timestamp: status.initiatedAt,
    };
    this.handoffHistory.push(initEvent);

    await logLifecycleEvent(
      this.projectPath,
      sourceAgent,
      'handoff_initiated',
      {
        targetAgent: target,
        reason,
        taskCount: tasksToTransfer.length,
        snapshotId,
      },
    );

    await this.saveState();

    return {
      success: true,
      sourceAgent,
      targetAgent: target,
      tasksTransferred: [],
      snapshotId,
    };
  }

  /**
   * Complete a handoff — atomically transfer all tasks from source to target.
   */
  async completeHandoff(
    sourceAgent: string,
    targetAgent: string,
    tasks: string[],
  ): Promise<void> {
    const status = this.activeHandoffs.get(sourceAgent);
    if (!status || status.phase !== 'initiated') {
      throw new Error(
        `No initiated handoff found for agent "${sourceAgent}".`,
      );
    }

    const snapshot = await getLatestSnapshot(this.projectPath, sourceAgent);
    const timestamp = new Date().toISOString();

    const updatedTaskIds: string[] = [];
    try {
      for (const taskId of tasks) {
        const existing = await getTask(this.projectPath, taskId);
        const existingProgress = (existing as Record<string, unknown>)?.progress as Record<string, unknown> | undefined;
        const existingContext = (existing as Record<string, unknown>)?.context as Record<string, unknown> | undefined;

        await updateTask(this.projectPath, taskId, {
          status: 'in_progress',
          assigned_to: targetAgent,
          progress: {
            ...existingProgress,
            summary: `Handed off from ${sourceAgent}`,
            decisions_made: [
              ...((existingProgress?.decisions_made as string[]) ?? []),
              `Handoff from ${sourceAgent} at ${timestamp}`,
            ],
          },
          context: {
            ...existingContext,
            usage_percent: 0,
            handoff_count: ((existingContext?.handoff_count as number) ?? 0) + 1,
          },
        });
        updatedTaskIds.push(taskId);
      }

      await logLifecycleEvent(
        this.projectPath,
        sourceAgent,
        'handoff_completed',
        {
          targetAgent,
          taskCount: tasks.length,
          snapshotId: snapshot?.snapshotId ?? '',
        },
      );

      const notification: InboxMessage = {
        id: `msg-${uuidv4()}`,
        from: sourceAgent,
        to: targetAgent,
        timestamp,
        type: 'memory_handoff',
        priority: 'critical',
        body: {
          event: 'snapshot_complete',
          sourceAgent,
          tasks,
          contextSnapshot: snapshot,
        },
        read: false,
      };
      await writeToInbox(this.projectPath, targetAgent, notification);

      status.phase = 'completed';
      status.targetAgent = targetAgent;
      status.completedAt = timestamp;
      this.activeHandoffs.set(sourceAgent, status);

      const completeEvent: HandoffEvent = {
        eventType: 'handoff_completed',
        sourceAgent,
        targetAgent,
        tasks,
        snapshotId: snapshot?.snapshotId ?? '',
        reason: 'handoff_completed',
        timestamp,
      };
      this.handoffHistory.push(completeEvent);

      await this.saveState();

    } catch (error: unknown) {
      for (const taskId of updatedTaskIds) {
        try {
          await updateTask(this.projectPath, taskId, {
            status: 'in_progress',
            assigned_to: sourceAgent,
            progress: {
              summary: `Rolled back handoff to ${targetAgent}`,
              decisions_made: [`Handoff rollback at ${new Date().toISOString()}`],
            },
          });
        } catch {
          // Best-effort rollback
        }
      }

      status.phase = 'failed';
      this.activeHandoffs.set(sourceAgent, status);

      const errorMsg = error instanceof Error ? error.message : String(error);

      await logLifecycleEvent(
        this.projectPath,
        sourceAgent,
        'handoff_failed',
        { targetAgent, error: errorMsg, rolledBackTasks: updatedTaskIds },
      );

      const failEvent: HandoffEvent = {
        eventType: 'handoff_failed',
        sourceAgent,
        targetAgent,
        tasks,
        snapshotId: snapshot?.snapshotId ?? '',
        reason: 'transaction_failed',
        timestamp: new Date().toISOString(),
        error: errorMsg,
      };
      this.handoffHistory.push(failEvent);

      await this.saveState();

      throw error;
    }
  }

  /**
   * Cancel an in-flight handoff.
   */
  async cancelHandoff(sourceAgent: string): Promise<void> {
    const status = this.activeHandoffs.get(sourceAgent);
    if (!status || status.phase !== 'initiated') {
      throw new Error(
        `No initiated handoff found for agent "${sourceAgent}" to cancel.`,
      );
    }

    status.phase = 'cancelled';
    status.completedAt = new Date().toISOString();
    this.activeHandoffs.set(sourceAgent, status);

    const cancelEvent: HandoffEvent = {
      eventType: 'handoff_cancelled',
      sourceAgent,
      targetAgent: status.targetAgent,
      tasks: status.tasksToTransfer,
      snapshotId: '',
      reason: 'cancelled_by_request',
      timestamp: status.completedAt,
    };
    this.handoffHistory.push(cancelEvent);

    await this.saveState();
  }

  /**
   * Get the current handoff status for an agent.
   */
  async getHandoffStatus(
    sourceAgent: string,
  ): Promise<HandoffStatus | null> {
    return this.activeHandoffs.get(sourceAgent) ?? null;
  }

  /**
   * Quick check: is there an in-flight handoff for this agent?
   */
  isHandoffInProgress(agentId: string): boolean {
    const status = this.activeHandoffs.get(agentId);
    return status?.phase === 'initiated' || status?.phase === 'in_progress';
  }

  /**
   * Query handoff history for an agent within an optional time range.
   */
  async queryHandoffHistory(
    agentId: string,
    timeRange?: TimeRange,
  ): Promise<HandoffEvent[]> {
    return this.handoffHistory.filter((e) => {
      const matchesAgent =
        e.sourceAgent === agentId || e.targetAgent === agentId;
      if (!matchesAgent) return false;
      if (timeRange?.startTime && e.timestamp < timeRange.startTime) return false;
      if (timeRange?.endTime && e.timestamp > timeRange.endTime) return false;
      return true;
    });
  }
}
