import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloseoutManager } from '../closeout-manager.js';
import type { SpawnFn } from '../closeout-manager.js';
import type { InboxMessage } from '@command-post/core';

// Mock all dependencies
vi.mock('../../closeout/data-collector.js', () => ({
  collectCloseoutData: vi.fn(),
  findPrdPath: vi.fn(),
}));

vi.mock('../../closeout/actuals-builder.js', () => ({
  buildActualsMarkdown: vi.fn(),
  buildReportMarkdown: vi.fn(),
  injectActualsIntoPrd: vi.fn(),
}));

vi.mock('@command-post/core', () => ({
  getProjectRoot: vi.fn(() => '/tmp/test-project/.command-post'),
}));

vi.mock('../../utils/lifecycle-logger.js', () => ({
  logLifecycleEvent: vi.fn(),
}));

vi.mock('node:fs', () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    access: vi.fn(),
  },
}));

// Import mocked modules
import { collectCloseoutData, findPrdPath } from '../../closeout/data-collector.js';
import { buildActualsMarkdown, buildReportMarkdown, injectActualsIntoPrd } from '../../closeout/actuals-builder.js';
import { promises as fs } from 'node:fs';

const mockCollectCloseoutData = vi.mocked(collectCloseoutData);
const mockFindPrdPath = vi.mocked(findPrdPath);
const mockBuildActualsMarkdown = vi.mocked(buildActualsMarkdown);
const mockBuildReportMarkdown = vi.mocked(buildReportMarkdown);
const mockInjectActualsIntoPrd = vi.mocked(injectActualsIntoPrd);
const mockFsReadFile = vi.mocked(fs.readFile);
const mockFsWriteFile = vi.mocked(fs.writeFile);
const mockFsMkdir = vi.mocked(fs.mkdir);
const mockFsAccess = vi.mocked(fs.access);

function createMockCloseoutData() {
  return {
    projectName: 'test-project',
    tasks: [
      {
        id: 'task-1',
        title: 'Test Task',
        feature: 'test',
        domain: 'frontend',
        status: 'approved',
        assignedTo: 'worker-1',
        complianceScore: 0.95,
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-02T00:00:00Z',
      },
    ],
    events: [],
    agents: [],
    outputFiles: [],
    prdPath: '/tmp/test-project/PRD.md',
    startTime: '2026-01-01T00:00:00Z',
    endTime: '2026-01-02T00:00:00Z',
    totalDuration: '1d 0h 0m',
  };
}

function createInboxMessage(type: string, body: Record<string, unknown>): InboxMessage {
  return {
    id: `msg-test-${Date.now()}`,
    from: 'closeout-writer-1',
    to: 'orchestrator-1',
    timestamp: new Date().toISOString(),
    type: type as InboxMessage['type'],
    priority: 'normal',
    body,
    read: false,
  };
}

