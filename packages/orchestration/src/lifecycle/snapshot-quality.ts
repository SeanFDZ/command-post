/**
 * Snapshot Quality Validator — validates memory snapshot quality per PRD Section 5.3.
 *
 * Checks that snapshots contain all required information for a replacement
 * agent to continue work without information loss:
 *   - References all files from the task's files_modified
 *   - Mentions the current step from the plan
 *   - Has non-empty next_steps
 *   - Carries forward decisions when handoff_number > 0
 *   - Includes gotchas and edge cases discovered
 */

import type { OrchestrationSnapshot } from '../types/index.js';

/** Quality finding severity. */
export type QualityFindingSeverity = 'error' | 'warning' | 'info';

/** A single quality check finding. */
export interface QualityFinding {
  check: string;
  severity: QualityFindingSeverity;
  message: string;
  passed: boolean;
}

/** Result of a snapshot quality validation. */
export interface SnapshotQualityResult {
  valid: boolean;
  score: number; // 0.0 - 1.0
  findings: QualityFinding[];
  passedChecks: number;
  totalChecks: number;
}

/** PRD-format memory snapshot (Section 5.2) — the human-oriented snapshot format. */
export interface PrdMemorySnapshot {
  agent_id: string;
  task_id: string;
  snapshot_timestamp: string;
  handoff_number: number;
  context_at_snapshot: number; // 0-1

  state: {
    current_step: string;
    progress_summary: string;
    completion_estimate: string;
  };

  decisions?: Array<{
    decision: string;
    rationale: string;
    impact: string;
  }>;

  gotchas?: string[];

  files_state?: {
    completed: string[];
    in_progress: string[];
    not_started: string[];
  };

  next_steps: string[];

  dependencies_discovered?: string[];
}

/** Task context used for cross-referencing quality checks. */
export interface TaskContext {
  filesModified?: string[];
  currentStep?: number;
  planSteps?: string[];
  handoffCount?: number;
}

/**
 * Validate a PRD-format memory snapshot for quality per PRD Section 5.3.
 *
 * Returns a quality score (0-1) and detailed findings.
 */
