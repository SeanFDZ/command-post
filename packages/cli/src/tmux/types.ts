/** Possible agent/session statuses. */
export type SessionStatus = 'idle' | 'running' | 'error' | 'waiting' | 'stopped';

/** Parsed tmux session information with Command Post attributes. */
export interface Session {
  name: string;
  agentId: string;
  domain: string;
  role: string;
  active: boolean;
  createdAt: string;
}

/** Row data for the status table display. */
export interface AgentStatusRow {
  agentId: string;
  role: string;
  domain: string | null;
  status: SessionStatus;
  contextPercent: number | null;
  complianceScore: number | null;
  lastActivity: string | null;
}
