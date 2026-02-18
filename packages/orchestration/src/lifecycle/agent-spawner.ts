/**
 * Agent Spawner — prepares replacement agents during the Memory Snapshot Protocol.
 *
 * This module handles PRD Section 5.2 Step 3: spawning a replacement agent with:
 *   1. Original task assignment (from task object)
 *   2. Relevant PRD sections (from agent instructions)
 *   3. Memory snapshot from the departing agent
 *   4. Updated task object with handoff_count incremented
 *
 * The actual tmux session creation is delegated to a SpawnExecutor callback
 * to avoid circular dependencies with the CLI package.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { writeToInbox, getProjectRoot } from '@command-post/core';
import type { InboxMessage } from '@command-post/core';
import { logLifecycleEvent } from '../utils/lifecycle-logger.js';
import type { OrchestrationSnapshot } from '../types/index.js';
import type { PrdMemorySnapshot } from './snapshot-quality.js';

/** Request describing everything needed to spawn a replacement agent. */
export interface SpawnRequest {
  /** Unique ID for this spawn request. */
  requestId: string;
  /** ID for the new replacement agent. */
  replacementAgentId: string;
  /** ID of the agent being replaced. */
  originalAgentId: string;
  /** Path to the original agent's instructions file. */
  instructionsPath: string;
  /** Content of the prepared instructions (original + snapshot context). */
  preparedInstructions: string;
  /** Memory snapshot from the departing agent. */
  snapshot: OrchestrationSnapshot | PrdMemorySnapshot | null;
  /** Task IDs being transferred. */
  taskIds: string[];
  /** Agent role (worker, audit, etc). */
  role: string;
  /** Agent domain. */
  domain: string;
  /** Handoff number (incremented from original). */
  handoffNumber: number;
  /** Project path. */
  projectPath: string;
  /** Timestamp of spawn request. */
  timestamp: string;
}

/** Result of a spawn preparation. */
export interface SpawnResult {
  success: boolean;
  request: SpawnRequest;
  error?: string;
}

/** Callback for executing the actual agent spawn (e.g., tmux session creation). */
export type SpawnExecutor = (request: SpawnRequest) => Promise<boolean>;

/**
 * Generate a replacement agent ID from the original.
 *
 * Pattern: original-id-r{handoffNumber}
 * e.g., worker-frontend-1-r1, worker-frontend-1-r2
 */
export function generateReplacementId(
  originalAgentId: string,
  handoffNumber: number,
): string {
  // Strip any existing replacement suffix
  const base = originalAgentId.replace(/-r\d+$/, '');
  return `${base}-r${handoffNumber}`;
}

/**
 * Prepare replacement agent instructions by appending the memory snapshot
 * context to the original instructions.
 */
export function prepareReplacementInstructions(
  originalInstructions: string,
  snapshot: OrchestrationSnapshot | PrdMemorySnapshot | null,
  handoffNumber: number,
): string {
  const sections: string[] = [originalInstructions];

  sections.push('\n\n---\n');
  sections.push(`## Memory Handoff Context (Handoff #${handoffNumber})\n`);
  sections.push('You are a **replacement agent** continuing work from a predecessor whose context ');
  sections.push('window approached capacity. Review the snapshot below carefully before proceeding.\n');

  if (!snapshot) {
    sections.push('\n> **Warning**: No memory snapshot available from predecessor.\n');
    sections.push('> Start from the task assignment and any existing code/output.\n');
    return sections.join('');
  }

  // Handle PRD-format snapshot
  if ('state' in snapshot && 'next_steps' in snapshot) {
    const prd = snapshot as PrdMemorySnapshot;
    sections.push(`\n### Current State\n`);
    sections.push(`- **Current Step**: ${prd.state.current_step}\n`);
    sections.push(`- **Progress**: ${prd.state.progress_summary}\n`);
    sections.push(`- **Completion Estimate**: ${prd.state.completion_estimate}\n`);
    sections.push(`- **Context at Snapshot**: ${(prd.context_at_snapshot * 100).toFixed(1)}%\n`);

    if (prd.decisions && prd.decisions.length > 0) {
      sections.push(`\n### Decisions Made (DO NOT REVERSE without good reason)\n`);
      for (const d of prd.decisions) {
        sections.push(`- **${d.decision}** — ${d.rationale} (Impact: ${d.impact})\n`);
      }
    }

    if (prd.gotchas && prd.gotchas.length > 0) {
      sections.push(`\n### Gotchas & Edge Cases\n`);
      for (const g of prd.gotchas) {
        sections.push(`- ${g}\n`);
      }
    }

    if (prd.files_state) {
      sections.push(`\n### File State\n`);
      if (prd.files_state.completed?.length) {
        sections.push(`- **Completed**: ${prd.files_state.completed.join(', ')}\n`);
      }
      if (prd.files_state.in_progress?.length) {
        sections.push(`- **In Progress**: ${prd.files_state.in_progress.join(', ')}\n`);
      }
      if (prd.files_state.not_started?.length) {
        sections.push(`- **Not Started**: ${prd.files_state.not_started.join(', ')}\n`);
      }
    }

    if (prd.next_steps.length > 0) {
      sections.push(`\n### Next Steps (Start Here)\n`);
      for (let i = 0; i < prd.next_steps.length; i++) {
        sections.push(`${i + 1}. ${prd.next_steps[i]}\n`);
      }
    }

    if (prd.dependencies_discovered && prd.dependencies_discovered.length > 0) {
      sections.push(`\n### Dependencies Discovered\n`);
      for (const dep of prd.dependencies_discovered) {
        sections.push(`- ${dep}\n`);
      }
    }
  }
  // Handle OrchestrationSnapshot format
  else if ('snapshotId' in snapshot) {
    const orch = snapshot as OrchestrationSnapshot;
    sections.push(`\n### Context Usage at Handoff\n`);
    sections.push(`- **Snapshot ID**: ${orch.snapshotId}\n`);
    sections.push(`- **Context Usage**: ${orch.contextUsage.percentageOfMax.toFixed(1)}%\n`);
    sections.push(`- **Total Tokens**: ${orch.contextUsage.tokens.total}\n`);

    if (orch.decisionLog.length > 0) {
      sections.push(`\n### Decision Log (DO NOT REVERSE without good reason)\n`);
      for (const d of orch.decisionLog) {
        sections.push(`- [${d.taskId}] **${d.decision}** — ${d.reasoning} (confidence: ${d.confidence})\n`);
      }
    }

    sections.push(`\n### Task Status\n`);
    sections.push(`- Completed: ${orch.taskStatus.tasksCompleted}\n`);
    sections.push(`- In Progress: ${orch.taskStatus.tasksInProgress}\n`);
    sections.push(`- Failed: ${orch.taskStatus.tasksFailed}\n`);

    if (orch.handoffSignal.active) {
      sections.push(`\n### Handoff Signal\n`);
      sections.push(`- Reason: ${orch.handoffSignal.reason}\n`);
    }
  }

  sections.push('\n---\n');

  return sections.join('');
}