export function validateSnapshotQuality(
  snapshot: PrdMemorySnapshot,
  taskContext?: TaskContext,
): SnapshotQualityResult {
  const findings: QualityFinding[] = [];

  // Check 1: Required fields present
  findings.push({
    check: 'required_fields',
    severity: 'error',
    message: snapshot.agent_id && snapshot.task_id && snapshot.snapshot_timestamp
      ? 'All required identification fields present'
      : 'Missing required identification fields (agent_id, task_id, snapshot_timestamp)',
    passed: !!(snapshot.agent_id && snapshot.task_id && snapshot.snapshot_timestamp),
  });

  // Check 2: State section present with meaningful content
  findings.push({
    check: 'state_present',
    severity: 'error',
    message: snapshot.state?.current_step && snapshot.state?.progress_summary
      ? 'State section present with current step and progress summary'
      : 'Missing or incomplete state section (current_step, progress_summary required)',
    passed: !!(snapshot.state?.current_step && snapshot.state?.progress_summary),
  });

  // Check 3: Non-empty next_steps (PRD 5.3 requirement)
  const hasNextSteps = Array.isArray(snapshot.next_steps) && snapshot.next_steps.length > 0;
  findings.push({
    check: 'next_steps_non_empty',
    severity: 'error',
    message: hasNextSteps
      ? `${snapshot.next_steps.length} next step(s) defined`
      : 'next_steps is empty — replacement agent will not know what to do next',
    passed: hasNextSteps,
  });

  // Check 4: Decisions present if handoff_number > 0 (PRD 5.3 requirement)
  if (snapshot.handoff_number > 0 || (taskContext?.handoffCount && taskContext.handoffCount > 0)) {
    const hasDecisions = Array.isArray(snapshot.decisions) && snapshot.decisions.length > 0;
    findings.push({
      check: 'decisions_carried_forward',
      severity: 'error',
      message: hasDecisions
        ? `${snapshot.decisions!.length} decision(s) carried forward from previous handoff(s)`
        : 'No decisions carried forward — replacement agent will lose accumulated architectural context',
      passed: hasDecisions,
    });
  }

  // Check 5: Decisions include rationale (not just the decision)
  if (Array.isArray(snapshot.decisions) && snapshot.decisions.length > 0) {
    const allHaveRationale = snapshot.decisions.every(
      (d) => d.rationale && d.rationale.trim().length > 0,
    );
    findings.push({
      check: 'decisions_have_rationale',
      severity: 'warning',
      message: allHaveRationale
        ? 'All decisions include rationale'
        : 'Some decisions are missing rationale — replacement agent cannot understand the reasoning',
      passed: allHaveRationale,
    });
  }

  // Check 6: Files state present
  if (snapshot.files_state) {
    const totalFiles = (snapshot.files_state.completed?.length ?? 0) +
      (snapshot.files_state.in_progress?.length ?? 0) +
      (snapshot.files_state.not_started?.length ?? 0);
    findings.push({
      check: 'files_state_present',
      severity: 'warning',
      message: totalFiles > 0
        ? `File state tracked: ${snapshot.files_state.completed?.length ?? 0} complete, ${snapshot.files_state.in_progress?.length ?? 0} in progress, ${snapshot.files_state.not_started?.length ?? 0} not started`
        : 'File state sections are empty',
      passed: totalFiles > 0,
    });
  } else {
    findings.push({
      check: 'files_state_present',
      severity: 'warning',
      message: 'No files_state section — replacement agent will not know file completion status',
      passed: false,
    });
  }

  // Check 7: Cross-reference files_modified from task (PRD 5.3 requirement)
  if (taskContext?.filesModified && taskContext.filesModified.length > 0 && snapshot.files_state) {
    const allSnapshotFiles = [
      ...(snapshot.files_state.completed ?? []),
      ...(snapshot.files_state.in_progress ?? []),
      ...(snapshot.files_state.not_started ?? []),
    ];
    const missingFiles = taskContext.filesModified.filter(
      (f) => !allSnapshotFiles.some((sf) => sf.includes(f) || f.includes(sf)),
    );
    findings.push({
      check: 'files_cross_reference',
      severity: 'warning',
      message: missingFiles.length === 0
        ? 'All task files_modified are referenced in snapshot'
        : `${missingFiles.length} file(s) from task not referenced: ${missingFiles.join(', ')}`,
      passed: missingFiles.length === 0,
    });
  }

  // Check 8: Cross-reference current step from plan (PRD 5.3 requirement)
  if (taskContext?.planSteps && taskContext.currentStep !== undefined) {
    const currentPlanStep = taskContext.planSteps[taskContext.currentStep];
    if (currentPlanStep && snapshot.state?.current_step) {
      const mentionsCurrent = snapshot.state.current_step.toLowerCase()
        .includes(currentPlanStep.toLowerCase().substring(0, 20));
      findings.push({
        check: 'current_step_matches_plan',
        severity: 'info',
        message: mentionsCurrent
          ? 'Snapshot current_step aligns with task plan'
          : `Snapshot current_step may not match plan step ${taskContext.currentStep}: "${currentPlanStep}"`,
        passed: mentionsCurrent,
      });
    }
  }

  // Check 9: Gotchas present (hardest things to rediscover per PRD 5.3)
  const hasGotchas = Array.isArray(snapshot.gotchas) && snapshot.gotchas.length > 0;
  findings.push({
    check: 'gotchas_present',
    severity: 'info',
    message: hasGotchas
      ? `${snapshot.gotchas!.length} gotcha(s) documented`
      : 'No gotchas documented — edge cases and pitfalls may be lost',
    passed: hasGotchas,
  });

  // Check 10: Context usage recorded
  findings.push({
    check: 'context_usage_recorded',
    severity: 'info',
    message: typeof snapshot.context_at_snapshot === 'number'
      ? `Context usage at snapshot: ${(snapshot.context_at_snapshot * 100).toFixed(1)}%`
      : 'Context usage not recorded in snapshot',
    passed: typeof snapshot.context_at_snapshot === 'number' && snapshot.context_at_snapshot > 0,
  });

  // Check 11: Completion estimate present
  findings.push({
    check: 'completion_estimate',
    severity: 'info',
    message: snapshot.state?.completion_estimate
      ? `Completion estimate: ${snapshot.state.completion_estimate}`
      : 'No completion estimate — replacement agent will not know how much work remains',
    passed: !!(snapshot.state?.completion_estimate),
  });

  // Calculate score
  const passedChecks = findings.filter((f) => f.passed).length;
  const totalChecks = findings.length;

  // Weighted scoring: errors count 3x, warnings 2x, info 1x
  let weightedPassed = 0;
  let weightedTotal = 0;
  for (const f of findings) {
    const weight = f.severity === 'error' ? 3 : f.severity === 'warning' ? 2 : 1;
    weightedTotal += weight;
    if (f.passed) weightedPassed += weight;
  }
  const score = weightedTotal > 0 ? weightedPassed / weightedTotal : 0;

  // Valid if no error-level checks failed
  const valid = findings.filter((f) => f.severity === 'error' && !f.passed).length === 0;

  return {
    valid,
    score,
    findings,
    passedChecks,
    totalChecks,
  };
}

