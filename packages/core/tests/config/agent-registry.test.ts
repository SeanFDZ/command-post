import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  loadAgentRegistry,
  saveAgentRegistry,
  registerAgent,
  updateAgentStatus,
  getActiveAgents,
  getAgentRegistryPath,
  computeProjectHash,
  discoverTranscriptPath,
} from '../../src/config/agent-registry.js';
import type { AgentRegistryEntry, AgentRegistry } from '../../src/config/agent-registry.js';

const TEST_PROJECT = '/tmp/test-registry-project';
const COMMAND_POST_ROOT = join(TEST_PROJECT, '.command-post');

function createTestEntry(overrides: Partial<AgentRegistryEntry> = {}): AgentRegistryEntry {
  return {
    tmux_session: 'cp-test',
    role: 'worker',
    domain: 'frontend',
    task_id: null,
    transcript_path: null,
    pid: 12345,
    status: 'active',
    launched_at: new Date().toISOString(),
    handoff_count: 0,
    ...overrides,
  };
}

beforeEach(async () => {
  await fs.mkdir(COMMAND_POST_ROOT, { recursive: true });
});

afterEach(async () => {
  try {
    await fs.rm(TEST_PROJECT, { recursive: true });
  } catch {
    // ignore
  }
});

// ─── Path Utilities ──────────────────────────────────────────────────────

describe('getAgentRegistryPath', () => {
  it('should return the correct path under .command-post', () => {
    const result = getAgentRegistryPath('/home/user/project');
    expect(result).toBe('/home/user/project/.command-post/agent-registry.json');
  });
});

describe('computeProjectHash', () => {
  it('should replace all slashes with dashes', () => {
    expect(computeProjectHash('/home/user/project')).toBe('-home-user-project');
  });

  it('should handle deeply nested paths', () => {
    expect(computeProjectHash('/a/b/c/d/e')).toBe('-a-b-c-d-e');
  });

  it('should handle root path', () => {
    expect(computeProjectHash('/')).toBe('-');
  });
});

// ─── Registry CRUD ───────────────────────────────────────────────────────

describe('loadAgentRegistry', () => {
  it('should return empty registry when file does not exist', async () => {
    const registry = await loadAgentRegistry(TEST_PROJECT);
    expect(registry).toEqual({ agents: {} });
  });

  it('should load and validate existing registry', async () => {
    const expected: AgentRegistry = {
      agents: {
        'worker-1': createTestEntry(),
      },
    };
    await fs.writeFile(
      join(COMMAND_POST_ROOT, 'agent-registry.json'),
      JSON.stringify(expected, null, 2),
    );

    const registry = await loadAgentRegistry(TEST_PROJECT);
    expect(registry.agents['worker-1']).toBeDefined();
    expect(registry.agents['worker-1'].role).toBe('worker');
  });

  it('should return empty registry for invalid JSON', async () => {
    await fs.writeFile(
      join(COMMAND_POST_ROOT, 'agent-registry.json'),
      'not valid json{{{',
    );

    const registry = await loadAgentRegistry(TEST_PROJECT);
    expect(registry).toEqual({ agents: {} });
  });
});

describe('saveAgentRegistry', () => {
  it('should write registry to disk', async () => {
    const registry: AgentRegistry = {
      agents: { 'worker-1': createTestEntry() },
    };

    await saveAgentRegistry(TEST_PROJECT, registry);

    const data = await fs.readFile(
      join(COMMAND_POST_ROOT, 'agent-registry.json'),
      'utf-8',
    );
    const parsed = JSON.parse(data);
    expect(parsed.agents['worker-1'].role).toBe('worker');
  });

  it('should use atomic write (no .tmp file left behind)', async () => {
    const registry: AgentRegistry = { agents: {} };
    await saveAgentRegistry(TEST_PROJECT, registry);

    // .tmp file should not exist after successful write
    const tmpPath = join(COMMAND_POST_ROOT, 'agent-registry.json.tmp');
    await expect(fs.access(tmpPath)).rejects.toThrow();
  });

  it('should create directory if it does not exist', async () => {
    // Remove the directory first
    await fs.rm(COMMAND_POST_ROOT, { recursive: true });

    const registry: AgentRegistry = { agents: {} };
    await saveAgentRegistry(TEST_PROJECT, registry);

    const data = await fs.readFile(
      join(COMMAND_POST_ROOT, 'agent-registry.json'),
      'utf-8',
    );
    expect(JSON.parse(data)).toEqual({ agents: {} });
  });
});

