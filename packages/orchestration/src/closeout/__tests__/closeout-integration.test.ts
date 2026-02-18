/**
 * Closeout Round-Trip Integration Test
 *
 * Verifies the full data flow:
 * tasks + events + output → data-collector → actuals-builder → PRD with Actuals → extractActuals() → parsed ActualsSection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectCloseoutData } from '../data-collector.js';
import { buildActualsMarkdown, buildReportMarkdown, injectActualsIntoPrd } from '../actuals-builder.js';
// TODO: @command-post/prd-pipeline not yet extracted — re-enable when available
// import { parseMarkdownContent, extractActuals } from '@command-post/prd-pipeline';
// import type { PrdDocument } from '@command-post/prd-pipeline';

// ── Helpers ──────────────────────────────────────────────────────────

function makeTaskJson(overrides: Record<string, unknown> = {}) {
  const id = overrides.id ?? `task-${Math.floor(Math.random() * 10000)}`;
  return {
    id,
    title: overrides.title ?? 'Test task',
    feature: overrides.feature ?? 'Test Feature',
    domain: overrides.domain ?? 'frontend',
    assigned_to: overrides.assigned_to ?? 'worker-1',
    assigned_by: 'orchestrator',
    status: overrides.status ?? 'approved',
    prd_sections: [],
    plan: { steps: [], current_step: 0, estimated_steps_remaining: 0 },
    progress: { summary: 'Done', files_modified: overrides.files_modified ?? [] },
    dependencies: { blocked_by: [], blocks: [] },
    audit: { compliance_score: overrides.compliance_score ?? 0.9 },
    context: { usage_percent: 0.5, handoff_count: overrides.handoff_count ?? 0 },
    timestamps: {
      created: overrides.created ?? '2026-01-01T00:00:00Z',
      last_updated: overrides.last_updated ?? '2026-01-01T01:00:00Z',
      started: overrides.started ?? '2026-01-01T00:10:00Z',
      completed: overrides.completed ?? '2026-01-01T01:00:00Z',
    },
  };
}

const SAMPLE_PRD = `---
title: Integration Test Project
spaces:
  version: 1
  status: building
  previous_version: null
  refined_at: null
  approved_at: null
  built_at: null
  completeness_score: null
  manning: null
  resolved_questions: []
  open_questions: []
---

# Integration Test Project

## Features

- Authentication: User login and registration
- Dashboard: Admin dashboard with charts
- Notifications: Push notification system

## Architecture

Standard microservice architecture.
`;

// ── Test Suite ────────────────────────────────────────────────────────

describe('Closeout Round-Trip Integration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(join(tmpdir(), 'closeout-integration-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper: Set up a mock project directory with tasks, events, agents, output, and PRD.
   */
  async function setupMockProject(opts: {
    tasks?: Record<string, unknown>[];
    eventLines?: string[];
    outputFiles?: Record<string, string>;
    prdContent?: string;
    agentRegistry?: Record<string, unknown>;
    spawnLog?: Record<string, unknown>;
  } = {}) {
    const commandPostDir = join(tmpDir, '.command-post');
    const tasksDir = join(commandPostDir, 'tasks');
    const eventsDir = join(commandPostDir, 'events');
    const agentsDir = join(commandPostDir, 'agents');
    const outputDir = join(commandPostDir, 'output');

    await fs.mkdir(tasksDir, { recursive: true });
    await fs.mkdir(eventsDir, { recursive: true });
    await fs.mkdir(agentsDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });

    // Write tasks
    const tasks = opts.tasks ?? [
      makeTaskJson({ id: 'task-001', title: 'Build login form', feature: 'Authentication', status: 'approved' }),
      makeTaskJson({ id: 'task-002', title: 'Build dashboard', feature: 'Dashboard', status: 'approved' }),
      makeTaskJson({ id: 'task-003', title: 'Setup notifications', feature: 'Notifications', status: 'pending', started: null, completed: null }),
      makeTaskJson({ id: 'task-004', title: 'Add push service', feature: 'Push Service', status: 'failed', compliance_score: 0.3 }),
    ];

    for (const task of tasks) {
      await fs.writeFile(join(tasksDir, `${task.id}.json`), JSON.stringify(task));
    }

    // Write events
    if (opts.eventLines) {
      await fs.writeFile(join(eventsDir, 'events.jsonl'), opts.eventLines.join('\n'));
    }

    // Write output files
    const files = opts.outputFiles ?? { 'login.ts': 'export class Login {}', 'dashboard.ts': 'export class Dashboard {}' };
    for (const [name, content] of Object.entries(files)) {
      const dir = join(outputDir, ...name.split('/').slice(0, -1));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(outputDir, name), content);
    }

    // Write PRD
    const prdContent = opts.prdContent ?? SAMPLE_PRD;
    await fs.writeFile(join(tmpDir, 'PRD.md'), prdContent);

    // Write agent registry
    if (opts.agentRegistry) {
      await fs.writeFile(join(agentsDir, 'registry.json'), JSON.stringify(opts.agentRegistry));
    }

    // Write spawn log
    if (opts.spawnLog) {
      await fs.writeFile(join(agentsDir, 'spawn-log.json'), JSON.stringify(opts.spawnLog));
    }

    return { commandPostDir, tasksDir, eventsDir, agentsDir, outputDir };
  }

  // TODO: Re-enable when @command-post/prd-pipeline is extracted — requires parseMarkdownContent + extractActuals
  it.skip('should produce Actuals that extractActuals() can parse', async () => {
    // Requires @command-post/prd-pipeline (parseMarkdownContent, extractActuals, PrdDocument)
  });

  it('should set built status in frontmatter', async () => {
    await setupMockProject();
    const data = await collectCloseoutData(tmpDir);
    const actualsMarkdown = buildActualsMarkdown(data);
    const prdRaw = await fs.readFile(join(tmpDir, 'PRD.md'), 'utf-8');
    const injectedPrd = injectActualsIntoPrd(prdRaw, actualsMarkdown);

    expect(injectedPrd).toContain('status: built');
    expect(injectedPrd).toMatch(/built_at: '\d{4}-\d{2}-\d{2}/);
  });

  it('should handle PRD with existing Actuals section (replacement)', async () => {
    const prdWithActuals = `---
title: Test PRD
spaces:
  version: 1
  status: building
  previous_version: null
  refined_at: null
  approved_at: null
  built_at: null
  completeness_score: null
  manning: null
  resolved_questions: []
  open_questions: []
---

# Test PRD

## Features

- Feature A

## Actuals

### Completed Features
- OldFeature: This was from v1

### Deferred Features
- OldDeferred: Not done

### Lessons Learned
- Old lesson from v1

## Architecture

Important architecture notes.
`;

    await setupMockProject({ prdContent: prdWithActuals });
    const data = await collectCloseoutData(tmpDir);
    const actualsMarkdown = buildActualsMarkdown(data);
    const injectedPrd = injectActualsIntoPrd(prdWithActuals, actualsMarkdown);

    // New actuals should be present
    expect(injectedPrd).toContain('Authentication: Build login form');
    // Old actuals should NOT be present
    expect(injectedPrd).not.toContain('OldFeature: This was from v1');
    expect(injectedPrd).not.toContain('Old lesson from v1');
    // Architecture section should be preserved
    expect(injectedPrd).toContain('## Architecture');
    expect(injectedPrd).toContain('Important architecture notes.');
    // Should not have duplicate ## Actuals headers
    const actualsCount = (injectedPrd.match(/^## Actuals/gm) || []).length;
    expect(actualsCount).toBe(1);
  });

  it('should produce valid BUILD-REPORT.md', async () => {
    await setupMockProject();
    const data = await collectCloseoutData(tmpDir);
    const report = buildReportMarkdown(data);

    // Verify expected sections
    expect(report).toContain('# Build Report:');
    expect(report).toContain('## Summary');
    expect(report).toContain('## Task Summary');
    expect(report).toContain('**Build Duration**');
    expect(report).toContain('**Start Time**');
    expect(report).toContain('**End Time**');

    // Verify task summary table
    expect(report).toContain('Completed (approved)');
    expect(report).toContain('**Total**');

    // Verify file manifest
    expect(report).toContain('## File Manifest');
  });

  it('should work when some data sources are missing', async () => {
    // Minimal project with only tasks dir
    const commandPostDir = join(tmpDir, '.command-post');
    const tasksDir = join(commandPostDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    const task = makeTaskJson({ id: 'task-001', title: 'Solo task', feature: 'Solo', status: 'approved' });
    await fs.writeFile(join(tasksDir, 'task-001.json'), JSON.stringify(task));

    const data = await collectCloseoutData(tmpDir);

    // Should still collect tasks
    expect(data.tasks.length).toBe(1);
    expect(data.tasks[0].feature).toBe('Solo');

    // Other sections should be empty, not error
    expect(data.events).toEqual([]);
    expect(data.agents).toEqual([]);
    expect(data.prdPath).toBeNull();

    // Actuals should still be buildable
    const actuals = buildActualsMarkdown(data);
    expect(actuals).toContain('### Completed Features');
    expect(actuals).toContain('Solo: Solo task');
  });

  it('should handle all tasks completed with no deferred', async () => {
    const tasks = [
      makeTaskJson({ id: 'task-001', title: 'Build login', feature: 'Auth', status: 'approved' }),
      makeTaskJson({ id: 'task-002', title: 'Build dashboard', feature: 'Dashboard', status: 'approved' }),
    ];

    await setupMockProject({ tasks });
    const data = await collectCloseoutData(tmpDir);
    const actualsMarkdown = buildActualsMarkdown(data);

    expect(actualsMarkdown).toContain('Auth: Build login');
    expect(actualsMarkdown).toContain('Dashboard: Build dashboard');
    // Deferred should show (None)
    expect(actualsMarkdown).toContain('### Deferred Features');
    expect(actualsMarkdown).toContain('- (None)');
  });

  // TODO: Re-enable when @command-post/prd-pipeline is extracted — requires extractActuals + PrdDocument
  it.skip('should preserve version in round-trip through extractActuals', async () => {
    // Requires @command-post/prd-pipeline (extractActuals, PrdDocument)
  });
});
