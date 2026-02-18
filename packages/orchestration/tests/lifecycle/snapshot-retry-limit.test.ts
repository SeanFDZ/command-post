/**
 * Tests for Snapshot Retry Limit with Force-Handoff.
 *
 * Verifies the dual-limited retry strategy:
 *   - Max 3 snapshot attempts (configurable)
 *   - Force handoff when limit is reached
 *   - Synthetic snapshot when no snapshot on disk
 *   - Shutdown signal always sent to original agent
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initProjectStructure,
  readInbox,
} from '@command-post/core';
import { createSnapshot } from '../../src/lifecycle/memory-snapshot.js';
import { ReplacementCoordinator } from '../../src/lifecycle/replacement-coordinator.js';
import type { SnapshotData } from '../../src/types/index.js';

// Mock agent-spawner to avoid filesystem side effects
const mockSpawnResult = {
  success: true,
  request: {
    requestId: 'req-mock',
    replacementAgentId: 'worker-1-r1',
    originalAgentId: 'worker-1',
    instructionsPath: '/tmp/instructions.md',
    preparedInstructions: '# Instructions',
    snapshot: null,
    taskIds: ['task-1'],
    role: 'worker',
    domain: 'frontend',
    handoffNumber: 1,
    projectPath: '/tmp',
    timestamp: new Date().toISOString(),
  },
};

vi.mock('../../src/lifecycle/agent-spawner.js', () => ({
  prepareReplacement: vi.fn(async () => mockSpawnResult),
  writeSpawnRequest: vi.fn(async () => undefined),
}));

// Mock handoff-manager to avoid filesystem side effects
vi.mock('../../src/lifecycle/handoff-manager.js', () => {
  class MockHandoffManager {
    initiateHandoff = vi.fn().mockResolvedValue({ success: true, snapshotId: 'snap-1', sourceAgent: 'worker-1', targetAgent: null, tasksTransferred: ['task-1'] });
    completeHandoff = vi.fn().mockResolvedValue(undefined);
    getHandoffStatus = vi.fn().mockReturnValue(null);
  }
  return { HandoffManager: MockHandoffManager };
});

/** Create a low-quality snapshot (missing decision log = lower score). */
function makeLowQualitySnapshotData(): SnapshotData {
  return {
    contextUsage: {
      tokens: { prompt: 7000, completion: 2000, total: 9000 },
      percentageOfMax: 85,
      maxTokens: 10000,
      modelsUsed: ['claude-opus-4-6'],
    },
    decisionLog: [], // Empty — causes quality to drop
    taskStatus: { tasksCompleted: 0, tasksInProgress: 0, tasksFailed: 0, averageCompletionTime: 0 },
    handoffSignal: { active: false, targetAgent: null, reason: null, readyToHandoff: false },
    memoryState: { conversationHistory: 0, retrievedDocuments: 0, activeContextSize: 0 },
    modelPerformance: {},
  };
}

/** Create a high-quality snapshot. */
function makeHighQualitySnapshotData(): SnapshotData {
  return {
    contextUsage: {
      tokens: { prompt: 7000, completion: 2000, total: 9000 },
      percentageOfMax: 85,
      maxTokens: 10000,
      modelsUsed: ['claude-opus-4-6'],
    },
    decisionLog: [{
      timestamp: new Date().toISOString(),
      taskId: 'task-1',
      decision: 'execute',
      reasoning: 'Task assigned and ready',
      confidence: 0.9,
    }],
    taskStatus: { tasksCompleted: 2, tasksInProgress: 1, tasksFailed: 0, averageCompletionTime: 120 },
    handoffSignal: { active: true, targetAgent: null, reason: 'context_usage_high', readyToHandoff: true },
    memoryState: { conversationHistory: 10, retrievedDocuments: 5, activeContextSize: 9000 },
    modelPerformance: { opusTokensUsed: 9000 },
  };
}

const agentInfo = { role: 'worker', domain: 'frontend', taskIds: ['task-1'] };

