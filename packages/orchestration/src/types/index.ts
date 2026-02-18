/**
 * TypeScript types for @command-post/orchestration.
 *
 * Covers memory snapshots, context metrics, handoff protocol,
 * degradation strategies, and template management.
 */

// ── Time Range ──────────────────────────────────────────────────────

/** Time range for querying snapshots and handoff history. */
export interface TimeRange {
  startTime?: string; // ISO 8601
  endTime?: string;   // ISO 8601
}

// ── Context Metrics ─────────────────────────────────────────────────

/** Context usage health zone. */
export type ContextZone = 'green' | 'yellow' | 'red';

/** Context usage trend direction. */
export type ContextTrend = 'increasing' | 'stable' | 'decreasing';

/** Current context metrics for an agent. */
export interface ContextMetrics {
  agentId: string;
  tokens: {
    prompt: number;
    completion: number;
    total: number;
  };
  percentageOfMax: number;
  maxTokens: number;
  zone: ContextZone;
  trend: ContextTrend;
  isWarning: boolean;
  isCritical: boolean;
  timestamp: string; // ISO 8601
  /** Source of the metrics data (optional, defaults to 'heuristic' for backward compat) */
  source?: 'daemon' | 'heuristic' | 'manual';
  /** Raw Claude API usage data when source is 'daemon' (optional) */
  raw?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
}

/** Projected context usage for workload simulation. */
export interface ContextProjection {
  agentId: string;
  currentPercentage: number;
  projectedPercentage: number;
  decisionsSimulated: number;
  minutesUntilCritical: number;
  confidence: number; // 0-1
  wouldTriggerHandoff: boolean;
}

// ── Memory Snapshot ─────────────────────────────────────────────────

/** Decision log entry within a snapshot. */
export interface DecisionLogEntry {
  timestamp: string; // ISO 8601
  taskId: string;
  decision: string;
  reasoning: string;
  confidence: number; // 0-1
  evidence?: string;
}

/** Handoff signal state within a snapshot. */
export interface HandoffSignal {
  active: boolean;
  targetAgent: string | null;
  reason: string | null;
  readyToHandoff: boolean;
}

/** Task status summary within a snapshot. */
export interface SnapshotTaskStatus {
  tasksCompleted: number;
  tasksInProgress: number;
  tasksFailed: number;
  averageCompletionTime: number; // seconds
}

/** Memory state within a snapshot. */
export interface SnapshotMemoryState {
  conversationHistory: number;
  retrievedDocuments: number;
  activeContextSize: number;
}

/** Model performance metrics within a snapshot. */
export interface ModelPerformance {
  [modelKey: string]: number;
}

/** Data supplied when creating a snapshot. */
export interface SnapshotData {
  contextUsage: {
    tokens: { prompt: number; completion: number; total: number };
    percentageOfMax: number;
    maxTokens: number;
    modelsUsed: string[];
  };
  decisionLog: DecisionLogEntry[];
  taskStatus: SnapshotTaskStatus;
  handoffSignal: HandoffSignal;
  memoryState: SnapshotMemoryState;
  modelPerformance: ModelPerformance;
}

/** Immutable memory snapshot for an agent. */
export interface OrchestrationSnapshot {
  snapshotId: string; // UUID
  agentId: string;
  timestamp: string; // ISO 8601
  contextUsage: SnapshotData['contextUsage'];
  decisionLog: DecisionLogEntry[];
  taskStatus: SnapshotTaskStatus;
  handoffSignal: HandoffSignal;
  memoryState: SnapshotMemoryState;
  modelPerformance: ModelPerformance;
}

// ── Degradation ─────────────────────────────────────────────────────

/** Strategy for graceful degradation. */
export type DegradationStrategy = 'none' | 'reduce' | 'compress' | 'offload';

/** Result of applying a degradation strategy. */
export interface DegradationResult {
  agentId: string;
  strategy: DegradationStrategy;
  applied: boolean;
  details: string;
  timestamp: string; // ISO 8601
}

