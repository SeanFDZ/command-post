import { tmux } from './executor.js';

/**
 * Sends keys (a command string) to a tmux session's stdin.
 * This is primarily for manual testing/debugging — the canonical
 * message passing mechanism is the agent inbox (writeToInbox).
 *
 * @param sessionName - Target tmux session
 * @param command - The command/text to send
 */
export async function sendKeys(sessionName: string, command: string): Promise<void> {
  await tmux(['send-keys', '-t', sessionName, command, 'Enter']);
}
