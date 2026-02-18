/**
 * CloseoutManager — state machine that manages the closeout lifecycle.
 *
 * Inserted between Tier 5 (context monitors) and Tier 6 (orchestrator) in the
 * shutdown cascade. After all context monitors shut down, the closeout phase:
 *   1. Collects project data
 *   2. Spawns a closeout-writer agent for human-quality actuals
 *   3. Falls back to programmatic actuals on timeout
 *   4. Writes actuals to PRD + BUILD-REPORT.md
 *   5. Spawns a closeout-auditor agent for verification
 *   6. Applies auditor corrections if needed
 *
 * NEVER throws — all errors are caught, logged, and returned in CloseoutResult.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot } from '@command-post/core';
import type { InboxMessage } from '@command-post/core';
import { collectCloseoutData } from '../closeout/data-collector.js';
import type { CloseoutData } from '../closeout/data-collector.js';
import {
  buildActualsMarkdown,
  buildReportMarkdown,
  injectActualsIntoPrd,
} from '../closeout/actuals-builder.js';
import { findPrdPath } from '../closeout/data-collector.js';
import { logLifecycleEvent } from '../utils/lifecycle-logger.js';
import type { AgentRole } from '../types/index.js';

// ── Types ────────────────────────────────────────────────────────────

export type CloseoutState =
  | 'idle'
  | 'collecting'
  | 'writer_spawned'
  | 'writer_complete'
  | 'auditor_spawned'
  | 'complete'
  | 'failed';

export interface CloseoutResult {
  success: boolean;
  actualsWritten: boolean;
  reportWritten: boolean;
  auditorVerdict: 'approved' | 'approved_with_notes' | 'revision_needed' | 'timeout' | 'skipped';
  errors: string[];
}

export type SpawnFn = (role: AgentRole, domain: string, reason: string) => Promise<string>;

// ── CloseoutManager ──────────────────────────────────────────────────

export class CloseoutManager {
  private readonly projectPath: string;
  private readonly orchestratorId: string;
  private readonly spawnFn: SpawnFn;

  private state: CloseoutState = 'idle';
  private errors: string[] = [];

  /** Timeout for writer agent response (ms). */
  private readonly writerTimeoutMs: number;
  /** Timeout for auditor agent response (ms). */
  private readonly auditorTimeoutMs: number;

  /** Resolve function for the writer response promise. */
  private writerResolve: ((msg: InboxMessage) => void) | null = null;
  /** Resolve function for the auditor response promise. */
  private auditorResolve: ((msg: InboxMessage) => void) | null = null;

  /** Collected closeout data. */
  private closeoutData: CloseoutData | null = null;
  /** Programmatic fallback actuals markdown. */
  private programmaticActuals: string | null = null;
  /** Writer-produced actuals (if received). */
  private writerActuals: string | null = null;

  constructor(
    projectPath: string,
    orchestratorId: string,
    spawnFn: SpawnFn,
    options?: { writerTimeoutMs?: number; auditorTimeoutMs?: number },
  ) {
    this.projectPath = projectPath;
    this.orchestratorId = orchestratorId;
    this.spawnFn = spawnFn;
    this.writerTimeoutMs = options?.writerTimeoutMs ?? 10 * 60 * 1000; // 10 minutes
    this.auditorTimeoutMs = options?.auditorTimeoutMs ?? 5 * 60 * 1000; // 5 minutes
  }

  /** Get the current state machine state. */
  getState(): CloseoutState {
    return this.state;
  }

  /**
   * Run the full closeout lifecycle.
   * NEVER throws — returns CloseoutResult with success: false on total failure.
   */
  async runCloseout(): Promise<CloseoutResult> {
    const result: CloseoutResult = {
      success: false,
      actualsWritten: false,
      reportWritten: false,
      auditorVerdict: 'skipped',
      errors: [],
    };

    try {
      // ── Step 1: Collect data ─────────────────────────────────────
      this.state = 'collecting';
      try {
        this.closeoutData = await collectCloseoutData(this.projectPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.errors.push(`Data collection failed: ${msg}`);
        this.state = 'failed';
        result.errors = [...this.errors];
        return result;
      }

      // ── Step 2: Generate programmatic fallback ───────────────────
      try {
        this.programmaticActuals = buildActualsMarkdown(this.closeoutData);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.errors.push(`Programmatic actuals build failed: ${msg}`);
        // Non-fatal: we can still try the writer agent
      }

      // ── Step 3: Spawn writer agent ───────────────────────────────
      this.state = 'writer_spawned';

      try {
        const writerId = await this.spawnFn(
          'closeout-writer',
          'closeout',
          'Build closeout documentation',
        );

        await logLifecycleEvent(this.projectPath, this.orchestratorId, 'context_snapshot_created', {
          action: 'closeout_writer_spawned',
          agentId: writerId,
        });

        // ── Step 4: Wait for writer response ─────────────────────
        const writerResponse = await this.waitForWriterResponse();

        if (writerResponse) {
          this.state = 'writer_complete';
          this.writerActuals = writerResponse.body?.actuals_markdown as string ?? null;

          await logLifecycleEvent(this.projectPath, this.orchestratorId, 'context_snapshot_created', {
            action: 'closeout_writer_responded',
            hasActuals: !!this.writerActuals,
          });
        } else {
          // Timeout — use programmatic fallback
          this.state = 'writer_complete';
          this.errors.push('Writer agent timed out — using programmatic fallback');

          await logLifecycleEvent(this.projectPath, this.orchestratorId, 'context_snapshot_created', {
            action: 'closeout_writer_timeout',
            timeoutMs: this.writerTimeoutMs,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.errors.push(`Writer spawn/wait failed: ${msg}`);
        this.state = 'writer_complete';
      }

      // ── Step 5: Determine final actuals ──────────────────────────
      const finalActuals = this.writerActuals ?? this.programmaticActuals ?? '';

      // ── Step 6: Write actuals to PRD and BUILD-REPORT.md ─────────
      try {
        const prdPath = await findPrdPath(this.projectPath);
        if (prdPath && finalActuals) {
          const prdRaw = await fs.readFile(prdPath, 'utf-8');
          const updatedPrd = injectActualsIntoPrd(prdRaw, finalActuals);
          await fs.writeFile(prdPath, updatedPrd, 'utf-8');
          result.actualsWritten = true;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.errors.push(`PRD injection failed: ${msg}`);
      }

      try {
        const reportMd = buildReportMarkdown(this.closeoutData);
        const projectRoot = getProjectRoot(this.projectPath);
        const outputDir = join(projectRoot, 'output');
        await fs.mkdir(outputDir, { recursive: true });
        await fs.writeFile(join(outputDir, 'BUILD-REPORT.md'), reportMd, 'utf-8');
        result.reportWritten = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.errors.push(`BUILD-REPORT.md write failed: ${msg}`);
      }

      // ── Step 7: Spawn auditor agent ──────────────────────────────
      this.state = 'auditor_spawned';
      try {
        const auditorId = await this.spawnFn(
          'closeout-auditor',
          'closeout',
          'Verify closeout documentation',
        );

        await logLifecycleEvent(this.projectPath, this.orchestratorId, 'context_snapshot_created', {
          action: 'closeout_auditor_spawned',
          agentId: auditorId,
        });

        // ── Step 8: Wait for auditor response ────────────────────
        const auditorResponse = await this.waitForAuditorResponse();

        if (auditorResponse) {
          const verdict = auditorResponse.body?.verdict as string ?? 'approved';
          result.auditorVerdict = this.normalizeVerdict(verdict);

          // If revision_needed with corrections, apply them
          if (result.auditorVerdict === 'revision_needed') {
            const corrections = auditorResponse.body?.corrections as string | undefined;
            if (corrections) {
              try {
                await this.applyCorrections(corrections);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.errors.push(`Correction application failed: ${msg}`);
              }
            }
          }

          await logLifecycleEvent(this.projectPath, this.orchestratorId, 'context_snapshot_created', {
            action: 'closeout_auditor_responded',
            verdict: result.auditorVerdict,
          });
        } else {
          // Timeout — accept writer output as-is
          result.auditorVerdict = 'timeout';
          this.errors.push('Auditor agent timed out — accepting writer output as-is');

          await logLifecycleEvent(this.projectPath, this.orchestratorId, 'context_snapshot_created', {
            action: 'closeout_auditor_timeout',
            timeoutMs: this.auditorTimeoutMs,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.errors.push(`Auditor spawn/wait failed: ${msg}`);
        result.auditorVerdict = 'skipped';
      }

      // ── Done ─────────────────────────────────────────────────────
      this.state = 'complete';
      result.success = true;
      result.errors = [...this.errors];
      return result;
    } catch (err) {
      // Catch-all: closeout must NEVER throw
      const msg = err instanceof Error ? err.message : String(err);
      this.errors.push(`Unexpected closeout error: ${msg}`);
      this.state = 'failed';
      result.errors = [...this.errors];
      return result;
    }
  }

  /**
   * Handle a writer response inbox message.
   * Called by the OrchestrationManager inbox router.
   */
  handleWriterResponse(message: InboxMessage): void {
    if (this.writerResolve) {
      this.writerResolve(message);
      this.writerResolve = null;
    }
  }

  /**
   * Handle an auditor response inbox message.
   * Called by the OrchestrationManager inbox router.
   */
  handleAuditorResponse(message: InboxMessage): void {
    if (this.auditorResolve) {
      this.auditorResolve(message);
      this.auditorResolve = null;
    }
  }

  // ── Private Helpers ────────────────────────────────────────────────

  /**
   * Wait for the writer agent to respond, with timeout.
   * Returns the inbox message, or null on timeout.
   */
  private waitForWriterResponse(): Promise<InboxMessage | null> {
    return new Promise<InboxMessage | null>((resolve) => {
      const timeout = setTimeout(() => {
        this.writerResolve = null;
        resolve(null);
      }, this.writerTimeoutMs);

      if (typeof timeout === 'object' && 'unref' in timeout) {
        timeout.unref();
      }

      this.writerResolve = (msg: InboxMessage) => {
        clearTimeout(timeout);
        resolve(msg);
      };
    });
  }

  /**
   * Wait for the auditor agent to respond, with timeout.
   * Returns the inbox message, or null on timeout.
   */
  private waitForAuditorResponse(): Promise<InboxMessage | null> {
    return new Promise<InboxMessage | null>((resolve) => {
      const timeout = setTimeout(() => {
        this.auditorResolve = null;
        resolve(null);
      }, this.auditorTimeoutMs);

      if (typeof timeout === 'object' && 'unref' in timeout) {
        timeout.unref();
      }

      this.auditorResolve = (msg: InboxMessage) => {
        clearTimeout(timeout);
        resolve(msg);
      };
    });
  }

  /**
   * Normalize an auditor verdict string to a known enum value.
   */
  private normalizeVerdict(verdict: string): CloseoutResult['auditorVerdict'] {
    const valid: CloseoutResult['auditorVerdict'][] = [
      'approved',
      'approved_with_notes',
      'revision_needed',
      'timeout',
      'skipped',
    ];
    if (valid.includes(verdict as CloseoutResult['auditorVerdict'])) {
      return verdict as CloseoutResult['auditorVerdict'];
    }
    return 'approved';
  }

  /**
   * Apply auditor corrections to the BUILD-REPORT.md.
   * Corrections are expected to be markdown that replaces the report.
   */
  private async applyCorrections(corrections: string): Promise<void> {
    const projectRoot = getProjectRoot(this.projectPath);
    const reportPath = join(projectRoot, 'output', 'BUILD-REPORT.md');

    try {
      await fs.access(reportPath);
      await fs.writeFile(reportPath, corrections, 'utf-8');

      await logLifecycleEvent(this.projectPath, this.orchestratorId, 'context_snapshot_created', {
        action: 'closeout_corrections_applied',
        reportPath,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot apply corrections to ${reportPath}: ${msg}`);
    }
  }
}
