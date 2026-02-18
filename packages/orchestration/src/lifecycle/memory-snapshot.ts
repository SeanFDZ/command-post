/**
 * Memory Snapshot Manager.
 *
 * Creates immutable snapshots of agent context state, stores them in
 * .command-post/memory-snapshots/, and provides query access.
 *
 * Snapshots are write-once / read-many.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { getMemorySnapshotsDir } from '@command-post/core';
import { logLifecycleEvent } from '../utils/lifecycle-logger.js';
import type {
  OrchestrationSnapshot,
  SnapshotData,
  TimeRange,
} from '../types/index.js';

/**
 * Build a deterministic, lexicographically-sortable filename for a snapshot.
 *
 * Format: `{agentId}-{ISO timestamp with special chars replaced}.json`
 */
function snapshotFilename(agentId: string, timestamp: string): string {
  const safe = timestamp.replace(/[:.]/g, '-');
  return `${agentId}-${safe}.json`;
}

/**
 * Ensure the memory-snapshots directory exists.
 */
async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Create an immutable memory snapshot for an agent.
 *
 * The snapshot is written atomically (write to .tmp, rename) and is
 * never modified after creation. A `-latest.json` copy is maintained
 * for quick lookups.
 */
export async function createSnapshot(
  projectPath: string,
  agentId: string,
  data: SnapshotData,
): Promise<OrchestrationSnapshot> {
  const dir = getMemorySnapshotsDir(projectPath);
  await ensureDir(dir);

  const timestamp = new Date().toISOString();
  const snapshot: OrchestrationSnapshot = {
    snapshotId: uuidv4(),
    agentId,
    timestamp,
    contextUsage: data.contextUsage,
    decisionLog: data.decisionLog,
    taskStatus: data.taskStatus,
    handoffSignal: data.handoffSignal,
    memoryState: data.memoryState,
    modelPerformance: data.modelPerformance,
  };

  // Write the snapshot atomically
  const filename = snapshotFilename(agentId, timestamp);
  const filePath = join(dir, filename);
  const tmpPath = `${filePath}.tmp`;
  const content = JSON.stringify(snapshot, null, 2);

  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, filePath);

  // Maintain a -latest.json copy for quick lookups
  const latestPath = join(dir, `${agentId}-latest.json`);
  await fs.writeFile(`${latestPath}.tmp`, content, 'utf-8');
  await fs.rename(`${latestPath}.tmp`, latestPath);

  // Log lifecycle event
  await logLifecycleEvent(projectPath, agentId, 'context_snapshot_created', {
    snapshotId: snapshot.snapshotId,
    percentageOfMax: data.contextUsage.percentageOfMax,
  });

  // Cleanup old snapshots (retain 5 most recent, delete files older than 24h)
  await cleanupOldSnapshots(projectPath, agentId);

  return snapshot;
}

/**
 * Retrieve the latest snapshot for an agent.
 *
 * Reads the `-latest.json` shortcut file for O(1) access.
 */
export async function getLatestSnapshot(
  projectPath: string,
  agentId: string,
): Promise<OrchestrationSnapshot | null> {
  const dir = getMemorySnapshotsDir(projectPath);
  const latestPath = join(dir, `${agentId}-latest.json`);

  try {
    const content = await fs.readFile(latestPath, 'utf-8');
    return JSON.parse(content) as OrchestrationSnapshot;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * Query snapshots for an agent within an optional time range.
 *
 * Reads all snapshot files for the agent, filters by time range,
 * and returns them sorted by timestamp (oldest first).
 */
export async function querySnapshots(
  projectPath: string,
  agentId: string,
  timeRange?: TimeRange,
): Promise<OrchestrationSnapshot[]> {
  const dir = getMemorySnapshotsDir(projectPath);

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  // Filter files belonging to this agent (exclude -latest.json)
  const prefix = `${agentId}-`;
  const agentFiles = entries.filter(
    (f) => f.startsWith(prefix) && f.endsWith('.json') && !f.endsWith('-latest.json'),
  );

  const snapshots: OrchestrationSnapshot[] = [];
  for (const file of agentFiles) {
    try {
      const content = await fs.readFile(join(dir, file), 'utf-8');
      const snap = JSON.parse(content) as OrchestrationSnapshot;

      // Apply time range filter
      if (timeRange?.startTime && snap.timestamp < timeRange.startTime) continue;
      if (timeRange?.endTime && snap.timestamp > timeRange.endTime) continue;

      snapshots.push(snap);
    } catch {
      // Skip malformed files
    }
  }

  // Sort by timestamp ascending
  snapshots.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return snapshots;
}

/**
 * Remove old snapshots for an agent, enforcing both a maximum count
 * and a maximum age. The newest `maxSnapshots` files are always kept
 * unless they exceed `maxAgeHours`.
 *
 * Returns the number of files deleted.
 */
export async function cleanupOldSnapshots(
  projectPath: string,
  agentId: string,
  maxSnapshots: number = 5,
  maxAgeHours: number = 24,
): Promise<number> {
  const dir = getMemorySnapshotsDir(projectPath);

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }

  // Filter files belonging to this agent (exclude -latest.json)
  const prefix = `${agentId}-`;
  const agentFiles = entries.filter(
    (f) => f.startsWith(prefix) && f.endsWith('.json') && !f.endsWith('-latest.json'),
  );

  // Get stats for sorting
  const fileStats = await Promise.all(
    agentFiles.map(async (file) => {
      const filePath = join(dir, file);
      const stat = await fs.stat(filePath);
      return { file, filePath, mtime: stat.mtime };
    }),
  );

  // Sort by modification time, newest first
  fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  const now = Date.now();
  const maxAgeMs = maxAgeHours * 3600 * 1000;
  let deletedCount = 0;

  for (let i = 0; i < fileStats.length; i++) {
    const { filePath, mtime } = fileStats[i];
    const tooOld = now - mtime.getTime() > maxAgeMs;
    const overLimit = i >= maxSnapshots;

    if (tooOld || overLimit) {
      try {
        await fs.unlink(filePath);
        deletedCount++;
      } catch {
        // File may have been deleted by another process
      }
    }
  }

  return deletedCount;
}

/**
 * MemorySnapshotManager — OOP wrapper around the snapshot functions.
 */
export class MemorySnapshotManager {
  constructor(private readonly projectPath: string) {}

  async createSnapshot(
    agentId: string,
    data: SnapshotData,
  ): Promise<OrchestrationSnapshot> {
    return createSnapshot(this.projectPath, agentId, data);
  }

  async getLatestSnapshot(
    agentId: string,
  ): Promise<OrchestrationSnapshot | null> {
    return getLatestSnapshot(this.projectPath, agentId);
  }

  async querySnapshots(
    agentId: string,
    timeRange?: TimeRange,
  ): Promise<OrchestrationSnapshot[]> {
    return querySnapshots(this.projectPath, agentId, timeRange);
  }

  async cleanupOldSnapshots(
    agentId: string,
    maxSnapshots?: number,
    maxAgeHours?: number,
  ): Promise<number> {
    return cleanupOldSnapshots(this.projectPath, agentId, maxSnapshots, maxAgeHours);
  }
}
