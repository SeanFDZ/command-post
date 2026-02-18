import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getContextUsage, createDaemon, ContextMonitorDaemon } from '../../src/lifecycle/context-daemon.js';
import type { AgentRegistry } from '@command-post/core';

// Mock external dependencies
vi.mock('@command-post/core', () => ({
  writeToInbox: vi.fn(),
  getProjectRoot: vi.fn((p: string) => join(p, '.command-post')),
  appendEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/lifecycle/memory-snapshot.js', () => ({
  createSnapshot: vi.fn().mockResolvedValue({
    snapshotId: 'test-snapshot-id',
    agentId: 'test-agent',
    timestamp: new Date().toISOString(),
    contextUsage: {
      tokens: { prompt: 0, completion: 0, total: 0 },
      percentageOfMax: 0,
      maxTokens: 200000,
      modelsUsed: ['claude-sonnet-4-20250514'],
    },
    decisionLog: [],
    taskStatus: { tasksCompleted: 0, tasksInProgress: 0, tasksFailed: 0, averageCompletionTime: 0 },
    handoffSignal: { active: false, targetAgent: null, reason: null, readyToHandoff: false },
    memoryState: { conversationHistory: 0, retrievedDocuments: 0, activeContextSize: 0 },
    modelPerformance: {},
  }),
}));

vi.mock('../../src/utils/lifecycle-logger.js', () => ({
  logLifecycleEvent: vi.fn().mockResolvedValue(undefined),
}));

// Mock child_process — tmux sessions default to "alive" in tests
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn().mockReturnValue({ status: 0 }),
}));

const TEST_PROJECT = '/tmp/test-project';
const COMMAND_POST_ROOT = join(TEST_PROJECT, '.command-post');
const TRANSCRIPT_DIR = '/tmp/test-transcripts';

// ─── Helper: Create a mock JSONL transcript file ─────────────────────────

function createTranscriptLine(
  type: string,
  usage?: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number },
): string {
  const line: Record<string, unknown> = {
    type,
    timestamp: new Date().toISOString(),
    sessionId: 'test-session',
  };
  if (type === 'assistant' && usage) {
    line.message = { id: `msg_${Date.now()}`, role: 'assistant', usage };
  } else {
    line.message = { role: type, content: 'test content' };
  }
  return JSON.stringify(line);
}

// ─── getContextUsage Tests ───────────────────────────────────────────────

