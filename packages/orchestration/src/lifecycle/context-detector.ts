/**
 * Context Detector — monitors agent context usage, detects thresholds,
 * predicts handoffs, and emits lifecycle events.
 */

import { logLifecycleEvent } from '../utils/lifecycle-logger.js';
import { getLatestSnapshot, querySnapshots, createSnapshot } from './memory-snapshot.js';
import { selectDegradationStrategy, applyDegradation } from './degradation.js';
import type {
  ContextMetrics,
  ContextProjection,
  ContextZone,
  ContextTrend,
  ContextEventCallback,
  ContextLifecycleEventType,
  DegradationStrategy,
  SnapshotData,
} from '../types/index.js';
import type { ContextUsageReading } from './context-daemon.js';
import { DEFAULT_THRESHOLDS } from '../config/thresholds.js';

/** Default monitoring interval: 5 minutes in milliseconds. */
const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Average tokens consumed per decision (used for projections). */
const AVG_TOKENS_PER_DECISION = 500;

/** Determine the context health zone from usage percentage (0-100 scale). */
export function getContextZone(percentageOfMax: number): ContextZone {
  if (percentageOfMax >= DEFAULT_THRESHOLDS.criticalThreshold * 100) return 'red';
  if (percentageOfMax >= DEFAULT_THRESHOLDS.warningThreshold * 100) return 'yellow';
  return 'green';
}

/** Determine the context trend from recent snapshot data. */
export function computeTrend(percentages: number[]): ContextTrend {
  if (percentages.length < 2) return 'stable';
  const recent = percentages.slice(-3); // last 3 readings
  const diffs: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    diffs.push(recent[i] - recent[i - 1]);
  }
  const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  if (avgDiff > 2) return 'increasing';
  if (avgDiff < -2) return 'decreasing';
  return 'stable';
}

/**
 * Detect current context usage for an agent by reading its latest snapshot.
 */
export async function detectContextUsage(
  projectPath: string,
  agentId: string,
): Promise<ContextMetrics> {
  const latest = await getLatestSnapshot(projectPath, agentId);
  const timestamp = new Date().toISOString();

  if (!latest) {
    // No snapshot yet — report zero usage
    return {
      agentId,
      tokens: { prompt: 0, completion: 0, total: 0 },
      percentageOfMax: 0,
      maxTokens: 0,
      zone: 'green',
      trend: 'stable',
      isWarning: false,
      isCritical: false,
      timestamp,
    };
  }

  // Gather historical snapshots for trend calculation
  const history = await querySnapshots(projectPath, agentId);
  const percentages = history.map((s) => s.contextUsage.percentageOfMax);

  const pct = latest.contextUsage.percentageOfMax;
  const zone = getContextZone(pct);
  const trend = computeTrend(percentages);

  return {
    agentId,
    tokens: latest.contextUsage.tokens,
    percentageOfMax: pct,
    maxTokens: latest.contextUsage.maxTokens,
    zone,
    trend,
    isWarning: pct >= DEFAULT_THRESHOLDS.warningThreshold * 100 && pct < DEFAULT_THRESHOLDS.criticalThreshold * 100,
    isCritical: pct >= DEFAULT_THRESHOLDS.criticalThreshold * 100,
    timestamp,
  };
}

/**
 * Predict how long until an agent reaches 80% context usage.
 */
export async function predictHandoffTime(
  projectPath: string,
  agentId: string,
): Promise<{ minutesUntilCritical: number; confidence: number }> {
  const history = await querySnapshots(projectPath, agentId);

  if (history.length < 2) {
    return { minutesUntilCritical: Infinity, confidence: 0 };
  }

  const rawPoints = history.map((s) => ({
    time: new Date(s.timestamp!).getTime(),
    pct: s.contextUsage.percentageOfMax,
  }));

  const latestRaw = rawPoints[rawPoints.length - 1];
  if (latestRaw.pct >= 80) {
    return { minutesUntilCritical: 0, confidence: 1.0 };
  }

  // Normalize timestamps relative to the first point to avoid
  // floating-point precision loss when squaring large epoch values.
  const t0 = rawPoints[0].time;
  const points = rawPoints.map((p) => ({ time: p.time - t0, pct: p.pct }));

  // Simple linear regression: pct = slope * time + intercept
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.time, 0);
  const sumY = points.reduce((s, p) => s + p.pct, 0);
  const sumXY = points.reduce((s, p) => s + p.time * p.pct, 0);
  const sumXX = points.reduce((s, p) => s + p.time * p.time, 0);

  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) {
    return { minutesUntilCritical: Infinity, confidence: 0 };
  }

  const slope = (n * sumXY - sumX * sumY) / denom;

  if (slope <= 0) {
    // Usage is flat or decreasing — won't reach 80%
    return { minutesUntilCritical: Infinity, confidence: 0.7 };
  }

  // Project when pct will reach 80
  const latest = points[points.length - 1];
  const intercept = (sumY - slope * sumX) / n;
  const targetTime = (80 - intercept) / slope;
  const minutesUntilCritical = Math.max(
    0,
    (targetTime - latest.time) / 60_000,
  );

  // Confidence based on number of data points (more = higher confidence)
  const confidence = Math.min(1.0, 0.3 + n * 0.1);

  return { minutesUntilCritical, confidence };
}

