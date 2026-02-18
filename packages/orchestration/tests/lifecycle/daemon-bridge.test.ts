import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { ContextDetector } from '../../src/lifecycle/context-detector.js';
import type { ContextUsageReading } from '../../src/lifecycle/context-daemon.js';
import type { ContextMetrics } from '../../src/types/index.js';

// ─── Mock Dependencies ──────────────────────────────────────────────────

vi.mock('@command-post/core', () => ({
  writeToInbox: vi.fn(),
  getProjectRoot: vi.fn((p: string) => join(p, '.command-post')),
  getMemorySnapshotsDir: vi.fn((p: string) => join(p, '.command-post', 'memory-snapshots')),
  getTaskPath: vi.fn((p: string, id: string) => join(p, '.command-post', 'tasks', `${id}.json`)),
  appendEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/lifecycle/memory-snapshot.js', () => ({
  createSnapshot: vi.fn().mockResolvedValue({
    snapshotId: 'test-snapshot',
    agentId: 'test',
    timestamp: new Date().toISOString(),
    contextUsage: { tokens: { prompt: 0, completion: 0, total: 0 }, percentageOfMax: 0, maxTokens: 200000, modelsUsed: [] },
    decisionLog: [],
    taskStatus: { tasksCompleted: 0, tasksInProgress: 0, tasksFailed: 0, averageCompletionTime: 0 },
    handoffSignal: { active: false, targetAgent: null, reason: null, readyToHandoff: false },
    memoryState: { conversationHistory: 0, retrievedDocuments: 0, activeContextSize: 0 },
    modelPerformance: {},
  }),
  getLatestSnapshot: vi.fn().mockResolvedValue(null),
  querySnapshots: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/utils/lifecycle-logger.js', () => ({
  logLifecycleEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/lifecycle/degradation.js', () => ({
  selectDegradationStrategy: vi.fn().mockReturnValue('none'),
  applyDegradation: vi.fn().mockResolvedValue({ applied: false }),
}));

const TEST_PROJECT = '/tmp/test-daemon-bridge';

// ─── Helper: Create a mock ContextUsageReading ──────────────────────────

function createReading(overrides: Partial<ContextUsageReading> = {}): ContextUsageReading {
  return {
    contextTokens: 140000,
    maxTokens: 200000,
    percentage: 0.70,
    percentageDisplay: 70,
    outputTokens: 2000,
    timestamp: new Date().toISOString(),
    raw: {
      input_tokens: 100000,
      output_tokens: 2000,
      cache_creation_input_tokens: 20000,
      cache_read_input_tokens: 20000,
    },
    ...overrides,
  };
}

// ─── ContextDetector.ingestExternalUsage Tests ───────────────────────────

