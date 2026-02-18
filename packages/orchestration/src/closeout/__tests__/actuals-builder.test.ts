import { describe, it, expect } from 'vitest';
import { buildActualsMarkdown, buildReportMarkdown, injectActualsIntoPrd } from '../actuals-builder.js';
// TODO: @command-post/prd-pipeline not yet extracted — re-enable when available
// import { parseMarkdownContent } from '@command-post/prd-pipeline';
// import { extractActuals } from '@command-post/prd-pipeline';
// import type { PrdDocument } from '@command-post/prd-pipeline';
import type { CloseoutData } from '../data-collector.js';

// ── Test Fixtures ────────────────────────────────────────────────────

function makeCloseoutData(overrides?: Partial<CloseoutData>): CloseoutData {
  return {
    projectName: 'test-project',
    tasks: [
      {
        id: 'task-001',
        title: 'Build login form',
        feature: 'Authentication',
        domain: 'frontend',
        status: 'approved',
        assignedTo: 'worker-1',
        complianceScore: 0.92,
        startedAt: '2026-01-01T00:10:00Z',
        completedAt: '2026-01-01T01:00:00Z',
      },
      {
        id: 'task-002',
        title: 'Build registration form',
        feature: 'Registration',
        domain: 'frontend',
        status: 'approved',
        assignedTo: 'worker-2',
        complianceScore: 0.88,
        startedAt: '2026-01-01T00:20:00Z',
        completedAt: '2026-01-01T02:00:00Z',
      },
      {
        id: 'task-003',
        title: 'Add password reset',
        feature: 'Password Reset',
        domain: 'frontend',
        status: 'pending',
        assignedTo: null,
        complianceScore: 0,
        startedAt: null,
        completedAt: null,
      },
      {
        id: 'task-004',
        title: 'Add OAuth integration',
        feature: 'OAuth',
        domain: 'backend',
        status: 'failed',
        assignedTo: 'worker-3',
        complianceScore: 0.3,
        startedAt: '2026-01-01T00:30:00Z',
        completedAt: null,
      },
    ],
    events: [
      {
        eventId: 'evt-001',
        timestamp: '2026-01-01T00:00:00Z',
        eventType: 'agent_spawned',
        agentId: 'worker-1',
      },
    ],
    agents: [
      {
        id: 'worker-1',
        role: 'worker',
        domain: 'frontend',
        status: 'active',
        launchedAt: '2026-01-01T00:00:00Z',
        handoffCount: 1,
        spawnedBy: 'orchestrator',
        reason: 'Build auth',
      },
    ],
    outputFiles: [
      {
        path: '/out/login.ts',
        relativePath: 'login.ts',
        sizeBytes: 2048,
        lastModified: '2026-01-01T01:00:00Z',
      },
    ],
    prdPath: '/project/PRD.md',
    startTime: '2026-01-01T00:00:00Z',
    endTime: '2026-01-01T02:00:00Z',
    totalDuration: '2h 0m 0s',
    ...overrides,
  };
}

// ── buildActualsMarkdown Tests ───────────────────────────────────────

describe('buildActualsMarkdown', () => {
  it('should produce valid markdown with correct headings', () => {
    const data = makeCloseoutData();
    const md = buildActualsMarkdown(data);

    expect(md).toContain('## Actuals');
    expect(md).toContain('### Completed Features');
    expect(md).toContain('### Deferred Features');
    expect(md).toContain('### Lessons Learned');
  });

  it('should list approved tasks as completed features', () => {
    const data = makeCloseoutData();
    const md = buildActualsMarkdown(data);

    expect(md).toContain('- Authentication: Build login form');
    expect(md).toContain('- Registration: Build registration form');
  });

  it('should list pending and failed tasks as deferred features', () => {
    const data = makeCloseoutData();
    const md = buildActualsMarkdown(data);

    expect(md).toContain('- Password Reset: not started in this version');
    expect(md).toContain('- OAuth: failed during build');
  });

  it('should handle empty tasks gracefully', () => {
    const data = makeCloseoutData({ tasks: [] });
    const md = buildActualsMarkdown(data);

    expect(md).toContain('### Completed Features');
    expect(md).toContain('- (None yet)');
  });

  it('should derive lessons from build patterns', () => {
    const data = makeCloseoutData();
    const md = buildActualsMarkdown(data);

    // Should mention failed tasks
    expect(md).toContain('1 task(s) failed');
    // Should mention handoffs
    expect(md).toContain('1 context handoff(s)');
    // Should mention low compliance
    expect(md).toContain('compliance scores below 70%');
  });

  // TODO: Re-enable when @command-post/prd-pipeline is extracted and available
  // These tests require extractActuals and parseMarkdownContent from prd-pipeline
  it.skip('should round-trip through extractActuals', () => {
    // Requires @command-post/prd-pipeline
  });

  it.skip('should be discoverable by parseMarkdownContent as a section', () => {
    // Requires @command-post/prd-pipeline
  });
});

