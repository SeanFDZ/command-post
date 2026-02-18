/**
 * E2E Build→Closeout→Iterate Simulation Test
 *
 * Simulates the full pipeline: completed build → closeout data collection →
 * actuals generation → PRD injection → iteration analysis of a new PRD.
 * Verifies the carry_forward/modify/create pipeline works without real agents.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectCloseoutData } from '../data-collector.js';
import { buildActualsMarkdown, buildReportMarkdown, injectActualsIntoPrd } from '../actuals-builder.js';
// TODO: @command-post/prd-pipeline not yet extracted — re-enable when available
// import { extractActuals } from '@command-post/prd-pipeline';
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
    progress: {
      summary: 'Done',
      files_modified: overrides.files_modified ?? [],
    },
    dependencies: { blocked_by: [], blocks: [] },
    audit: { compliance_score: overrides.compliance_score ?? 0.9 },
    context: { usage_percent: 0.5, handoff_count: overrides.handoff_count ?? 0 },
    timestamps: {
      created: '2026-01-01T00:00:00Z',
      last_updated: '2026-01-01T01:00:00Z',
      started: '2026-01-01T00:10:00Z',
      completed: overrides.completed ?? '2026-01-01T01:00:00Z',
    },
  };
}

// ── Test Suite ────────────────────────────────────────────────────────

describe('E2E Build→Closeout→Iterate Simulation', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(join(tmpdir(), 'e2e-simulation-'));
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('should simulate build completion, closeout, then iteration setup', async () => {
    // ─── Phase 1: Set up a "completed build" project ───────────────────
    const commandPostDir = join(projectDir, '.command-post');
    const tasksDir = join(commandPostDir, 'tasks');
    const outputDir = join(commandPostDir, 'output');
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });

    // Create task records representing the build
    const tasks = [
      makeTaskJson({
        id: 'task-001',
        title: 'Build login form with OAuth',
        feature: 'User Authentication',
        domain: 'auth',
        status: 'approved',
        files_modified: ['auth/login.ts'],
        compliance_score: 0.95,
      }),
      makeTaskJson({
        id: 'task-002',
        title: 'Build admin dashboard with charts',
        feature: 'Dashboard',
        domain: 'ui',
        status: 'approved',
        files_modified: ['ui/dashboard.tsx'],
        compliance_score: 0.88,
      }),
      makeTaskJson({
        id: 'task-003',
        title: 'Implement push notification system',
        feature: 'Notifications',
        domain: 'backend',
        status: 'pending',
        completed: null,
        compliance_score: 0,
      }),
      makeTaskJson({
        id: 'task-004',
        title: 'Add email templates',
        feature: 'Email System',
        domain: 'backend',
        status: 'failed',
        compliance_score: 0.2,
        handoff_count: 2,
      }),
    ];

    for (const task of tasks) {
      await fs.writeFile(join(tasksDir, `${task.id}.json`), JSON.stringify(task));
    }

    // Create output files
    await fs.mkdir(join(outputDir, 'auth'), { recursive: true });
    await fs.mkdir(join(outputDir, 'ui'), { recursive: true });
    await fs.writeFile(join(outputDir, 'auth', 'login.ts'), 'export class LoginService { /* OAuth logic */ }');
    await fs.writeFile(join(outputDir, 'ui', 'dashboard.tsx'), 'export function Dashboard() { return <div>Charts</div>; }');

    // Create PRD
    const originalPrd = `---
title: MyApp v1
spaces:
  version: 1
  status: building
  previous_version: null
  refined_at: null
  approved_at: null
  built_at: null
  completeness_score: 0.8
  manning: null
  resolved_questions: []
  open_questions: []
---

# MyApp v1

## Features

- User Authentication: OAuth login
- Dashboard: Admin dashboard with charts
- Notifications: Push notifications
- Email System: Email templates

## Architecture

Microservice architecture with event bus.
`;
    await fs.writeFile(join(projectDir, 'PRD.md'), originalPrd);

    // ─── Phase 2: Run closeout data collection ─────────────────────────
    const closeoutData = await collectCloseoutData(projectDir);
    expect(closeoutData.tasks).toHaveLength(4);
    expect(closeoutData.prdPath).toBe(join(projectDir, 'PRD.md'));

    // ─── Phase 3: Generate actuals and inject into PRD ─────────────────
    const actualsMarkdown = buildActualsMarkdown(closeoutData);
    expect(actualsMarkdown).toContain('### Completed Features');
    expect(actualsMarkdown).toContain('User Authentication');
    expect(actualsMarkdown).toContain('Dashboard');
    expect(actualsMarkdown).toContain('### Deferred Features');
    expect(actualsMarkdown).toContain('Notifications');
    expect(actualsMarkdown).toContain('Email System');

    const prdRaw = await fs.readFile(join(projectDir, 'PRD.md'), 'utf-8');
    const builtPrd = injectActualsIntoPrd(prdRaw, actualsMarkdown);

    // ─── Phase 4: Verify PRD now has Actuals section ───────────────────
    expect(builtPrd).toContain('## Actuals');
    expect(builtPrd).toContain('status: built');
    expect(builtPrd).toMatch(/built_at:/);

    // Write the built PRD back (as it would be after closeout)
    await fs.writeFile(join(projectDir, 'PRD.md'), builtPrd);

    // ─── Phase 5: Verify BUILD-REPORT.md generation ────────────────────
    const report = buildReportMarkdown(closeoutData);
    expect(report).toContain('# Build Report:');
    expect(report).toContain('Completed (approved) | 2');
    expect(report).toContain('Failed | 1');
    expect(report).toContain('Deferred | 1');
    expect(report).toContain('**Total** | **4**');

    // TODO: Re-enable Phases 6 & 7 when @command-post/prd-pipeline is extracted
    // Phase 6: Extract actuals for iteration analysis (requires extractActuals from prd-pipeline)
    // Phase 7: Verify iteration would work (requires extractActuals from prd-pipeline)
  });

  it('should handle a fully successful build with no deferred features', async () => {
    const commandPostDir = join(projectDir, '.command-post');
    const tasksDir = join(commandPostDir, 'tasks');
    const outputDir = join(commandPostDir, 'output');
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });

    const tasks = [
      makeTaskJson({ id: 'task-001', title: 'Build auth', feature: 'Auth', status: 'approved' }),
      makeTaskJson({ id: 'task-002', title: 'Build UI', feature: 'UI', status: 'approved' }),
    ];

    for (const task of tasks) {
      await fs.writeFile(join(tasksDir, `${task.id}.json`), JSON.stringify(task));
    }

    await fs.writeFile(join(outputDir, 'main.ts'), 'main()');

    const prd = `---
title: Perfect Build
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

# Perfect Build

## Features

- Auth
- UI
`;
    await fs.writeFile(join(projectDir, 'PRD.md'), prd);

    const closeoutData = await collectCloseoutData(projectDir);
    const actualsMarkdown = buildActualsMarkdown(closeoutData);
    const builtPrd = injectActualsIntoPrd(prd, actualsMarkdown);

    // All features completed
    expect(actualsMarkdown).toContain('Auth: Build auth');
    expect(actualsMarkdown).toContain('UI: Build UI');
    expect(actualsMarkdown).toContain('- (None)'); // No deferred

    // Frontmatter updated
    expect(builtPrd).toContain('status: built');
  });

  it('should handle build with only failed tasks', async () => {
    const commandPostDir = join(projectDir, '.command-post');
    const tasksDir = join(commandPostDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    const tasks = [
      makeTaskJson({ id: 'task-001', title: 'Failed attempt', feature: 'Feature A', status: 'failed', compliance_score: 0.1 }),
      makeTaskJson({ id: 'task-002', title: 'Blocked work', feature: 'Feature B', status: 'blocked' }),
    ];

    for (const task of tasks) {
      await fs.writeFile(join(tasksDir, `${task.id}.json`), JSON.stringify(task));
    }

    const closeoutData = await collectCloseoutData(projectDir);
    const actualsMarkdown = buildActualsMarkdown(closeoutData);

    // No completed features
    expect(actualsMarkdown).toContain('- (None yet)');
    // All tasks deferred
    expect(actualsMarkdown).toContain('Feature A: failed during build');
    expect(actualsMarkdown).toContain('Feature B: blocked by dependencies');
    // Should have lessons about failures
    expect(actualsMarkdown).toContain('task(s) failed');
    expect(actualsMarkdown).toContain('compliance scores below 70%');
  });
});
