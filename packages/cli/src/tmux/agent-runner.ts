/**
 * Agent Runner — generates the bash loop that keeps Claude Code running
 * within a tmux session. After each Claude turn completes, the runner
 * checks the inbox for new messages and restarts Claude with context.
 *
 * The runner script does:
 *   1. Read the agent's inbox for unread messages
 *   2. Compose a continuation prompt with inbox summary
 *   3. Launch `claude --print` with the prompt
 *   4. On exit, loop back to step 1 (unless max iterations or shutdown received)
 *
 * This solves the "agents pause at the prompt" problem identified in v1.0 testing.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { getProjectRoot } from '@command-post/core';

/** Configuration for the agent runner script. */
export interface AgentRunnerConfig {
  /** Project root path. */
  projectPath: string;
  /** Agent identifier. */
  agentId: string;
  /** Agent role. */
  role: string;
  /** Agent domain. */
  domain: string;
  /** Max consecutive turns before pausing. Default: 50. */
  maxTurns?: number;
  /** Seconds between turns (cooldown). Default: 5. */
  cooldownSeconds?: number;
  /** Whether to use --print mode (non-interactive). Default: true. */
  printMode?: boolean;
  /** Project output directory from config (e.g. './output'). Default: './output'. */
  outputDir?: string;
  /** Extra system prompt lines from tool profile. */
  systemPromptExtras?: string[];
}

/**
 * Generates the path where the agent runner script will be written.
 */
export function getRunnerScriptPath(projectPath: string, agentId: string): string {
  return path.join(getProjectRoot(projectPath), 'agents', agentId, 'runner.sh');
}

/**
 * Generates and writes a bash runner script for an agent.
 *
 * The script:
 *   - Loops up to maxTurns times
 *   - Before each turn, reads inbox messages and composes a prompt
 *   - Invokes `claude --print` (or interactive claude) with the prompt
 *   - Checks for shutdown signals in the inbox
 *   - Writes a heartbeat event after each turn
 *   - Sleeps between turns to avoid rate limits
 */
