import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectStructure, createTask, readInbox } from '@command-post/core';
import type { TaskObject } from '@command-post/core';
import {
  createSnapshot,
  HandoffManager,
  validateHandoff,
  validateSnapshotCompleteness,
} from '../../src/index.js';
import type { SnapshotData, OrchestrationSnapshot } from '../../src/index.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'cp-handoff-'));
}

function makeSnapshotData(pct: number): SnapshotData {
  const total = Math.round(pct * 100);
  return {
    contextUsage: {
      tokens: { prompt: Math.round(total * 0.7), completion: Math.round(total * 0.3), total },
      percentageOfMax: pct,
      maxTokens: 10000,
      modelsUsed: ['claude-opus-4-6'],
    },
    decisionLog: [],
    taskStatus: { tasksCompleted: 0, tasksInProgress: 0, tasksFailed: 0, averageCompletionTime: 0 },
    handoffSignal: { active: false, targetAgent: null, reason: null, readyToHandoff: false },
    memoryState: { conversationHistory: 10, retrievedDocuments: 5, activeContextSize: total },
    modelPerformance: { opusTokensUsed: total },
  };
}

function makeTask(id: string, assignedTo: string): TaskObject {
  const now = new Date().toISOString();
  return {
    id,
    title: `Task ${id}`,
    feature: 'auth',
    domain: 'authentication',
    assigned_to: assignedTo,
    assigned_by: 'orchestrator-1',
    status: 'in_progress',
    prd_sections: ['3.1'],
    plan: { steps: ['step-1'], current_step: 0, estimated_steps_remaining: 1 },
    progress: { summary: 'In progress' },
    dependencies: { blocked_by: [], blocks: [] },
    audit: { compliance_score: 1.0 },
    context: { usage_percent: 0.5, handoff_count: 0 },
    timestamps: { created: now, last_updated: now },
  };
}

