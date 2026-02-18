import { tmux } from './executor.js';
import { logger } from '../utils/logger.js';
import type { Session } from './types.js';

/** Default session name prefix. */
const DEFAULT_PREFIX = 'cp';

/**
 * Creates a new tmux session and sets Command Post user attributes.
 *
 * @param sessionName - tmux session name ({prefix}-{project}-{agent})
 * @param agentId - Agent identifier
 * @param domain - Agent's domain
 * @param role - Agent role (orchestrator|worker|audit|monitor)
 * @param projectName - Project name stored as attribute
 */
export async function createSession(
  sessionName: string,
  agentId: string,
  domain: string,
  role: string,
  projectName: string,
): Promise<void> {
  logger.debug(`Creating tmux session: ${sessionName}`);

  await tmux(['new-session', '-d', '-s', sessionName]);
  await setSessionAttribute(sessionName, 'agent_id', agentId);
  await setSessionAttribute(sessionName, 'domain', domain);
  await setSessionAttribute(sessionName, 'role', role);
  await setSessionAttribute(sessionName, 'projectName', projectName);
}

/**
 * Sets a user attribute on a tmux session.
 * Uses tmux `set-option -t session @key value`.
 */
export async function setSessionAttribute(
  sessionName: string,
  key: string,
  value: string,
): Promise<void> {
  await tmux(['set-option', '-t', sessionName, `@${key}`, value]);
}

/**
 * Gets a user attribute from a tmux session.
 * Returns empty string if attribute is not set.
 */
export async function getSessionAttribute(
  sessionName: string,
  key: string,
): Promise<string> {
  try {
    return await tmux(['show-option', '-t', sessionName, '-v', `@${key}`]);
  } catch {
    return '';
  }
}

/**
 * Kills a tmux session. Allows 2 seconds before force kill.
 */
export async function killSession(sessionName: string): Promise<void> {
  logger.debug(`Killing tmux session: ${sessionName}`);
  try {
    await tmux(['kill-session', '-t', sessionName]);
  } catch {
    // Session may already be gone
    logger.debug(`Session ${sessionName} not found or already killed`);
  }
}

/**
 * Lists all tmux sessions that match the Command Post naming convention.
 * Parses session names and retrieves stored attributes.
 *
 * @param projectName - Optional project name to filter by
 * @param prefix - Session name prefix (default: 'cp')
 */
export async function listSessions(
  projectName?: string,
  prefix: string = DEFAULT_PREFIX,
): Promise<Session[]> {
  const output = await tmux([
    'list-sessions',
    '-F',
    '#{session_name}|#{session_created}|#{session_attached}',
  ]);

  if (!output) return [];

  const filterPrefix = projectName ? `${prefix}-${projectName}-` : `${prefix}-`;
  const sessions: Session[] = [];

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const [name, createdTs, attached] = trimmed.split('|');
    if (!name || !name.startsWith(filterPrefix)) continue;

    try {
      const agentId = await getSessionAttribute(name, 'agent_id');
      const domain = await getSessionAttribute(name, 'domain');
      const role = await getSessionAttribute(name, 'role');

      sessions.push({
        name,
        agentId: agentId || name.replace(`${prefix}-`, ''),
        domain: domain || '',
        role: role || '',
        active: attached === '1',
        createdAt: createdTs
          ? new Date(parseInt(createdTs, 10) * 1000).toISOString()
          : new Date().toISOString(),
      });
    } catch {
      logger.debug(`Could not read attributes for session ${name}`);
    }
  }

  return sessions;
}

/**
 * Checks if a tmux session with the given name exists.
 */
export async function sessionExists(sessionName: string): Promise<boolean> {
  try {
    await tmux(['has-session', '-t', sessionName]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kills all Command Post sessions for a given project.
 * Used for idempotent relaunches.
 *
 * @param projectName - Project name
 * @param prefix - Session name prefix (default: 'cp')
 */
export async function killProjectSessions(
  projectName: string,
  prefix: string = DEFAULT_PREFIX,
): Promise<number> {
  const sessions = await listSessions(projectName, prefix);
  let killed = 0;

  for (const session of sessions) {
    await killSession(session.name);
    killed++;
  }

  if (killed > 0) {
    logger.debug(`Killed ${killed} existing session(s) for project ${projectName}`);
  }

  return killed;
}

/**
 * Generates the standard tmux session name for a Command Post agent.
 *
 * @param projectName - Project name
 * @param agentId - Agent identifier
 * @param prefix - Session name prefix (default: 'cp')
 */
export function sessionName(
  projectName: string,
  agentId: string,
  prefix: string = DEFAULT_PREFIX,
): string {
  return `${prefix}-${projectName}-${agentId}`;
}