describe('Snapshot Retry Limit', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await fs.mkdtemp(join(tmpdir(), 'cp-retry-'));
    await initProjectStructure(projectPath, {
      project: { name: 'retry-test', version: '1.0.0' },
      orchestration: { hierarchy: 'flat', domains: ['frontend'] },
      communication: { inbox_format: 'json', task_format: 'json', contracts_directory: '.command-post/contracts' },
      paths: { output_dir: './output' },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  it('retryCount increments on quality failure', async () => {
    const coordinator = new ReplacementCoordinator({
      projectPath,
      orchestratorId: 'orchestrator-1',
      minQualityScore: 0.9, // High threshold to force failure
      maxSnapshotRetries: 5, // High limit so we don't trigger force handoff
    });

    // Write a low-quality snapshot
    await createSnapshot(projectPath, 'worker-1', makeLowQualitySnapshotData());

    // Initiate flow
    await coordinator.initiateReplacement('worker-1', 'context_usage_critical', 0.85, agentInfo);

    // First attempt
    const flow1 = await coordinator.processSnapshot('worker-1');
    expect(flow1.retryCount).toBe(1);

    // Write another low-quality snapshot (simulating agent retry)
    await createSnapshot(projectPath, 'worker-1', makeLowQualitySnapshotData());

    // Second attempt
    const flow2 = await coordinator.processSnapshot('worker-1');
    expect(flow2.retryCount).toBe(2);
  });

  it('bestQualityScore tracks highest score across retries', async () => {
    const coordinator = new ReplacementCoordinator({
      projectPath,
      orchestratorId: 'orchestrator-1',
      minQualityScore: 0.99, // Unreachable threshold
      maxSnapshotRetries: 5,
    });

    await createSnapshot(projectPath, 'worker-1', makeLowQualitySnapshotData());
    await coordinator.initiateReplacement('worker-1', 'context_usage_critical', 0.85, agentInfo);

    // First attempt — get the score
    const flow1 = await coordinator.processSnapshot('worker-1');
    const firstScore = flow1.bestQualityScore;
    expect(firstScore).toBeGreaterThan(0);

    // Write a slightly better snapshot (still below threshold)
    const betterData = makeLowQualitySnapshotData();
    betterData.decisionLog = [{
      timestamp: new Date().toISOString(),
      taskId: 'task-1',
      decision: 'partial',
      reasoning: 'Some reasoning',
      confidence: 0.5,
    }];
    await createSnapshot(projectPath, 'worker-1', betterData);

    // Second attempt — score should be at least as high
    const flow2 = await coordinator.processSnapshot('worker-1');
    expect(flow2.bestQualityScore).toBeGreaterThanOrEqual(firstScore);
  });

  it('force handoff fires at retry limit', async () => {
    const coordinator = new ReplacementCoordinator({
      projectPath,
      orchestratorId: 'orchestrator-1',
      minQualityScore: 0.99, // Unreachable
      maxSnapshotRetries: 2, // Low limit
    });

    await createSnapshot(projectPath, 'worker-1', makeLowQualitySnapshotData());
    await coordinator.initiateReplacement('worker-1', 'context_usage_critical', 0.85, agentInfo);

    // First attempt — returns for retry
    const flow1 = await coordinator.processSnapshot('worker-1');
    expect(flow1.phase).not.toBe('completed');
    expect(flow1.retryCount).toBe(1);

    // Write another bad snapshot
    await createSnapshot(projectPath, 'worker-1', makeLowQualitySnapshotData());

    // Second attempt — hits the limit, should force handoff and complete
    const flow2 = await coordinator.processSnapshot('worker-1');
    expect(flow2.phase).toBe('completed');
    expect(flow2.retryCount).toBe(2);
    expect(flow2.replacementAgentId).toBe('worker-1-r1');
  });

  it('force handoff works with no snapshot on disk', async () => {
    const coordinator = new ReplacementCoordinator({
      projectPath,
      orchestratorId: 'orchestrator-1',
    });

    // Write a snapshot just for initiateReplacement, then we'll call forceHandoff
    // which will try getLatestSnapshot but we won't write one for this agent ID
    await createSnapshot(projectPath, 'worker-1', makeLowQualitySnapshotData());
    await coordinator.initiateReplacement('worker-1', 'context_usage_critical', 0.85, agentInfo);

    // Remove the snapshot directory to simulate no snapshot on disk
    const cpRoot = join(projectPath, '.command-post');
    const snapshotDir = join(cpRoot, 'memory-snapshots');
    await fs.rm(snapshotDir, { recursive: true, force: true });
    await fs.mkdir(snapshotDir, { recursive: true });

    // Force handoff should still succeed with synthetic snapshot
    const flow = await coordinator.forceHandoff('worker-1', 'snapshot_timeout');
    expect(flow.phase).toBe('completed');
    expect(flow.replacementAgentId).toBe('worker-1-r1');
  });

  it('force handoff sends shutdown signal to original agent', async () => {
    const coordinator = new ReplacementCoordinator({
      projectPath,
      orchestratorId: 'orchestrator-1',
      maxSnapshotRetries: 1, // Trigger immediately
      minQualityScore: 0.99,
    });

    await createSnapshot(projectPath, 'worker-1', makeLowQualitySnapshotData());
    await coordinator.initiateReplacement('worker-1', 'context_usage_critical', 0.85, agentInfo);

    // This should trigger force handoff (retryCount reaches 1 which is >= maxSnapshotRetries of 1)
    await coordinator.processSnapshot('worker-1');

    // Check original agent's inbox for prepare_shutdown
    const inbox = await readInbox(projectPath, 'worker-1');
    const shutdownMsgs = inbox.filter(
      (m) => m.type === 'lifecycle_command' && m.body.command === 'prepare_shutdown',
    );
    expect(shutdownMsgs.length).toBeGreaterThanOrEqual(1);
    expect(shutdownMsgs[0].body.replacementAgentId).toBe('worker-1-r1');
  });

  it('force handoff notifies orchestrator with forced metadata', async () => {
    const coordinator = new ReplacementCoordinator({
      projectPath,
      orchestratorId: 'orchestrator-1',
    });

    await createSnapshot(projectPath, 'worker-1', makeLowQualitySnapshotData());
    await coordinator.initiateReplacement('worker-1', 'context_usage_critical', 0.85, agentInfo);

    // Call forceHandoff directly
    await coordinator.forceHandoff('worker-1', 'retry_limit_exhausted');

    // Check orchestrator's inbox for completion notification
    const inbox = await readInbox(projectPath, 'orchestrator-1');
    const completionMsgs = inbox.filter(
      (m) => m.type === 'task_update' && m.body.report_type === 'agent_replacement_completed',
    );
    expect(completionMsgs.length).toBeGreaterThanOrEqual(1);
    expect(completionMsgs[0].body.forced).toBe(true);
    expect(completionMsgs[0].body.reason).toBe('retry_limit_exhausted');
  });

  it('normal happy path still works without hitting retry logic', async () => {
    const coordinator = new ReplacementCoordinator({
      projectPath,
      orchestratorId: 'orchestrator-1',
      minQualityScore: 0.5, // Low threshold — high-quality snapshot will pass
      maxSnapshotRetries: 3,
    });

    // Write a high-quality snapshot
    await createSnapshot(projectPath, 'worker-1', makeHighQualitySnapshotData());

    await coordinator.initiateReplacement('worker-1', 'context_usage_critical', 0.85, agentInfo);

    const flow = await coordinator.processSnapshot('worker-1');
    expect(flow.phase).toBe('completed');
    expect(flow.retryCount).toBe(0);
    expect(flow.replacementAgentId).toBe('worker-1-r1');
  });

  it('forceHandoff throws if no active flow exists', async () => {
    const coordinator = new ReplacementCoordinator({
      projectPath,
      orchestratorId: 'orchestrator-1',
    });

    await expect(
      coordinator.forceHandoff('nonexistent-agent', 'snapshot_timeout'),
    ).rejects.toThrow('No active replacement flow for agent "nonexistent-agent"');
  });
});