// ── Handoff Protocol ────────────────────────────────────────────────

/** Handoff request sent to orchestrator inbox. */
export interface HandoffRequest {
  type: 'signal';
  event: 'context_handoff_request';
  sourceAgent: string;
  suggestedTarget: string | null;
  reason: string;
  contextSnapshot: OrchestrationSnapshot;
  tasksToTransfer: string[];
  timestamp: string; // ISO 8601
}

/** Status of an in-flight handoff. */
export type HandoffPhase = 'initiated' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

/** Current handoff status for an agent. */
export interface HandoffStatus {
  agentId: string;
  phase: HandoffPhase;
  sourceAgent: string;
  targetAgent: string | null;
  tasksToTransfer: string[];
  initiatedAt: string; // ISO 8601
  completedAt: string | null;
}

/** Result of initiating a handoff. */
export interface HandoffResult {
  success: boolean;
  sourceAgent: string;
  targetAgent: string | null;
  tasksTransferred: string[];
  snapshotId: string;
  error?: string;
}

/** Historical handoff event record. */
export interface HandoffEvent {
  eventType: 'handoff_initiated' | 'handoff_completed' | 'handoff_failed' | 'handoff_cancelled';
  sourceAgent: string;
  targetAgent: string | null;
  tasks: string[];
  snapshotId: string;
  reason: string;
  timestamp: string; // ISO 8601
  error?: string;
}

// ── Context Lifecycle Events ────────────────────────────────────────

/** Context lifecycle event types logged to events.jsonl. */
export type ContextLifecycleEventType =
  | 'context_snapshot_created'
  | 'context_usage_warning'
  | 'context_usage_critical'
  | 'degradation_strategy_applied'
  | 'handoff_initiated'
  | 'handoff_completed'
  | 'handoff_failed'
  | 'handoff_forced'
  | 'context_recovered'
  | 'human_escalation';

/** Callback type for context lifecycle event listeners. */
export type ContextEventCallback = (
  eventType: ContextLifecycleEventType,
  data: Record<string, unknown>,
) => void;

// ── Template ────────────────────────────────────────────────────────

/** Available agent role template names. */
export type AgentRole =
  | 'orchestrator'
  | 'po'
  | 'audit'
  | 'audit-agent'
  | 'worker'
  | 'context-monitor'
  | 'security'
  | 'tech-docs'
  | 'user-guide'
  | 'testing'
  | 'closeout-writer'
  | 'closeout-auditor'
  | 'prd-discovery-orchestrator'
  | 'prd-discovery-market-researcher'
  | 'prd-discovery-technical-analyst'
  | 'prd-discovery-ux-researcher'
  | 'prd-refiner'
  | 'ticket-refiner';

/** Result of validating a template. */
export interface TemplateValidationResult {
  valid: boolean;
  role: string;
  placeholders: string[];
  missingSections: string[];
  errors: string[];
}

// ── Context Monitor Config ──────────────────────────────────────────

/**
 * Configuration for the context monitoring strategy.
 * Used by OrchestrationManager.startDaemonMode().
 */
export interface ContextMonitorConfig {
  /** Monitoring approach: 'daemon' for transcript parsing, 'agent' for legacy heuristic */
  type: 'daemon' | 'agent';
  /** Context usage threshold that triggers snapshot protocol (0.0 - 1.0) */
  threshold: number;
  /** Context usage threshold that emits warning events (0.0 - 1.0) */
  warningThreshold: number;
  /** Polling interval in seconds */
  pollIntervalSeconds: number;
  /** Timeout for snapshot responses in seconds */
  snapshotTimeoutSeconds: number;
  /** Detection method: 'transcript' for JSONL parsing, 'statusline' for future use */
  detectionMethod: 'transcript' | 'statusline';
  /** Maximum snapshot quality retries before forcing handoff. Default: 3 */
  maxSnapshotRetries?: number;
}