export async function writeRunnerScript(config: AgentRunnerConfig): Promise<string> {
  const {
    projectPath,
    agentId,
    role,
    domain,
    maxTurns = 50,
    cooldownSeconds = 5,
    printMode = true,
    outputDir = './output',
    systemPromptExtras = [],
  } = config;

  const cpRoot = getProjectRoot(projectPath);
  const instructionsPath = path.join(cpRoot, 'agents', agentId, 'INSTRUCTIONS.md');
  const inboxPath = path.join(cpRoot, 'messages', agentId + '.json');
  const eventsPath = path.join(cpRoot, 'events', 'events.jsonl');
  const stateFile = path.join(cpRoot, 'agents', agentId + '.state.json');
  const scriptPath = getRunnerScriptPath(projectPath, agentId);

  // Ensure agent directory exists
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });

  const claudeCmd = printMode
    ? `claude --print --dangerously-skip-permissions`
    : `claude --dangerously-skip-permissions`;

  // Build the bash script as an array of lines to avoid template literal
  // collisions between TypeScript ${} and bash ${} syntax.
  const lines: string[] = [
    '#!/usr/bin/env bash',
    '# ═══════════════════════════════════════════════════════════════════',
    `# Command Post Agent Runner — Auto-continue loop for ${agentId}`,
    `# Role: ${role} | Domain: ${domain}`,
    '# ═══════════════════════════════════════════════════════════════════',
    '',
    'set -euo pipefail',
    '',
    `PROJECT_PATH="${projectPath}"`,
    `AGENT_ID="${agentId}"`,
    `ROLE="${role}"`,
    `DOMAIN="${domain}"`,
    `MAX_TURNS=${maxTurns}`,
    `COOLDOWN=${cooldownSeconds}`,
    `INSTRUCTIONS="${instructionsPath}"`,
    `INBOX="${inboxPath}"`,
    `EVENTS="${eventsPath}"`,
    `STATE_FILE="${stateFile}"`,
    'TURN=0',
    '',
    '# Logging helpers',
    'log_info()  { echo "[$(/bin/date -u +%H:%M:%S)] [$AGENT_ID] $*"; }',
    'log_event() {',
    '  local event_type="$1"',
    '  local data="$2"',
    '  local timestamp',
    '  timestamp=$(/bin/date -u +"%Y-%m-%dT%H:%M:%SZ")',
    '  local event_id',
    '  event_id="evt-$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen 2>/dev/null || echo $$-$RANDOM)"',
    '  echo "{\\"event_id\\":\\"$event_id\\",\\"timestamp\\":\\"$timestamp\\",\\"event_type\\":\\"$event_type\\",\\"agent_id\\":\\"$AGENT_ID\\",\\"data\\":$data}" >> "$EVENTS" 2>/dev/null || true',
    '}',
    '',
    '# Check if agent is paused',
    'is_paused() {',
    '  if [ -f "$STATE_FILE" ]; then',
    '    local paused',
    '    paused=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get(\'paused\', False))" "$STATE_FILE" 2>/dev/null || echo "False")',
    '    [ "$paused" = "True" ]',
    '  else',
    '    return 1',
    '  fi',
    '}',
    '',
    '# Check for shutdown signal in inbox',
    'has_shutdown_signal() {',
    '  if [ -f "$INBOX" ]; then',
    '    python3 -c "',
    'import json, sys',
    'try:',
    '  data = json.load(open(sys.argv[1]))',
    '  for msg in data.get(\'messages\', []):',
    '    if not msg.get(\'read\') and msg.get(\'type\') == \'lifecycle_command\':',
    '      cmd = msg.get(\'body\', {}).get(\'command\', \'\')',
    '      if cmd in (\'prepare_shutdown\', \'shutdown\', \'terminate\'):',
    '        print(\'SHUTDOWN\')',
    '        sys.exit(0)',
    'except Exception:',
    '  pass',
    '" "$INBOX" 2>/dev/null | grep -q "SHUTDOWN"',
    '  else',
    '    return 1',
    '  fi',
    '}',
    '',
    '# Read unread inbox messages and compose a summary',
    'read_inbox_summary() {',
    '  if [ ! -f "$INBOX" ]; then',
    '    echo "No messages in inbox."',
    '    return',
    '  fi',
    '  python3 -c "',
    'import json, sys',
    'try:',
    '  data = json.load(open(sys.argv[1]))',
    '  unread = [m for m in data.get(\'messages\', []) if not m.get(\'read\')]',
    '  if not unread:',
    '    print(\'No unread messages.\')',
    '  else:',
    '    print(str(len(unread)) + \' unread message(s):\')',
    '    for m in unread[-10:]:', // Show last 10
    '      mtype = m.get(\'type\', \'unknown\')',
    '      frm = m.get(\'from\', \'unknown\')',
    '      body = json.dumps(m.get(\'body\', {}))[:200]',
    '      print(\'  - [\' + mtype + \'] from \' + frm + \': \' + body)',
    'except Exception as e:',
    '  print(\'Could not read inbox: \' + str(e))',
    '" "$INBOX" 2>/dev/null || echo "Could not read inbox."',
    '}',
    '',
    '# ═══════════════════════════════════════════════════════════════════',
    '# Main loop',
    '# ═══════════════════════════════════════════════════════════════════',
    'cd "$PROJECT_PATH"',
    '',
    'log_info "Starting agent runner (max $MAX_TURNS turns, $COOLDOWN s cooldown)"',
    'log_event "agent_heartbeat" "{\\"action\\":\\"runner_started\\",\\"max_turns\\":$MAX_TURNS}"',
    '',
    'while [ $TURN -lt $MAX_TURNS ]; do',
    '  TURN=$((TURN + 1))',
    '',
    '  # Check for pause',
    '  if is_paused; then',
    '    log_info "Agent is paused. Waiting 30s..."',
    '    sleep 30',
    '    continue',
    '  fi',
    '',
    '  # Check for shutdown',
    '  if has_shutdown_signal; then',
    '    log_info "Shutdown signal received. Exiting."',
    '    log_event "agent_heartbeat" "{\\"action\\":\\"shutdown_received\\",\\"turn\\":$TURN}"',
    '    exit 0',
    '  fi',
    '',
    '  # Read inbox state',
    '  INBOX_SUMMARY=$(read_inbox_summary)',
    '',
    '  # Compose continuation prompt',
    '  if [ $TURN -eq 1 ]; then',
    '    # First turn: full initialization',
    '    PROMPT="Read your instructions at $INSTRUCTIONS and begin executing your assignment. You are agent $AGENT_ID with role $ROLE in domain $DOMAIN. Your project root is $PROJECT_PATH.',
    '',
    'Current inbox state:',
    '$INBOX_SUMMARY',
    '',
    'Check your inbox for any task assignments or messages, then begin working."',
    '  else',
    '    # Subsequent turns: continuation with inbox context',
    '    PROMPT="You are agent $AGENT_ID (turn $TURN/$MAX_TURNS). Continue your work on the current project at $PROJECT_PATH.',
    '',
    'Current inbox state:',
    '$INBOX_SUMMARY',
    '',
    'Check for new messages in your inbox, update task progress, and continue working on your assigned tasks. If all tasks are complete, report completion to the orchestrator."',
    '  fi',
    '',
    '  log_info "Turn $TURN/$MAX_TURNS"',
    '  log_event "agent_heartbeat" "{\\"action\\":\\"turn_started\\",\\"turn\\":$TURN}"',
    '',
    '  # Execute Claude',
    `  OUTPUT_DIR="${outputDir}"`,
    '  SAFETY_PROMPT="You must only create and modify files within two directories: $OUTPUT_DIR/ (build output) and .command-post/ (agent communication, tasks, events). You may read files anywhere in the project for context (PRD, instructions, packages). Do NOT modify any files in packages/, schemas/, reviews/, or the project root. Do NOT modify any .md files in the project root (HANDOFF, DESIGN, PRD docs, etc.)."',
    // Append tool profile system prompt extras
    ...(systemPromptExtras.length > 0
      ? [
          `  PROFILE_EXTRAS="${systemPromptExtras.map(s => s.replace(/"/g, '\\"')).join(' ')}"`,
          '  SAFETY_PROMPT="$SAFETY_PROMPT $PROFILE_EXTRAS"',
        ]
      : []),
    '',
    `  ${claudeCmd} \\`,
    '    --append-system-prompt "$SAFETY_PROMPT" \\',
    '    "$PROMPT" \\',
    '    2>&1 || true',
    '',
    '  log_event "agent_heartbeat" "{\\"action\\":\\"turn_completed\\",\\"turn\\":$TURN}"',
    '',
    '  # Cooldown before next turn',
    '  if [ $TURN -lt $MAX_TURNS ]; then',
    '    log_info "Cooldown ${COOLDOWN}s before next turn..."',
    '    sleep $COOLDOWN',
    '  fi',
    'done',
    '',
    'log_info "Max turns ($MAX_TURNS) reached. Runner exiting."',
    'log_event "agent_heartbeat" "{\\"action\\":\\"max_turns_reached\\",\\"turn\\":$TURN}"',
  ];

  const script = lines.join('\n') + '\n';

  await fs.writeFile(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

/**
 * Builds the tmux command that starts the runner script.
 * Returns the command string to be sent via sendKeys.
 */
export function buildRunnerCommand(scriptPath: string): string {
  const escaped = scriptPath.replace(/'/g, "'\\''");
  return `bash '${escaped}'`;
}
