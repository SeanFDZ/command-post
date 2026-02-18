import { z } from 'zod';

/** Task status values matching task-object.schema.json enum. */
export const TaskStatus = {
  Pending: 'pending',
  Assigned: 'assigned',
  Ready: 'ready',
  InProgress: 'in_progress',
  Blocked: 'blocked',
  ReadyForReview: 'ready_for_review',
  InReview: 'in_review',
  NeedsRevision: 'needs_revision',
  Approved: 'approved',
  Completed: 'completed',
  Failed: 'failed',
  Error: 'error',
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

/** Valid status transitions.
 *  Permissive to support kanban drag-and-drop between any column
 *  while still preventing nonsensical jumps. */
export const VALID_STATUS_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['assigned', 'ready', 'in_progress', 'ready_for_review', 'approved', 'error', 'failed'],
  assigned: ['ready', 'in_progress', 'pending', 'blocked', 'ready_for_review'],
  ready: ['in_progress', 'pending', 'error'],
  in_progress: ['blocked', 'ready_for_review', 'failed', 'pending', 'ready', 'error', 'approved'],
  blocked: ['in_progress', 'failed', 'pending'],
  ready_for_review: ['in_review', 'needs_revision', 'approved', 'in_progress', 'pending'],
  in_review: ['approved', 'needs_revision', 'ready_for_review', 'in_progress'],
  needs_revision: ['in_progress', 'ready_for_review', 'pending'],
  approved: ['completed', 'in_progress', 'pending'],
  completed: ['pending', 'in_progress'],
  failed: ['pending', 'in_progress', 'ready'],
  error: ['pending', 'in_progress', 'ready'],
};

/** Refinement status for kanban tickets. */
export const RefinementStatusSchema = z.enum(['draft', 'refining', 'refined']);
export type RefinementStatus = z.infer<typeof RefinementStatusSchema>;

/** Refinement data attached to kanban-sourced tickets. */
export const RefinementSchema = z.object({
  status: RefinementStatusSchema,
  requirements: z.string().optional(),
  acceptance_criteria: z.array(z.string()).optional(),
  technical_approach: z.string().optional(),
  files_affected: z.array(z.string()).optional(),
  risks: z.array(z.string()).optional(),
  agent_scope: z.object({
    workers: z.number().int().min(1),
    auditors: z.number().int().min(1),
    domains: z.array(z.string()),
  }).optional(),
  refined_at: z.string().datetime().optional(),
  refined_by: z.string().optional(),
});
export type Refinement = z.infer<typeof RefinementSchema>;

/** Task source: PRD-generated or kanban-created. */
export const TaskSourceSchema = z.enum(['prd', 'kanban']);
export type TaskSource = z.infer<typeof TaskSourceSchema>;

/** Task priority levels. */
export const TaskPrioritySchema = z.enum(['low', 'normal', 'high', 'critical']);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

/** Zod schema for a task object matching task-object.schema.json. */
export const TaskObjectSchema = z.object({
  id: z.string().regex(/^task-\d+$/),
  title: z.string(),
  description: z.string().optional(),
  feature: z.string(),
  domain: z.string(),
  assigned_to: z.string().nullable(),
  assigned_by: z.string(),
  status: z.enum([
    'pending', 'assigned', 'ready', 'in_progress', 'blocked',
    'ready_for_review', 'in_review', 'needs_revision', 'approved',
    'completed', 'failed', 'error',
  ]),
  prd_sections: z.array(z.string()),
  plan: z.object({
    steps: z.array(z.string()),
    current_step: z.number().int().min(0),
    estimated_steps_remaining: z.number().int().min(0),
  }),
  progress: z.object({
    summary: z.string(),
    files_modified: z.array(z.string()).optional(),
    decisions_made: z.array(z.string()).optional(),
    blockers: z.array(z.string()).optional(),
    gotchas: z.array(z.string()).optional(),
  }),
  dependencies: z.object({
    blocked_by: z.array(z.string()),
    blocks: z.array(z.string()),
  }),
  audit: z.object({
    last_audit: z.string().datetime().nullable().optional(),
    compliance_score: z.number().min(0).max(1),
    findings_count: z.number().int().min(0).optional(),
    findings_resolved: z.number().int().min(0).optional(),
  }),
  context: z.object({
    usage_percent: z.number().min(0).max(1),
    handoff_count: z.number().int().min(0),
    last_memory_snapshot: z.string().nullable().optional(),
  }),
  timestamps: z.object({
    created: z.string().datetime(),
    started: z.string().datetime().nullable().optional(),
    last_updated: z.string().datetime(),
    completed: z.string().datetime().nullable().optional(),
  }),
  // Kanban ticket pipeline fields (all optional for backward compat)
  source: TaskSourceSchema.default('prd').optional(),
  refinement: RefinementSchema.optional(),
  parent_ticket_id: z.string().optional(),
  priority: TaskPrioritySchema.default('normal').optional(),
});

/** TypeScript type for a task object. */
export type TaskObject = z.infer<typeof TaskObjectSchema>;

/** Filters for querying tasks. */
export interface TaskFilters {
  status?: TaskStatus;
  assignee?: string;
  domain?: string;
}

/** Public API surface for task operations. */
export interface TaskAPI {
  /** Create a new task with validation. */
  createTask(taskData: TaskObject): Promise<TaskObject>;
  /** Retrieve a task by ID, or null if not found. */
  getTask(taskId: string): Promise<TaskObject | null>;
  /** Atomically update task fields. */
  updateTask(taskId: string, updates: Partial<TaskObject>): Promise<TaskObject>;
  /** List tasks, optionally filtered. */
  listTasks(filters?: TaskFilters): Promise<TaskObject[]>;
  /** Delete a task by ID. */
  deleteTask(taskId: string): Promise<void>;
}
