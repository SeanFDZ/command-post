import { describe, it, expect } from 'vitest';
import {
  generateReplacementId,
  prepareReplacementInstructions,
} from '../../src/lifecycle/agent-spawner.js';
import type { OrchestrationSnapshot } from '../../src/types/index.js';
import type { PrdMemorySnapshot } from '../../src/lifecycle/snapshot-quality.js';

describe('generateReplacementId', () => {
  it('should append -r{N} to the agent ID', () => {
    expect(generateReplacementId('worker-frontend-1', 1)).toBe('worker-frontend-1-r1');
    expect(generateReplacementId('worker-frontend-1', 2)).toBe('worker-frontend-1-r2');
  });

  it('should strip existing replacement suffix', () => {
    expect(generateReplacementId('worker-frontend-1-r1', 2)).toBe('worker-frontend-1-r2');
    expect(generateReplacementId('worker-frontend-1-r3', 4)).toBe('worker-frontend-1-r4');
  });

  it('should handle agent IDs without numbers', () => {
    expect(generateReplacementId('audit-backend', 1)).toBe('audit-backend-r1');
  });
});

describe('prepareReplacementInstructions', () => {
  const originalInstructions = '# Agent: worker-frontend-1\n## Role: worker\n\nDo the work.';

  it('should include the original instructions', () => {
    const result = prepareReplacementInstructions(originalInstructions, null, 1);
    expect(result).toContain('# Agent: worker-frontend-1');
    expect(result).toContain('Do the work.');
  });

  it('should add handoff context header', () => {
    const result = prepareReplacementInstructions(originalInstructions, null, 1);
    expect(result).toContain('## Memory Handoff Context (Handoff #1)');
    expect(result).toContain('replacement agent');
  });

  it('should show warning when no snapshot available', () => {
    const result = prepareReplacementInstructions(originalInstructions, null, 1);
    expect(result).toContain('No memory snapshot available');
  });

  it('should format PRD-format snapshot correctly', () => {
    const snapshot: PrdMemorySnapshot = {
      agent_id: 'worker-frontend-1',
      task_id: 'task-017',
      snapshot_timestamp: '2026-02-06T16:30:00Z',
      handoff_number: 1,
      context_at_snapshot: 0.83,
      state: {
        current_step: 'Implementing WebSocket connection',
        progress_summary: 'Board layout and drag-drop complete.',
        completion_estimate: '60%',
      },
      decisions: [
        { decision: 'Using @dnd-kit', rationale: 'Lighter bundle', impact: 'Import structure' },
      ],
      gotchas: ['Column width must account for scrollbar'],
      files_state: {
        completed: ['src/KanbanBoard.tsx'],
        in_progress: ['src/useWebSocket.ts'],
        not_started: ['src/TaskCard.tsx'],
      },
      next_steps: ['Connect WebSocket hook', 'Implement TaskCard'],
      dependencies_discovered: ['task-023 needs same WebSocket'],
    };

    const result = prepareReplacementInstructions(originalInstructions, snapshot, 1);

    expect(result).toContain('### Current State');
    expect(result).toContain('Implementing WebSocket connection');
    expect(result).toContain('83.0%');
    expect(result).toContain('### Decisions Made');
    expect(result).toContain('Using @dnd-kit');
    expect(result).toContain('Lighter bundle');
    expect(result).toContain('### Gotchas & Edge Cases');
    expect(result).toContain('scrollbar');
    expect(result).toContain('### File State');
    expect(result).toContain('src/KanbanBoard.tsx');
    expect(result).toContain('### Next Steps (Start Here)');
    expect(result).toContain('1. Connect WebSocket hook');
    expect(result).toContain('### Dependencies Discovered');
    expect(result).toContain('task-023');
  });

  it('should format OrchestrationSnapshot correctly', () => {
    const snapshot: OrchestrationSnapshot = {
      snapshotId: 'snap-001',
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
          reasoning: 'Better TS support',
          confidence: 0.9,
        },
      ],
      taskStatus: {
        tasksCompleted: 2,
        tasksInProgress: 1,
        tasksFailed: 0,
        averageCompletionTime: 3600,
      },
      handoffSignal: { active: true, targetAgent: null, reason: 'context_high', readyToHandoff: true },
      memoryState: { conversationHistory: 120, retrievedDocuments: 5, activeContextSize: 45000 },
      modelPerformance: {},
    };

    const result = prepareReplacementInstructions(originalInstructions, snapshot, 1);

    expect(result).toContain('### Context Usage at Handoff');
    expect(result).toContain('snap-001');
    expect(result).toContain('50.0%');
    expect(result).toContain('### Decision Log');
    expect(result).toContain('Use @dnd-kit');
    expect(result).toContain('### Task Status');
    expect(result).toContain('Completed: 2');
    expect(result).toContain('### Handoff Signal');
    expect(result).toContain('context_high');
  });
});
