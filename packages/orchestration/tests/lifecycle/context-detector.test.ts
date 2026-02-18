import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createSnapshot,
  getContextZone,
  computeTrend,
  detectContextUsage,
  predictHandoffTime,
  ContextDetector,
} from '../../src/index.js';
import type { SnapshotData, ContextEventCallback } from '../../src/index.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'cp-ctx-'));
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

describe('Context Zone', () => {
  it('returns green for <60%', () => {
    expect(getContextZone(0)).toBe('green');
    expect(getContextZone(30)).toBe('green');
    expect(getContextZone(59.9)).toBe('green');
  });

  it('returns yellow for 60-70%', () => {
    expect(getContextZone(60)).toBe('yellow');
    expect(getContextZone(65)).toBe('yellow');
    expect(getContextZone(69.9)).toBe('yellow');
  });

  it('returns red for >=70%', () => {
    expect(getContextZone(70)).toBe('red');
    expect(getContextZone(85)).toBe('red');
    expect(getContextZone(100)).toBe('red');
  });
});

describe('Trend Computation', () => {
  it('returns stable for < 2 data points', () => {
    expect(computeTrend([])).toBe('stable');
    expect(computeTrend([50])).toBe('stable');
  });

  it('detects increasing trend', () => {
    expect(computeTrend([30, 40, 55])).toBe('increasing');
  });

  it('detects decreasing trend', () => {
    expect(computeTrend([70, 60, 45])).toBe('decreasing');
  });

  it('returns stable for flat data', () => {
    expect(computeTrend([50, 50, 51])).toBe('stable');
  });
});

describe('detectContextUsage', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await makeTempDir();
    // Create .command-post/memory-snapshots directory manually
    await fs.mkdir(join(projectPath, '.command-post', 'memory-snapshots'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  it('returns zero metrics when no snapshot exists', async () => {
    const metrics = await detectContextUsage(projectPath, 'worker-1');
    expect(metrics.percentageOfMax).toBe(0);
    expect(metrics.zone).toBe('green');
    expect(metrics.isWarning).toBe(false);
    expect(metrics.isCritical).toBe(false);
  });

  it('returns correct metrics from latest snapshot', async () => {
    await createSnapshot(projectPath, 'worker-1', makeSnapshotData(65));
    const metrics = await detectContextUsage(projectPath, 'worker-1');
    expect(metrics.percentageOfMax).toBe(65);
    expect(metrics.zone).toBe('yellow');
    expect(metrics.isWarning).toBe(true);
    expect(metrics.isCritical).toBe(false);
  });

  it('detects critical state', async () => {
    await createSnapshot(projectPath, 'worker-1', makeSnapshotData(85));
    const metrics = await detectContextUsage(projectPath, 'worker-1');
    expect(metrics.isCritical).toBe(true);
    expect(metrics.zone).toBe('red');
  });
});

describe('predictHandoffTime', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await makeTempDir();
    await fs.mkdir(join(projectPath, '.command-post', 'memory-snapshots'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  it('returns Infinity with < 2 snapshots', async () => {
    const pred = await predictHandoffTime(projectPath, 'worker-1');
    expect(pred.minutesUntilCritical).toBe(Infinity);
    expect(pred.confidence).toBe(0);
  });

  it('returns 0 when already critical', async () => {
    await createSnapshot(projectPath, 'worker-1', makeSnapshotData(70));
    await new Promise((r) => setTimeout(r, 10));
    await createSnapshot(projectPath, 'worker-1', makeSnapshotData(85));

    const pred = await predictHandoffTime(projectPath, 'worker-1');
    expect(pred.minutesUntilCritical).toBe(0);
    expect(pred.confidence).toBe(1.0);
  });

  it('predicts future critical time for increasing usage', async () => {
    await createSnapshot(projectPath, 'worker-1', makeSnapshotData(30));
    await new Promise((r) => setTimeout(r, 50));
    await createSnapshot(projectPath, 'worker-1', makeSnapshotData(50));

    const pred = await predictHandoffTime(projectPath, 'worker-1');
    expect(pred.minutesUntilCritical).toBeGreaterThan(0);
    expect(pred.minutesUntilCritical).toBeLessThan(Infinity);
    expect(pred.confidence).toBeGreaterThan(0);
  });
});

describe('ContextDetector class', () => {
  let projectPath: string;
  let detector: ContextDetector;

  beforeEach(async () => {
    projectPath = await makeTempDir();
    await fs.mkdir(join(projectPath, '.command-post', 'memory-snapshots'), { recursive: true });
    detector = new ContextDetector(projectPath);
  });

  afterEach(async () => {
    await detector.stopAll();
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  it('monitors and stops monitoring an agent', async () => {
    await detector.monitorAgent('worker-1', 60_000);
    expect(detector.isMonitoring('worker-1')).toBe(true);

    await detector.stopMonitoring('worker-1');
    expect(detector.isMonitoring('worker-1')).toBe(false);
  });

  it('does not double-monitor an agent', async () => {
    await detector.monitorAgent('worker-1', 60_000);
    await detector.monitorAgent('worker-1', 60_000); // no-op
    expect(detector.isMonitoring('worker-1')).toBe(true);
  });

  it('gets usage metrics', async () => {
    await createSnapshot(projectPath, 'worker-1', makeSnapshotData(45));
    const metrics = await detector.getUsageMetrics('worker-1');
    expect(metrics.percentageOfMax).toBe(45);
    expect(metrics.zone).toBe('green');
  });

  it('simulates workload projection', async () => {
    await createSnapshot(projectPath, 'worker-1', makeSnapshotData(30));
    const projection = await detector.simulateWorkload('worker-1', 20);
    expect(projection.currentPercentage).toBe(30);
    expect(projection.projectedPercentage).toBeGreaterThan(30);
    expect(projection.decisionsSimulated).toBe(20);
  });

  it('fires events on critical context detection', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    detector.addEventListener('context_usage_critical', ((type: string, data: Record<string, unknown>) => {
      events.push({ type, data });
    }) as ContextEventCallback);

    await createSnapshot(projectPath, 'worker-1', makeSnapshotData(85));
    await detector.monitorAgent('worker-1', 60_000);

    // Give the initial check time to complete
    await new Promise((r) => setTimeout(r, 100));

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].data.agentId).toBe('worker-1');
  });

  it('fires wildcard events', async () => {
    const events: string[] = [];
    detector.addEventListener('*', ((type: string) => {
      events.push(type);
    }) as ContextEventCallback);

    await createSnapshot(projectPath, 'worker-1', makeSnapshotData(75));
    await detector.monitorAgent('worker-1', 60_000);
    await new Promise((r) => setTimeout(r, 100));

    expect(events.length).toBeGreaterThan(0);
  });

  it('removeEventListener works', () => {
    const cb: ContextEventCallback = () => {};
    detector.addEventListener('context_usage_warning', cb);
    detector.removeEventListener('context_usage_warning', cb);
    // No easy way to verify removal externally, but it should not throw
  });
});
