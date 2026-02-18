// @command-post/cli — barrel export

// ── Tmux Session Management ────────────────────────────────────────
export {
  // Types
  type Session,
  type SessionStatus,
  type AgentStatusRow,
  type AgentRunnerConfig,
  type EventQuery,
  type TaskQuery,

  // Executor
  tmux,
  isTmuxAvailable,

  // Session management
  createSession,
  setSessionAttribute,
  getSessionAttribute,
  killSession,
  listSessions,
  sessionExists,
  killProjectSessions,
  sessionName,

  // Send keys
  sendKeys,

  // Status detection
  getSessionStatus,
  getAgentStatuses,
  createStatusDetector,

  // Agent runner
  writeRunnerScript,
  buildRunnerCommand,
  getRunnerScriptPath,
} from './tmux/index.js';

// ── Agent Launcher ──────────────────────────────────────────────────
export { createAgentSession } from './utils/agent-launcher.js';
export type { AgentLaunchConfig } from './utils/agent-launcher.js';

// ── Utilities ───────────────────────────────────────────────────────
export { CLIError, ExitCode, handleError, NotImplementedError } from './utils/error-handler.js';
export { logger, setVerbose, isVerbose } from './utils/logger.js';