// ── buildReportMarkdown Tests ────────────────────────────────────────

describe('buildReportMarkdown', () => {
  it('should include project name and duration', () => {
    const data = makeCloseoutData();
    const md = buildReportMarkdown(data);

    expect(md).toContain('# Build Report: test-project');
    expect(md).toContain('**Build Duration**: 2h 0m 0s');
  });

  it('should include task summary table', () => {
    const data = makeCloseoutData();
    const md = buildReportMarkdown(data);

    expect(md).toContain('Completed (approved) | 2');
    expect(md).toContain('Failed | 1');
    expect(md).toContain('Deferred | 1');
    expect(md).toContain('**Total** | **4**');
  });

  it('should include agent table', () => {
    const data = makeCloseoutData();
    const md = buildReportMarkdown(data);

    expect(md).toContain('worker-1');
    expect(md).toContain('worker');
    expect(md).toContain('frontend');
  });

  it('should include file manifest', () => {
    const data = makeCloseoutData();
    const md = buildReportMarkdown(data);

    expect(md).toContain('login.ts');
    expect(md).toContain('2.0 KB');
  });

  it('should handle empty data gracefully', () => {
    const data = makeCloseoutData({
      tasks: [],
      events: [],
      agents: [],
      outputFiles: [],
    });
    const md = buildReportMarkdown(data);

    expect(md).toContain('# Build Report');
    expect(md).toContain('**Total** | **0**');
  });
});

// ── injectActualsIntoPrd Tests ───────────────────────────────────────

describe('injectActualsIntoPrd', () => {
  const samplePrd = `---
title: My Project
spaces:
  version: 1
  status: building
---

# My Project

## Features

- Feature A
- Feature B

## Architecture

Some architecture notes.`;

  it('should append Actuals section when none exists', () => {
    const data = makeCloseoutData();
    const actuals = buildActualsMarkdown(data);
    const result = injectActualsIntoPrd(samplePrd, actuals);

    expect(result).toContain('## Actuals');
    expect(result).toContain('### Completed Features');
    expect(result).toContain('## Architecture');
  });

  it('should set status to built in frontmatter', () => {
    const data = makeCloseoutData();
    const actuals = buildActualsMarkdown(data);
    const result = injectActualsIntoPrd(samplePrd, actuals);

    expect(result).toContain('status: built');
    expect(result).toMatch(/built_at: '\d{4}-\d{2}-\d{2}/);
  });

  it('should replace existing Actuals section', () => {
    const prdWithActuals = `---
title: My Project
spaces:
  version: 1
  status: building
---

# My Project

## Actuals

### Completed Features
- Old feature

### Deferred Features
- Old deferred

### Lessons Learned
- Old lesson

## Architecture

Some architecture notes.`;

    const data = makeCloseoutData();
    const newActuals = buildActualsMarkdown(data);
    const result = injectActualsIntoPrd(prdWithActuals, newActuals);

    // Should contain new features, not old ones
    expect(result).toContain('Authentication: Build login form');
    expect(result).not.toContain('Old feature');
    // Should preserve Architecture section
    expect(result).toContain('## Architecture');
    expect(result).toContain('Some architecture notes.');
  });

  it('should replace Actuals when it is the last section', () => {
    const prdWithActualsLast = `---
title: My Project
spaces:
  version: 1
  status: building
---

# My Project

## Actuals

### Completed Features
- Old feature`;

    const data = makeCloseoutData();
    const newActuals = buildActualsMarkdown(data);
    const result = injectActualsIntoPrd(prdWithActualsLast, newActuals);

    expect(result).toContain('Authentication: Build login form');
    expect(result).not.toContain('Old feature');
  });

  it('should create spaces frontmatter block if missing', () => {
    const simplePrd = `---
title: Simple PRD
---

# Simple PRD`;

    const data = makeCloseoutData();
    const actuals = buildActualsMarkdown(data);
    const result = injectActualsIntoPrd(simplePrd, actuals);

    expect(result).toContain('status: built');
    expect(result).toContain('## Actuals');
  });
});