/**
 * Prepare everything needed to spawn a replacement agent.
 *
 * This creates:
 * 1. A new agent ID
 * 2. Prepared instructions (original + snapshot)
 * 3. Agent directory with INSTRUCTIONS.md
 * 4. Inbox initialization message
 * 5. A spawn request for the executor
 */
export async function prepareReplacement(
  projectPath: string,
  originalAgentId: string,
  snapshot: OrchestrationSnapshot | PrdMemorySnapshot | null,
  taskIds: string[],
  role: string,
  domain: string,
  handoffNumber: number,
): Promise<SpawnResult> {
  const requestId = uuidv4();
  const replacementAgentId = generateReplacementId(originalAgentId, handoffNumber);
  const projectRoot = getProjectRoot(projectPath);
  const timestamp = new Date().toISOString();

  try {
    // 1. Read original instructions
    const originalInstructionsPath = join(
      projectRoot, 'agents', originalAgentId, 'INSTRUCTIONS.md',
    );
    let originalInstructions: string;
    try {
      originalInstructions = await fs.readFile(originalInstructionsPath, 'utf-8');
    } catch {
      originalInstructions = `# Agent: ${replacementAgentId}\n## Role: ${role}\n## Domain: ${domain}\n\nReplacement agent — original instructions not found.\n`;
    }

    // 2. Prepare enhanced instructions with snapshot context
    const preparedInstructions = prepareReplacementInstructions(
      originalInstructions,
      snapshot,
      handoffNumber,
    );

    // 3. Create agent directory and write instructions
    const agentDir = join(projectRoot, 'agents', replacementAgentId);
    await fs.mkdir(agentDir, { recursive: true });
    const instructionsPath = join(agentDir, 'INSTRUCTIONS.md');
    await fs.writeFile(instructionsPath, preparedInstructions, 'utf-8');

    // 4. Send initialization message to replacement agent's inbox
    const initMessage: InboxMessage = {
      id: `msg-${uuidv4()}`,
      from: 'context-monitor',
      to: replacementAgentId,
      timestamp,
      type: 'memory_handoff',
      priority: 'critical',
      body: {
        event: 'replacement_initialized',
        originalAgent: originalAgentId,
        handoffNumber,
        taskIds,
        snapshotId: snapshot && 'snapshotId' in snapshot
          ? (snapshot as OrchestrationSnapshot).snapshotId
          : null,
        message: `You are replacing ${originalAgentId} (handoff #${handoffNumber}). ` +
          `Review your INSTRUCTIONS.md for the memory snapshot context, then continue ` +
          `working on tasks: ${taskIds.join(', ')}.`,
      },
      read: false,
    };
    await writeToInbox(projectPath, replacementAgentId, initMessage);

    // 5. Log the event
    await logLifecycleEvent(projectPath, originalAgentId, 'handoff_completed', {
      replacementAgentId,
      handoffNumber,
      taskCount: taskIds.length,
      requestId,
    });

    const request: SpawnRequest = {
      requestId,
      replacementAgentId,
      originalAgentId,
      instructionsPath,
      preparedInstructions,
      snapshot,
      taskIds,
      role,
      domain,
      handoffNumber,
      projectPath,
      timestamp,
    };

    return { success: true, request };
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    await logLifecycleEvent(projectPath, originalAgentId, 'handoff_failed', {
      replacementAgentId,
      handoffNumber,
      error: errorMsg,
    });

    return {
      success: false,
      request: {
        requestId,
        replacementAgentId,
        originalAgentId,
        instructionsPath: '',
        preparedInstructions: '',
        snapshot,
        taskIds,
        role,
        domain,
        handoffNumber,
        projectPath,
        timestamp,
      },
      error: errorMsg,
    };
  }
}

/**
 * Write a spawn request to disk for the CLI/external system to execute.
 *
 * The CLI can poll `.command-post/spawn-requests/` and create tmux sessions
 * for any pending requests.
 */
export async function writeSpawnRequest(
  projectPath: string,
  request: SpawnRequest,
): Promise<string> {
  const projectRoot = getProjectRoot(projectPath);
  const dir = join(projectRoot, 'spawn-requests');
  await fs.mkdir(dir, { recursive: true });

  const filePath = join(dir, `${request.requestId}.json`);
  const tmpPath = `${filePath}.tmp`;
  const content = JSON.stringify(request, null, 2);

  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, filePath);

  return filePath;
}
