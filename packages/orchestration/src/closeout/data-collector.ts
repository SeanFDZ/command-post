/**
 * Closeout Data Collector — reads project state and returns a CloseoutData struct.
 *
 * Pure function module that gathers data from tasks, events, agent registry,
 * spawn log, and output directory. All errors are caught and result in partial
 * data — closeout must never throw.
 */

import { promises as fs } from 'node:fs';
import { join, basename, relative } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import {
  listTasks,
  loadAgentRegistry,
  getProjectRoot,
  getEventsPath,
  getSpawnLogPath,
} from '@command-post/core';
import type {
  TaskObject,
  SystemEvent,
  AgentRegistryEntry,
} from '@command-post/core';

// ── Local helpers — TODO: move to @command-post/core ─────────────────

/** SpawnLogEntry type (not yet exported from @command-post/core). */
const SpawnLogEntrySchema = z.object({
  id: z.string(),
  role: z.enum(['coordinator', 'worker', 'specialist']),
  domain: z.string(),
  spawned_at: z.string(),
  requested_by: z.string(),
  reason: z.string(),
  spawn_queue_id: z.string(),
  assigned_features: z.array(z.string()),
});
export type SpawnLogEntry = z.infer<typeof SpawnLogEntrySchema>;

const SpawnLogSchema = z.object({ spawned_agents: z.array(SpawnLogEntrySchema) });

/** Read spawn log from .command-post/spawn-log.yaml. Returns empty if missing. */
async function readSpawnLog(projectPath: string) {
  const spawnLogPath = getSpawnLogPath(projectPath);
  try {
    const raw = await fs.readFile(spawnLogPath, 'utf-8');
    return SpawnLogSchema.parse(YAML.parse(raw));
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { spawned_agents: [] as SpawnLogEntry[] };
    }
    throw err;
  }
}

/** Read events.jsonl and optionally filter. */
async function queryEvents(projectPath: string, _filters: Record<string, unknown>): Promise<SystemEvent[]> {
  const eventsPath = getEventsPath(projectPath);
  try {
    await fs.access(eventsPath);
  } catch {
    return [];
  }
  const content = await fs.readFile(eventsPath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const events: SystemEvent[] = [];
  for (const line of lines) {
    try { events.push(JSON.parse(line) as SystemEvent); } catch { /* skip malformed */ }
  }
  return events;
}

// ── Closeout Summary Interfaces ──────────────────────────────────────

export interface TaskSummary {
  id: string;
  title: string;
  feature: string;
  domain: string;
  status: string;
  assignedTo: string | null;
  complianceScore: number;
  startedAt: string | null;
  completedAt: string | null;
}

export interface EventSummary {
  eventId: string;
  timestamp: string;
  eventType: string;
  agentId: string | null;
}

export interface AgentSummary {
  id: string;
  role: string;
  domain: string;
  status: string;
  launchedAt: string;
  handoffCount: number;
  spawnedBy: string | null;
  reason: string | null;
}

export interface OutputFileSummary {
  path: string;
  relativePath: string;
  sizeBytes: number;
  lastModified: string;
}

export interface CloseoutData {
  projectName: string;
  tasks: TaskSummary[];
  events: EventSummary[];
  agents: AgentSummary[];
  outputFiles: OutputFileSummary[];
  prdPath: string | null;
  startTime: string;
  endTime: string;
  totalDuration: string;
}

// ── Helper: Find PRD Path ────────────────────────────────────────────

/**
 * Check for PRD.md then COMMAND-POST.md in project root, return path or null.
 */
export async function findPrdPath(projectPath: string): Promise<string | null> {
  for (const name of ['PRD.md', 'COMMAND-POST.md']) {
    const candidate = join(projectPath, name);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // continue checking next candidate
    }
  }
  return null;
}

// ── Helper: Scan Output Directory ────────────────────────────────────

/**
 * Recursively scan a directory and return file paths + sizes + last modified.
 */
