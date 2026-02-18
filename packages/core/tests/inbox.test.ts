import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import {
  readInbox,
  writeToInbox,
  markMessageRead,
  deleteMessage,
  getMessage,
  queryMessages,
} from '../src/index.js';
import { NotFoundError } from '../src/index.js';
import type { InboxMessage } from '../src/index.js';

let tmpDir: string;

function makeMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  const uuid = uuidv4();
  return {
    id: `msg-${uuid}`,
    from: 'agent-sender',
    to: 'agent-receiver',
    timestamp: new Date().toISOString(),
    type: 'peer_message',
    priority: 'normal',
    body: { topic: 'test', content: 'hello' },
    read: false,
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'command-post-inbox-test-'));
  // Create messages directory
  await fs.mkdir(path.join(tmpDir, '.command-post', 'messages'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('readInbox', () => {
  it('returns empty array for non-existent inbox', async () => {
    const messages = await readInbox(tmpDir, 'nonexistent-agent');
    expect(messages).toEqual([]);
  });

  it('reads messages from existing inbox', async () => {
    const msg = makeMessage();
    const inboxPath = path.join(tmpDir, '.command-post', 'messages', 'agent-1.json');
    await fs.writeFile(inboxPath, JSON.stringify({ messages: [msg] }, null, 2));

    const messages = await readInbox(tmpDir, 'agent-1');
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(msg.id);
  });

  it('handles empty inbox file', async () => {
    const inboxPath = path.join(tmpDir, '.command-post', 'messages', 'agent-1.json');
    await fs.writeFile(inboxPath, JSON.stringify({ messages: [] }));

    const messages = await readInbox(tmpDir, 'agent-1');
    expect(messages).toEqual([]);
  });
});

describe('writeToInbox', () => {
  it('creates inbox file if not exists and writes message', async () => {
    const msg = makeMessage();
    await writeToInbox(tmpDir, 'new-agent', msg);

    const messages = await readInbox(tmpDir, 'new-agent');
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(msg.id);
  });

  it('appends message to existing inbox', async () => {
    const msg1 = makeMessage();
    const msg2 = makeMessage();

    await writeToInbox(tmpDir, 'agent-1', msg1);
    await writeToInbox(tmpDir, 'agent-1', msg2);

    const messages = await readInbox(tmpDir, 'agent-1');
    expect(messages).toHaveLength(2);
  });

  it('handles 5+ concurrent writes without data loss', { timeout: 30000 }, async () => {
    const messages = Array.from({ length: 6 }, () => makeMessage());

    await Promise.all(
      messages.map((msg) => writeToInbox(tmpDir, 'concurrent-agent', msg)),
    );

    const result = await readInbox(tmpDir, 'concurrent-agent');
    expect(result).toHaveLength(6);

    // Verify all unique messages are present
    const ids = new Set(result.map((m) => m.id));
    expect(ids.size).toBe(6);
  });

  it('handles large inbox (1000+ messages)', async () => {
    // Pre-create inbox with 1000 messages
    const existingMessages = Array.from({ length: 1000 }, () => makeMessage());
    const inboxPath = path.join(tmpDir, '.command-post', 'messages', 'big-agent.json');
    await fs.writeFile(
      inboxPath,
      JSON.stringify({ messages: existingMessages }, null, 2),
    );

    const newMsg = makeMessage();
    await writeToInbox(tmpDir, 'big-agent', newMsg);

    const result = await readInbox(tmpDir, 'big-agent');
    expect(result).toHaveLength(1001);
  });
});

describe('markMessageRead', () => {
  it('marks a message as read', async () => {
    const msg = makeMessage({ read: false });
    await writeToInbox(tmpDir, 'agent-1', msg);

    await markMessageRead(tmpDir, 'agent-1', msg.id);

    const messages = await readInbox(tmpDir, 'agent-1');
    expect(messages[0].read).toBe(true);
  });

  it('throws NotFoundError for non-existent message', async () => {
    await writeToInbox(tmpDir, 'agent-1', makeMessage());

    await expect(
      markMessageRead(tmpDir, 'agent-1', 'msg-00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('deleteMessage', () => {
  it('removes a message from inbox', async () => {
    const msg1 = makeMessage();
    const msg2 = makeMessage();
    await writeToInbox(tmpDir, 'agent-1', msg1);
    await writeToInbox(tmpDir, 'agent-1', msg2);

    await deleteMessage(tmpDir, 'agent-1', msg1.id);

    const messages = await readInbox(tmpDir, 'agent-1');
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(msg2.id);
  });

  it('throws NotFoundError for non-existent message', async () => {
    await writeToInbox(tmpDir, 'agent-1', makeMessage());

    await expect(
      deleteMessage(tmpDir, 'agent-1', 'msg-00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('getMessage', () => {
  it('returns message by ID', async () => {
    const msg = makeMessage();
    await writeToInbox(tmpDir, 'agent-1', msg);

    const found = await getMessage(tmpDir, 'agent-1', msg.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(msg.id);
  });

  it('returns null for non-existent message', async () => {
    const found = await getMessage(tmpDir, 'agent-1', 'msg-00000000-0000-0000-0000-000000000000');
    expect(found).toBeNull();
  });
});

describe('queryMessages', () => {
  it('filters by type', async () => {
    const msg1 = makeMessage({ type: 'peer_message' });
    const msg2 = makeMessage({ type: 'task_assignment' });
    await writeToInbox(tmpDir, 'agent-1', msg1);
    await writeToInbox(tmpDir, 'agent-1', msg2);

    const result = await queryMessages(tmpDir, 'agent-1', { type: 'peer_message' });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('peer_message');
  });

  it('filters by read status', async () => {
    const msg1 = makeMessage({ read: false });
    const msg2 = makeMessage({ read: true });
    await writeToInbox(tmpDir, 'agent-1', msg1);
    await writeToInbox(tmpDir, 'agent-1', msg2);

    const unread = await queryMessages(tmpDir, 'agent-1', { read: false });
    expect(unread).toHaveLength(1);
  });

  it('filters by priority', async () => {
    const msg1 = makeMessage({ priority: 'critical' });
    const msg2 = makeMessage({ priority: 'low' });
    await writeToInbox(tmpDir, 'agent-1', msg1);
    await writeToInbox(tmpDir, 'agent-1', msg2);

    const critical = await queryMessages(tmpDir, 'agent-1', { priority: 'critical' });
    expect(critical).toHaveLength(1);
    expect(critical[0].priority).toBe('critical');
  });

  it('filters by sender', async () => {
    const msg1 = makeMessage({ from: 'agent-a' });
    const msg2 = makeMessage({ from: 'agent-b' });
    await writeToInbox(tmpDir, 'agent-1', msg1);
    await writeToInbox(tmpDir, 'agent-1', msg2);

    const fromA = await queryMessages(tmpDir, 'agent-1', { from: 'agent-a' });
    expect(fromA).toHaveLength(1);
  });

  it('returns all messages with no filters', async () => {
    await writeToInbox(tmpDir, 'agent-1', makeMessage());
    await writeToInbox(tmpDir, 'agent-1', makeMessage());

    const all = await queryMessages(tmpDir, 'agent-1');
    expect(all).toHaveLength(2);
  });
});
