import fs from 'graceful-fs';
import path from 'node:path';
import { getInboxPath } from '../utils/paths.js';
import { withFileLock } from '../utils/file-lock.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { FileSystemError, NotFoundError } from '../errors.js';
import { InboxMessageSchema } from './types.js';
import type { InboxMessage } from './types.js';

const fsPromises = fs.promises;

/**
 * Ensures the inbox file exists, creating it with an empty messages array if not.
 * Uses writeFile with 'wx' flag (exclusive create) to avoid race conditions.
 */
async function ensureInboxFile(inboxPath: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(inboxPath), { recursive: true });
  try {
    await fsPromises.writeFile(inboxPath, JSON.stringify({ messages: [] }, null, 2), { flag: 'wx' });
  } catch (err) {
    // EEXIST means file already exists — that's fine
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
  }
}

/**
 * Reads the raw inbox data from disk (must be called inside a lock).
 */
async function readInboxData(inboxPath: string): Promise<{ messages: InboxMessage[] }> {
  const content = await fsPromises.readFile(inboxPath, 'utf-8');
  return JSON.parse(content) as { messages: InboxMessage[] };
}

/**
 * Appends a message to an agent's inbox with atomic write and file locking.
 *
 * @param projectPath - Root project directory
 * @param agentId - Target agent's identifier
 * @param message - The message to append
 * @throws {FileSystemError} If the write operation fails
 */
export async function writeToInbox(
  projectPath: string,
  agentId: string,
  message: InboxMessage,
): Promise<void> {
  // Validate message schema before writing
  InboxMessageSchema.parse(message);

  const inboxPath = getInboxPath(projectPath, agentId);
  await ensureInboxFile(inboxPath);

  await withFileLock(inboxPath, async () => {
    try {
      const data = await readInboxData(inboxPath);
      data.messages.push(message);
      await atomicWrite(inboxPath, JSON.stringify(data, null, 2));
    } catch (err) {
      if (err instanceof FileSystemError) throw err;
      throw new FileSystemError(
        `Failed to write to inbox for agent ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
        inboxPath,
        err,
      );
    }
  });
}

/**
 * Marks a specific message as read in an agent's inbox.
 *
 * @param projectPath - Root project directory
 * @param agentId - Target agent's identifier
 * @param messageId - The message ID to mark as read
 * @throws {NotFoundError} If the message is not found
 * @throws {FileSystemError} If the write operation fails
 */
export async function markMessageRead(
  projectPath: string,
  agentId: string,
  messageId: string,
): Promise<void> {
  const inboxPath = getInboxPath(projectPath, agentId);
  await ensureInboxFile(inboxPath);

  await withFileLock(inboxPath, async () => {
    const data = await readInboxData(inboxPath);
    const msg = data.messages.find((m) => m.id === messageId);
    if (!msg) {
      throw new NotFoundError(
        `Message ${messageId} not found in inbox for agent ${agentId}`,
        'message',
        messageId,
      );
    }
    msg.read = true;
    await atomicWrite(inboxPath, JSON.stringify(data, null, 2));
  });
}

/**
 * Deletes a specific message from an agent's inbox.
 *
 * @param projectPath - Root project directory
 * @param agentId - Target agent's identifier
 * @param messageId - The message ID to delete
 * @throws {NotFoundError} If the message is not found
 * @throws {FileSystemError} If the write operation fails
 */
export async function deleteMessage(
  projectPath: string,
  agentId: string,
  messageId: string,
): Promise<void> {
  const inboxPath = getInboxPath(projectPath, agentId);
  await ensureInboxFile(inboxPath);

  await withFileLock(inboxPath, async () => {
    const data = await readInboxData(inboxPath);
    const idx = data.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) {
      throw new NotFoundError(
        `Message ${messageId} not found in inbox for agent ${agentId}`,
        'message',
        messageId,
      );
    }
    data.messages.splice(idx, 1);
    await atomicWrite(inboxPath, JSON.stringify(data, null, 2));
  });
}
