/**
 * @command-post/core — Foundational library for the Command Post platform.
 *
 * Provides task types, event logging types, configuration parsing types,
 * and agent registry utilities used by all downstream packages.
 */

// ── Configuration Subsystem ──────────────────────────────────────────
export {
  ProjectConfigSchema,
  TopologyConfigSchema,
} from './config/index.js';
export type { ProjectConfig, TopologyConfig, ConfigAPI } from './config/index.js';
export {
  loadAgentRegistry,
  saveAgentRegistry,
  registerAgent,
  updateAgentStatus,
  getActiveAgents,
  getAgentRegistryPath,
  computeProjectHash,
  discoverTranscriptPath,
  AgentRegistryEntrySchema,
  AgentRegistrySchema,
} from './config/index.js';
export type {
  AgentRegistryEntry,
  AgentRegistry,
} from './config/index.js';

// ── Events Subsystem ─────────────────────────────────────────────────
export {
  SystemEventSchema,
  EventType,
  appendEvent,
} from './events/index.js';
export type { SystemEvent, EventFilters, EventAPI } from './events/index.js';

// ── Task Subsystem ───────────────────────────────────────────────────
export {
  TaskObjectSchema,
  TaskStatus,
  VALID_STATUS_TRANSITIONS,
  RefinementStatusSchema,
  RefinementSchema,
  TaskSourceSchema,
  TaskPrioritySchema,
} from './task/index.js';
export type { TaskObject, TaskFilters, TaskAPI, Refinement, RefinementStatus, TaskSource, TaskPriority } from './task/index.js';
export { createTask, getTask, updateTask, listTasks } from './task/index.js';

// ── Inbox Messaging Subsystem ───────────────────────────────────────
export {
  readInbox,
  getMessage,
  queryMessages,
  writeToInbox,
  markMessageRead,
  deleteMessage,
  sendMessage,
  InboxMessageSchema,
  MessageType,
  Priority,
} from './inbox/index.js';

export type {
  SendMessageOptions,
  NewMessage,
  AgentRole,
  InboxMessage,
  InboxFilters,
  InboxAPI,
} from './inbox/index.js';

// ── Error Classes ───────────────────────────────────────────────────
export {
  ValidationError,
  FileSystemError,
  LockTimeoutError,
  NotFoundError,
} from './errors.js';

// ── Utility Functions ───────────────────────────────────────────────
export { withFileLock } from './utils/file-lock.js';
export type { LockOptions } from './utils/file-lock.js';
export { atomicWrite } from './utils/atomic-write.js';
export { createValidator, validateOrThrow } from './utils/validator.js';
export {
  getProjectRoot,
  getAgentsDir,
  getMessagesDir,
  getInboxPath,
  getTasksDir,
  getTaskPath,
  getEventsDir,
  getEventsPath,
  getMemorySnapshotsDir,
  getConfigPath,
  getTopologyPath,
  getSpawnLogPath,
  getContractsDir,
  getContractPath,
} from './utils/paths.js';

// ── Schema Validators ───────────────────────────────────────────────
export { validateInboxMessage } from './validators.js';

// ── Project Initialization ─────────────────────────────────────────
export { initProjectStructure } from './init.js';
export type { InitConfig } from './init.js';
