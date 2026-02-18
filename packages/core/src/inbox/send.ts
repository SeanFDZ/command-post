import { v4 as uuidv4 } from 'uuid';
import { writeToInbox } from './write.js';
import { ValidationError } from '../errors.js';
import { MessageType, Priority } from './types.js';
import type { InboxMessage } from './types.js';

/**
 * Agent role as defined in the topology schema.
 * Used for message routing validation.
 */
export type AgentRole = 'orchestrator' | 'po' | 'audit' | 'worker' | 'context-monitor' | 'security' | 'coordinator' | 'specialist';

/**
 * Options for sendMessage that control validation and delivery behavior.
 */
export interface SendMessageOptions {
  /** The project root path (required for file operations). */
  projectPath: string;

  /** Role of the sending agent (enables routing validation). */
  senderRole?: AgentRole;

  /** Role of the target agent (enables routing validation). */
  targetRole?: AgentRole;

  /**
   * Whether lateral (worker-to-worker) messaging is enabled.
   * Maps to config.agents.workers.lateral_messaging.
   * Defaults to true.
   */
  lateralMessagingEnabled?: boolean;

  /**
   * Whether to auto-CC the orchestrator on lateral messages.
   * Maps to config.agents.workers.cc_orchestrator.
   * Defaults to false.
   */
  ccOrchestrator?: boolean;

  /** The orchestrator agent ID to CC when ccOrchestrator is true. */
  orchestratorId?: string;

  /**
   * Set of valid agent IDs from the topology.
   * When provided, target agent is validated against this set.
   */
  knownAgentIds?: ReadonlySet<string>;

  /**
   * Skip all routing validation.
   * Useful for system-level messages (e.g., from CLI).
   */
  skipValidation?: boolean;
}

/**
 * Parameters for constructing a new message.
 * Unlike InboxMessage, id and timestamp are auto-generated.
 */
export interface NewMessage {
  from: string;
  to: string;
  type: InboxMessage['type'];
  priority?: InboxMessage['priority'];
  body: Record<string, unknown>;
  cc?: string[];
}

/**
 * Defines which message types each role is allowed to send.
 * This enforces the PRD communication constraints:
 * - Only orchestrator/PO can send task_assignment and feedback
 * - Workers can send task_update, peer_message, escalation, memory_handoff
 * - Audit agents can only send audit_report and escalation
 * - Context Monitor sends lifecycle_command and can receive memory_handoff
 */
const ROLE_SEND_PERMISSIONS: Record<AgentRole, readonly string[]> = {
  orchestrator: [
    MessageType.TaskAssignment,
    MessageType.Feedback,
    MessageType.TaskUpdate,
    MessageType.Escalation,
    MessageType.HumanApprovalRequest,
    MessageType.LifecycleCommand,
  ],
  po: [
    MessageType.TaskAssignment,
    MessageType.Feedback,
    MessageType.TaskUpdate,
    MessageType.Escalation,
  ],
  worker: [
    MessageType.TaskUpdate,
    MessageType.PeerMessage,
    MessageType.Escalation,
    MessageType.MemoryHandoff,
  ],
  audit: [
    MessageType.AuditReport,
    MessageType.Escalation,
  ],
  security: [
    MessageType.AuditReport,
    MessageType.Escalation,
  ],
  'context-monitor': [
    MessageType.LifecycleCommand,
    MessageType.TaskUpdate,
    MessageType.Escalation,
  ],
  coordinator: [
    MessageType.TaskAssignment,
    MessageType.Feedback,
    MessageType.TaskUpdate,
    MessageType.Escalation,
  ],
  specialist: [
    MessageType.TaskUpdate,
    MessageType.PeerMessage,
    MessageType.Escalation,
    MessageType.MemoryHandoff,
  ],
};

/**
 * Validates that the sender's role permits sending the given message type.
 *
 * @throws {ValidationError} If the sender role cannot send this message type
 */
function validateSenderPermission(
  senderRole: AgentRole,
  messageType: string,
  from: string,
): void {
  const allowed = ROLE_SEND_PERMISSIONS[senderRole];
  if (!allowed.includes(messageType)) {
    throw new ValidationError(
      `Agent "${from}" with role "${senderRole}" is not permitted to send message type "${messageType}". ` +
      `Allowed types: ${allowed.join(', ')}`,
      'inbox/send',
      [{ senderRole, messageType, allowed }],
    );
  }
}

/**
 * Validates lateral messaging constraints per PRD Section 4.3:
 * - Workers cannot assign tasks to each other
 * - Workers cannot override each other's task status
 * - Lateral messaging must be enabled in config
 *
 * @throws {ValidationError} If lateral constraints are violated
 */
