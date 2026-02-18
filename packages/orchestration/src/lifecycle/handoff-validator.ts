/**
 * Handoff Validator — validates handoff preconditions.
 *
 * Ensures target agent exists & is healthy, tasks are in valid states,
 * no circular handoffs, and the context snapshot is valid.
 */

import { listTasks } from '@command-post/core';
import type { TaskObject } from '@command-post/core';
import { getLatestSnapshot } from './memory-snapshot.js';
import type { OrchestrationSnapshot } from '../types/index.js';

/** Valid task statuses that can be transferred in a handoff. */
const TRANSFERABLE_STATUSES = new Set([
  'assigned',
  'in_progress',
  'pending',
  'blocked',
]);

export interface HandoffValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate all preconditions for a handoff.
 */
export async function validateHandoff(
  projectPath: string,
  sourceAgent: string,
  targetAgent: string,
  taskIds: string[],
  activeHandoffs: Map<string, string>,
): Promise<HandoffValidationResult> {
  const errors: string[] = [];

  // 1. Source and target must be different
  if (sourceAgent === targetAgent) {
    errors.push('Source and target agent cannot be the same.');
  }

  // 2. No circular handoffs (A → B → A)
  if (activeHandoffs.get(targetAgent) === sourceAgent) {
    errors.push(
      `Circular handoff detected: ${targetAgent} already has a pending handoff to ${sourceAgent}.`,
    );
  }

  // 3. Target agent must exist and be healthy (snapshot with <80% usage)
  const targetSnapshot = await getLatestSnapshot(projectPath, targetAgent);
  if (!targetSnapshot) {
    errors.push(
      `Target agent "${targetAgent}" has no memory snapshot. Cannot verify health.`,
    );
  } else if (targetSnapshot.contextUsage.percentageOfMax >= 80) {
    errors.push(
      `Target agent "${targetAgent}" is in critical context state (${targetSnapshot.contextUsage.percentageOfMax}%). Cannot accept handoff.`,
    );
  }

  // 4. All tasks must be in transferable states
  if (taskIds.length === 0) {
    errors.push('No tasks specified for transfer.');
  } else {
    const allTasks = await listTasks(projectPath);
    const taskMap = new Map<string, TaskObject>();
    for (const t of allTasks) taskMap.set(t.id, t);

    for (const taskId of taskIds) {
      const task = taskMap.get(taskId);
      if (!task) {
        errors.push(`Task "${taskId}" does not exist.`);
      } else if (!TRANSFERABLE_STATUSES.has(task.status)) {
        errors.push(
          `Task "${taskId}" is in status "${task.status}" which cannot be transferred.`,
        );
      }
    }
  }

  // 5. Source agent must have a valid snapshot
  const sourceSnapshot = await getLatestSnapshot(projectPath, sourceAgent);
  if (!sourceSnapshot) {
    errors.push(
      `Source agent "${sourceAgent}" has no memory snapshot. Cannot capture handoff context.`,
    );
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate that a snapshot is complete (all required fields present).
 */
export function validateSnapshotCompleteness(
  snapshot: OrchestrationSnapshot,
): HandoffValidationResult {
  const errors: string[] = [];

  if (!snapshot.snapshotId) errors.push('Missing snapshotId.');
  if (!snapshot.agentId) errors.push('Missing agentId.');
  if (!snapshot.timestamp) errors.push('Missing timestamp.');
  if (!snapshot.contextUsage) errors.push('Missing contextUsage.');
  if (!snapshot.taskStatus) errors.push('Missing taskStatus.');
  if (!snapshot.handoffSignal) errors.push('Missing handoffSignal.');

  return { valid: errors.length === 0, errors };
}
