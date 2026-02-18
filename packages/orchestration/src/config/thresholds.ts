/**
 * Centralized context threshold configuration.
 *
 * All context monitoring components should import thresholds from here
 * rather than hardcoding values. This ensures consistent behavior across
 * ContextDetector, ContextMonitorDaemon, and DegradationStrategy.
 */

export interface ContextThresholds {
  /** Usage percentage (0-1) that triggers a warning event */
  warningThreshold: number;
  /** Usage percentage (0-1) that triggers critical/handoff protocol */
  criticalThreshold: number;
}

/**
 * Default thresholds used across all context monitoring components.
 * Warning at 60% (gives agents plenty of time to write handoff).
 * Critical at 70% (must be well below 80% — Claude Code autocompacts at ~80%,
 * erasing the agent's conversation context before it can act on the message.
 * 10% margin gives the replacement flow time to complete: send snapshot
 * request → agent writes snapshot → spawn replacement → send shutdown).
 */
export const DEFAULT_THRESHOLDS: ContextThresholds = {
  warningThreshold: 0.60,
  criticalThreshold: 0.70,
};

/**
 * Get context thresholds, merging any provided overrides with defaults.
 */
export function getContextThresholds(config?: Partial<ContextThresholds>): ContextThresholds {
  return { ...DEFAULT_THRESHOLDS, ...config };
}