function validateLateralConstraints(
  message: NewMessage,
  senderRole: AgentRole | undefined,
  targetRole: AgentRole | undefined,
  lateralEnabled: boolean,
): void {
  // Only apply lateral constraints for worker-to-worker communication
  if (senderRole !== 'worker' || targetRole !== 'worker') {
    return;
  }

  if (!lateralEnabled) {
    throw new ValidationError(
      `Lateral messaging is disabled. Worker "${message.from}" cannot send messages to worker "${message.to}". ` +
      `Enable agents.workers.lateral_messaging in config.yaml.`,
      'inbox/send',
      [{ from: message.from, to: message.to, lateralEnabled }],
    );
  }

  // Workers can only send peer_message to other workers
  if (message.type !== MessageType.PeerMessage) {
    throw new ValidationError(
      `Worker "${message.from}" can only send "peer_message" to other workers. ` +
      `Attempted to send "${message.type}" to worker "${message.to}". ` +
      `Use the orchestrator for task assignments and status overrides.`,
      'inbox/send',
      [{ from: message.from, to: message.to, type: message.type }],
    );
  }
}

/**
 * Validates the target agent exists in the known topology.
 *
 * @throws {ValidationError} If the target agent is not in the known set
 */
function validateTargetExists(
  to: string,
  knownAgentIds: ReadonlySet<string>,
): void {
  if (!knownAgentIds.has(to)) {
    throw new ValidationError(
      `Target agent "${to}" does not exist in the project topology. ` +
      `Known agents: ${[...knownAgentIds].join(', ')}`,
      'inbox/send',
      [{ to, knownAgents: [...knownAgentIds] }],
    );
  }
}

/**
 * Sends a message to an agent's inbox with optional routing validation,
 * CC delivery, and lateral messaging enforcement.
 *
 * This is the recommended high-level function for inter-agent communication.
 * It wraps writeToInbox with additional safety checks per PRD Section 4.
 *
 * Features:
 * - Auto-generates message ID (msg-{uuid}) and timestamp
 * - Validates sender role permissions (optional)
 * - Enforces lateral messaging constraints (optional)
 * - Validates target agent exists in topology (optional)
 * - Delivers copies to all CC'd agents
 * - Auto-CCs orchestrator on worker-to-worker messages when configured
 *
 * @param message - The message to send (id and timestamp are auto-generated)
 * @param options - Delivery and validation options
 * @returns The fully constructed InboxMessage that was delivered
 * @throws {ValidationError} If routing validation fails
 * @throws {FileSystemError} If the write operation fails
 *
 * @example
 * ```typescript
 * // Worker sends peer message to another worker
 * await sendMessage(
 *   {
 *     from: 'worker-frontend-1',
 *     to: 'worker-backend-1',
 *     type: 'peer_message',
 *     body: {
 *       topic: 'api-contract',
 *       content: 'Proposing /api/tasks endpoint shape',
 *       related_tasks: ['task-005', 'task-012'],
 *     },
 *   },
 *   {
 *     projectPath: '/path/to/project',
 *     senderRole: 'worker',
 *     targetRole: 'worker',
 *     lateralMessagingEnabled: true,
 *     ccOrchestrator: true,
 *     orchestratorId: 'orchestrator-1',
 *   },
 * );
 * ```
 */
export async function sendMessage(
  message: NewMessage,
  options: SendMessageOptions,
): Promise<InboxMessage> {
  const {
    projectPath,
    senderRole,
    targetRole,
    lateralMessagingEnabled = true,
    ccOrchestrator = false,
    orchestratorId,
    knownAgentIds,
    skipValidation = false,
  } = options;

  // ── Validation ──────────────────────────────────────────────────────
  if (!skipValidation) {
    // Validate sender permissions
    if (senderRole) {
      validateSenderPermission(senderRole, message.type, message.from);
    }

    // Validate lateral messaging constraints
    validateLateralConstraints(message, senderRole, targetRole, lateralMessagingEnabled);

    // Validate target exists in topology
    if (knownAgentIds) {
      validateTargetExists(message.to, knownAgentIds);
    }
  }

  // ── Build full message ──────────────────────────────────────────────
  const ccList = [...(message.cc ?? [])];

  // Auto-CC orchestrator on worker-to-worker messages per config
  if (
    ccOrchestrator &&
    orchestratorId &&
    senderRole === 'worker' &&
    targetRole === 'worker' &&
    !ccList.includes(orchestratorId)
  ) {
    ccList.push(orchestratorId);
  }

  const fullMessage: InboxMessage = {
    id: `msg-${uuidv4()}`,
    from: message.from,
    to: message.to,
    timestamp: new Date().toISOString(),
    type: message.type,
    priority: message.priority ?? Priority.Normal,
    body: message.body,
    read: false,
    ...(ccList.length > 0 ? { cc: ccList } : {}),
  };

  // ── Deliver to primary recipient ────────────────────────────────────
  await writeToInbox(projectPath, message.to, fullMessage);

  // ── Deliver to CC'd agents ──────────────────────────────────────────
  for (const ccAgent of ccList) {
    // Don't double-deliver if CC'd agent is the primary recipient
    if (ccAgent === message.to) continue;

    // Validate CC'd agent exists if topology is provided
    if (knownAgentIds && !skipValidation) {
      validateTargetExists(ccAgent, knownAgentIds);
    }

    await writeToInbox(projectPath, ccAgent, fullMessage);
  }

  return fullMessage;
}
