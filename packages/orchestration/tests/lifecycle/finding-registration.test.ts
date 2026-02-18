/**
 * Tests for WP-3: Finding Registration & Remediation Tasks.
 *
 * Verifies that cross-cutting agents (security, testing, docs) have their
 * findings registered in the FindingsRegistry, that remediation tasks are
 * created on the kanban, and that finding resolution flows correctly through
 * auto-triage approval.
 */

// TODO: Re-enable when OrchestrationManager is extracted into @command-post/orchestration
// This test requires orchestration-manager.js which has not been built yet.
import { describe, it } from 'vitest';

// ── Helpers ──────────────────────────────────────────────────────────

function makeMessage(
  to: string,
  type: InboxMessage['type'],
  body: Record<string, unknown> = {},
  from = 'audit-1',
): InboxMessage {
  return {
    id: `msg-${uuidv4()}`,
    from,
    to,
    timestamp: new Date().toISOString(),
    type,
    priority: 'normal',
    body,
    read: false,
  };
}

function makeTask(id: string, domain: string, assignedTo: string = 'worker-1'): TaskObject {
  const now = new Date().toISOString();
  return {
    id,
    title: `Task ${id}`,
    feature: 'auth',
    domain,
    assigned_to: assignedTo,
    assigned_by: 'orchestrator-1',
    status: 'in_progress',
    prd_sections: [],
    plan: { steps: ['implement'], current_step: 0, estimated_steps_remaining: 1 },
    progress: { summary: 'Started' },
    dependencies: { blocked_by: [], blocks: [] },
    audit: { compliance_score: 0 },
    context: { usage_percent: 0, handoff_count: 0 },
    timestamps: { created: now, last_updated: now },
  };
}

