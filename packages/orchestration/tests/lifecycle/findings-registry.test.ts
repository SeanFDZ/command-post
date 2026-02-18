import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  FindingsRegistry,
} from '../../src/lifecycle/findings-registry.js';
import type {
  DomainFinding,
  FindingSeverity,
} from '../../src/lifecycle/findings-registry.js';

function baseFinding(overrides: Partial<Omit<DomainFinding, 'id' | 'status' | 'createdAt' | 'resolvedAt' | 'resolvedBy'>> = {}) {
  return {
    domain: 'auth',
    sourceAgent: 'security-1',
    sourceRole: 'security',
    taskId: null,
    severity: 'error' as FindingSeverity,
    category: 'vulnerability',
    description: 'SQL injection in login endpoint',
    recommendation: 'Use parameterised queries',
    ...overrides,
  };
}

describe('FindingsRegistry', () => {
  let registry: FindingsRegistry;

  beforeEach(() => {
    registry = new FindingsRegistry();
  });

  // ── Registration ────────────────────────────────────────────────

  describe('Registration', () => {
    it('registers a finding and stores it with correct fields', () => {
      const id = registry.registerFinding(baseFinding());
      const finding = registry.getFinding(id);
      expect(finding).toBeDefined();
      expect(finding!.domain).toBe('auth');
      expect(finding!.sourceAgent).toBe('security-1');
      expect(finding!.sourceRole).toBe('security');
      expect(finding!.severity).toBe('error');
      expect(finding!.category).toBe('vulnerability');
      expect(finding!.description).toBe('SQL injection in login endpoint');
      expect(finding!.recommendation).toBe('Use parameterised queries');
    });

    it('defaults status to open with createdAt set and resolvedAt/resolvedBy null', () => {
      const id = registry.registerFinding(baseFinding());
      const finding = registry.getFinding(id)!;
      expect(finding.status).toBe('open');
      expect(finding.createdAt).toBeTruthy();
      expect(new Date(finding.createdAt).toISOString()).toBe(finding.createdAt);
      expect(finding.resolvedAt).toBeNull();
      expect(finding.resolvedBy).toBeNull();
    });

    it('registers multiple findings for the same domain', () => {
      registry.registerFinding(baseFinding());
      registry.registerFinding(baseFinding({ category: 'xss' }));
      const findings = registry.getFindingsForDomain('auth');
      expect(findings).toHaveLength(2);
    });

    it('registers findings for different domains', () => {
      registry.registerFinding(baseFinding({ domain: 'auth' }));
      registry.registerFinding(baseFinding({ domain: 'payments' }));
      expect(registry.getFindingsForDomain('auth')).toHaveLength(1);
      expect(registry.getFindingsForDomain('payments')).toHaveLength(1);
    });

    it('generates an ID matching finding-{uuid} format', () => {
      const id = registry.registerFinding(baseFinding());
      expect(id).toMatch(/^finding-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
  });

  // ── Status Transitions ──────────────────────────────────────────

  describe('Status Transitions', () => {
    it('markInProgress changes status from open to in_progress', () => {
      const id = registry.registerFinding(baseFinding());
      registry.markInProgress(id);
      expect(registry.getFinding(id)!.status).toBe('in_progress');
    });

    it('markInProgress throws for nonexistent finding ID', () => {
      expect(() => registry.markInProgress('finding-nonexistent')).toThrow(
        'Finding not found: finding-nonexistent',
      );
    });

    it('resolveFinding changes status to resolved and sets resolvedAt and resolvedBy', () => {
      const id = registry.registerFinding(baseFinding());
      registry.resolveFinding(id, 'worker-fix-1');
      const finding = registry.getFinding(id)!;
      expect(finding.status).toBe('resolved');
      expect(finding.resolvedAt).toBeTruthy();
      expect(new Date(finding.resolvedAt!).toISOString()).toBe(finding.resolvedAt);
      expect(finding.resolvedBy).toBe('worker-fix-1');
    });

    it('resolveFinding throws for nonexistent finding ID', () => {
      expect(() => registry.resolveFinding('finding-nope', 'agent')).toThrow(
        'Finding not found: finding-nope',
      );
    });

    it('resolveFinding throws if finding is already resolved', () => {
      const id = registry.registerFinding(baseFinding());
      registry.resolveFinding(id, 'worker-1');
      expect(() => registry.resolveFinding(id, 'worker-2')).toThrow(
        `Finding already resolved: ${id}`,
      );
    });

    it('markInProgress on an already in_progress finding is idempotent', () => {
      const id = registry.registerFinding(baseFinding());
      registry.markInProgress(id);
      expect(() => registry.markInProgress(id)).not.toThrow();
      expect(registry.getFinding(id)!.status).toBe('in_progress');
    });
  });

  // ── Task Linking ────────────────────────────────────────────────

  describe('Task Linking', () => {
    it('linkTask sets the taskId on a finding', () => {
      const id = registry.registerFinding(baseFinding());
      registry.linkTask(id, 'task-42');
      expect(registry.getFinding(id)!.taskId).toBe('task-42');
    });

    it('linkTask throws for nonexistent finding ID', () => {
      expect(() => registry.linkTask('finding-missing', 'task-1')).toThrow(
        'Finding not found: finding-missing',
      );
    });
  });

  // ── Queries ─────────────────────────────────────────────────────

  describe('Queries', () => {
    it('getUnresolvedFindings returns only open + in_progress findings for the domain', () => {
      const id1 = registry.registerFinding(baseFinding());
      const id2 = registry.registerFinding(baseFinding({ category: 'xss' }));
      const id3 = registry.registerFinding(baseFinding({ category: 'csrf' }));
      registry.markInProgress(id2);
      registry.resolveFinding(id3, 'worker-1');

      const unresolved = registry.getUnresolvedFindings('auth');
      expect(unresolved).toHaveLength(2);
      const ids = unresolved.map((f) => f.id);
      expect(ids).toContain(id1);
      expect(ids).toContain(id2);
      expect(ids).not.toContain(id3);
    });

    it('getUnresolvedFindings returns empty array for domain with no findings', () => {
      expect(registry.getUnresolvedFindings('nonexistent')).toEqual([]);
    });

    it('getBlockingFindings returns only error + critical severity unresolved findings', () => {
      const idErr = registry.registerFinding(baseFinding({ severity: 'error' }));
      const idCrit = registry.registerFinding(baseFinding({ severity: 'critical' }));
      registry.registerFinding(baseFinding({ severity: 'info' }));
      registry.registerFinding(baseFinding({ severity: 'warning' }));

      const blocking = registry.getBlockingFindings('auth');
      expect(blocking).toHaveLength(2);
      const ids = blocking.map((f) => f.id);
      expect(ids).toContain(idErr);
      expect(ids).toContain(idCrit);
    });

    it('getBlockingFindings excludes info and warning severity', () => {
      registry.registerFinding(baseFinding({ severity: 'info' }));
      registry.registerFinding(baseFinding({ severity: 'warning' }));
      expect(registry.getBlockingFindings('auth')).toHaveLength(0);
    });

    it('getBlockingFindings excludes resolved findings even if error/critical', () => {
      const id = registry.registerFinding(baseFinding({ severity: 'critical' }));
      registry.resolveFinding(id, 'worker-1');
      expect(registry.getBlockingFindings('auth')).toHaveLength(0);
    });

    it('hasBlockingFindings returns true when blocking findings exist', () => {
      registry.registerFinding(baseFinding({ severity: 'error' }));
      expect(registry.hasBlockingFindings('auth')).toBe(true);
    });

    it('hasBlockingFindings returns false when no blocking findings exist', () => {
      registry.registerFinding(baseFinding({ severity: 'info' }));
      expect(registry.hasBlockingFindings('auth')).toBe(false);
    });

    it('getBlockedDomains returns all domains with blocking findings', () => {
      registry.registerFinding(baseFinding({ domain: 'auth', severity: 'error' }));
      registry.registerFinding(baseFinding({ domain: 'payments', severity: 'critical' }));
      registry.registerFinding(baseFinding({ domain: 'search', severity: 'warning' }));

      const blocked = registry.getBlockedDomains();
      expect(blocked).toContain('auth');
      expect(blocked).toContain('payments');
      expect(blocked).not.toContain('search');
      expect(blocked).toHaveLength(2);
    });

    it('getAllFindings returns everything regardless of domain or status', () => {
      registry.registerFinding(baseFinding({ domain: 'auth' }));
      registry.registerFinding(baseFinding({ domain: 'payments' }));
      const id3 = registry.registerFinding(baseFinding({ domain: 'search' }));
      registry.resolveFinding(id3, 'worker-1');

      expect(registry.getAllFindings()).toHaveLength(3);
    });

    it('getFindingsForDomain returns all findings (any status) for one domain', () => {
      const id1 = registry.registerFinding(baseFinding());
      const id2 = registry.registerFinding(baseFinding({ category: 'xss' }));
      registry.resolveFinding(id2, 'worker-1');
      registry.registerFinding(baseFinding({ domain: 'other' }));

      const findings = registry.getFindingsForDomain('auth');
      expect(findings).toHaveLength(2);
    });

    it('getFinding returns undefined for nonexistent ID', () => {
      expect(registry.getFinding('finding-does-not-exist')).toBeUndefined();
    });
  });

  // ── Callbacks ───────────────────────────────────────────────────

  describe('Callbacks', () => {
    it('onFindingResolved callback fires when a finding is resolved', () => {
      const cb = vi.fn();
      registry.onFindingResolved(cb);
      const id = registry.registerFinding(baseFinding());
      registry.resolveFinding(id, 'worker-1');
      expect(cb).toHaveBeenCalledOnce();
    });

    it('callback receives the resolved finding object with updated status/timestamps', () => {
      const cb = vi.fn();
      registry.onFindingResolved(cb);
      const id = registry.registerFinding(baseFinding());
      registry.resolveFinding(id, 'worker-1');

      const received: DomainFinding = cb.mock.calls[0][0];
      expect(received.id).toBe(id);
      expect(received.status).toBe('resolved');
      expect(received.resolvedBy).toBe('worker-1');
      expect(received.resolvedAt).toBeTruthy();
    });

    it('multiple callbacks all fire on resolution', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      registry.onFindingResolved(cb1);
      registry.onFindingResolved(cb2);
      const id = registry.registerFinding(baseFinding());
      registry.resolveFinding(id, 'worker-1');
      expect(cb1).toHaveBeenCalledOnce();
      expect(cb2).toHaveBeenCalledOnce();
    });

    it('offFindingResolved prevents callback from firing', () => {
      const cb = vi.fn();
      registry.onFindingResolved(cb);
      registry.offFindingResolved(cb);
      const id = registry.registerFinding(baseFinding());
      registry.resolveFinding(id, 'worker-1');
      expect(cb).not.toHaveBeenCalled();
    });

    it('callback does NOT fire for markInProgress, only for resolveFinding', () => {
      const cb = vi.fn();
      registry.onFindingResolved(cb);
      const id = registry.registerFinding(baseFinding());
      registry.markInProgress(id);
      expect(cb).not.toHaveBeenCalled();
      registry.resolveFinding(id, 'worker-1');
      expect(cb).toHaveBeenCalledOnce();
    });
  });

  // ── Edge Cases ──────────────────────────────────────────────────

  describe('Edge Cases', () => {
    it('operations on an empty registry do not throw', () => {
      expect(() => registry.getUnresolvedFindings('auth')).not.toThrow();
      expect(() => registry.getBlockingFindings('auth')).not.toThrow();
      expect(() => registry.hasBlockingFindings('auth')).not.toThrow();
      expect(() => registry.getFindingsForDomain('auth')).not.toThrow();
      expect(() => registry.getAllFindings()).not.toThrow();
      expect(() => registry.getBlockedDomains()).not.toThrow();
      expect(registry.getAllFindings()).toEqual([]);
      expect(registry.getBlockedDomains()).toEqual([]);
    });

    it('registers findings with all severity levels and verifies blocking logic', () => {
      const severities: FindingSeverity[] = ['info', 'warning', 'error', 'critical'];
      const ids: string[] = [];

      for (const severity of severities) {
        ids.push(registry.registerFinding(baseFinding({ severity, domain: 'test' })));
      }

      const blocking = registry.getBlockingFindings('test');
      expect(blocking).toHaveLength(2);
      const blockingSeverities = blocking.map((f) => f.severity);
      expect(blockingSeverities).toContain('error');
      expect(blockingSeverities).toContain('critical');
      expect(blockingSeverities).not.toContain('info');
      expect(blockingSeverities).not.toContain('warning');

      expect(registry.hasBlockingFindings('test')).toBe(true);

      // Resolve blocking ones — domain should no longer be blocked
      registry.resolveFinding(ids[2], 'worker-1'); // error
      registry.resolveFinding(ids[3], 'worker-1'); // critical
      expect(registry.hasBlockingFindings('test')).toBe(false);
      expect(registry.getBlockedDomains()).not.toContain('test');

      // info and warning still show as unresolved
      expect(registry.getUnresolvedFindings('test')).toHaveLength(2);
    });
  });
});