describe('ContextDetector.ingestExternalUsage', () => {
  let detector: ContextDetector;

  beforeEach(async () => {
    await fs.mkdir(join(TEST_PROJECT, '.command-post', 'memory-snapshots'), { recursive: true });
    detector = new ContextDetector(TEST_PROJECT);
  });

  afterEach(async () => {
    await detector.stopAll();
    try {
      await fs.rm(TEST_PROJECT, { recursive: true });
    } catch {
      // ignore
    }
  });

  it('should convert ContextUsageReading to ContextMetrics with source=daemon', async () => {
    const reading = createReading({
      contextTokens: 160000,
      percentage: 0.80,
      percentageDisplay: 80,
    });

    const metrics = await detector.ingestExternalUsage('worker-1', reading);

    expect(metrics.agentId).toBe('worker-1');
    expect(metrics.percentageOfMax).toBe(80);
    expect(metrics.source).toBe('daemon');
    expect(metrics.maxTokens).toBe(200000);
  });

  it('should set correct zone based on percentage', async () => {
    // Green zone (< 50%)
    const greenReading = createReading({ percentage: 0.30, percentageDisplay: 30 });
    const green = await detector.ingestExternalUsage('a1', greenReading);
    expect(green.zone).toBe('green');

    // Yellow zone (60-70%)
    const yellowReading = createReading({ percentage: 0.65, percentageDisplay: 65 });
    const yellow = await detector.ingestExternalUsage('a2', yellowReading);
    expect(yellow.zone).toBe('yellow');

    // Red zone (>= 70%)
    const redReading = createReading({ percentage: 0.85, percentageDisplay: 85 });
    const red = await detector.ingestExternalUsage('a3', redReading);
    expect(red.zone).toBe('red');
  });

  it('should set isWarning for 60-70% range', async () => {
    const reading = createReading({ percentage: 0.65, percentageDisplay: 65 });
    const metrics = await detector.ingestExternalUsage('worker-1', reading);
    expect(metrics.isWarning).toBe(true);
    expect(metrics.isCritical).toBe(false);
  });

  it('should set isCritical for >= 70%', async () => {
    const reading = createReading({ percentage: 0.85, percentageDisplay: 85 });
    const metrics = await detector.ingestExternalUsage('worker-1', reading);
    expect(metrics.isWarning).toBe(false);
    expect(metrics.isCritical).toBe(true);
  });

  it('should create a snapshot with real token data', async () => {
    const { createSnapshot } = await import('../../src/lifecycle/memory-snapshot.js');
    const reading = createReading();

    await detector.ingestExternalUsage('worker-1', reading);

    expect(createSnapshot).toHaveBeenCalledWith(
      TEST_PROJECT,
      'worker-1',
      expect.objectContaining({
        contextUsage: expect.objectContaining({
          percentageOfMax: 70, // 0.70 * 100
          maxTokens: 200000,
        }),
      }),
    );
  });

  it('should preserve raw usage data in metrics', async () => {
    const reading = createReading();
    const metrics = await detector.ingestExternalUsage('worker-1', reading);

    expect(metrics.raw).toEqual({
      input_tokens: 100000,
      output_tokens: 2000,
      cache_creation_input_tokens: 20000,
      cache_read_input_tokens: 20000,
    });
  });

  it('should fire context_usage_critical event for critical readings', async () => {
    const { logLifecycleEvent } = await import('../../src/utils/lifecycle-logger.js');
    const reading = createReading({ percentage: 0.85, percentageDisplay: 85 });

    const eventsFired: string[] = [];
    detector.addEventListener('context_usage_critical', (type) => {
      eventsFired.push(type);
    });

    await detector.ingestExternalUsage('worker-1', reading);

    expect(eventsFired).toContain('context_usage_critical');
    expect(logLifecycleEvent).toHaveBeenCalledWith(
      TEST_PROJECT,
      'worker-1',
      'context_snapshot_created',
      expect.objectContaining({ source: 'daemon' }),
    );
  });

  it('should fire context_usage_warning event for warning readings', async () => {
    const reading = createReading({ percentage: 0.65, percentageDisplay: 65 });

    const eventsFired: string[] = [];
    detector.addEventListener('context_usage_warning', (type) => {
      eventsFired.push(type);
    });

    await detector.ingestExternalUsage('worker-1', reading);

    expect(eventsFired).toContain('context_usage_warning');
  });

  it('should calculate tokens correctly: prompt = input + cache_read', async () => {
    const reading = createReading({
      outputTokens: 3000,
      raw: {
        input_tokens: 50000,
        output_tokens: 3000,
        cache_creation_input_tokens: 10000,
        cache_read_input_tokens: 40000,
      },
    });

    const metrics = await detector.ingestExternalUsage('worker-1', reading);

    // prompt = input_tokens + cache_read_input_tokens = 50000 + 40000
    expect(metrics.tokens.prompt).toBe(90000);
    expect(metrics.tokens.completion).toBe(3000);
  });
});

// ─── ContextMetrics Source Field Tests ────────────────────────────────────

describe('ContextMetrics source field backward compatibility', () => {
  it('should allow metrics without source field (backward compat)', () => {
    const metrics: ContextMetrics = {
      agentId: 'test',
      tokens: { prompt: 100, completion: 50, total: 150 },
      percentageOfMax: 50,
      maxTokens: 200000,
      zone: 'yellow',
      trend: 'stable',
      isWarning: true,
      isCritical: false,
      timestamp: new Date().toISOString(),
      // No source field — should be valid
    };

    expect(metrics.source).toBeUndefined();
  });

  it('should allow metrics with source=daemon', () => {
    const metrics: ContextMetrics = {
      agentId: 'test',
      tokens: { prompt: 100, completion: 50, total: 150 },
      percentageOfMax: 50,
      maxTokens: 200000,
      zone: 'yellow',
      trend: 'stable',
      isWarning: true,
      isCritical: false,
      timestamp: new Date().toISOString(),
      source: 'daemon',
      raw: {
        input_tokens: 80,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 10,
      },
    };

    expect(metrics.source).toBe('daemon');
    expect(metrics.raw).toBeDefined();
  });
});