/**
 * ContextDetector — monitors agents in the background, fires lifecycle events.
 */
export class ContextDetector {
  private monitors = new Map<string, ReturnType<typeof setInterval>>();
  private listeners = new Map<string, Set<ContextEventCallback>>();

  constructor(
    private readonly projectPath: string,
    private readonly orchestratorId: string = 'orchestrator',
    private readonly degradationStrategy?: DegradationStrategy,
  ) {}

  /**
   * Start monitoring an agent in the background.
   * Checks at the configured interval (default 5 minutes).
   */
  async monitorAgent(
    agentId: string,
    checkIntervalMs: number = DEFAULT_CHECK_INTERVAL_MS,
  ): Promise<void> {
    if (this.monitors.has(agentId)) return; // already monitoring

    // Run an initial check
    await this.checkAgent(agentId);

    // Set up recurring check
    const interval = setInterval(
      () => void this.checkAgent(agentId),
      checkIntervalMs,
    );
    // Prevent interval from keeping the process alive
    if (typeof interval === 'object' && 'unref' in interval) {
      interval.unref();
    }
    this.monitors.set(agentId, interval);
  }

  /** Stop monitoring an agent. */
  async stopMonitoring(agentId: string): Promise<void> {
    const interval = this.monitors.get(agentId);
    if (interval) {
      clearInterval(interval);
      this.monitors.delete(agentId);
    }
  }

  /** Check if an agent is currently being monitored. */
  isMonitoring(agentId: string): boolean {
    return this.monitors.has(agentId);
  }

  /** Get current context metrics for an agent. */
  async getUsageMetrics(agentId: string): Promise<ContextMetrics> {
    return detectContextUsage(this.projectPath, agentId);
  }

  /**
   * Simulate adding N decisions and project context usage.
   */
  async simulateWorkload(
    agentId: string,
    decisions: number,
  ): Promise<ContextProjection> {
    const metrics = await detectContextUsage(this.projectPath, agentId);
    const additionalTokens = decisions * AVG_TOKENS_PER_DECISION;
    const projectedTotal = metrics.tokens.total + additionalTokens;
    const maxTokens = metrics.maxTokens || 100_000;
    const projectedPct = Math.min(100, (projectedTotal / maxTokens) * 100);

    const prediction = await predictHandoffTime(this.projectPath, agentId);

    return {
      agentId,
      currentPercentage: metrics.percentageOfMax,
      projectedPercentage: projectedPct,
      decisionsSimulated: decisions,
      minutesUntilCritical: prediction.minutesUntilCritical,
      confidence: prediction.confidence,
      wouldTriggerHandoff: projectedPct >= 80,
    };
  }

