import { z } from 'zod';

/** Event type values matching event-log.schema.json enum. */
export const EventType = {
  AgentSpawned: 'agent_spawned',
  AgentShutdown: 'agent_shutdown',
  TaskCreated: 'task_created',
  TaskStatusChanged: 'task_status_changed',
  MessageSent: 'message_sent',
  AuditCompleted: 'audit_completed',
  MemorySnapshotCreated: 'memory_snapshot_created',
  HandoffCompleted: 'handoff_completed',
  ApprovalRequested: 'approval_requested',
  ApprovalResolved: 'approval_resolved',
  ErrorOccurred: 'error_occurred',
  ContextMetric: 'context_metric',
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

/** Zod schema for a system event matching event-log.schema.json. */
export const SystemEventSchema = z.object({
  event_id: z.string().uuid(),
  timestamp: z.string().datetime(),
  event_type: z.enum([
    'agent_spawned', 'agent_shutdown', 'task_created', 'task_status_changed',
    'message_sent', 'audit_completed', 'memory_snapshot_created',
    'handoff_completed', 'approval_requested', 'approval_resolved', 'error_occurred',
    'context_metric',
  ]),
  agent_id: z.string().nullable().optional(),
  data: z.record(z.unknown()).optional(),
});

/** TypeScript type for a system event. */
export type SystemEvent = z.infer<typeof SystemEventSchema>;

/** Filters for querying events. */
export interface EventFilters {
  agentId?: string;
  eventType?: EventType;
  startTime?: string;
  endTime?: string;
}

/** Public API surface for event logging operations. */
export interface EventAPI {
  /** Append an event to the event log. */
  appendEvent(event: SystemEvent): Promise<void>;
  /** Query events with optional filters. */
  queryEvents(filters: EventFilters): Promise<SystemEvent[]>;
  /** Clear all events from the log. */
  clearEvents(): Promise<void>;
}