export async function scanOutputDir(
  outputPath: string,
  basePath?: string,
): Promise<OutputFileSummary[]> {
  const root = basePath ?? outputPath;
  const results: OutputFileSummary[] = [];

  try {
    const entries = await fs.readdir(outputPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(outputPath, entry.name);
      if (entry.isDirectory()) {
        const nested = await scanOutputDir(fullPath, root);
        results.push(...nested);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(fullPath);
          results.push({
            path: fullPath,
            relativePath: relative(root, fullPath),
            sizeBytes: stat.size,
            lastModified: stat.mtime.toISOString(),
          });
        } catch {
          // Skip files we can't stat
        }
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  return results;
}

// ── Helper: Format Duration ──────────────────────────────────────────

function formatDuration(startIso: string, endIso: string): string {
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  const diffMs = Math.max(0, endMs - startMs);

  const hours = Math.floor(diffMs / 3_600_000);
  const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
  const seconds = Math.floor((diffMs % 60_000) / 1_000);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

// ── Helper: Summarize Tasks ──────────────────────────────────────────

function summarizeTask(task: TaskObject): TaskSummary {
  return {
    id: task.id,
    title: task.title,
    feature: task.feature,
    domain: task.domain,
    status: task.status,
    assignedTo: task.assigned_to,
    complianceScore: task.audit.compliance_score,
    startedAt: task.timestamps.started ?? null,
    completedAt: task.timestamps.completed ?? null,
  };
}

// ── Helper: Summarize Events ─────────────────────────────────────────

function summarizeEvent(event: SystemEvent): EventSummary {
  return {
    eventId: event.event_id,
    timestamp: event.timestamp,
    eventType: event.event_type,
    agentId: event.agent_id ?? null,
  };
}

// ── Helper: Merge Registry + Spawn Log ───────────────────────────────

function mergeAgentSummaries(
  registryEntries: Record<string, AgentRegistryEntry>,
  spawnEntries: SpawnLogEntry[],
): AgentSummary[] {
  const summaries: AgentSummary[] = [];
  const seenIds = new Set<string>();

  // Process registry entries first
  for (const [id, entry] of Object.entries(registryEntries)) {
    seenIds.add(id);
    const spawnEntry = spawnEntries.find((s) => s.id === id);
    summaries.push({
      id,
      role: entry.role,
      domain: entry.domain,
      status: entry.status,
      launchedAt: entry.launched_at,
      handoffCount: entry.handoff_count,
      spawnedBy: spawnEntry?.requested_by ?? null,
      reason: spawnEntry?.reason ?? null,
    });
  }

  // Add spawn log entries not in registry
  for (const entry of spawnEntries) {
    if (!seenIds.has(entry.id)) {
      summaries.push({
        id: entry.id,
        role: entry.role,
        domain: entry.domain,
        status: 'unknown',
        launchedAt: entry.spawned_at,
        handoffCount: 0,
        spawnedBy: entry.requested_by,
        reason: entry.reason,
      });
    }
  }

  return summaries;
}

// ── Main: Collect Closeout Data ──────────────────────────────────────

/**
 * Collect all closeout data from a project.
 * Never throws — returns partial data on any error.
 */
export async function collectCloseoutData(projectPath: string): Promise<CloseoutData> {
  const endTime = new Date().toISOString();
  let startTime = endTime;

  // Collect tasks
  let tasks: TaskSummary[] = [];
  try {
    const rawTasks = await listTasks(projectPath);
    tasks = rawTasks.map(summarizeTask);
    // Derive start time from earliest task creation
    for (const t of rawTasks) {
      if (t.timestamps.created < startTime) {
        startTime = t.timestamps.created;
      }
    }
  } catch {
    // Partial data is fine
  }

  // Collect events
  let events: EventSummary[] = [];
  try {
    const rawEvents = await queryEvents(projectPath, {});
    events = rawEvents.map(summarizeEvent);
    // Also check event timestamps for start time
    for (const e of rawEvents) {
      if (e.timestamp < startTime) {
        startTime = e.timestamp;
      }
    }
  } catch {
    // Partial data is fine
  }

  // Collect agents
  let agents: AgentSummary[] = [];
  try {
    const registry = await loadAgentRegistry(projectPath);
    let spawnLog: SpawnLogEntry[] = [];
    try {
      const log = await readSpawnLog(projectPath);
      spawnLog = log.spawned_agents;
    } catch {
      // No spawn log
    }
    agents = mergeAgentSummaries(registry.agents, spawnLog);
    // Check agent launch times for start time
    for (const a of agents) {
      if (a.launchedAt < startTime) {
        startTime = a.launchedAt;
      }
    }
  } catch {
    // Partial data is fine
  }

  // Scan output directory
  let outputFiles: OutputFileSummary[] = [];
  try {
    const outputDir = join(getProjectRoot(projectPath), 'output');
    outputFiles = await scanOutputDir(outputDir);
  } catch {
    // No output dir
  }

  // Find PRD path
  let prdPath: string | null = null;
  try {
    prdPath = await findPrdPath(projectPath);
  } catch {
    // No PRD found
  }

  // Derive project name from directory
  const projectName = basename(projectPath);

  return {
    projectName,
    tasks,
    events,
    agents,
    outputFiles,
    prdPath,
    startTime,
    endTime,
    totalDuration: formatDuration(startTime, endTime),
  };
}