/**
 * Validate an OrchestrationSnapshot (machine-format) for basic quality.
 *
 * This is a lighter validation since OrchestrationSnapshot uses a different
 * structure than the PRD memory snapshot. It checks what it can.
 */
export function validateOrchestrationSnapshotQuality(
  snapshot: OrchestrationSnapshot,
): SnapshotQualityResult {
  const findings: QualityFinding[] = [];

  // Check 1: Required fields
  findings.push({
    check: 'required_fields',
    severity: 'error',
    message: snapshot.snapshotId && snapshot.agentId && snapshot.timestamp
      ? 'All required fields present'
      : 'Missing required identification fields',
    passed: !!(snapshot.snapshotId && snapshot.agentId && snapshot.timestamp),
  });

  // Check 2: Context usage data present
  findings.push({
    check: 'context_usage',
    severity: 'error',
    message: snapshot.contextUsage?.tokens && typeof snapshot.contextUsage.percentageOfMax === 'number'
      ? `Context usage: ${snapshot.contextUsage.percentageOfMax.toFixed(1)}%`
      : 'Missing context usage data',
    passed: !!(snapshot.contextUsage?.tokens && typeof snapshot.contextUsage.percentageOfMax === 'number'),
  });

  // Check 3: Decision log present
  const hasDecisions = Array.isArray(snapshot.decisionLog) && snapshot.decisionLog.length > 0;
  findings.push({
    check: 'decision_log',
    severity: 'warning',
    message: hasDecisions
      ? `${snapshot.decisionLog.length} decision(s) logged`
      : 'No decisions in decision log',
    passed: hasDecisions,
  });

  // Check 4: Task status present
  findings.push({
    check: 'task_status',
    severity: 'warning',
    message: snapshot.taskStatus
      ? `Tasks: ${snapshot.taskStatus.tasksCompleted} completed, ${snapshot.taskStatus.tasksInProgress} in progress`
      : 'Missing task status',
    passed: !!snapshot.taskStatus,
  });

  // Check 5: Handoff signal present
  findings.push({
    check: 'handoff_signal',
    severity: 'info',
    message: snapshot.handoffSignal
      ? `Handoff signal: active=${snapshot.handoffSignal.active}`
      : 'Missing handoff signal',
    passed: !!snapshot.handoffSignal,
  });

  const passedChecks = findings.filter((f) => f.passed).length;
  const totalChecks = findings.length;
  let weightedPassed = 0;
  let weightedTotal = 0;
  for (const f of findings) {
    const weight = f.severity === 'error' ? 3 : f.severity === 'warning' ? 2 : 1;
    weightedTotal += weight;
    if (f.passed) weightedPassed += weight;
  }
  const score = weightedTotal > 0 ? weightedPassed / weightedTotal : 0;
  const valid = findings.filter((f) => f.severity === 'error' && !f.passed).length === 0;

  return { valid, score, findings, passedChecks, totalChecks };
}
