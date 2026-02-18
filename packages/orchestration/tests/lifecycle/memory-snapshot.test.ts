import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectStructure } from '@command-post/core';
import {
  createSnapshot,
  getLatestSnapshot,
  querySnapshots,
  MemorySnapshotManager,
} from '../../src/index.js';
import type { SnapshotData } from '../../src/index.js';

/** Helper to create a unique temp directory for each test. */
async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'cp-snap-'));
}

/** Standard snapshot data for testing. */
function makeSnapshotData(overrides?: Partial<SnapshotData>): SnapshotData {
  return {
    contextUsage: {
      tokens: { prompt: 4500, completion: 1200, total: 5700 },
      percentageOfMax: 57.0,
      maxTokens: 10000,
      modelsUsed: ['claude-opus-4-6'],
    },
    decisionLog: [
      {
        timestamp: new Date().toISOString(),
        taskId: 'task-1',
        decision: 'split-task',
        reasoning: 'Task too complex',
        confidence: 0.95,
      },
    ],
    taskStatus: {
      tasksCompleted: 5,
      tasksInProgress: 2,
      tasksFailed: 0,
      averageCompletionTime: 300,
    },
    handoffSignal: {
      active: false,
      targetAgent: null,
      reason: null,
      readyToHandoff: false,
    },
    memoryState: {
      conversationHistory: 45,
      retrievedDocuments: 12,
      activeContextSize: 5700,
    },
    modelPerformance: {
      opusTokensUsed: 3200,
      haikuTokensUsed: 2500,
    },
    ...overrides,
  };
}

describe('Memory Snapshot Manager', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await makeTempDir();
    await initProjectStructure(projectPath, {
      project: { name: 'test-project', version: '1.0.0' },
      orchestration: { hierarchy: 'flat', domains: ['default'] },
      communication: { inbox_format: 'json', task_format: 'json', contracts_directory: '.command-post/contracts' },
      paths: { output_dir: './output' },
    });
  });

  afterEach(async () => {
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  describe('createSnapshot', () => {
    it('creates a snapshot with a unique ID and timestamp', async () => {
      const snap = await createSnapshot(projectPath, 'worker-1', makeSnapshotData());
      expect(snap.snapshotId).toBeTruthy();
      expect(snap.agentId).toBe('worker-1');
      expect(snap.timestamp).toBeTruthy();
      expect(snap.contextUsage.tokens.total).toBe(5700);
    });

    it('writes the snapshot to disk', async () => {
      const snap = await createSnapshot(projectPath, 'worker-1', makeSnapshotData());
      const dir = join(projectPath, '.command-post', 'memory-snapshots');
      const files = await fs.readdir(dir);
      const snapshotFiles = files.filter(
        (f) => f.startsWith('worker-1-') && !f.endsWith('-latest.json'),
      );
      expect(snapshotFiles.length).toBe(1);
    });

    it('creates a latest.json symlink/copy', async () => {
      await createSnapshot(projectPath, 'worker-1', makeSnapshotData());
      const latestPath = join(
        projectPath,
        '.command-post',
        'memory-snapshots',
        'worker-1-latest.json',
      );
      const content = await fs.readFile(latestPath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.agentId).toBe('worker-1');
    });

    it('snapshots are immutable — new snapshots do not overwrite old ones', async () => {
      await createSnapshot(projectPath, 'worker-1', makeSnapshotData());
      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 10));
      await createSnapshot(
        projectPath,
        'worker-1',
        makeSnapshotData({
          contextUsage: {
            tokens: { prompt: 9000, completion: 1000, total: 10000 },
            percentageOfMax: 100,
            maxTokens: 10000,
            modelsUsed: ['claude-opus-4-6'],
          },
        }),
      );

      const dir = join(projectPath, '.command-post', 'memory-snapshots');
      const files = await fs.readdir(dir);
      const snapshotFiles = files.filter(
        (f) => f.startsWith('worker-1-') && !f.endsWith('-latest.json'),
      );
      expect(snapshotFiles.length).toBe(2);
    });
  });

  describe('getLatestSnapshot', () => {
    it('returns null when no snapshot exists', async () => {
      const result = await getLatestSnapshot(projectPath, 'nonexistent');
      expect(result).toBeNull();
    });

    it('returns the most recent snapshot', async () => {
      await createSnapshot(projectPath, 'worker-1', makeSnapshotData());
      await new Promise((r) => setTimeout(r, 10));
      const secondData = makeSnapshotData({
        contextUsage: {
          tokens: { prompt: 8000, completion: 2000, total: 10000 },
          percentageOfMax: 100,
          maxTokens: 10000,
          modelsUsed: ['claude-opus-4-6'],
        },
      });
      await createSnapshot(projectPath, 'worker-1', secondData);

      const latest = await getLatestSnapshot(projectPath, 'worker-1');
      expect(latest).not.toBeNull();
      expect(latest!.contextUsage.tokens.total).toBe(10000);
    });
  });

  describe('querySnapshots', () => {
    it('returns empty array when no snapshots exist', async () => {
      const result = await querySnapshots(projectPath, 'worker-1');
      expect(result).toEqual([]);
    });

    it('returns all snapshots sorted by timestamp', async () => {
      await createSnapshot(projectPath, 'worker-1', makeSnapshotData());
      await new Promise((r) => setTimeout(r, 10));
      await createSnapshot(projectPath, 'worker-1', makeSnapshotData());

      const result = await querySnapshots(projectPath, 'worker-1');
      expect(result).toHaveLength(2);
      expect(result[0].timestamp <= result[1].timestamp).toBe(true);
    });

    it('filters by time range', async () => {
      const snap1 = await createSnapshot(projectPath, 'worker-1', makeSnapshotData());
      await new Promise((r) => setTimeout(r, 50));
      const midpoint = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 50));
      const snap2 = await createSnapshot(projectPath, 'worker-1', makeSnapshotData());

      const afterMid = await querySnapshots(projectPath, 'worker-1', {
        startTime: midpoint,
      });
      expect(afterMid).toHaveLength(1);
      expect(afterMid[0].snapshotId).toBe(snap2.snapshotId);
    });

    it('only returns snapshots for the requested agent', async () => {
      await createSnapshot(projectPath, 'worker-1', makeSnapshotData());
      await createSnapshot(projectPath, 'worker-2', makeSnapshotData());

      const result = await querySnapshots(projectPath, 'worker-1');
      expect(result).toHaveLength(1);
      expect(result[0].agentId).toBe('worker-1');
    });
  });

  describe('MemorySnapshotManager class', () => {
    it('provides OOP wrapper over functional API', async () => {
      const mgr = new MemorySnapshotManager(projectPath);
      const snap = await mgr.createSnapshot('worker-1', makeSnapshotData());
      expect(snap.agentId).toBe('worker-1');

      const latest = await mgr.getLatestSnapshot('worker-1');
      expect(latest).not.toBeNull();
      expect(latest!.snapshotId).toBe(snap.snapshotId);

      const history = await mgr.querySnapshots('worker-1');
      expect(history).toHaveLength(1);
    });
  });
});
