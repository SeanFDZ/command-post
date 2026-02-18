/**
 * Graceful degradation strategies.
 *
 * Applied when an agent's context usage enters the yellow/red zone.
 * Strategies are applied in escalating order: reduce → compress → offload → handoff.
 */

import { writeToInbox } from '@command-post/core';
import type { InboxMessage } from '@command-post/core';
import { v4 as uuidv4 } from 'uuid';
import { logLifecycleEvent } from '../utils/lifecycle-logger.js';
import type { DegradationStrategy, DegradationResult } from '../types/index.js';
import { DEFAULT_THRESHOLDS } from '../config/thresholds.js';

/**
 * Apply a degradation strategy for the given agent.
 *
 * - **none**: No action, wait for handoff.
 * - **reduce**: Ask orchestrator to assign simpler tasks.
 * - **compress**: Signal agent to summarise old conversation history.
 * - **offload**: Move context to external storage (snapshot serves as offloaded state).
 */
export async function applyDegradation(
  projectPath: string,
  agentId: string,
  orchestratorId: string,
  strategy: DegradationStrategy,
): Promise<DegradationResult> {
  const timestamp = new Date().toISOString();

  const result: DegradationResult = {
    agentId,
    strategy,
    applied: false,
    details: '',
    timestamp,
  };

  switch (strategy) {
    case 'none':
      result.applied = true;
      result.details = 'No degradation applied; waiting for handoff.';
      break;

    case 'reduce': {
      // Send message to orchestrator asking for reduced complexity
      const msg: InboxMessage = {
        id: `msg-${uuidv4()}`,
        from: agentId,
        to: orchestratorId,
        timestamp,
        type: 'lifecycle_command',
        priority: 'high',
        body: {
          command: 'reduce_task_complexity',
          reason: 'context_usage_warning',
          agentId,
        },
        read: false,
      };
      await writeToInbox(projectPath, orchestratorId, msg);
      result.applied = true;
      result.details = 'Requested orchestrator to reduce task complexity.';
      break;
    }

    case 'compress': {
      // Signal agent to compress its conversation history
      const msg: InboxMessage = {
        id: `msg-${uuidv4()}`,
        from: 'context-monitor',
        to: agentId,
        timestamp,
        type: 'lifecycle_command',
        priority: 'high',
        body: {
          command: 'compress_history',
          reason: 'context_usage_warning',
        },
        read: false,
      };
      await writeToInbox(projectPath, agentId, msg);
      result.applied = true;
      result.details = 'Signaled agent to compress conversation history.';
      break;
    }

    case 'offload': {
      // Signal agent to offload context to external storage
      const msg: InboxMessage = {
        id: `msg-${uuidv4()}`,
        from: 'context-monitor',
        to: agentId,
        timestamp,
        type: 'lifecycle_command',
        priority: 'critical',
        body: {
          command: 'offload_context',
          reason: 'context_usage_critical',
        },
        read: false,
      };
      await writeToInbox(projectPath, agentId, msg);
      result.applied = true;
      result.details = 'Signaled agent to offload context to external storage.';
      break;
    }
  }

  // Log the degradation event
  await logLifecycleEvent(
    projectPath,
    agentId,
    'degradation_strategy_applied',
    {
      strategy,
      applied: result.applied,
      details: result.details,
    },
  );

  return result;
}

/**
 * Select the appropriate degradation strategy based on context usage percentage.
 */
export function selectDegradationStrategy(
  percentageOfMax: number,
  configuredStrategy?: DegradationStrategy,
): DegradationStrategy {
  // If a specific strategy is configured, use it (unless 'none')
  if (configuredStrategy && configuredStrategy !== 'none') {
    return configuredStrategy;
  }

  if (percentageOfMax >= DEFAULT_THRESHOLDS.criticalThreshold * 100) return 'offload';
  if (percentageOfMax >= DEFAULT_THRESHOLDS.warningThreshold * 100) return 'compress';
  if (percentageOfMax >= (DEFAULT_THRESHOLDS.warningThreshold * 100 - 20)) return 'reduce';
  return 'none';
}