  /** Register an event listener for context lifecycle events. */
  addEventListener(
    event: string,
    callback: ContextEventCallback,
  ): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(callback);
  }

  /** Remove an event listener. */
  removeEventListener(
    event: string,
    callback: ContextEventCallback,
  ): void {
    this.listeners.get(event)?.delete(callback);
  }

  /** Stop all monitoring. */
  async stopAll(): Promise<void> {
    for (const [agentId] of this.monitors) {
      await this.stopMonitoring(agentId);
    }
  }

  /**
   * Ingest external context usage data from the daemon.
   *
   * Converts the daemon's ContextUsageReading into a ContextMetrics object,
   * creates a snapshot, and fires appropriate events through the existing
   * event pipeline (context_usage_warning, context_usage_critical).
   *
   * @param agentId - The agent this reading belongs to
   * @param reading - Raw usage data from the daemon's getContextUsage()
   * @returns The ContextMetrics object created from the reading
   */
  async ingestExternalUsage(
    agentId: string,
    reading: ContextUsageReading,
  ): Promise<ContextMetrics> {
    // 1. Convert ContextUsageReading → ContextMetrics
    const zone = getContextZone(reading.percentage * 100);
    const metrics: ContextMetrics = {
      agentId,
      tokens: {
        prompt: reading.raw.input_tokens + reading.raw.cache_read_input_tokens,
        completion: reading.outputTokens,
        total: reading.contextTokens + reading.outputTokens,
      },
      percentageOfMax: reading.percentage * 100, // ContextMetrics uses 0-100 scale
      maxTokens: reading.maxTokens,
      zone,
      trend: 'stable', // Daemon provides point-in-time data; trend requires history
      isWarning: reading.percentage >= DEFAULT_THRESHOLDS.warningThreshold && reading.percentage < DEFAULT_THRESHOLDS.criticalThreshold,
      isCritical: reading.percentage >= DEFAULT_THRESHOLDS.criticalThreshold,
      timestamp: reading.timestamp,
      source: 'daemon',
      raw: reading.raw,
    };

    // 2. Create snapshot with real data
    const snapshotData: SnapshotData = {
      contextUsage: {
        tokens: metrics.tokens,
        percentageOfMax: metrics.percentageOfMax,
        maxTokens: metrics.maxTokens,
        modelsUsed: ['claude-sonnet-4-20250514'],
      },
      decisionLog: [],
      taskStatus: {
        tasksCompleted: 0,
        tasksInProgress: 0,
        tasksFailed: 0,
        averageCompletionTime: 0,
      },
      handoffSignal: {
        active: metrics.isCritical,
        targetAgent: null,
        reason: metrics.isCritical ? 'context_usage_high' : null,
        readyToHandoff: metrics.isCritical,
      },
      memoryState: {
        conversationHistory: 0,
        retrievedDocuments: 0,
        activeContextSize: reading.contextTokens,
      },
      modelPerformance: {},
    };

    await createSnapshot(this.projectPath, agentId, snapshotData);

    // 3. Fire events through the existing pipeline using existing private emit()
    if (metrics.isCritical) {
      this.emit('context_usage_critical', {
        agentId,
        percentageOfMax: metrics.percentageOfMax,
        zone: metrics.zone,
        source: 'daemon',
      });
    } else if (metrics.isWarning) {
      this.emit('context_usage_warning', {
        agentId,
        percentageOfMax: metrics.percentageOfMax,
        zone: metrics.zone,
        source: 'daemon',
      });
    }

    // 4. Log the event
    await logLifecycleEvent(this.projectPath, agentId, 'context_snapshot_created', {
      percentageOfMax: metrics.percentageOfMax,
      source: 'daemon',
      contextTokens: reading.contextTokens,
    });

    return metrics;
  }

  // ── Internal ────────────────────────────────────────────────────

  private async checkAgent(agentId: string): Promise<void> {
    const metrics = await detectContextUsage(this.projectPath, agentId);

    if (metrics.isCritical) {
      await logLifecycleEvent(
        this.projectPath,
        agentId,
        'context_usage_critical',
        { percentageOfMax: metrics.percentageOfMax, trend: metrics.trend },
      );
      this.emit('context_usage_critical', {
        agentId,
        percentageOfMax: metrics.percentageOfMax,
      });

      // Apply degradation
      const strategy = selectDegradationStrategy(
        metrics.percentageOfMax,
        this.degradationStrategy,
      );
      if (strategy !== 'none') {
        await applyDegradation(
          this.projectPath,
          agentId,
          this.orchestratorId,
          strategy,
        );
      }
    } else if (metrics.isWarning) {
      await logLifecycleEvent(
        this.projectPath,
        agentId,
        'context_usage_warning',
        { percentageOfMax: metrics.percentageOfMax, trend: metrics.trend },
      );
      this.emit('context_usage_warning', {
        agentId,
        percentageOfMax: metrics.percentageOfMax,
      });

      // Apply lighter degradation
      const strategy = selectDegradationStrategy(
        metrics.percentageOfMax,
        this.degradationStrategy,
      );
      if (strategy !== 'none') {
        await applyDegradation(
          this.projectPath,
          agentId,
          this.orchestratorId,
          strategy,
        );
      }
    } else if (metrics.zone === 'green' && metrics.percentageOfMax > 0) {
      // Check if agent recovered from a previous warning/critical state.
      // We need to look at the *previous* snapshot (not the latest) to see
      // if the agent was in warning/critical zone before this recovery.
      const history = await querySnapshots(this.projectPath, agentId);
      if (history.length >= 2) {
        const previous = history[history.length - 2];
        if (previous.contextUsage.percentageOfMax >= 50) {
          await logLifecycleEvent(
            this.projectPath,
            agentId,
            'context_recovered',
            { percentageOfMax: metrics.percentageOfMax, previousPercentage: previous.contextUsage.percentageOfMax },
          );
          this.emit('context_recovered', {
            agentId,
            percentageOfMax: metrics.percentageOfMax,
          });
        }
      }
    }
  }

  private emit(
    eventType: ContextLifecycleEventType,
    data: Record<string, unknown>,
  ): void {
    // Fire listeners for the specific event
    const specific = this.listeners.get(eventType);
    if (specific) {
      for (const cb of specific) cb(eventType, data);
    }
    // Fire wildcard listeners
    const wildcard = this.listeners.get('*');
    if (wildcard) {
      for (const cb of wildcard) cb(eventType, data);
    }
  }
}
