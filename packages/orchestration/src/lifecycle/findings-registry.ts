/**
 * FindingsRegistry — tracks cross-cutting findings (security, testing, docs)
 * filed against domains and determines whether a domain has unresolved
 * blocking findings that should gate shutdown.
 */

import { v4 as uuidv4 } from 'uuid';

// ── Types ───────────────────────────────────────────────────────────

export type FindingSeverity = 'info' | 'warning' | 'error' | 'critical';
export type FindingStatus = 'open' | 'in_progress' | 'resolved';

export interface DomainFinding {
  id: string;
  domain: string;
  sourceAgent: string;
  sourceRole: string;
  taskId: string | null;
  severity: FindingSeverity;
  category: string;
  description: string;
  recommendation: string;
  status: FindingStatus;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export type FindingResolvedCallback = (finding: DomainFinding) => void;

// ── Registry ────────────────────────────────────────────────────────

export class FindingsRegistry {
  private findings = new Map<string, DomainFinding>();
  private callbacks = new Set<FindingResolvedCallback>();

  /** Register a new finding. Returns the generated finding ID. */
  registerFinding(
    params: Omit<DomainFinding, 'id' | 'status' | 'createdAt' | 'resolvedAt' | 'resolvedBy'>,
  ): string {
    const id = `finding-${uuidv4()}`;
    const finding: DomainFinding = {
      ...params,
      id,
      status: 'open',
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedBy: null,
    };
    this.findings.set(id, finding);
    return id;
  }

  /** Mark a finding as in-progress. Idempotent if already in_progress. */
  markInProgress(findingId: string): void {
    const finding = this.findings.get(findingId);
    if (!finding) {
      throw new Error(`Finding not found: ${findingId}`);
    }
    finding.status = 'in_progress';
  }

  /** Resolve a finding, setting resolvedAt and resolvedBy. Fires callbacks. */
  resolveFinding(findingId: string, resolvedBy: string): void {
    const finding = this.findings.get(findingId);
    if (!finding) {
      throw new Error(`Finding not found: ${findingId}`);
    }
    if (finding.status === 'resolved') {
      throw new Error(`Finding already resolved: ${findingId}`);
    }
    finding.status = 'resolved';
    finding.resolvedAt = new Date().toISOString();
    finding.resolvedBy = resolvedBy;

    for (const cb of this.callbacks) {
      cb(finding);
    }
  }

  /** Link a remediation task to a finding. */
  linkTask(findingId: string, taskId: string): void {
    const finding = this.findings.get(findingId);
    if (!finding) {
      throw new Error(`Finding not found: ${findingId}`);
    }
    finding.taskId = taskId;
  }

  /** All unresolved findings (open + in_progress) for a domain. */
  getUnresolvedFindings(domain: string): DomainFinding[] {
    return [...this.findings.values()].filter(
      (f) => f.domain === domain && f.status !== 'resolved',
    );
  }

  /** Only error + critical severity unresolved findings for a domain. */
  getBlockingFindings(domain: string): DomainFinding[] {
    return [...this.findings.values()].filter(
      (f) =>
        f.domain === domain &&
        f.status !== 'resolved' &&
        (f.severity === 'error' || f.severity === 'critical'),
    );
  }

  /** Does this domain have any blocking findings? */
  hasBlockingFindings(domain: string): boolean {
    return this.getBlockingFindings(domain).length > 0;
  }

  /** All findings (any status) for a domain. */
  getFindingsForDomain(domain: string): DomainFinding[] {
    return [...this.findings.values()].filter((f) => f.domain === domain);
  }

  /** All findings across all domains. */
  getAllFindings(): DomainFinding[] {
    return [...this.findings.values()];
  }

  /** Single finding by ID. */
  getFinding(findingId: string): DomainFinding | undefined {
    return this.findings.get(findingId);
  }

  /**
   * Find a finding by its linked remediation task ID.
   * Returns undefined if no finding is linked to this task.
   */
  findByTaskId(taskId: string): DomainFinding | undefined {
    for (const finding of this.findings.values()) {
      if (finding.taskId === taskId) {
        return finding;
      }
    }
    return undefined;
  }

  /** All domains that currently have blocking findings. */
  getBlockedDomains(): string[] {
    const domains = new Set<string>();
    for (const f of this.findings.values()) {
      if (
        f.status !== 'resolved' &&
        (f.severity === 'error' || f.severity === 'critical')
      ) {
        domains.add(f.domain);
      }
    }
    return [...domains];
  }

  /** Register a callback for finding resolution events. */
  onFindingResolved(callback: FindingResolvedCallback): void {
    this.callbacks.add(callback);
  }

  /** Unregister a resolution callback. */
  offFindingResolved(callback: FindingResolvedCallback): void {
    this.callbacks.delete(callback);
  }
}
