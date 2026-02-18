import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sessionName } from '../../src/tmux/session-manager.js';

// Mock the executor module to avoid real tmux calls in tests
vi.mock('../../src/tmux/executor.js', () => ({
  tmux: vi.fn(),
  isTmuxAvailable: vi.fn(),
}));

import { tmux, isTmuxAvailable } from '../../src/tmux/executor.js';
import {
  createSession,
  killSession,
  listSessions,
  sessionExists,
  killProjectSessions,
  setSessionAttribute,
  getSessionAttribute,
} from '../../src/tmux/session-manager.js';

const mockTmux = vi.mocked(tmux);
const mockIsTmuxAvailable = vi.mocked(isTmuxAvailable);

beforeEach(() => {
  vi.clearAllMocks();
  mockTmux.mockResolvedValue('');
});

describe('sessionName', () => {
  it('generates correct session name with default prefix', () => {
    expect(sessionName('myapp', 'orchestrator-1')).toBe('cp-myapp-orchestrator-1');
  });

  it('handles hyphens in project and agent names', () => {
    expect(sessionName('my-app', 'frontend-worker-1')).toBe(
      'cp-my-app-frontend-worker-1',
    );
  });

  it('supports custom prefix', () => {
    expect(sessionName('myapp', 'orchestrator-1', 'spaces')).toBe(
      'spaces-myapp-orchestrator-1',
    );
  });
});

describe('createSession', () => {
  it('creates a tmux session and sets attributes', async () => {
    await createSession('cp-myapp-orch', 'orch', 'frontend', 'orchestrator', 'myapp');

    expect(mockTmux).toHaveBeenCalledWith(['new-session', '-d', '-s', 'cp-myapp-orch']);
    expect(mockTmux).toHaveBeenCalledWith([
      'set-option', '-t', 'cp-myapp-orch', '@agent_id', 'orch',
    ]);
    expect(mockTmux).toHaveBeenCalledWith([
      'set-option', '-t', 'cp-myapp-orch', '@domain', 'frontend',
    ]);
    expect(mockTmux).toHaveBeenCalledWith([
      'set-option', '-t', 'cp-myapp-orch', '@role', 'orchestrator',
    ]);
    expect(mockTmux).toHaveBeenCalledWith([
      'set-option', '-t', 'cp-myapp-orch', '@projectName', 'myapp',
    ]);
  });
});

describe('setSessionAttribute', () => {
  it('calls tmux set-option with @ prefix', async () => {
    await setSessionAttribute('test-session', 'mykey', 'myvalue');
    expect(mockTmux).toHaveBeenCalledWith([
      'set-option', '-t', 'test-session', '@mykey', 'myvalue',
    ]);
  });
});

describe('getSessionAttribute', () => {
  it('returns attribute value from tmux', async () => {
    mockTmux.mockResolvedValueOnce('orchestrator');
    const value = await getSessionAttribute('test-session', 'role');
    expect(value).toBe('orchestrator');
    expect(mockTmux).toHaveBeenCalledWith([
      'show-option', '-t', 'test-session', '-v', '@role',
    ]);
  });

  it('returns empty string when attribute not set', async () => {
    mockTmux.mockRejectedValueOnce(new Error('unknown option'));
    const value = await getSessionAttribute('test-session', 'missing');
    expect(value).toBe('');
  });
});

describe('killSession', () => {
  it('kills a tmux session', async () => {
    await killSession('cp-myapp-orch');
    expect(mockTmux).toHaveBeenCalledWith(['kill-session', '-t', 'cp-myapp-orch']);
  });

  it('does not throw if session does not exist', async () => {
    mockTmux.mockRejectedValueOnce(new Error('session not found'));
    await expect(killSession('nonexistent')).resolves.not.toThrow();
  });
});

describe('sessionExists', () => {
  it('returns true when session exists', async () => {
    mockTmux.mockResolvedValueOnce('');
    expect(await sessionExists('cp-myapp-orch')).toBe(true);
    expect(mockTmux).toHaveBeenCalledWith(['has-session', '-t', 'cp-myapp-orch']);
  });

  it('returns false when session does not exist', async () => {
    mockTmux.mockRejectedValueOnce(new Error('session not found'));
    expect(await sessionExists('nonexistent')).toBe(false);
  });
});

describe('listSessions', () => {
  it('returns empty array when no sessions', async () => {
    mockTmux.mockResolvedValueOnce('');
    const sessions = await listSessions('myapp');
    expect(sessions).toEqual([]);
  });

  it('parses tmux session list output', async () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    mockTmux
      .mockResolvedValueOnce(`cp-myapp-orch|${timestamp}|0`) // list-sessions
      .mockResolvedValueOnce('orch')         // show-option agent_id
      .mockResolvedValueOnce('frontend')     // show-option domain
      .mockResolvedValueOnce('orchestrator'); // show-option role

    const sessions = await listSessions('myapp');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBe('cp-myapp-orch');
    expect(sessions[0].agentId).toBe('orch');
    expect(sessions[0].domain).toBe('frontend');
    expect(sessions[0].role).toBe('orchestrator');
    expect(sessions[0].active).toBe(false);
  });

  it('filters sessions by project name', async () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    mockTmux.mockResolvedValueOnce(
      `cp-myapp-orch|${timestamp}|0\ncp-other-orch|${timestamp}|0`,
    )
      .mockResolvedValueOnce('orch')
      .mockResolvedValueOnce('frontend')
      .mockResolvedValueOnce('orchestrator');

    const sessions = await listSessions('myapp');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBe('cp-myapp-orch');
  });
});

describe('killProjectSessions', () => {
  it('kills all sessions for a project', async () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    mockTmux
      .mockResolvedValueOnce(`cp-myapp-a|${timestamp}|0\ncp-myapp-b|${timestamp}|0`) // list
      .mockResolvedValueOnce('a').mockResolvedValueOnce('d1').mockResolvedValueOnce('worker') // attrs for a
      .mockResolvedValueOnce('b').mockResolvedValueOnce('d2').mockResolvedValueOnce('worker') // attrs for b
      .mockResolvedValue(''); // kill calls

    const killed = await killProjectSessions('myapp');
    expect(killed).toBe(2);
  });

  it('returns 0 when no sessions exist', async () => {
    mockTmux.mockResolvedValueOnce('');
    const killed = await killProjectSessions('myapp');
    expect(killed).toBe(0);
  });
});
