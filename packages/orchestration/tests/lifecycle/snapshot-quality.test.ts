import { describe, it, expect } from 'vitest';
import {
  validateSnapshotQuality,
  validateOrchestrationSnapshotQuality,
} from '../../src/lifecycle/snapshot-quality.js';
import type { PrdMemorySnapshot, TaskContext } from '../../src/lifecycle/snapshot-quality.js';
import type { OrchestrationSnapshot } from '../../src/types/index.js';

function makeValidPrdSnapshot(overrides?: Partial<PrdMemorySnapshot>): PrdMemorySnapshot {
  return {
    agent_id: 'worker-frontend-1',
    task_id: 'task-017',
    snapshot_timestamp: '2026-02-06T16:30:00Z',
    handoff_number: 0,
    context_at_snapshot: 0.83,
    state: {
      current_step: 'Implementing WebSocket connection',
      progress_summary: 'Board layout and drag-drop complete.',
      completion_estimate: '60% — two major steps remaining',
    },
    decisions: [
      {
        decision: 'Using @dnd-kit for drag-drop',
        rationale: 'Lighter bundle, better TypeScript support',
        impact: 'Affects import structure',
      },
    ],
    gotchas: ['Column width must account for scrollbar'],
    files_state: {
      completed: ['src/components/KanbanBoard.tsx'],
      in_progress: ['src/hooks/useWebSocket.ts'],
      not_started: ['src/components/TaskCard.tsx'],
    },
    next_steps: [
      'Connect WebSocket hook to board state',
      'Implement TaskCard component',
    ],
    dependencies_discovered: ['task-023 will need the same WebSocket connection'],
    ...overrides,
  };
}

function makeValidOrchestrationSnapshot(): OrchestrationSnapshot {
  return {
    snapshotId: '550e8400-e29b-41d4-a716-446655440000',
    agentId: 'worker-frontend-1',
    timestamp: '2026-02-06T16:30:00Z',
    contextUsage: {
      tokens: { prompt: 40000, completion: 10000, total: 50000 },
      percentageOfMax: 50,
      maxTokens: 100000,
      modelsUsed: ['claude-opus-4-6'],
    },
    decisionLog: [
      {
        timestamp: '2026-02-06T15:00:00Z',
        taskId: 'task-017',
        decision: 'Use @dnd-kit',
        reasoning: 'Lighter than alternatives',
        confidence: 0.9,
      },
    ],
    taskStatus: {
      tasksCompleted: 2,
      tasksInProgress: 1,
      tasksFailed: 0,
      averageCompletionTime: 3600,
    },
    handoffSignal: {
      active: false,
      targetAgent: null,
      reason: null,
      readyToHandoff: false,
    },
    memoryState: {
      conversationHistory: 120,
      retrievedDocuments: 5,
      activeContextSize: 45000,
    },
    modelPerformance: { opusTokensUsed: 50000 },
  };
}

