/**
 * Shared agent-launching utility used by both `launch` and `watch` commands.
 *
 * Extracts the common logic for creating a tmux session, writing a launch
 * message to the agent inbox, and sending the appropriate Claude Code command.
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { writeToInbox, getProjectRoot, registerAgent } from '@command-post/core';
import type { InboxMessage, AgentRegistryEntry } from '@command-post/core';
import {
  createSession,
  sessionName,
  sendKeys,
  writeRunnerScript,
  buildRunnerCommand,
} from '../tmux/index.js';
import { logger } from './logger.js';

function isDiscoveryRole(role: string): boolean {
  return ['discovery', 'research', 'ideation', 'prd-reviewer'].includes(role);
}

export interface AgentLaunchConfig {
  projectPath: string;
  projectName: string;
  agentId: string;
  role: string;
  domain: string;
  autoContinue?: boolean;
  maxTurns?: number;
}

/**
 * Creates a tmux session for an agent, writes a launch message to its inbox,
 * and sends the appropriate Claude Code command.
 *
 * @param config - Agent launch configuration
 * @returns The tmux session name
 */
export async function createAgentSession(config: AgentLaunchConfig): Promise<string> {
  const { projectPath, projectName, agentId, role, domain, autoContinue, maxTurns } = config;

  // Create tmux session with agent metadata
  const sName = sessionName(projectName, agentId);
  await createSession(sName, agentId, domain, role, projectName);
  logger.debug(`Created tmux session: ${sName} for agent ${agentId}`);

  // Register agent in the registry
  try {
    const registryEntry: AgentRegistryEntry = {
      tmux_session: sName,
      role,
      domain,
      task_id: null,
      transcript_path: null,
      pid: process.pid,
      status: 'active',
      launched_at: new Date().toISOString(),
      handoff_count: 0,
    };
    await registerAgent(projectPath, agentId, registryEntry);
    logger.debug(`Registered agent ${agentId} in registry`);
  } catch (err) {
    logger.debug(`Failed to register agent ${agentId}: ${err}`);
  }

  // Write launch message to agent's inbox
  const launchMessage: InboxMessage = {
    id: `msg-${crypto.randomUUID()}`,
    from: 'cli',
    to: agentId,
    timestamp: new Date().toISOString(),
    type: 'lifecycle_command',
    priority: 'normal',
    body: {
      command: 'status_check',
      reason: 'Agent session launched',
      agentId,
      role,
      domain,
    },
    read: false,
  };

  await writeToInbox(projectPath, agentId, launchMessage);
  logger.debug(`Wrote launch message to inbox for agent: ${agentId}`);

  // Build and send Claude Code command
  const cpRoot = getProjectRoot(projectPath);

  // TODO: Load project config to get output_dir dynamically once loadConfig is available in @command-post/core
  const outputDir = './output';

  // TODO: Apply tool profile if configured.
  // resolveProfile/materializeProfile are not yet available in @command-post/core.
  // When they are, the pattern is:
  //   const tier = isDiscoveryRole(role) ? 'discovery' : 'build';
  //   const resolved = await resolveProfile(projectPath, tier);
  //   if (resolved) { await materializeProfile(projectPath, resolved); profileExtras = resolved.systemPromptExtras; }
  const profileExtras: string[] = [];
  if (isDiscoveryRole(role)) {
    logger.debug(`Agent ${agentId} has discovery role — profile support pending`);
  }

  // Safety prompt scoped to the project's output dir and .command-post/ communication
  const safetyPrompt =
    `You must only create and modify files within two directories: ` +
    `${outputDir}/ (build output) and .command-post/ (agent communication, tasks, events). ` +
    `You may read files anywhere in the project for context (PRD, instructions, packages). ` +
    `Do NOT modify any files in packages/, schemas/, reviews/, or the project root. ` +
    `Do NOT modify any .md files in the project root (HANDOFF, DESIGN, PRD docs, etc.).`;

  const fullSystemPrompt = profileExtras.length > 0
    ? safetyPrompt + '\n\n' + profileExtras.join('\n')
    : safetyPrompt;

  if (autoContinue) {
    // Use runner script for auto-continue loop
    const scriptPath = await writeRunnerScript({
      projectPath,
      agentId,
      role,
      domain: domain || 'general',
      maxTurns: maxTurns ?? 50,
      cooldownSeconds: 5,
      printMode: true,
      outputDir,
      systemPromptExtras: profileExtras,
    });
    await sendKeys(sName, buildRunnerCommand(scriptPath));
  } else {
    // Single interactive Claude session
    const instructionsPath = path.join(cpRoot, 'agents', agentId, 'INSTRUCTIONS.md');
    const claudePrompt =
      `Read your instructions at ${instructionsPath} and begin executing your assignment. ` +
      `You are agent ${agentId} with role ${role} in domain ${domain || 'general'}. ` +
      `Your project root is ${projectPath}.`;
    const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    const claudeCmd = [
      `cd ${sq(projectPath)}`,
      `&&`,
      `claude`,
      `--dangerously-skip-permissions`,
      `--append-system-prompt`, sq(fullSystemPrompt),
      sq(claudePrompt),
    ].join(' ');
    await sendKeys(sName, claudeCmd);
  }

  logger.debug(`Sent command to session ${sName}`);
  return sName;
}