describe('registerAgent', () => {
  it('should add a new agent to the registry', async () => {
    const entry = createTestEntry({ tmux_session: 'cp-w1' });
    await registerAgent(TEST_PROJECT, 'worker-1', entry);

    const registry = await loadAgentRegistry(TEST_PROJECT);
    expect(registry.agents['worker-1']).toBeDefined();
    expect(registry.agents['worker-1'].tmux_session).toBe('cp-w1');
  });

  it('should be idempotent (overwrite existing entry)', async () => {
    const entry1 = createTestEntry({ role: 'worker' });
    const entry2 = createTestEntry({ role: 'specialist' });

    await registerAgent(TEST_PROJECT, 'agent-1', entry1);
    await registerAgent(TEST_PROJECT, 'agent-1', entry2);

    const registry = await loadAgentRegistry(TEST_PROJECT);
    expect(registry.agents['agent-1'].role).toBe('specialist');
  });

  it('should preserve other agents when adding new one', async () => {
    await registerAgent(TEST_PROJECT, 'agent-1', createTestEntry());
    await registerAgent(TEST_PROJECT, 'agent-2', createTestEntry({ role: 'orchestrator' }));

    const registry = await loadAgentRegistry(TEST_PROJECT);
    expect(Object.keys(registry.agents)).toHaveLength(2);
    expect(registry.agents['agent-1']).toBeDefined();
    expect(registry.agents['agent-2']).toBeDefined();
  });
});

describe('updateAgentStatus', () => {
  it('should update status of existing agent', async () => {
    await registerAgent(TEST_PROJECT, 'worker-1', createTestEntry());
    await updateAgentStatus(TEST_PROJECT, 'worker-1', 'dead');

    const registry = await loadAgentRegistry(TEST_PROJECT);
    expect(registry.agents['worker-1'].status).toBe('dead');
  });

  it('should throw for non-existent agent', async () => {
    await expect(
      updateAgentStatus(TEST_PROJECT, 'nonexistent', 'dead'),
    ).rejects.toThrow("Agent 'nonexistent' not found in registry");
  });
});

describe('getActiveAgents', () => {
  it('should return only active agents', async () => {
    await registerAgent(TEST_PROJECT, 'active-1', createTestEntry({ status: 'active' }));
    await registerAgent(TEST_PROJECT, 'dead-1', createTestEntry({ status: 'dead' }));
    await registerAgent(TEST_PROJECT, 'replaced-1', createTestEntry({ status: 'replaced' }));
    await registerAgent(TEST_PROJECT, 'active-2', createTestEntry({ status: 'active' }));

    const active = await getActiveAgents(TEST_PROJECT);
    expect(Object.keys(active)).toHaveLength(2);
    expect(active['active-1']).toBeDefined();
    expect(active['active-2']).toBeDefined();
    expect(active['dead-1']).toBeUndefined();
  });

  it('should return empty object when no agents are active', async () => {
    await registerAgent(TEST_PROJECT, 'dead-1', createTestEntry({ status: 'dead' }));

    const active = await getActiveAgents(TEST_PROJECT);
    expect(Object.keys(active)).toHaveLength(0);
  });

  it('should return empty object when registry is empty', async () => {
    const active = await getActiveAgents(TEST_PROJECT);
    expect(Object.keys(active)).toHaveLength(0);
  });
});

// ─── Transcript Discovery ────────────────────────────────────────────────

describe('discoverTranscriptPath', () => {
  it('should return null when transcript directory does not exist', async () => {
    const result = await discoverTranscriptPath('/nonexistent/path', 'agent-1');
    expect(result).toBeNull();
  });

  it('should return null when no .jsonl files exist', async () => {
    // Directory exists but is empty
    const result = await discoverTranscriptPath(TEST_PROJECT, 'agent-1');
    // This will look in ~/.claude/projects/<hash>/ which likely doesn't exist in test
    expect(result).toBeNull();
  });
});

// ─── Schema Validation ───────────────────────────────────────────────────

describe('schema validation', () => {
  it('should reject entry with invalid status', async () => {
    const badEntry = {
      ...createTestEntry(),
      status: 'invalid_status',
    } as unknown as AgentRegistryEntry;

    await expect(
      registerAgent(TEST_PROJECT, 'bad-agent', badEntry),
    ).rejects.toThrow();
  });

  it('should reject entry with negative handoff_count', async () => {
    const badEntry = {
      ...createTestEntry(),
      handoff_count: -1,
    } as unknown as AgentRegistryEntry;

    await expect(
      registerAgent(TEST_PROJECT, 'bad-agent', badEntry),
    ).rejects.toThrow();
  });
});
