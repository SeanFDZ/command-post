/**
 * Agent Registry — Central data store for agent runtime state.
 *
 * Maps agent IDs to their tmux sessions, transcript paths, PIDs,
 * and lifecycle status. Used by:
 *   - Context Monitor Daemon to find transcripts and check status
 *   - CLI launch command to register new agents
 *   - API layer to serve agent status to the dashboard
 *
 * File location: .command-post/agent-registry.json
 * Write strategy: Atomic (write .tmp, then rename)
 */

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { getProjectRoot } from '../utils/paths.js';
import { withFileLock } from '../utils/file-lock.js';

// ─── Zod Schemas ─────────────────────────────────────────────────────────

/**
 * Schema for a single agent registry entry.
 */
export const AgentRegistryEntrySchema = z.object({
  /** tmux session name (e.g., 'cp-wf1') */
  tmux_session: z.string(),
  /** Agent role (e.g., 'worker', 'orchestrator', 'po-agent') */
  role: z.string(),
  /** Domain the agent operates in (e.g., 'frontend', 'auth') */
  domain: z.string(),
  /** Current task ID or null */
  task_id: z.string().nullable(),
  /** Absolute path to the JSONL transcript file, or null if not yet discovered */
  transcript_path: z.string().nullable(),
  /** Process ID of the Claude Code process */
  pid: z.number().int(),
  /** Agent lifecycle status */
  status: z.enum(['active', 'dead', 'replaced']),
  /** ISO 8601 timestamp when agent was launched */
  launched_at: z.string().datetime(),
  /** Number of times this agent slot has been handed off */
  handoff_count: z.number().int().min(0),
});

export type AgentRegistryEntry = z.infer<typeof AgentRegistryEntrySchema>;

/**
 * Schema for the complete agent registry file.
 */
export const AgentRegistrySchema = z.object({
  agents: z.record(z.string(), AgentRegistryEntrySchema),
});

export type AgentRegistry = z.infer<typeof AgentRegistrySchema>;

// ─── Path Utilities ──────────────────────────────────────────────────────

/**
 * Get the file path for the agent registry.
 *
 * @param projectPath - Absolute path to the project root
 * @returns Absolute path to .command-post/agent-registry.json
 */
export function getAgentRegistryPath(projectPath: string): string {
  return join(getProjectRoot(projectPath), 'agent-registry.json');
}

/**
 * Compute the project hash used by Claude Code for transcript storage.
 *
 * Claude Code stores transcripts in ~/.claude/projects/<hash>/
 * where <hash> is the project path with '/' replaced by '-'.
 *
 * @param projectPath - Absolute path to the project (e.g., '/home/user/project')
 * @returns The hash string (e.g., '-home-user-project')
 *
 * @example
 * computeProjectHash('/home/user/project') // → '-home-user-project'
 * computeProjectHash('/Users/dev/app')     // → '-Users-dev-app'
 */