describe('CloseoutManager', () => {
  let spawnFn: ReturnType<typeof vi.fn>;
  let manager: CloseoutManager;

  beforeEach(() => {
    vi.clearAllMocks();
    spawnFn = vi.fn().mockResolvedValue('closeout-writer-1');
    manager = new CloseoutManager(
      '/tmp/test-project',
      'orchestrator-1',
      spawnFn as unknown as SpawnFn,
      { writerTimeoutMs: 200, auditorTimeoutMs: 200 },
    );
  });

  describe('initial state', () => {
    it('should start in idle state', () => {
      expect(manager.getState()).toBe('idle');
    });
  });

  describe('happy path: full closeout lifecycle', () => {
    it('should complete the full cycle: collect → writer → auditor → complete', async () => {
      const mockData = createMockCloseoutData();
      mockCollectCloseoutData.mockResolvedValue(mockData);
      mockBuildActualsMarkdown.mockReturnValue('## Actuals\n### Completed Features\n- test');
      mockBuildReportMarkdown.mockReturnValue('# Build Report\n...');
      mockFindPrdPath.mockResolvedValue('/tmp/test-project/PRD.md');
      mockFsReadFile.mockResolvedValue('---\n---\n# PRD\n');
      mockInjectActualsIntoPrd.mockReturnValue('---\nspaces:\n  status: built\n---\n# PRD\n## Actuals\n');
      mockFsWriteFile.mockResolvedValue(undefined);
      mockFsMkdir.mockResolvedValue(undefined);

      // Configure spawnFn to return different IDs for writer and auditor
      spawnFn.mockResolvedValueOnce('closeout-writer-1').mockResolvedValueOnce('closeout-auditor-1');

      // Run closeout in background and resolve writer/auditor responses
      const resultPromise = manager.runCloseout();

      // Wait a tick for the writer spawn to occur
      await new Promise((r) => setTimeout(r, 50));

      // Simulate writer response
      manager.handleWriterResponse(createInboxMessage('closeout_writer_complete', {
        actuals_markdown: '## Actuals\n### Completed Features\n- test (writer)',
      }));

      // Wait for auditor spawn
      await new Promise((r) => setTimeout(r, 50));

      // Simulate auditor response
      manager.handleAuditorResponse(createInboxMessage('closeout_auditor_verdict', {
        verdict: 'approved',
      }));

      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.actualsWritten).toBe(true);
      expect(result.reportWritten).toBe(true);
      expect(result.auditorVerdict).toBe('approved');
      expect(manager.getState()).toBe('complete');

      // Verify spawn calls
      expect(spawnFn).toHaveBeenCalledTimes(2);
      expect(spawnFn).toHaveBeenCalledWith('closeout-writer', 'closeout', 'Build closeout documentation');
      expect(spawnFn).toHaveBeenCalledWith('closeout-auditor', 'closeout', 'Verify closeout documentation');
    });
  });

  describe('writer timeout', () => {
    it('should use programmatic fallback when writer times out', async () => {
      const mockData = createMockCloseoutData();
      mockCollectCloseoutData.mockResolvedValue(mockData);
      mockBuildActualsMarkdown.mockReturnValue('## Actuals\nprogrammatic fallback');
      mockBuildReportMarkdown.mockReturnValue('# Build Report\n...');
      mockFindPrdPath.mockResolvedValue('/tmp/test-project/PRD.md');
      mockFsReadFile.mockResolvedValue('---\n---\n# PRD\n');
      mockInjectActualsIntoPrd.mockReturnValue('updated prd');
      mockFsWriteFile.mockResolvedValue(undefined);
      mockFsMkdir.mockResolvedValue(undefined);

      spawnFn.mockResolvedValueOnce('closeout-writer-1').mockResolvedValueOnce('closeout-auditor-1');

      const resultPromise = manager.runCloseout();

      // Don't respond as writer — let it timeout (200ms)
      // Wait for auditor spawn (after writer timeout)
      await new Promise((r) => setTimeout(r, 300));

      // Simulate auditor response
      manager.handleAuditorResponse(createInboxMessage('closeout_auditor_verdict', {
        verdict: 'approved_with_notes',
      }));

      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.actualsWritten).toBe(true);
      expect(result.auditorVerdict).toBe('approved_with_notes');
      expect(result.errors).toContain('Writer agent timed out — using programmatic fallback');

      // Verify programmatic actuals were used (since writer timed out)
      expect(mockInjectActualsIntoPrd).toHaveBeenCalledWith(
        '---\n---\n# PRD\n',
        '## Actuals\nprogrammatic fallback',
      );
    });
  });

  describe('auditor timeout', () => {
    it('should accept writer output when auditor times out', async () => {
      const mockData = createMockCloseoutData();
      mockCollectCloseoutData.mockResolvedValue(mockData);
      mockBuildActualsMarkdown.mockReturnValue('## Actuals\nprogrammatic');
      mockBuildReportMarkdown.mockReturnValue('# Build Report');
      mockFindPrdPath.mockResolvedValue(null); // No PRD
      mockFsWriteFile.mockResolvedValue(undefined);
      mockFsMkdir.mockResolvedValue(undefined);

      spawnFn.mockResolvedValueOnce('closeout-writer-1').mockResolvedValueOnce('closeout-auditor-1');

      const resultPromise = manager.runCloseout();

      // Respond as writer
      await new Promise((r) => setTimeout(r, 50));
      manager.handleWriterResponse(createInboxMessage('closeout_writer_complete', {
        actuals_markdown: '## Actuals\nwriter output',
      }));

      // Don't respond as auditor — let it timeout (200ms)
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.auditorVerdict).toBe('timeout');
      expect(result.errors).toContain('Auditor agent timed out — accepting writer output as-is');
    });
  });

  describe('total failure', () => {
    it('should return success: false when data collection fails', async () => {
      mockCollectCloseoutData.mockRejectedValue(new Error('Filesystem exploded'));

      const result = await manager.runCloseout();

      expect(result.success).toBe(false);
      expect(result.actualsWritten).toBe(false);
      expect(result.reportWritten).toBe(false);
      expect(result.errors.some((e) => e.includes('Data collection failed'))).toBe(true);
      expect(manager.getState()).toBe('failed');
    });
  });

  describe('state machine transitions', () => {
    it('should transition through states correctly on happy path', async () => {
      const mockData = createMockCloseoutData();
      mockCollectCloseoutData.mockResolvedValue(mockData);
      mockBuildActualsMarkdown.mockReturnValue('## Actuals');
      mockBuildReportMarkdown.mockReturnValue('# Report');
      mockFindPrdPath.mockResolvedValue(null);
      mockFsWriteFile.mockResolvedValue(undefined);
      mockFsMkdir.mockResolvedValue(undefined);

      spawnFn.mockResolvedValueOnce('closeout-writer-1').mockResolvedValueOnce('closeout-auditor-1');

      const states: string[] = [];

      const resultPromise = manager.runCloseout();

      // Capture state at various points
      await new Promise((r) => setTimeout(r, 20));
      states.push(manager.getState()); // Should be 'writer_spawned'

      manager.handleWriterResponse(createInboxMessage('closeout_writer_complete', {
        actuals_markdown: 'test',
      }));

      await new Promise((r) => setTimeout(r, 20));
      states.push(manager.getState()); // Should be 'auditor_spawned'

      manager.handleAuditorResponse(createInboxMessage('closeout_auditor_verdict', {
        verdict: 'approved',
      }));

      await resultPromise;
      states.push(manager.getState()); // Should be 'complete'

      expect(states).toContain('writer_spawned');
      expect(states).toContain('auditor_spawned');
      expect(states[states.length - 1]).toBe('complete');
    });
  });

  describe('handleWriterResponse', () => {
    it('should resolve the writer promise when called during writer_spawned state', async () => {
      const mockData = createMockCloseoutData();
      mockCollectCloseoutData.mockResolvedValue(mockData);
      mockBuildActualsMarkdown.mockReturnValue('## Actuals');
      mockBuildReportMarkdown.mockReturnValue('# Report');
      mockFindPrdPath.mockResolvedValue(null);
      mockFsWriteFile.mockResolvedValue(undefined);
      mockFsMkdir.mockResolvedValue(undefined);

      spawnFn.mockResolvedValueOnce('closeout-writer-1').mockResolvedValueOnce('closeout-auditor-1');

      const resultPromise = manager.runCloseout();

      await new Promise((r) => setTimeout(r, 50));

      // Call with valid message
      const writerMsg = createInboxMessage('closeout_writer_complete', {
        actuals_markdown: '## Actuals\n### Completed Features\n- custom writer output',
      });
      manager.handleWriterResponse(writerMsg);

      // Also handle auditor quickly
      await new Promise((r) => setTimeout(r, 50));
      manager.handleAuditorResponse(createInboxMessage('closeout_auditor_verdict', {
        verdict: 'approved',
      }));

      const result = await resultPromise;
      expect(result.success).toBe(true);
    });
  });

  describe('handleAuditorResponse with revision_needed', () => {
    it('should apply corrections when auditor says revision_needed', async () => {
      const mockData = createMockCloseoutData();
      mockCollectCloseoutData.mockResolvedValue(mockData);
      mockBuildActualsMarkdown.mockReturnValue('## Actuals');
      mockBuildReportMarkdown.mockReturnValue('# Report');
      mockFindPrdPath.mockResolvedValue(null);
      mockFsWriteFile.mockResolvedValue(undefined);
      mockFsMkdir.mockResolvedValue(undefined);
      mockFsAccess.mockResolvedValue(undefined);

      spawnFn.mockResolvedValueOnce('closeout-writer-1').mockResolvedValueOnce('closeout-auditor-1');

      const resultPromise = manager.runCloseout();

      // Writer responds
      await new Promise((r) => setTimeout(r, 50));
      manager.handleWriterResponse(createInboxMessage('closeout_writer_complete', {
        actuals_markdown: 'original actuals',
      }));

      // Auditor responds with revision_needed and corrections
      await new Promise((r) => setTimeout(r, 50));
      manager.handleAuditorResponse(createInboxMessage('closeout_auditor_verdict', {
        verdict: 'revision_needed',
        corrections: '# Corrected Build Report\ncorrected content',
      }));

      const result = await resultPromise;

      expect(result.auditorVerdict).toBe('revision_needed');
      // Verify corrections were written
      expect(mockFsWriteFile).toHaveBeenCalledWith(
        '/tmp/test-project/.command-post/output/BUILD-REPORT.md',
        '# Corrected Build Report\ncorrected content',
        'utf-8',
      );
    });
  });

  describe('never throws', () => {
    it('should catch unexpected errors and return failed result', async () => {
      // Make collectCloseoutData return data but then cause an internal error
      // by making buildActualsMarkdown throw after collect succeeds
      const mockData = createMockCloseoutData();
      mockCollectCloseoutData.mockResolvedValue(mockData);
      mockBuildActualsMarkdown.mockImplementation(() => {
        throw new Error('Unexpected internal error');
      });
      mockBuildReportMarkdown.mockReturnValue('# Report');
      mockFindPrdPath.mockResolvedValue(null);
      mockFsWriteFile.mockResolvedValue(undefined);
      mockFsMkdir.mockResolvedValue(undefined);

      spawnFn.mockResolvedValueOnce('closeout-writer-1').mockResolvedValueOnce('closeout-auditor-1');

      const resultPromise = manager.runCloseout();

      // Handle writer/auditor quickly via timeout
      const result = await resultPromise;

      // Should NOT throw — should return a result
      expect(result).toBeDefined();
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('spawn failure', () => {
    it('should handle writer spawn failure gracefully', async () => {
      const mockData = createMockCloseoutData();
      mockCollectCloseoutData.mockResolvedValue(mockData);
      mockBuildActualsMarkdown.mockReturnValue('## Actuals');
      mockBuildReportMarkdown.mockReturnValue('# Report');
      mockFindPrdPath.mockResolvedValue(null);
      mockFsWriteFile.mockResolvedValue(undefined);
      mockFsMkdir.mockResolvedValue(undefined);

      // First call (writer) fails, second call (auditor) succeeds
      spawnFn.mockRejectedValueOnce(new Error('Spawn failed')).mockResolvedValueOnce('closeout-auditor-1');

      const resultPromise = manager.runCloseout();

      // Auditor times out since we don't respond
      const result = await resultPromise;

      expect(result.success).toBe(true); // Still succeeds overall
      expect(result.errors.some((e) => e.includes('Writer spawn/wait failed'))).toBe(true);
    });
  });
});