describe('validateSnapshotQuality', () => {
  it('should pass a complete, high-quality snapshot', () => {
    const snapshot = makeValidPrdSnapshot();
    const result = validateSnapshotQuality(snapshot);

    expect(result.valid).toBe(true);
    expect(result.score).toBeGreaterThan(0.8);
    expect(result.passedChecks).toBeGreaterThan(result.totalChecks * 0.7);
  });

  it('should fail when required fields are missing', () => {
    const snapshot = makeValidPrdSnapshot({ agent_id: '' });
    const result = validateSnapshotQuality(snapshot);

    expect(result.valid).toBe(false);
    const requiredCheck = result.findings.find((f) => f.check === 'required_fields');
    expect(requiredCheck?.passed).toBe(false);
  });

  it('should fail when state section is incomplete', () => {
    const snapshot = makeValidPrdSnapshot({
      state: { current_step: '', progress_summary: '', completion_estimate: '' },
    });
    const result = validateSnapshotQuality(snapshot);

    expect(result.valid).toBe(false);
    const stateCheck = result.findings.find((f) => f.check === 'state_present');
    expect(stateCheck?.passed).toBe(false);
  });

  it('should fail when next_steps is empty', () => {
    const snapshot = makeValidPrdSnapshot({ next_steps: [] });
    const result = validateSnapshotQuality(snapshot);

    expect(result.valid).toBe(false);
    const nextStepsCheck = result.findings.find((f) => f.check === 'next_steps_non_empty');
    expect(nextStepsCheck?.passed).toBe(false);
  });

  it('should fail when handoff_number > 0 and no decisions', () => {
    const snapshot = makeValidPrdSnapshot({
      handoff_number: 1,
      decisions: [],
    });
    const result = validateSnapshotQuality(snapshot);

    expect(result.valid).toBe(false);
    const decisionsCheck = result.findings.find((f) => f.check === 'decisions_carried_forward');
    expect(decisionsCheck?.passed).toBe(false);
  });

  it('should pass when handoff_number is 0 and no decisions', () => {
    const snapshot = makeValidPrdSnapshot({
      handoff_number: 0,
      decisions: [],
    });
    const result = validateSnapshotQuality(snapshot);

    // Should not have the decisions_carried_forward check at all
    const decisionsCheck = result.findings.find((f) => f.check === 'decisions_carried_forward');
    expect(decisionsCheck).toBeUndefined();
  });

  it('should warn when decisions lack rationale', () => {
    const snapshot = makeValidPrdSnapshot({
      decisions: [{ decision: 'Use X', rationale: '', impact: 'something' }],
    });
    const result = validateSnapshotQuality(snapshot);

    const rationaleCheck = result.findings.find((f) => f.check === 'decisions_have_rationale');
    expect(rationaleCheck?.passed).toBe(false);
    expect(rationaleCheck?.severity).toBe('warning');
  });

  it('should warn when files_state is missing', () => {
    const snapshot = makeValidPrdSnapshot({ files_state: undefined });
    const result = validateSnapshotQuality(snapshot);

    const filesCheck = result.findings.find((f) => f.check === 'files_state_present');
    expect(filesCheck?.passed).toBe(false);
    expect(filesCheck?.severity).toBe('warning');
  });

  it('should cross-reference task files_modified', () => {
    const snapshot = makeValidPrdSnapshot();
    const taskContext: TaskContext = {
      filesModified: [
        'src/components/KanbanBoard.tsx',
        'src/hooks/useWebSocket.ts',
        'src/missing-file.ts',
      ],
    };
    const result = validateSnapshotQuality(snapshot, taskContext);

    const crossRef = result.findings.find((f) => f.check === 'files_cross_reference');
    expect(crossRef?.passed).toBe(false);
    expect(crossRef?.message).toContain('src/missing-file.ts');
  });

  it('should pass file cross-reference when all files present', () => {
    const snapshot = makeValidPrdSnapshot();
    const taskContext: TaskContext = {
      filesModified: [
        'src/components/KanbanBoard.tsx',
        'src/hooks/useWebSocket.ts',
      ],
    };
    const result = validateSnapshotQuality(snapshot, taskContext);

    const crossRef = result.findings.find((f) => f.check === 'files_cross_reference');
    expect(crossRef?.passed).toBe(true);
  });

  it('should give info-level finding for missing gotchas', () => {
    const snapshot = makeValidPrdSnapshot({ gotchas: [] });
    const result = validateSnapshotQuality(snapshot);

    const gotchasCheck = result.findings.find((f) => f.check === 'gotchas_present');
    expect(gotchasCheck?.passed).toBe(false);
    expect(gotchasCheck?.severity).toBe('info');
  });

  it('should calculate weighted score correctly', () => {
    // Perfect snapshot should have high score
    const perfectResult = validateSnapshotQuality(makeValidPrdSnapshot());
    expect(perfectResult.score).toBeGreaterThan(0.9);

    // Snapshot missing critical fields should have low score
    const badResult = validateSnapshotQuality(makeValidPrdSnapshot({
      agent_id: '',
      state: { current_step: '', progress_summary: '', completion_estimate: '' },
      next_steps: [],
    }));
    expect(badResult.score).toBeLessThan(0.5);
  });
});

describe('validateOrchestrationSnapshotQuality', () => {
  it('should pass a complete OrchestrationSnapshot', () => {
    const snapshot = makeValidOrchestrationSnapshot();
    const result = validateOrchestrationSnapshotQuality(snapshot);

    expect(result.valid).toBe(true);
    expect(result.score).toBeGreaterThan(0.8);
  });

  it('should fail when required fields are missing', () => {
    const snapshot = { ...makeValidOrchestrationSnapshot(), snapshotId: '' };
    const result = validateOrchestrationSnapshotQuality(snapshot);

    expect(result.valid).toBe(false);
  });

  it('should warn when decision log is empty', () => {
    const snapshot = { ...makeValidOrchestrationSnapshot(), decisionLog: [] };
    const result = validateOrchestrationSnapshotQuality(snapshot);

    const decisionCheck = result.findings.find((f) => f.check === 'decision_log');
    expect(decisionCheck?.passed).toBe(false);
    expect(decisionCheck?.severity).toBe('warning');
  });
});
