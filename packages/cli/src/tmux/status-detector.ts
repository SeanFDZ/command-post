import { getMemorySnapshotsDir } from '@command-post/core';
import { sessionExists } from './session-manager.js';
import { logger } from '../utils/logger.js';
import type { SessionStatus, AgentStatusRow } from './types.js';

/**
 * Adapter interface for querying events.
 * Injected to decouple from a specific @command-post/core implementation.
 */
export interface EventQuery {
  (projectPath: string, filters: {
    agentId?: string;
    eventType?: string;
    startTime?: string;
  }): Promise<Array<{ event_id: string; timestamp: string; event_type: string; agent_id: string }>>;
}

/**
 * Adapter interface for listing tasks.
 * Injected to decouple from a specific @command-post/core implementation.
 */
export interface TaskQuery {
  (projectPath: string): Promise<Array<{
    id: string;
    assigned_to: string;
    status: string;
    audit?: { compliance_score?: number };
  }>>;
}

/** No-op defaults that return empty arrays. */
const defaultEventQuery: EventQuery = async () => [];
const defaultTaskQuery: TaskQuery = async () => [];

/**
 * Creates a status detector with injected query dependencies.
 *
 * Usage:
 *   const { getSessionStatus, getAgentStatuses } = createStatusDetector(queryEvents, listTasks);
 *
 * Or use the default exports which use no-op stubs (useful until
 * @command-post/core exposes queryEvents/listTasks implementations).
 */
export function createStatusDetector(
  queryEvents: EventQuery = defaultEventQuery,
  listTasks: TaskQuery = defaultTaskQuery,
) {
  /**
   * Determines the current status of an agent session.
   *
   * Status logic:
   *  - stopped:  tmux session not found
   *  - error:    error event from this agent within last 30s
   *  - waiting:  a task assigned to this agent has pending_approval status
   *  - running:  recent event from this agent within last 5s
   *  - idle:     tmux session exists, no recent activity
   */
  async function getSessionStatus(
    sName: string,
    agentId: string,
    projectPath: string,
  ): Promise<SessionStatus> {
    // Check if session exists
    const exists = await sessionExists(sName);
    if (!exists) return 'stopped';

    const now = Date.now();

    // Check for error events in last 30 seconds
    try {
      const errorEvents = await queryEvents(projectPath, {
        agentId,
        eventType: 'error_occurred',
        startTime: new Date(now - 30_000).toISOString(),
      });
      if (errorEvents.length > 0) return 'error';
    } catch {
      logger.debug(`Could not query error events for ${agentId}`);
    }

    // Check for pending_approval tasks
    try {
      const tasks = await listTasks(projectPath);
      const waiting = tasks.some(
        (t) => t.assigned_to === agentId && t.status === 'ready_for_review',
      );
      if (waiting) return 'waiting';
    } catch {
      logger.debug(`Could not query tasks for ${agentId}`);
    }

    // Check for recent activity (5 seconds)
    try {
      const recentEvents = await queryEvents(projectPath, {
        agentId,
        startTime: new Date(now - 5_000).toISOString(),
      });
      if (recentEvents.length > 0) return 'running';
    } catch {
      logger.debug(`Could not query recent events for ${agentId}`);
    }

    return 'idle';
  }

  /**
   * Builds AgentStatusRow objects for all agents in a topology.
   */
  async function getAgentStatuses(
    agents: Array<{ id: string; role: string; domain: string | null; sessionName: string }>,
    projectPath: string,
  ): Promise<AgentStatusRow[]> {
    const rows: AgentStatusRow[] = [];

    // Pre-load tasks once for compliance scoring
    let allTasks: Awaited<ReturnType<typeof listTasks>> = [];
    try {
      allTasks = await listTasks(projectPath);
    } catch {
      logger.debug('Could not load tasks for compliance scoring');
    }

    for (const agent of agents) {
      const status = await getSessionStatus(agent.sessionName, agent.id, projectPath);

      // Try to read context usage from memory snapshot
      let contextPercent: number | null = null;
      try {
        const fs = await import('node:fs/promises');
        const pathMod = await import('node:path');
        const snapshotDir = getMemorySnapshotsDir(projectPath);
        const files = await fs.readdir(snapshotDir).catch(() => [] as string[]);
        const agentFiles = files
          .filter((f) => f.startsWith(agent.id) && f.endsWith('.json'))
          .sort()
          .reverse();

        if (agentFiles.length > 0) {
          const content = await fs.readFile(
            pathMod.join(snapshotDir, agentFiles[0]),
            'utf-8',
          );
          const snapshot = JSON.parse(content) as { context_at_snapshot?: number };
          contextPercent = snapshot.context_at_snapshot ?? null;
        }
      } catch {
        // No snapshot available
      }

      // Get last activity timestamp
      let lastActivity: string | null = null;
      try {
        const events = await queryEvents(projectPath, { agentId: agent.id });
        if (events.length > 0) {
          const latest = events[events.length - 1];
          lastActivity = formatRelativeTime(latest.timestamp);
        }
      } catch {
        // No events
      }

      // Compute compliance score from tasks assigned to this agent
      let complianceScore: number | null = null;
      const agentTasks = allTasks.filter((t) => t.assigned_to === agent.id);
      if (agentTasks.length > 0) {
        const scores = agentTasks
          .map((t) => t.audit?.compliance_score)
          .filter((s): s is number => s != null);
        if (scores.length > 0) {
          complianceScore = scores.reduce((a, b) => a + b, 0) / scores.length;
        }
      }

      rows.push({
        agentId: agent.id,
        role: agent.role,
        domain: agent.domain,
        status,
        contextPercent,
        complianceScore,
        lastActivity,
      });
    }

    return rows;
  }

  return { getSessionStatus, getAgentStatuses };
}

/** Formats an ISO timestamp as a human-readable relative time. */
function formatRelativeTime(isoTimestamp: string): string {
  const diff = Date.now() - new Date(isoTimestamp).getTime();
  const seconds = Math.floor(diff / 1000);

  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  return `${Math.floor(hours / 24)}d ago`;
}

// Default instance using no-op stubs (consumers can call createStatusDetector
// with real implementations once @command-post/core exposes them).
const defaultDetector = createStatusDetector();

/** @see createStatusDetector for injectable version */
export const getSessionStatus = defaultDetector.getSessionStatus;

/** @see createStatusDetector for injectable version */
export const getAgentStatuses = defaultDetector.getAgentStatuses;
