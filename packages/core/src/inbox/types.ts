import { z } from 'zod';

/** Message type categories matching the inbox-message.schema.json enum. */
export const MessageType = {
  TaskAssignment: 'task_assignment',
  TaskUpdate: 'task_update',
  AuditReport: 'audit_report',
  Feedback: 'feedback',
  PeerMessage: 'peer_message',
  LifecycleCommand: 'lifecycle_command',
  MemoryHandoff: 'memory_handoff',
  Escalation: 'escalation',
  HumanApprovalRequest: 'human_approval_request',
  HumanApprovalResponse: 'human_approval_response',
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/** Priority levels for messages. */
export const Priority = {
  Low: 'low',
  Normal: 'normal',
  High: 'high',
  Critical: 'critical',
} as const;

export type Priority = (typeof Priority)[keyof typeof Priority];

/** Zod schema for an inbox message. */
export const InboxMessageSchema = z.object({
  id: z.string().regex(/^msg-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  from: z.string(),
  to: z.string(),
  timestamp: z.string().datetime(),
  type: z.enum([
    'task_assignment', 'task_update', 'audit_report', 'feedback',
    'peer_message', 'lifecycle_command', 'memory_handoff', 'escalation',
    'human_approval_request', 'human_approval_response',
  ]),
  priority: z.enum(['low', 'normal', 'high', 'critical']),
  body: z.record(z.unknown()),
  read: z.boolean().default(false),
  cc: z.array(z.string()).optional(),
});

/** TypeScript type for a single inbox message. */
export type InboxMessage = z.infer<typeof InboxMessageSchema>;

/** Filters for querying inbox messages. */
export interface InboxFilters {
  type?: MessageType;
  from?: string;
  read?: boolean;
  priority?: Priority;
}

/** Public API surface for inbox operations. */
export interface InboxAPI {
  /** Read all messages from an agent's inbox. */
  readInbox(agentId: string): Promise<InboxMessage[]>;
  /** Write a message to an agent's inbox. */
  writeToInbox(agentId: string, message: InboxMessage): Promise<void>;
  /** Mark a specific message as read. */
  markMessageRead(agentId: string, messageId: string): Promise<void>;
  /** Delete a specific message from an agent's inbox. */
  deleteMessage(agentId: string, messageId: string): Promise<void>;
}