export function computeProjectHash(projectPath: string): string {
  return projectPath.replace(/\//g, '-');
}

// ─── File Initialization ────────────────────────────────────────────────

/**
 * Ensure the registry file exists before locking.
 * proper-lockfile requires the target file to exist for lstat.
 */
async function ensureRegistryFile(registryPath: string): Promise<void> {
  await fs.mkdir(dirname(registryPath), { recursive: true });
  try {
    await fs.writeFile(registryPath, JSON.stringify({ agents: {} }, null, 2), { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

// ─── Registry CRUD ───────────────────────────────────────────────────────

/**
 * Load the agent registry from disk.
 *
 * Returns `{ agents: {} }` if the file doesn't exist or contains invalid data.
 * Validates the file content against the Zod schema.
 *
 * @param projectPath - Absolute path to the project root
 * @returns The parsed and validated agent registry
 */
export async function loadAgentRegistry(projectPath: string): Promise<AgentRegistry> {
  const registryPath = getAgentRegistryPath(projectPath);
  try {
    const data = await fs.readFile(registryPath, 'utf-8');
    const parsed = JSON.parse(data);
    return AgentRegistrySchema.parse(parsed);
  } catch {
    return { agents: {} };
  }
}

/**
 * Save the agent registry to disk with atomic write.
 *
 * Writes to a temporary file first, then renames for crash safety.
 * Creates the parent directory if it doesn't exist.
 *
 * @param projectPath - Absolute path to the project root
 * @param registry - The registry data to persist
 */
export async function saveAgentRegistry(
  projectPath: string,
  registry: AgentRegistry,
): Promise<void> {
  const registryPath = getAgentRegistryPath(projectPath);
  const tmpPath = `${registryPath}.tmp`;

  // Ensure directory exists
  await fs.mkdir(dirname(registryPath), { recursive: true });

  // Atomic write: tmp → rename
  await fs.writeFile(tmpPath, JSON.stringify(registry, null, 2), 'utf-8');
  await fs.rename(tmpPath, registryPath);
}

/**
 * Register an agent in the registry.
 *
 * Idempotent: if the agent already exists, its entry is overwritten.
 * Loads the current registry, adds/updates the entry, and saves.
 *
 * @param projectPath - Absolute path to the project root
 * @param agentId - Unique agent identifier (e.g., 'worker-frontend-1')
 * @param entry - The registry entry data for this agent
 */
export async function registerAgent(
  projectPath: string,
  agentId: string,
  entry: AgentRegistryEntry,
): Promise<void> {
  // Validate the entry before saving
  AgentRegistryEntrySchema.parse(entry);

  const registryPath = getAgentRegistryPath(projectPath);
  await ensureRegistryFile(registryPath);
  await withFileLock(registryPath, async () => {
    const registry = await loadAgentRegistry(projectPath);
    registry.agents[agentId] = entry;
    await saveAgentRegistry(projectPath, registry);
  });
}

/**
 * Update an agent's status in the registry.
 *
 * Quick status-only update without requiring a full entry.
 * Throws if the agent is not found in the registry.
 *
 * @param projectPath - Absolute path to the project root
 * @param agentId - Agent to update
 * @param status - New status value
 * @throws Error if agent not found in registry
 */
export async function updateAgentStatus(
  projectPath: string,
  agentId: string,
  status: AgentRegistryEntry['status'],
): Promise<void> {
  const registryPath = getAgentRegistryPath(projectPath);
  await ensureRegistryFile(registryPath);
  await withFileLock(registryPath, async () => {
    const registry = await loadAgentRegistry(projectPath);
    if (!registry.agents[agentId]) {
      throw new Error(`Agent '${agentId}' not found in registry`);
    }
    registry.agents[agentId].status = status;
    await saveAgentRegistry(projectPath, registry);
  });
}

/**
 * Get all active agents from the registry.
 *
 * Loads the registry and filters for agents with status === 'active'.
 *
 * @param projectPath - Absolute path to the project root
 * @returns Record of active agent entries keyed by agent ID
 */
export async function getActiveAgents(
  projectPath: string,
): Promise<Record<string, AgentRegistryEntry>> {
  const registry = await loadAgentRegistry(projectPath);
  const active: Record<string, AgentRegistryEntry> = {};
  for (const [id, entry] of Object.entries(registry.agents)) {
    if (entry.status === 'active') {
      active[id] = entry;
    }
  }
  return active;
}

// ─── Transcript Discovery ────────────────────────────────────────────────

/**
 * Discover the JSONL transcript path for an agent.
 *
 * Claude Code writes transcripts to:
 *   ~/.claude/projects/<computeProjectHash(projectPath)>/<session-id>.jsonl
 *
 * This function finds the most recently modified .jsonl file in the
 * project's transcript directory.
 *
 * Returns null if:
 * - The directory doesn't exist
 * - No .jsonl files are found
 *
 * Note: A better approach is for the launch command to capture the session ID
 * at launch time and write it to the registry's transcript_path field.
 * This discovery function serves as a fallback.
 *
 * @param projectPath - Absolute path to the project root
 * @param agentId - Agent ID (currently unused, but available for future per-agent filtering)
 * @returns Absolute path to the most recent .jsonl file, or null
 */
export async function discoverTranscriptPath(
  projectPath: string,
  _agentId: string,
): Promise<string | null> {
  const hash = computeProjectHash(projectPath);
  const transcriptDir = join(homedir(), '.claude', 'projects', hash);

  try {
    const entries = await fs.readdir(transcriptDir, { withFileTypes: true });
    const jsonlFiles = entries.filter(
      (e) => e.isFile() && e.name.endsWith('.jsonl'),
    );

    if (jsonlFiles.length === 0) return null;

    // Find the most recently modified file
    let newest: { name: string; mtime: number } | null = null;
    for (const file of jsonlFiles) {
      const filePath = join(transcriptDir, file.name);
      const stat = await fs.stat(filePath);
      if (!newest || stat.mtimeMs > newest.mtime) {
        newest = { name: file.name, mtime: stat.mtimeMs };
      }
    }

    if (!newest) return null;
    return join(transcriptDir, newest.name);
  } catch {
    return null;
  }
}