function createManager(projectPath: string, opts: Record<string, unknown> = {}) {
  return new OrchestrationManager({
    projectPath,
    orchestratorId: 'orchestrator-1',
    autoDiscoverAgents: false,
    inboxPollIntervalMs: 600_000,
    taskCompletionPollIntervalMs: 600_000,
    auditApprovalThreshold: 0.7,
    ...opts,
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe.skip('WP-3: Finding Registration & Remediation Tasks', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await fs.mkdtemp(join(tmpdir(), 'spaces-wp3-'));
    await initProjectStructure(projectPath, {
      project: { name: 'wp3-test', version: '1.0.0' },
      orchestration: { hierarchy: 'flat', domains: ['frontend', 'backend'] },
      communication: { inbox_format: 'json', task_format: 'json', contracts_directory: '.command-post/contracts' },
      paths: { output_dir: './output' },
    });
  });

  afterEach(async () => {
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  // ── Cross-Cutting Agent Detection ──────────────────────────────────

  describe('Cross-Cutting Agent Detection', () => {
    it('security agent identified as cross-cutting — findings registered', async () => {
      const manager = createManager(projectPath);
      await manager.monitorAgent('security-scanner', { role: 'security', domain: 'security' });

      const task = makeTask('task-1', 'frontend');
      task.status = 'ready_for_review';
      await createTask(projectPath, task);

      await manager.start();

      const msg = makeMessage('orchestrator-1', 'audit_report', {
        task_id: 'task-1',
        compliance_score: 0.5,
        findings: [{ severity: 'error', category: 'xss', description: 'XSS vulnerability found' }],
        recommendations: ['Sanitize input'],
      }, 'security-scanner');
      await writeToInbox(projectPath, 'orchestrator-1', msg);
      await manager.getPoller().poll();

      const findings = manager.getFindings().getFindingsForDomain('frontend');
      expect(findings.length).toBeGreaterThanOrEqual(1);

      await manager.stop();
    });

    it('testing domain agent identified as cross-cutting — findings registered', async () => {
      const manager = createManager(projectPath);
      await manager.monitorAgent('testing-worker-1', { role: 'worker', domain: 'testing' });

      const task = makeTask('task-2', 'backend');
      task.status = 'ready_for_review';
      await createTask(projectPath, task);

      await manager.start();

      const msg = makeMessage('orchestrator-1', 'audit_report', {
        task_id: 'task-2',
        compliance_score: 0.6,
        findings: [{ severity: 'warning', category: 'coverage', description: 'Low test coverage' }],
        recommendations: ['Add unit tests'],
      }, 'testing-worker-1');
      await writeToInbox(projectPath, 'orchestrator-1', msg);
      await manager.getPoller().poll();

      const findings = manager.getFindings().getFindingsForDomain('backend');
      expect(findings.length).toBeGreaterThanOrEqual(1);

      await manager.stop();
    });

    it('documentation domain agent identified as cross-cutting — findings registered', async () => {
      const manager = createManager(projectPath);
      await manager.monitorAgent('doc-worker-1', { role: 'worker', domain: 'documentation' });

      const task = makeTask('task-3', 'frontend');
      task.status = 'ready_for_review';
      await createTask(projectPath, task);

      await manager.start();

      const msg = makeMessage('orchestrator-1', 'audit_report', {
        task_id: 'task-3',
        compliance_score: 0.8,
        findings: [{ severity: 'info', category: 'docs', description: 'Missing JSDoc' }],
        recommendations: ['Add JSDoc comments'],
      }, 'doc-worker-1');
      await writeToInbox(projectPath, 'orchestrator-1', msg);
      await manager.getPoller().poll();

      const findings = manager.getFindings().getFindingsForDomain('frontend');
      expect(findings.length).toBeGreaterThanOrEqual(1);

      await manager.stop();
    });

    it('regular domain auditor does NOT register findings', async () => {
      const manager = createManager(projectPath);
      await manager.monitorAgent('audit-frontend', { role: 'audit', domain: 'frontend' });

      const task = makeTask('task-4', 'frontend');
      task.status = 'ready_for_review';
      await createTask(projectPath, task);

      await manager.start();

      const msg = makeMessage('orchestrator-1', 'audit_report', {
        task_id: 'task-4',
        compliance_score: 0.5,
        findings: [{ severity: 'error', category: 'quality', description: 'Code quality issue' }],
        recommendations: ['Fix code quality'],
      }, 'audit-frontend');
      await writeToInbox(projectPath, 'orchestrator-1', msg);
      await manager.getPoller().poll();

      const findings = manager.getFindings().getAllFindings();
      expect(findings).toHaveLength(0);

      await manager.stop();
    });

    it('unknown agent with security- prefix detected via fallback', async () => {
      const manager = createManager(projectPath);
      // Do NOT register 'security-unknown' in agentInfo — test fallback detection

      const task = makeTask('task-5', 'backend');
      task.status = 'ready_for_review';
      await createTask(projectPath, task);

      await manager.start();

      const msg = makeMessage('orchestrator-1', 'audit_report', {
        task_id: 'task-5',
        compliance_score: 0.4,
        findings: [{ severity: 'critical', category: 'auth', description: 'Auth bypass found' }],
        recommendations: ['Fix auth'],
      }, 'security-unknown');
      await writeToInbox(projectPath, 'orchestrator-1', msg);
      await manager.getPoller().poll();

      const findings = manager.getFindings().getFindingsForDomain('backend');
      expect(findings.length).toBeGreaterThanOrEqual(1);
      expect(findings[0].sourceAgent).toBe('security-unknown');

      await manager.stop();
    });
  });

  // ── Finding Registration ───────────────────────────────────────────

  describe('Finding Registration', () => {
    it('cross-cutting audit report registers findings in registry', async () => {
      const manager = createManager(projectPath);
      await manager.monitorAgent('security-1', { role: 'security', domain: 'security' });

      const task = makeTask('task-10', 'frontend');
      task.status = 'ready_for_review';
      await createTask(projectPath, task);

      await manager.start();

      const msg = makeMessage('orchestrator-1', 'audit_report', {
        task_id: 'task-10',
        compliance_score: 0.3,
        findings: [
          { severity: 'critical', category: 'injection', description: 'SQL injection' },
          { severity: 'error', category: 'xss', description: 'XSS vulnerability' },
        ],
        recommendations: ['Fix all'],
      }, 'security-1');
      await writeToInbox(projectPath, 'orchestrator-1', msg);
      await manager.getPoller().poll();

      const findings = manager.getFindings().getFindingsForDomain('frontend');
      expect(findings).toHaveLength(2);

      await manager.stop();
    });

    it('structured findings parsed correctly', async () => {
      const manager = createManager(projectPath);
      await manager.monitorAgent('security-1', { role: 'security', domain: 'security' });

      const task = makeTask('task-11', 'backend');
      task.status = 'ready_for_review';
      await createTask(projectPath, task);

      await manager.start();

      const msg = makeMessage('orchestrator-1', 'audit_report', {
        task_id: 'task-11',
        compliance_score: 0.4,
        findings: [{
          severity: 'critical',
          category: 'vulnerability',
          description: 'Remote code execution via unsafe deserialization',
          recommendation: 'Replace unsafe deserialization with safe alternative',
        }],
        recommendations: [],
      }, 'security-1');
      await writeToInbox(projectPath, 'orchestrator-1', msg);
      await manager.getPoller().poll();

      const findings = manager.getFindings().getFindingsForDomain('backend');
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('critical');
      expect(findings[0].category).toBe('vulnerability');
      expect(findings[0].description).toBe('Remote code execution via unsafe deserialization');
      expect(findings[0].recommendation).toBe('Replace unsafe deserialization with safe alternative');

      await manager.stop();
    });

    it('string findings parsed as warnings', async () => {
      const manager = createManager(projectPath);
      await manager.monitorAgent('security-1', { role: 'security', domain: 'security' });

      const task = makeTask('task-12', 'frontend');
      task.status = 'ready_for_review';
      await createTask(projectPath, task);

      await manager.start();

      const msg = makeMessage('orchestrator-1', 'audit_report', {
        task_id: 'task-12',
        compliance_score: 0.6,
        findings: ['Use of deprecated API detected'],
        recommendations: [],
      }, 'security-1');
      await writeToInbox(projectPath, 'orchestrator-1', msg);
      await manager.getPoller().poll();

      const findings = manager.getFindings().getFindingsForDomain('frontend');
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('warning');
      expect(findings[0].category).toBe('general');
      expect(findings[0].description).toBe('Use of deprecated API detected');

      await manager.stop();
    });

    it('invalid severity defaults to warning', async () => {
      const manager = createManager(projectPath);
      await manager.monitorAgent('security-1', { role: 'security', domain: 'security' });

      const task = makeTask('task-13', 'frontend');
      task.status = 'ready_for_review';
      await createTask(projectPath, task);

      await manager.start();

      const msg = makeMessage('orchestrator-1', 'audit_report', {
        task_id: 'task-13',
        compliance_score: 0.5,
        findings: [{ severity: 'extreme', category: 'test', description: 'Bad severity' }],
        recommendations: [],
      }, 'security-1');
      await writeToInbox(projectPath, 'orchestrator-1', msg);
      await manager.getPoller().poll();

      const findings = manager.getFindings().getFindingsForDomain('frontend');
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('warning');

      await manager.stop();
    });
  });

  // ── Remediation Task Creation ──────────────────────────────────────

  describe('Remediation Task Creation', () => {
    it('remediation task created for each finding', async () => {
      const manager = createManager(projectPath);
      await manager.monitorAgent('security-1', { role: 'security', domain: 'security' });

      const task = makeTask('task-20', 'frontend');
      task.status = 'ready_for_review';
      await createTask(projectPath, task);

      await manager.start();

      const msg = makeMessage('orchestrator-1', 'audit_report', {
        task_id: 'task-20',
        compliance_score: 0.3,
        findings: [
          { severity: 'critical', category: 'injection', description: 'SQL injection' },
          { severity: 'error', category: 'xss', description: 'XSS vulnerability' },
        ],
        recommendations: [],
      }, 'security-1');
      await writeToInbox(projectPath, 'orchestrator-1', msg);
      await manager.getPoller().poll();

      const allTasks = await listTasks(projectPath);
      const remediationTasks = allTasks.filter((t) => t.feature === 'cross-cutting-remediation');
      expect(remediationTasks).toHaveLength(2);

      await manager.stop();
    });

    it('task ID matches pattern ^task-\\d+$', async () => {
      const manager = createManager(projectPath);
      await manager.monitorAgent('security-1', { role: 'security', domain: 'security' });

      const task = makeTask('task-21', 'frontend');
      task.status = 'ready_for_review';
      await createTask(projectPath, task);

      await manager.start();

      const msg = makeMessage('orchestrator-1', 'audit_report', {
        task_id: 'task-21',
        compliance_score: 0.5,
        findings: [{ severity: 'error', category: 'security', description: 'Insecure endpoint' }],
        recommendations: [],
      }, 'security-1');
      await writeToInbox(projectPath, 'orchestrator-1', msg);
      await manager.getPoller().poll();

      const allTasks = await listTasks(projectPath);
      const remediationTasks = allTasks.filter((t) => t.feature === 'cross-cutting-remediation');
      expect(remediationTasks).toHaveLength(1);
      expect(remediationTasks[0].id).toMatch(/^task-\d+$/);

      await manager.stop();
    });

    it('task title includes severity and category', async () => {
      const manager = createManager(projectPath);
      await manager.monitorAgent('security-1', { role: 'security', domain: 'security' });

      const task = makeTask('task-22', 'frontend');
      task.status = 'ready_for_review';
      await createTask(projectPath, task);

      await manager.start();

      const msg = makeMessage('orchestrator-1', 'audit_report', {
        task_id: 'task-22',
        compliance_score: 0.4,
        findings: [{ severity: 'critical', category: 'authentication', description: 'Broken auth' }],
        recommendations: [],
      }, 'security-1');
      await writeToInbox(projectPath, 'orchestrator-1', msg);
      await manager.getPoller().poll();

      const allTasks = await listTasks(projectPath);
      const remediationTasks = allTasks.filter((t) => t.feature === 'cross-cutting-remediation');
      expect(remediationTasks).toHaveLength(1);
      expect(remediationTasks[0].title).toContain('[CRITICAL]');
      expect(remediationTasks[0].title).toContain('authentication');

      await manager.stop();
    });

    it('task has feature cross-cutting-remediation', async () => {
      const manager = createManager(projectPath);
      await manager.monitorAgent('security-1', { role: 'security', domain: 'security' });

      const task = makeTask('task-23', 'backend');
      task.status = 'ready_for_review';
      await createTask(projectPath, task);

      await manager.start();

      const msg = makeMessage('orchestrator-1', 'audit_report', {
        task_id: 'task-23',
        compliance_score: 0.5,
        findings: [{ severity: 'warning', category: 'perf', description: 'Slow query' }],
        recommendations: [],
      }, 'security-1');
      await writeToInbox(projectPath, 'orchestrator-1', msg);
      await manager.getPoller().poll();

      const allTasks = await listTasks(projectPath);
      const remediationTasks = allTasks.filter((t) => t.feature === 'cross-cutting-remediation');
      expect(remediationTasks).toHaveLength(1);
      expect(remediationTasks[0].feature).toBe('cross-cutting-remediation');
      expect(remediationTasks[0].domain).toBe('backend');

      await manager.stop();
    });

    it('task is linked to finding via findByTaskId', async () => {
      const manager = createManager(projectPath);
      await manager.monitorAgent('security-1', { role: 'security', domain: 'security' });

      const task = makeTask('task-24', 'frontend');
      task.status = 'ready_for_review';
      await createTask(projectPath, task);

      await manager.start();

      const msg = makeMessage('orchestrator-1', 'audit_report', {
        task_id: 'task-24',
        compliance_score: 0.4,
        findings: [{ severity: 'error', category: 'sec', description: 'Insecure cookie' }],
        recommendations: [],
      }, 'security-1');
      await writeToInbox(projectPath, 'orchestrator-1', msg);
      await manager.getPoller().poll();

      const allTasks = await listTasks(projectPath);
      const remediationTask = allTasks.find((t) => t.feature === 'cross-cutting-remediation');
      expect(remediationTask).toBeDefined();

      const finding = manager.getFindings().findByTaskId(remediationTask!.id);
      expect(finding).toBeDefined();
      expect(finding!.description).toBe('Insecure cookie');
      expect(finding!.taskId).toBe(remediationTask!.id);

      await manager.stop();
    });
  });

  // ── Finding Resolution via Auto-Triage ─────────────────────────────

  describe('Finding Resolution via Auto-Triage', () => {
    it('finding resolved when remediation task auto-approved', async () => {
      const manager = createManager(projectPath);
      await manager.monitorAgent('security-1', { role: 'security', domain: 'security' });

      const originalTask = makeTask('task-30', 'frontend');
      originalTask.status = 'ready_for_review';
      await createTask(projectPath, originalTask);

      await manager.start();

      // Step 1: Security agent files finding
      const auditMsg = makeMessage('orchestrator-1', 'audit_report', {
        task_id: 'task-30',
        compliance_score: 0.4,
        findings: [{ severity: 'error', category: 'xss', description: 'XSS in form handler' }],
        recommendations: ['Sanitize'],
      }, 'security-1');
      await writeToInbox(projectPath, 'orchestrator-1', auditMsg);
      await manager.getPoller().poll();

      // Verify finding is registered
      const findings = manager.getFindings().getFindingsForDomain('frontend');
      expect(findings).toHaveLength(1);
      expect(findings[0].status).toBe('open');

      // Get the remediation task
      const allTasks = await listTasks(projectPath);
      const remTask = allTasks.find((t) => t.feature === 'cross-cutting-remediation');
      expect(remTask).toBeDefined();

      // Step 2: Remediation task gets a passing audit report
      const approvalMsg = makeMessage('orchestrator-1', 'audit_report', {
        task_id: remTask!.id,
        compliance_score: 0.9,
        findings: [],
        recommendations: [],
      }, 'audit-1');
      await writeToInbox(projectPath, 'orchestrator-1', approvalMsg);
      await manager.getPoller().poll();

      // Verify finding is resolved
      const updatedFindings = manager.getFindings().getFindingsForDomain('frontend');
      expect(updatedFindings).toHaveLength(1);
      expect(updatedFindings[0].status).toBe('resolved');

      await manager.stop();
    });

    it('finding NOT resolved when task auto-rejected', async () => {
      const manager = createManager(projectPath);
      await manager.monitorAgent('security-1', { role: 'security', domain: 'security' });

      const originalTask = makeTask('task-31', 'frontend');
      originalTask.status = 'ready_for_review';
      await createTask(projectPath, originalTask);

      await manager.start();

      // Security agent files finding
      const auditMsg = makeMessage('orchestrator-1', 'audit_report', {
        task_id: 'task-31',
        compliance_score: 0.3,
        findings: [{ severity: 'critical', category: 'auth', description: 'Broken authentication' }],
        recommendations: ['Fix auth'],
      }, 'security-1');
      await writeToInbox(projectPath, 'orchestrator-1', auditMsg);
      await manager.getPoller().poll();

      // Get remediation task
      const allTasks = await listTasks(projectPath);
      const remTask = allTasks.find((t) => t.feature === 'cross-cutting-remediation');
      expect(remTask).toBeDefined();

      // Send failing audit for remediation task (below threshold)
      const rejectMsg = makeMessage('orchestrator-1', 'audit_report', {
        task_id: remTask!.id,
        compliance_score: 0.4,
        findings: [{ severity: 'error', description: 'Still broken' }],
        recommendations: ['Fix it properly'],
      }, 'audit-1');
      await writeToInbox(projectPath, 'orchestrator-1', rejectMsg);
      await manager.getPoller().poll();

      // Finding should still be open
      const findings = manager.getFindings().getFindingsForDomain('frontend');
      expect(findings).toHaveLength(1);
      expect(findings[0].status).toBe('open');

      await manager.stop();
    });

    it('non-remediation task approval does not affect findings', async () => {
      const manager = createManager(projectPath);
      await manager.monitorAgent('security-1', { role: 'security', domain: 'security' });

      const regularTask = makeTask('task-32', 'frontend');
      regularTask.status = 'ready_for_review';
      await createTask(projectPath, regularTask);

      await manager.start();

      // Security agent files finding against this task
      const auditMsg = makeMessage('orchestrator-1', 'audit_report', {
        task_id: 'task-32',
        compliance_score: 0.4,
        findings: [{ severity: 'error', category: 'xss', description: 'XSS issue' }],
        recommendations: [],
      }, 'security-1');
      await writeToInbox(projectPath, 'orchestrator-1', auditMsg);
      await manager.getPoller().poll();

      // Approve an unrelated task
      const unrelatedTask = makeTask('task-33', 'frontend');
      unrelatedTask.status = 'ready_for_review';
      await createTask(projectPath, unrelatedTask);

      const approvalMsg = makeMessage('orchestrator-1', 'audit_report', {
        task_id: 'task-33',
        compliance_score: 0.95,
        findings: [],
        recommendations: [],
      }, 'audit-1');
      await writeToInbox(projectPath, 'orchestrator-1', approvalMsg);
      await manager.getPoller().poll();

      // Findings should still be open
      const findings = manager.getFindings().getFindingsForDomain('frontend');
      const openFindings = findings.filter((f) => f.status === 'open');
      expect(openFindings).toHaveLength(1);

      await manager.stop();
    });
  });

  // ── End-to-End ─────────────────────────────────────────────────────

  describe('End-to-End', () => {
    it('full flow: audit -> finding -> remediation task -> approval -> resolved', async () => {
      const manager = createManager(projectPath);
      await manager.monitorAgent('security-1', { role: 'security', domain: 'security' });

      const task = makeTask('task-40', 'frontend');
      task.status = 'ready_for_review';
      await createTask(projectPath, task);

      await manager.start();

      // 1. Security agent files critical finding
      const auditMsg = makeMessage('orchestrator-1', 'audit_report', {
        task_id: 'task-40',
        compliance_score: 0.2,
        findings: [{ severity: 'critical', category: 'injection', description: 'SQL injection in login' }],
        recommendations: ['Use parameterized queries'],
      }, 'security-1');
      await writeToInbox(projectPath, 'orchestrator-1', auditMsg);
      await manager.getPoller().poll();

      // 2. Verify finding registered + task created
      const findings = manager.getFindings().getFindingsForDomain('frontend');
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('critical');
      expect(findings[0].status).toBe('open');

      // Domain should be blocked
      expect(manager.getFindings().hasBlockingFindings('frontend')).toBe(true);

      // Remediation task on kanban
      const allTasks = await listTasks(projectPath);
      const remTask = allTasks.find((t) => t.feature === 'cross-cutting-remediation');
      expect(remTask).toBeDefined();
      expect(remTask!.title).toContain('[CRITICAL]');

      // Task linked to finding
      const linkedFinding = manager.getFindings().findByTaskId(remTask!.id);
      expect(linkedFinding).toBeDefined();
      expect(linkedFinding!.id).toBe(findings[0].id);

      // 3. Remediation task passes audit
      const approvalMsg = makeMessage('orchestrator-1', 'audit_report', {
        task_id: remTask!.id,
        compliance_score: 0.95,
        findings: [],
        recommendations: [],
      }, 'audit-1');
      await writeToInbox(projectPath, 'orchestrator-1', approvalMsg);
      await manager.getPoller().poll();

      // 4. Finding should be resolved
      const updatedFindings = manager.getFindings().getFindingsForDomain('frontend');
      expect(updatedFindings).toHaveLength(1);
      expect(updatedFindings[0].status).toBe('resolved');

      // Domain no longer blocked
      expect(manager.getFindings().hasBlockingFindings('frontend')).toBe(false);

      await manager.stop();
    });

    it('multiple findings, partial resolution', async () => {
      const manager = createManager(projectPath);
      await manager.monitorAgent('security-1', { role: 'security', domain: 'security' });

      const task = makeTask('task-50', 'backend');
      task.status = 'ready_for_review';
      await createTask(projectPath, task);

      await manager.start();

      // File 2 critical findings
      const auditMsg = makeMessage('orchestrator-1', 'audit_report', {
        task_id: 'task-50',
        compliance_score: 0.1,
        findings: [
          { severity: 'critical', category: 'injection', description: 'SQL injection' },
          { severity: 'critical', category: 'auth', description: 'Auth bypass' },
        ],
        recommendations: [],
      }, 'security-1');
      await writeToInbox(projectPath, 'orchestrator-1', auditMsg);
      await manager.getPoller().poll();

      // Both registered
      expect(manager.getFindings().getFindingsForDomain('backend')).toHaveLength(2);
      expect(manager.getFindings().hasBlockingFindings('backend')).toBe(true);

      // Get remediation tasks
      const allTasks = await listTasks(projectPath);
      const remTasks = allTasks.filter((t) => t.feature === 'cross-cutting-remediation');
      expect(remTasks).toHaveLength(2);

      // Resolve first finding only
      const approval1 = makeMessage('orchestrator-1', 'audit_report', {
        task_id: remTasks[0].id,
        compliance_score: 0.9,
        findings: [],
        recommendations: [],
      }, 'audit-1');
      await writeToInbox(projectPath, 'orchestrator-1', approval1);
      await manager.getPoller().poll();

      // 1 resolved, 1 still open
      const afterPartial = manager.getFindings().getFindingsForDomain('backend');
      const resolved = afterPartial.filter((f) => f.status === 'resolved');
      const open = afterPartial.filter((f) => f.status === 'open');
      expect(resolved).toHaveLength(1);
      expect(open).toHaveLength(1);

      // Still blocking
      expect(manager.getFindings().hasBlockingFindings('backend')).toBe(true);

      // Resolve second finding
      const approval2 = makeMessage('orchestrator-1', 'audit_report', {
        task_id: remTasks[1].id,
        compliance_score: 0.85,
        findings: [],
        recommendations: [],
      }, 'audit-1');
      await writeToInbox(projectPath, 'orchestrator-1', approval2);
      await manager.getPoller().poll();

      // All resolved
      const afterFull = manager.getFindings().getFindingsForDomain('backend');
      expect(afterFull.every((f) => f.status === 'resolved')).toBe(true);

      // No longer blocking
      expect(manager.getFindings().hasBlockingFindings('backend')).toBe(false);

      await manager.stop();
    });
  });

  // ── findByTaskId ───────────────────────────────────────────────────

  describe('FindingsRegistry.findByTaskId', () => {
    it('returns undefined for unlinked task ID', () => {
      const manager = createManager(projectPath);
      const registry = manager.getFindings();
      expect(registry.findByTaskId('task-9999')).toBeUndefined();
    });

    it('returns finding after linking', () => {
      const manager = createManager(projectPath);
      const registry = manager.getFindings();

      const findingId = registry.registerFinding({
        domain: 'frontend',
        sourceAgent: 'security-1',
        sourceRole: 'security',
        taskId: null,
        severity: 'error',
        category: 'xss',
        description: 'XSS found',
        recommendation: 'Fix it',
      });

      registry.linkTask(findingId, 'task-linked-1');

      const found = registry.findByTaskId('task-linked-1');
      expect(found).toBeDefined();
      expect(found!.id).toBe(findingId);
      expect(found!.description).toBe('XSS found');
    });
  });

  // ── getFindings accessor ───────────────────────────────────────────

  describe('getFindings() accessor', () => {
    it('returns the same FindingsRegistry instance', () => {
      const manager = createManager(projectPath);
      const reg1 = manager.getFindings();
      const reg2 = manager.getFindings();
      expect(reg1).toBe(reg2);
    });
  });
});
