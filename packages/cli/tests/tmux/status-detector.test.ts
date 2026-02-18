import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../../src/tmux/session-manager.js', () => ({
  sessionExists: vi.fn(),
}));

import { sessionExists } from '../../src/tmux/session-manager.js';
import { createStatusDetector } from '../../src/tmux/status-detector.js';
import type { EventQuery, TaskQuery } from '../../src/tmux/status-detector.js';

const mockSessionExists = vi.mocked(sessionExists);

// Create mock query functions
const mockQueryEvents = vi.fn() as unknown as EventQuery & ReturnType<typeof vi.fn>;
const mockListTasks = vi.fn() as unknown as TaskQuery & ReturnType<typeof vi.fn>;

// Create detector with injected mocks
const { getSessionStatus } = createStatusDetector(
  mockQueryEvents as EventQuery,
  mockListTasks as TaskQuery,
);

beforeEach(() => {
  vi.clearAllMocks();
  mockSessionExists.mockResolvedValue(true);
  (mockQueryEvents as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (mockListTasks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

describe('getSessionStatus', () => {
  it('returns "stopped" when session does not exist', async () => {
    mockSessionExists.mockResolvedValue(false);
    const status = await getSessionStatus('cp-myapp-orch', 'orch', '/tmp/project');
    expect(status).toBe('stopped');
  });

  it('returns "error" when recent error event exists', async () => {
    (mockQueryEvents as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        {
          event_id: 'e1',
          timestamp: new Date().toISOString(),
          event_type: 'error_occurred',
          agent_id: 'orch',
        },
      ]) // error events query
      .mockResolvedValueOnce([]); // recent events query

    const status = await getSessionStatus('cp-myapp-orch', 'orch', '/tmp/project');
    expect(status).toBe('error');
  });

  it('returns "waiting" when agent has pending review task', async () => {
    (mockQueryEvents as ReturnType<typeof vi.fn>).mockResolvedValue([]); // no errors
    (mockListTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'task-001',
        assigned_to: 'orch',
        status: 'ready_for_review',
        audit: { compliance_score: 0 },
      },
    ]);

    const status = await getSessionStatus('cp-myapp-orch', 'orch', '/tmp/project');
    expect(status).toBe('waiting');
  });

  it('returns "running" when recent events exist', async () => {
    (mockQueryEvents as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([]) // no errors
      .mockResolvedValueOnce([
        {
          event_id: 'e2',
          timestamp: new Date().toISOString(),
          event_type: 'task_status_changed',
          agent_id: 'orch',
        },
      ]); // recent activity

    const status = await getSessionStatus('cp-myapp-orch', 'orch', '/tmp/project');
    expect(status).toBe('running');
  });

  it('returns "idle" when session exists but no activity', async () => {
    const status = await getSessionStatus('cp-myapp-orch', 'orch', '/tmp/project');
    expect(status).toBe('idle');
  });

  it('returns "idle" when event queries fail', async () => {
    (mockQueryEvents as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('file not found'));
    (mockListTasks as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('file not found'));

    const status = await getSessionStatus('cp-myapp-orch', 'orch', '/tmp/project');
    expect(status).toBe('idle');
  });
});