describe('Handoff Validator', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await makeTempDir();
    await initProjectStructure(projectPath, {
      project: { name: 'test', version: '1.0.0' },
      orchestration: { hierarchy: 'flat', domains: ['default'] },
      communication: { inbox_format: 'json', task_format: 'json', contracts_directory: '.command-post/contracts' },
      paths: { output_dir: './output' },
    });
  });

  afterEach(async () => {
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  it('rejects handoff when source equals target', async () => {
    const result = await validateHandoff(
      projectPath, 'worker-1', 'worker-1', ['task-1'], new Map(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('same'))).toBe(true);
  });

  it('rejects circular handoffs', async () => {
    const activeHandoffs = new Map([['worker-2', 'worker-1']]);
    const result = await validateHandoff(
      projectPath, 'worker-1', 'worker-2', ['task-1'], activeHandoffs,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Circular'))).toBe(true);
  });

  it('rejects when target agent is in critical state', async () => {
    await createSnapshot(projectPath, 'worker-1', makeSnapshotData(30));
    await createSnapshot(projectPath, 'worker-2', makeSnapshotData(90)); // critical!
    await createTask(projectPath, makeTask('task-1', 'worker-1'));

    const result = await validateHandoff(
      projectPath, 'worker-1', 'worker-2', ['task-1'], new Map(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('critical'))).toBe(true);
  });

  it('rejects when tasks do not exist', async () => {
    await createSnapshot(projectPath, 'worker-1', makeSnapshotData(30));
    await createSnapshot(projectPath, 'worker-2', makeSnapshotData(30));

    const result = await validateHandoff(
      projectPath, 'worker-1', 'worker-2', ['task-999'], new Map(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('does not exist'))).toBe(true);
  });

  it('rejects empty task list', async () => {
    await createSnapshot(projectPath, 'worker-1', makeSnapshotData(30));
    await createSnapshot(projectPath, 'worker-2', makeSnapshotData(30));

    const result = await validateHandoff(
      projectPath, 'worker-1', 'worker-2', [], new Map(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('No tasks'))).toBe(true);
  });

  it('accepts valid handoff', async () => {
    await createSnapshot(projectPath, 'worker-1', makeSnapshotData(85));
    await createSnapshot(projectPath, 'worker-2', makeSnapshotData(30));
    await createTask(projectPath, makeTask('task-1', 'worker-1'));

    const result = await validateHandoff(
      projectPath, 'worker-1', 'worker-2', ['task-1'], new Map(),
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

describe('validateSnapshotCompleteness', () => {
  it('validates a complete snapshot', () => {
    const snap: OrchestrationSnapshot = {
      snapshotId: 'snap-1',
      agentId: 'worker-1',
      timestamp: new Date().toISOString(),
      contextUsage: {
        tokens: { prompt: 100, completion: 50, total: 150 },
        percentageOfMax: 15,
        maxTokens: 1000,
        modelsUsed: [],
      },
      decisionLog: [],
      taskStatus: { tasksCompleted: 0, tasksInProgress: 0, tasksFailed: 0, averageCompletionTime: 0 },
      handoffSignal: { active: false, targetAgent: null, reason: null, readyToHandoff: false },
      memoryState: { conversationHistory: 0, retrievedDocuments: 0, activeContextSize: 0 },
      modelPerformance: {},
    };
    const result = validateSnapshotCompleteness(snap);
    expect(result.valid).toBe(true);
  });

  it('detects missing fields', () => {
    const snap = { snapshotId: '', agentId: '', timestamp: '' } as unknown as OrchestrationSnapshot;
    const result = validateSnapshotCompleteness(snap);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('HandoffManager', () => {
  let projectPath: string;
  let manager: HandoffManager;

  beforeEach(async () => {
    projectPath = await makeTempDir();
    await initProjectStructure(projectPath, {
      project: { name: 'test', version: '1.0.0' },
      orchestration: { hierarchy: 'flat', domains: ['default'] },
      communication: { inbox_format: 'json', task_format: 'json', contracts_directory: '.command-post/contracts' },
      paths: { output_dir: './output' },
    });
    manager = new HandoffManager(projectPath);
  });

  afterEach(async () => {
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  it('initiates a handoff without a target', async () => {
    await createSnapshot(projectPath, 'worker-1', makeSnapshotData(85));
    const result = await manager.initiateHandoff('worker-1', 'context_critical');
    expect(result.success).toBe(true);
    expect(result.sourceAgent).toBe('worker-1');
    expect(result.targetAgent).toBeNull();
  });

  it('tracks handoff in progress', async () => {
    await createSnapshot(projectPath, 'worker-1', makeSnapshotData(85));
    await manager.initiateHandoff('worker-1', 'context_critical');
    expect(manager.isHandoffInProgress('worker-1')).toBe(true);
    expect(manager.isHandoffInProgress('worker-2')).toBe(false);
  });

  it('gets handoff status', async () => {
    await createSnapshot(projectPath, 'worker-1', makeSnapshotData(85));
    await manager.initiateHandoff('worker-1', 'context_critical');

    const status = await manager.getHandoffStatus('worker-1');
    expect(status).not.toBeNull();
    expect(status!.phase).toBe('initiated');
    expect(status!.sourceAgent).toBe('worker-1');
  });

  it('completes a handoff — transfers tasks atomically', async () => {
    await createSnapshot(projectPath, 'worker-1', makeSnapshotData(85));
    await createSnapshot(projectPath, 'worker-2', makeSnapshotData(30));
    await createTask(projectPath, makeTask('task-1', 'worker-1'));

    // Initiate
    await manager.initiateHandoff('worker-1', 'context_critical', 'worker-2', ['task-1']);

    // Complete
    await manager.completeHandoff('worker-1', 'worker-2', ['task-1']);

    const status = await manager.getHandoffStatus('worker-1');
    expect(status!.phase).toBe('completed');

    // Target should have received notification
    const messages = await readInbox(projectPath, 'worker-2');
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].type).toBe('memory_handoff');
  });

  it('cancels an in-flight handoff', async () => {
    await createSnapshot(projectPath, 'worker-1', makeSnapshotData(85));
    await manager.initiateHandoff('worker-1', 'context_critical');

    await manager.cancelHandoff('worker-1');
    const status = await manager.getHandoffStatus('worker-1');
    expect(status!.phase).toBe('cancelled');
    expect(manager.isHandoffInProgress('worker-1')).toBe(false);
  });

  it('throws when completing without prior initiation', async () => {
    await expect(
      manager.completeHandoff('worker-1', 'worker-2', ['task-1']),
    ).rejects.toThrow('No initiated handoff');
  });

  it('throws when cancelling without prior initiation', async () => {
    await expect(
      manager.cancelHandoff('worker-1'),
    ).rejects.toThrow('No initiated handoff');
  });

  it('fails initiation when validation fails', async () => {
    // Target is critical
    await createSnapshot(projectPath, 'worker-1', makeSnapshotData(85));
    await createSnapshot(projectPath, 'worker-2', makeSnapshotData(90));
    await createTask(projectPath, makeTask('task-1', 'worker-1'));

    const result = await manager.initiateHandoff(
      'worker-1', 'context_critical', 'worker-2', ['task-1'],
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('critical');
  });

  it('queries handoff history', async () => {
    await createSnapshot(projectPath, 'worker-1', makeSnapshotData(85));
    await manager.initiateHandoff('worker-1', 'context_critical');

    const history = await manager.queryHandoffHistory('worker-1');
    expect(history.length).toBe(1);
    expect(history[0].eventType).toBe('handoff_initiated');
  });

  it('queries handoff history with time range', async () => {
    const before = new Date().toISOString();
    await createSnapshot(projectPath, 'worker-1', makeSnapshotData(85));
    await manager.initiateHandoff('worker-1', 'context_critical');

    const future = new Date(Date.now() + 10000).toISOString();
    const historyInRange = await manager.queryHandoffHistory('worker-1', {
      startTime: before,
      endTime: future,
    });
    expect(historyInRange.length).toBe(1);

    const historyOutOfRange = await manager.queryHandoffHistory('worker-1', {
      endTime: '2000-01-01T00:00:00Z',
    });
    expect(historyOutOfRange.length).toBe(0);
  });
});
