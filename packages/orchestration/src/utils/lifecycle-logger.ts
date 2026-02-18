/**
 * Lifecycle event logger.
 *
 * Wraps @command-post/core appendEvent to provide typed context lifecycle
 * event logging with consistent structure.
 */

import { v4 as uuidv4 } from 'uuid';
import { appendEvent } from '@command-post/core';
import type { ContextLifecycleEventType } from '../types/index.js';

/**
 * Map context lifecycle event types to the closest core EventType value.
 *
 * The core schema has a fixed enum for event_type. We use the closest
 * match and store the specific lifecycle type in the `data` payload.
 */
function coreEventType(
  lifecycleType: ContextLifecycleEventType,
): string {
  switch (lifecycleType) {
    case 'context_snapshot_created':
      return 'memory_snapshot_created';
    case 'handoff_completed':
      return 'handoff_completed';
    case 'handoff_initiated':
      return 'task_status_changed'; // task assignment is changing
    case 'handoff_failed':
    case 'handoff_forced':
      return 'error_occurred'; // failure condition
    case 'human_escalation':
      return 'approval_requested'; // requesting human decision
    case 'context_usage_warning':
    case 'context_usage_critical':
    case 'degradation_strategy_applied':
    case 'context_recovered':
      return 'error_occurred'; // lifecycle alerts
  }
}

/**
 * Log a context lifecycle event to events.jsonl.
 */
export async function logLifecycleEvent(
  projectPath: string,
  agentId: string,
  lifecycleType: ContextLifecycleEventType,
  details: Record<string, unknown> = {},
): Promise<void> {
  await appendEvent(projectPath, {
    event_id: uuidv4(),
    timestamp: new Date().toISOString(),
    event_type: coreEventType(lifecycleType) as 'memory_snapshot_created',
    agent_id: agentId,
    data: {
      lifecycle_event: lifecycleType,
      ...details,
    },
  });
}
