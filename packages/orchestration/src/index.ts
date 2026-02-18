// @command-post/orchestration — barrel export

// ── Types ────────────────────────────────────────────────────────────
export type {
  SnapshotData,
  OrchestrationSnapshot,
  ContextMetrics,
  ContextProjection,
  ContextZone,
  ContextTrend,
  ContextEventCallback,
  ContextLifecycleEventType,
  DegradationStrategy,
  DegradationResult,
  HandoffRequest,
  HandoffStatus,
  HandoffResult,
  HandoffEvent,
  TimeRange,
  ContextMonitorConfig,
} from './types/index.js';

// ── Config ───────────────────────────────────────────────────────────
export {
  DEFAULT_THRESHOLDS,
  getContextThresholds,
} from './config/thresholds.js';
export type { ContextThresholds } from './config/thresholds.js';

// ── Context Daemon ───────────────────────────────────────────────────
export {
  getContextUsage,
  createDaemon,
  ContextMonitorDaemon,
} from './lifecycle/context-daemon.js';
export type {
  DaemonConfig,
  ContextUsageReading,
} from './lifecycle/context-daemon.js';

// ── Context Detector ─────────────────────────────────────────────────
export {
  getContextZone,
  computeTrend,
  detectContextUsage,
  predictHandoffTime,
  ContextDetector,
} from './lifecycle/context-detector.js';

// ── Memory Snapshots ─────────────────────────────────────────────────
export {
  createSnapshot,
  getLatestSnapshot,
  querySnapshots,
  cleanupOldSnapshots,
  MemorySnapshotManager,
} from './lifecycle/memory-snapshot.js';

// ── Degradation ─────────────────────────────────────────────────────
export {
  applyDegradation,
  selectDegradationStrategy,
} from './lifecycle/degradation.js';

// ── Snapshot Quality ────────────────────────────────────────────────
export {
  validateSnapshotQuality,
  validateOrchestrationSnapshotQuality,
} from './lifecycle/snapshot-quality.js';
export type {
  PrdMemorySnapshot,
  TaskContext,
  QualityFinding,
  SnapshotQualityResult,
} from './lifecycle/snapshot-quality.js';

// ── Handoff Validator ───────────────────────────────────────────────
export {
  validateHandoff,
  validateSnapshotCompleteness,
} from './lifecycle/handoff-validator.js';

// ── Agent Spawner ───────────────────────────────────────────────────
export {
  generateReplacementId,
  prepareReplacementInstructions,
  prepareReplacement,
  writeSpawnRequest,
} from './lifecycle/agent-spawner.js';
export type {
  SpawnRequest,
  SpawnResult,
  SpawnExecutor,
} from './lifecycle/agent-spawner.js';

// ── Handoff Manager ─────────────────────────────────────────────────
export { HandoffManager } from './lifecycle/handoff-manager.js';

// ── Replacement Coordinator ─────────────────────────────────────────
export { ReplacementCoordinator } from './lifecycle/replacement-coordinator.js';
export type {
  ReplacementCoordinatorConfig,
  ReplacementPhase,
  ReplacementFlowState,
} from './lifecycle/replacement-coordinator.js';

// ── Lifecycle Logger ─────────────────────────────────────────────────
export { logLifecycleEvent } from './utils/lifecycle-logger.js';

// ── Templates ───────────────────────────────────────────────────────
export { fillTemplate, extractPlaceholders } from './templates/filler.js';
export { loadTemplate, listTemplateRoles } from './templates/loader.js';
export { validateTemplate } from './templates/validator.js';

// ── Findings Registry ───────────────────────────────────────────────
export { FindingsRegistry } from './lifecycle/findings-registry.js';
export type {
  FindingSeverity,
  FindingStatus,
  DomainFinding,
  FindingResolvedCallback,
} from './lifecycle/findings-registry.js';

// ── Task Completion Monitor ─────────────────────────────────────────
export { TaskCompletionMonitor } from './lifecycle/task-completion-monitor.js';
export type { TaskCompletionMonitorConfig } from './lifecycle/task-completion-monitor.js';

// ── Closeout Manager ────────────────────────────────────────────────
export { CloseoutManager } from './lifecycle/closeout-manager.js';
export type {
  CloseoutState,
  CloseoutResult,
  SpawnFn,
} from './lifecycle/closeout-manager.js';

// ── Spawn Queue ─────────────────────────────────────────────────────
export { SpawnQueue } from './lifecycle/spawn-queue.js';

// ── Closeout (Data Collection & Reporting) ──────────────────────────
export {
  collectCloseoutData,
  findPrdPath,
  scanOutputDir,
} from './closeout/data-collector.js';
export type {
  TaskSummary,
  EventSummary,
  AgentSummary,
  OutputFileSummary,
  CloseoutData,
} from './closeout/data-collector.js';
export {
  buildActualsMarkdown,
  buildReportMarkdown,
  injectActualsIntoPrd,
} from './closeout/actuals-builder.js';