describe('getContextUsage', () => {
  const transcriptPath = join(TRANSCRIPT_DIR, 'test-transcript.jsonl');

  beforeEach(async () => {
    await fs.mkdir(TRANSCRIPT_DIR, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(TRANSCRIPT_DIR, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('should return null for non-existent file', () => {
    const result = getContextUsage('/nonexistent/path.jsonl');
    expect(result).toBeNull();
  });

  it('should return null for empty file', async () => {
    await fs.writeFile(transcriptPath, '', 'utf-8');
    const result = getContextUsage(transcriptPath);
    expect(result).toBeNull();
  });

  it('should return null when no assistant messages with usage exist', async () => {
    const lines = [
      createTranscriptLine('system'),
      createTranscriptLine('user'),
    ].join('\n');
    await fs.writeFile(transcriptPath, lines, 'utf-8');
    const result = getContextUsage(transcriptPath);
    expect(result).toBeNull();
  });

  it('should parse the most recent assistant usage (last line)', async () => {
    const lines = [
      createTranscriptLine('assistant', {
        input_tokens: 15000, output_tokens: 800,
        cache_creation_input_tokens: 5000, cache_read_input_tokens: 0,
      }),
      createTranscriptLine('user'),
      createTranscriptLine('assistant', {
        input_tokens: 85000, output_tokens: 3200,
        cache_creation_input_tokens: 12000, cache_read_input_tokens: 45000,
      }),
    ].join('\n');
    await fs.writeFile(transcriptPath, lines, 'utf-8');

    const result = getContextUsage(transcriptPath);
    expect(result).not.toBeNull();
    // 85000 + 12000 + 45000 = 142000
    expect(result!.contextTokens).toBe(142000);
    expect(result!.maxTokens).toBe(200000);
    expect(result!.percentage).toBeCloseTo(0.71, 2);
    expect(result!.percentageDisplay).toBe(71);
    expect(result!.outputTokens).toBe(3200);
  });

  it('should NOT include output_tokens in context percentage', async () => {
    const lines = [
      createTranscriptLine('assistant', {
        input_tokens: 100000, output_tokens: 50000,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      }),
    ].join('\n');
    await fs.writeFile(transcriptPath, lines, 'utf-8');

    const result = getContextUsage(transcriptPath);
    expect(result).not.toBeNull();
    // Only input_tokens: 100000 / 200000 = 0.50
    expect(result!.contextTokens).toBe(100000);
    expect(result!.percentage).toBe(0.5);
    expect(result!.percentageDisplay).toBe(50);
    // output_tokens tracked but NOT in percentage
    expect(result!.outputTokens).toBe(50000);
  });

  it('should include all cache tokens in context calculation', async () => {
    const lines = [
      createTranscriptLine('assistant', {
        input_tokens: 50000, output_tokens: 1000,
        cache_creation_input_tokens: 30000, cache_read_input_tokens: 80000,
      }),
    ].join('\n');
    await fs.writeFile(transcriptPath, lines, 'utf-8');

    const result = getContextUsage(transcriptPath);
    expect(result).not.toBeNull();
    // 50000 + 30000 + 80000 = 160000
    expect(result!.contextTokens).toBe(160000);
    expect(result!.percentage).toBe(0.8);
    expect(result!.percentageDisplay).toBe(80);
  });

  it('should skip malformed JSON lines silently', async () => {
    const lines = [
      createTranscriptLine('assistant', {
        input_tokens: 50000, output_tokens: 1000,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      }),
      'this is not valid json{{{',
      '{"partial": true',
      createTranscriptLine('assistant', {
        input_tokens: 80000, output_tokens: 2000,
        cache_creation_input_tokens: 10000, cache_read_input_tokens: 30000,
      }),
    ].join('\n');
    await fs.writeFile(transcriptPath, lines, 'utf-8');

    const result = getContextUsage(transcriptPath);
    expect(result).not.toBeNull();
    // Should get last valid assistant line: 80000 + 10000 + 30000 = 120000
    expect(result!.contextTokens).toBe(120000);
  });

  it('should skip assistant messages without usage data', async () => {
    const assistantNoUsage = JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      sessionId: 'test',
      message: { id: 'msg_1', role: 'assistant', content: 'Hello' },
    });
    const lines = [
      createTranscriptLine('assistant', {
        input_tokens: 30000, output_tokens: 500,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      }),
      assistantNoUsage,
    ].join('\n');
    await fs.writeFile(transcriptPath, lines, 'utf-8');

    const result = getContextUsage(transcriptPath);
    expect(result).not.toBeNull();
    // Should find the first assistant with usage (reading backwards, skips the no-usage one)
    expect(result!.contextTokens).toBe(30000);
  });

  it('should use custom maxContextTokens parameter', async () => {
    const lines = [
      createTranscriptLine('assistant', {
        input_tokens: 50000, output_tokens: 1000,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      }),
    ].join('\n');
    await fs.writeFile(transcriptPath, lines, 'utf-8');

    const result = getContextUsage(transcriptPath, 100000);
    expect(result).not.toBeNull();
    expect(result!.maxTokens).toBe(100000);
    expect(result!.percentage).toBe(0.5); // 50000/100000
  });

  it('should preserve raw usage data in the reading', async () => {
    const usage = {
      input_tokens: 45000, output_tokens: 2100,
      cache_creation_input_tokens: 12000, cache_read_input_tokens: 20000,
    };
    const lines = [createTranscriptLine('assistant', usage)].join('\n');
    await fs.writeFile(transcriptPath, lines, 'utf-8');

    const result = getContextUsage(transcriptPath);
    expect(result).not.toBeNull();
    expect(result!.raw).toEqual(usage);
  });
});

// ─── DaemonConfig Defaults ───────────────────────────────────────────────

describe('DaemonConfig defaults', () => {
  it('should apply default config values via createDaemon', () => {
    const daemon = createDaemon({ projectRoot: TEST_PROJECT });
    // Verify daemon was created (it's running = false by default)
    expect(daemon.isRunning()).toBe(false);
  });

  it('should allow overriding individual config values', () => {
    const daemon = createDaemon({
      projectRoot: TEST_PROJECT,
      pollIntervalMs: 5000,
      contextThreshold: 0.90,
    });
    expect(daemon.isRunning()).toBe(false);
    // Config is internal, but we can verify behavior through runOnce
  });
});

// ─── ContextMonitorDaemon Lifecycle ──────────────────────────────────────

describe('ContextMonitorDaemon', () => {
  let daemon: ContextMonitorDaemon;

  beforeEach(async () => {
    await fs.mkdir(COMMAND_POST_ROOT, { recursive: true });
    daemon = createDaemon({
      projectRoot: TEST_PROJECT,
      pollIntervalMs: 60000, // Long interval so it doesn't fire during tests
    });
  });

  afterEach(async () => {
    daemon.stop();
    try {
      await fs.rm(TEST_PROJECT, { recursive: true });
    } catch {
      // ignore
    }
  });

  it('should start and stop cleanly', () => {
    expect(daemon.isRunning()).toBe(false);
    daemon.start();
    expect(daemon.isRunning()).toBe(true);
    daemon.stop();
    expect(daemon.isRunning()).toBe(false);
  });

  it('should be idempotent on start (no double intervals)', () => {
    daemon.start();
    daemon.start(); // Should not throw or create duplicate intervals
    expect(daemon.isRunning()).toBe(true);
    daemon.stop();
  });

  it('should be idempotent on stop', () => {
    daemon.stop(); // Should not throw when not running
    expect(daemon.isRunning()).toBe(false);
  });

  it('should have empty pending snapshots initially', () => {
    const pending = daemon.getPendingSnapshots();
    expect(pending.size).toBe(0);
  });
});

// ─── Threshold Detection ─────────────────────────────────────────────────

describe('threshold detection via runOnce', () => {
  let daemon: ContextMonitorDaemon;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Restore default mock: tmux sessions are alive
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
    await fs.mkdir(COMMAND_POST_ROOT, { recursive: true });
    await fs.mkdir(TRANSCRIPT_DIR, { recursive: true });
  });

  afterEach(async () => {
    if (daemon) daemon.stop();
    try {
      await fs.rm(TEST_PROJECT, { recursive: true });
      await fs.rm(TRANSCRIPT_DIR, { recursive: true });
    } catch {
      // ignore
    }
  });

  it('should skip agents with no transcript_path', async () => {
    const registry: AgentRegistry = {
      agents: {
        'worker-1': {
          tmux_session: 'cp-w1',
          role: 'worker',
          domain: 'frontend',
          task_id: null,
          transcript_path: null, // Not yet discovered
          pid: 12345,
          status: 'active',
          launched_at: new Date().toISOString(),
          handoff_count: 0,
        },
      },
    };
    await fs.writeFile(
      join(COMMAND_POST_ROOT, 'agent-registry.json'),
      JSON.stringify(registry, null, 2),
    );

    daemon = createDaemon({ projectRoot: TEST_PROJECT });
    // Should not throw
    await daemon.runOnce();
    expect(daemon.getPendingSnapshots().size).toBe(0);
  });

  it('should detect warning zone (>= 60%, < 70%)', async () => {
    const transcriptPath = join(TRANSCRIPT_DIR, 'warning-test.jsonl');
    // 130000 / 200000 = 65% — in warning zone (60-70%)
    const lines = [
      createTranscriptLine('assistant', {
        input_tokens: 100000, output_tokens: 1000,
        cache_creation_input_tokens: 15000, cache_read_input_tokens: 15000,
      }),
    ].join('\n');
    await fs.writeFile(transcriptPath, lines, 'utf-8');

    const registry: AgentRegistry = {
      agents: {
        'worker-1': {
          tmux_session: 'cp-w1',
          role: 'worker',
          domain: 'frontend',
          task_id: null,
          transcript_path: transcriptPath,
          pid: 12345,
          status: 'active',
          launched_at: new Date().toISOString(),
          handoff_count: 0,
        },
      },
    };
    await fs.writeFile(
      join(COMMAND_POST_ROOT, 'agent-registry.json'),
      JSON.stringify(registry, null, 2),
    );

    const { logLifecycleEvent } = await import('../../src/utils/lifecycle-logger.js');
    daemon = createDaemon({ projectRoot: TEST_PROJECT });
    await daemon.runOnce();

    // Warning event should be logged, but no snapshot requested
    expect(logLifecycleEvent).toHaveBeenCalledWith(
      TEST_PROJECT,
      'worker-1',
      'context_usage_warning',
      expect.objectContaining({ source: 'daemon' }),
    );
    expect(daemon.getPendingSnapshots().size).toBe(0);
  });

  it('should detect critical zone (>= 70%) and request snapshot', async () => {
    const transcriptPath = join(TRANSCRIPT_DIR, 'critical-test.jsonl');
    // 140000 / 200000 = 70% — at critical threshold
    const lines = [
      createTranscriptLine('assistant', {
        input_tokens: 100000, output_tokens: 2000,
        cache_creation_input_tokens: 20000, cache_read_input_tokens: 20000,
      }),
    ].join('\n');
    await fs.writeFile(transcriptPath, lines, 'utf-8');

    const registry: AgentRegistry = {
      agents: {
        'worker-1': {
          tmux_session: 'cp-w1',
          role: 'worker',
          domain: 'frontend',
          task_id: null,
          transcript_path: transcriptPath,
          pid: 12345,
          status: 'active',
          launched_at: new Date().toISOString(),
          handoff_count: 0,
        },
      },
    };
    await fs.writeFile(
      join(COMMAND_POST_ROOT, 'agent-registry.json'),
      JSON.stringify(registry, null, 2),
    );

    daemon = createDaemon({ projectRoot: TEST_PROJECT });
    await daemon.runOnce();

    // Should have a pending snapshot
    expect(daemon.getPendingSnapshots().size).toBe(1);
    expect(daemon.getPendingSnapshots().has('worker-1')).toBe(true);
  });

  it('should NOT re-request snapshot for agent already in pendingSnapshots', async () => {
    const transcriptPath = join(TRANSCRIPT_DIR, 'no-dupe-test.jsonl');
    const lines = [
      createTranscriptLine('assistant', {
        input_tokens: 120000, output_tokens: 2000,
        cache_creation_input_tokens: 30000, cache_read_input_tokens: 30000,
      }),
    ].join('\n');
    await fs.writeFile(transcriptPath, lines, 'utf-8');

    const registry: AgentRegistry = {
      agents: {
        'worker-1': {
          tmux_session: 'cp-w1',
          role: 'worker',
          domain: 'frontend',
          task_id: null,
          transcript_path: transcriptPath,
          pid: 12345,
          status: 'active',
          launched_at: new Date().toISOString(),
          handoff_count: 0,
        },
      },
    };
    await fs.writeFile(
      join(COMMAND_POST_ROOT, 'agent-registry.json'),
      JSON.stringify(registry, null, 2),
    );

    const { writeToInbox } = await import('@command-post/core');
    daemon = createDaemon({ projectRoot: TEST_PROJECT });

    // First cycle: should request snapshot
    await daemon.runOnce();
    expect(daemon.getPendingSnapshots().size).toBe(1);
    const firstCallCount = (writeToInbox as ReturnType<typeof vi.fn>).mock.calls.length;

    // Second cycle: should NOT request again (already pending)
    await daemon.runOnce();
    const secondCallCount = (writeToInbox as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(secondCallCount).toBe(firstCallCount); // No new calls
  });

  it('should handle below-warning zone gracefully', async () => {
    const transcriptPath = join(TRANSCRIPT_DIR, 'green-test.jsonl');
    // 50000 / 200000 = 25% — well below warning
    const lines = [
      createTranscriptLine('assistant', {
        input_tokens: 50000, output_tokens: 1000,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      }),
    ].join('\n');
    await fs.writeFile(transcriptPath, lines, 'utf-8');

    const registry: AgentRegistry = {
      agents: {
        'worker-1': {
          tmux_session: 'cp-w1',
          role: 'worker',
          domain: 'frontend',
          task_id: null,
          transcript_path: transcriptPath,
          pid: 12345,
          status: 'active',
          launched_at: new Date().toISOString(),
          handoff_count: 0,
        },
      },
    };
    await fs.writeFile(
      join(COMMAND_POST_ROOT, 'agent-registry.json'),
      JSON.stringify(registry, null, 2),
    );

    daemon = createDaemon({ projectRoot: TEST_PROJECT });
    await daemon.runOnce();

    // No warnings, no snapshots
    expect(daemon.getPendingSnapshots().size).toBe(0);
  });
});

// ─── Dead Session Detection ──────────────────────────────────────────────

describe('dead tmux session detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should mark agents with dead tmux sessions as dead in registry', async () => {
    await fs.mkdir(COMMAND_POST_ROOT, { recursive: true });

    // Override mock: tmux session is dead
    vi.mocked(spawnSync).mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>);

    const registry: AgentRegistry = {
      agents: {
        'worker-dead': {
          tmux_session: 'nonexistent-session-name',
          role: 'worker',
          domain: 'frontend',
          task_id: null,
          transcript_path: null,
          pid: 99999,
          status: 'active',
          launched_at: new Date().toISOString(),
          handoff_count: 0,
        },
      },
    };
    await fs.writeFile(
      join(COMMAND_POST_ROOT, 'agent-registry.json'),
      JSON.stringify(registry, null, 2),
    );

    const daemon = createDaemon({ projectRoot: TEST_PROJECT });
    await daemon.runOnce();

    // Read the updated registry
    const updatedData = await fs.readFile(
      join(COMMAND_POST_ROOT, 'agent-registry.json'),
      'utf-8',
    );
    const updated = JSON.parse(updatedData) as AgentRegistry;
    expect(updated.agents['worker-dead'].status).toBe('dead');

    daemon.stop();

    // Cleanup
    try {
      await fs.rm(TEST_PROJECT, { recursive: true });
    } catch {
      // ignore
    }
  });
});

// ─── Registry I/O ────────────────────────────────────────────────────────

describe('registry operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
  });

  it('should return empty registry when file does not exist', async () => {
    await fs.mkdir(COMMAND_POST_ROOT, { recursive: true });
    // Don't create the registry file
    const daemon = createDaemon({ projectRoot: TEST_PROJECT });
    // runOnce should not throw when registry is missing
    await daemon.runOnce();
    expect(daemon.getPendingSnapshots().size).toBe(0);
    daemon.stop();

    try {
      await fs.rm(TEST_PROJECT, { recursive: true });
    } catch {
      // ignore
    }
  });

  it('should handle empty agents object in registry', async () => {
    await fs.mkdir(COMMAND_POST_ROOT, { recursive: true });
    await fs.writeFile(
      join(COMMAND_POST_ROOT, 'agent-registry.json'),
      JSON.stringify({ agents: {} }, null, 2),
    );

    const daemon = createDaemon({ projectRoot: TEST_PROJECT });
    await daemon.runOnce(); // Should not throw
    expect(daemon.getPendingSnapshots().size).toBe(0);
    daemon.stop();

    try {
      await fs.rm(TEST_PROJECT, { recursive: true });
    } catch {
      // ignore
    }
  });
});
