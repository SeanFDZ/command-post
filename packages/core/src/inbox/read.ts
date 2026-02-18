import fs from 'graceful-fs';
import { getInboxPath } from '../utils/paths.js';
import { withFileLock } from '../utils/file-lock.js';
import { FileSystemError } from '../errors.js';
import type { InboxMessage, InboxFilters } from './types.js';

const fsPromises = fs.promises;

/**
 * Reads all messages from an agent's inbox.
 * Returns empty array if inbox file doesn't exist.
 *
 * @param projectPath - Root project directory
 * @param agentId - Target agent's identifier
 * @returns Array of inbox messages
 * @throws {FileSystemError} If the file exists but cannot be read/parsed
 */
export async function readInbox(projectPath: string, agentId: string): Promise<InboxMessage[]> {
  const inboxPath = getInboxPath(projectPath, agentId);

  try {
    await fsPromises.access(inboxPath);
  } catch {
    return [];
  }

  return withFileLock(inboxPath, async () => {
    try {
      const content = await fsPromises.readFile(inboxPath, 'utf-8');
      const data = JSON.parse(content) as { messages: InboxMessage[] };
      return data.messages ?? [];
    } catch (err) {
      throw new FileSystemError(
        `Failed to read inbox for agent ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
        inboxPath,
        err,
      );
    }
  });
}

/**
 * Retrieves a single message from an agent's inbox by message ID.
 *
 * @param projectPath - Root project directory
 * @param agentId - Target agent's identifier
 * @param messageId - The message ID to find
 * @returns The message if found, null otherwise
 */
export async function getMessage(
  projectPath: string,
  agentId: string,
  messageId: string,
): Promise<InboxMessage | null> {
  const messages = await readInbox(projectPath, agentId);
  return messages.find((m) => m.id === messageId) ?? null;
}

/**
 * Queries messages from an agent's inbox with optional filters.
 *
 * @param projectPath - Root project directory
 * @param agentId - Target agent's identifier
 * @param filters - Optional filters to narrow results
 * @returns Filtered array of inbox messages
 */
export async function queryMessages(
  projectPath: string,
  agentId: string,
  filters?: InboxFilters,
): Promise<InboxMessage[]> {
  let messages = await readInbox(projectPath, agentId);

  if (filters) {
    if (filters.type !== undefined) {
      messages = messages.filter((m) => m.type === filters.type);
    }
    if (filters.from !== undefined) {
      messages = messages.filter((m) => m.from === filters.from);
    }
    if (filters.read !== undefined) {
      messages = messages.filter((m) => m.read === filters.read);
    }
    if (filters.priority !== undefined) {
      messages = messages.filter((m) => m.priority === filters.priority);
    }
  }

  return messages;
}
