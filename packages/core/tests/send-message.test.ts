import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sendMessage, readInbox, ValidationError } from '../src/index.js';
import type { NewMessage, SendMessageOptions } from '../src/index.js';

let tmpDir: string;

function baseOptions(overrides: Partial<SendMessageOptions> = {}): SendMessageOptions {
  return {
    projectPath: tmpDir,
    ...overrides,
  };
}

function peerMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    from: 'worker-frontend-1',
    to: 'worker-backend-1',
    type: 'peer_message',
    body: { topic: 'api-contract', content: 'test' },
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'command-post-send-test-'));
  await fs.mkdir(path.join(tmpDir, '.command-post', 'messages'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('sendMessage', () => {
  describe('basic delivery', () => {
    it('delivers a message to the target agent inbox', async () => {
      const msg = peerMessage();
      const result = await sendMessage(msg, baseOptions());

      expect(result.id).toMatch(/^msg-[0-9a-f-]+$/);
      expect(result.from).toBe('worker-frontend-1');
      expect(result.to).toBe('worker-backend-1');
      expect(result.type).toBe('peer_message');
      expect(result.read).toBe(false);
      expect(result.timestamp).toBeTruthy();

      const inbox = await readInbox(tmpDir, 'worker-backend-1');
      expect(inbox).toHaveLength(1);
      expect(inbox[0].id).toBe(result.id);
    });

    it('auto-generates id and timestamp', async () => {
      const result = await sendMessage(peerMessage(), baseOptions());

      expect(result.id).toMatch(/^msg-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(new Date(result.timestamp).getTime()).toBeGreaterThan(0);
    });

    it('defaults priority to normal', async () => {
      const result = await sendMessage(peerMessage(), baseOptions());
      expect(result.priority).toBe('normal');
    });

    it('uses provided priority', async () => {
      const result = await sendMessage(
        peerMessage({ priority: 'high' }),
        baseOptions(),
      );
      expect(result.priority).toBe('high');
    });
  });

  describe('CC delivery', () => {
    it('delivers copies to CC\'d agents', async () => {
      const msg = peerMessage({ cc: ['orchestrator-1'] });
      await sendMessage(msg, baseOptions());

      const targetInbox = await readInbox(tmpDir, 'worker-backend-1');
      const ccInbox = await readInbox(tmpDir, 'orchestrator-1');

      expect(targetInbox).toHaveLength(1);
      expect(ccInbox).toHaveLength(1);
      expect(targetInbox[0].id).toBe(ccInbox[0].id);
    });

    it('does not double-deliver when CC includes the primary recipient', async () => {
      const msg = peerMessage({ cc: ['worker-backend-1', 'orchestrator-1'] });
      await sendMessage(msg, baseOptions());

      const targetInbox = await readInbox(tmpDir, 'worker-backend-1');
      expect(targetInbox).toHaveLength(1); // Not 2
    });

    it('auto-CCs orchestrator on worker-to-worker messages when configured', async () => {
      const msg = peerMessage();
      await sendMessage(msg, baseOptions({
        senderRole: 'worker',
        targetRole: 'worker',
        ccOrchestrator: true,
        orchestratorId: 'orchestrator-1',
      }));

      const orchInbox = await readInbox(tmpDir, 'orchestrator-1');
      expect(orchInbox).toHaveLength(1);
      expect(orchInbox[0].cc).toContain('orchestrator-1');
    });

    it('does not auto-CC orchestrator when ccOrchestrator is false', async () => {
      const msg = peerMessage();
      await sendMessage(msg, baseOptions({
        senderRole: 'worker',
        targetRole: 'worker',
        ccOrchestrator: false,
      }));

      const orchInbox = await readInbox(tmpDir, 'orchestrator-1');
      expect(orchInbox).toHaveLength(0);
    });

    it('does not duplicate orchestrator in CC if already present', async () => {
      const msg = peerMessage({ cc: ['orchestrator-1'] });
      await sendMessage(msg, baseOptions({
        senderRole: 'worker',
        targetRole: 'worker',
        ccOrchestrator: true,
        orchestratorId: 'orchestrator-1',
      }));

      const orchInbox = await readInbox(tmpDir, 'orchestrator-1');
      expect(orchInbox).toHaveLength(1);
    });
  });

  describe('sender role validation', () => {
    it('allows orchestrator to send task_assignment', async () => {
      const msg: NewMessage = {
        from: 'orchestrator-1',
        to: 'worker-frontend-1',
        type: 'task_assignment',
        body: { task_id: 'task-001', instruction: 'Build it' },
      };

      const result = await sendMessage(msg, baseOptions({ senderRole: 'orchestrator' }));
      expect(result.type).toBe('task_assignment');
    });

    it('rejects worker sending task_assignment', async () => {
      const msg: NewMessage = {
        from: 'worker-frontend-1',
        to: 'worker-backend-1',
        type: 'task_assignment',
        body: { task_id: 'task-001', instruction: 'Build it' },
      };

      await expect(
        sendMessage(msg, baseOptions({ senderRole: 'worker' })),
      ).rejects.toThrow(ValidationError);
    });

    it('allows worker to send task_update', async () => {
      const msg: NewMessage = {
        from: 'worker-frontend-1',
        to: 'orchestrator-1',
        type: 'task_update',
        body: { status: 'completed' },
      };

      const result = await sendMessage(msg, baseOptions({ senderRole: 'worker' }));
      expect(result.type).toBe('task_update');
    });

    it('allows audit agent to send audit_report', async () => {
      const msg: NewMessage = {
        from: 'audit-frontend',
        to: 'orchestrator-1',
        type: 'audit_report',
        body: { compliance_score: 0.95 },
      };

      const result = await sendMessage(msg, baseOptions({ senderRole: 'audit' }));
      expect(result.type).toBe('audit_report');
    });

    it('rejects audit agent sending task_assignment', async () => {
      const msg: NewMessage = {
        from: 'audit-frontend',
        to: 'worker-frontend-1',
        type: 'task_assignment',
        body: { task_id: 'task-001' },
      };

      await expect(
        sendMessage(msg, baseOptions({ senderRole: 'audit' })),
      ).rejects.toThrow(ValidationError);
    });

    it('allows context-monitor to send lifecycle_command', async () => {
      const msg: NewMessage = {
        from: 'context-monitor-1',
        to: 'worker-frontend-1',
        type: 'lifecycle_command',
        body: { command: 'write_memory_snapshot', reason: 'context_usage_high', current_usage: 0.82 },
      };

      const result = await sendMessage(msg, baseOptions({ senderRole: 'context-monitor' }));
      expect(result.type).toBe('lifecycle_command');
    });

    it('skips validation when senderRole is not provided', async () => {
      const msg: NewMessage = {
        from: 'unknown-agent',
        to: 'orchestrator-1',
        type: 'task_assignment',
        body: {},
      };

      // Should succeed because no senderRole means no role validation
      const result = await sendMessage(msg, baseOptions());
      expect(result.type).toBe('task_assignment');
    });

    it('skips validation when skipValidation is true', async () => {
      const msg: NewMessage = {
        from: 'worker-frontend-1',
        to: 'worker-backend-1',
        type: 'task_assignment', // normally forbidden for workers
        body: {},
      };

      const result = await sendMessage(msg, baseOptions({
        senderRole: 'worker',
        skipValidation: true,
      }));
      expect(result.type).toBe('task_assignment');
    });
  });

  describe('lateral messaging constraints', () => {
    it('allows worker-to-worker peer_message when lateral enabled', async () => {
      const result = await sendMessage(peerMessage(), baseOptions({
        senderRole: 'worker',
        targetRole: 'worker',
        lateralMessagingEnabled: true,
      }));

      expect(result.type).toBe('peer_message');
    });

    it('rejects worker-to-worker messages when lateral disabled', async () => {
      await expect(
        sendMessage(peerMessage(), baseOptions({
          senderRole: 'worker',
          targetRole: 'worker',
          lateralMessagingEnabled: false,
        })),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects worker sending non-peer_message to another worker', async () => {
      const msg: NewMessage = {
        from: 'worker-frontend-1',
        to: 'worker-backend-1',
        type: 'task_update', // not allowed between workers
        body: {},
      };

      await expect(
        sendMessage(msg, baseOptions({
          senderRole: 'worker',
          targetRole: 'worker',
          lateralMessagingEnabled: true,
        })),
      ).rejects.toThrow(ValidationError);
    });

    it('does not apply lateral constraints for worker-to-orchestrator', async () => {
      const msg: NewMessage = {
        from: 'worker-frontend-1',
        to: 'orchestrator-1',
        type: 'task_update',
        body: { status: 'completed' },
      };

      const result = await sendMessage(msg, baseOptions({
        senderRole: 'worker',
        targetRole: 'orchestrator',
        lateralMessagingEnabled: false, // shouldn't matter for non-lateral
      }));

      expect(result.type).toBe('task_update');
    });
  });

  describe('topology validation', () => {
    const knownAgents = new Set(['orchestrator-1', 'worker-frontend-1', 'worker-backend-1']);

    it('allows messages to known agents', async () => {
      const result = await sendMessage(peerMessage(), baseOptions({
        knownAgentIds: knownAgents,
      }));
      expect(result.to).toBe('worker-backend-1');
    });

    it('rejects messages to unknown agents', async () => {
      const msg = peerMessage({ to: 'nonexistent-agent' });

      await expect(
        sendMessage(msg, baseOptions({
          knownAgentIds: knownAgents,
        })),
      ).rejects.toThrow(ValidationError);
    });

    it('validates CC agents against topology', async () => {
      const msg = peerMessage({ cc: ['nonexistent-cc-agent'] });

      await expect(
        sendMessage(msg, baseOptions({
          knownAgentIds: knownAgents,
        })),
      ).rejects.toThrow(ValidationError);
    });

    it('skips topology validation when knownAgentIds not provided', async () => {
      const msg = peerMessage({ to: 'any-agent-id' });

      const result = await sendMessage(msg, baseOptions());
      expect(result.to).toBe('any-agent-id');
    });
  });
});
