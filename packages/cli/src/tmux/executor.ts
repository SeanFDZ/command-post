import { execa } from 'execa';
import { CLIError, ExitCode } from '../utils/error-handler.js';
import { logger } from '../utils/logger.js';

/**
 * Executes a tmux command asynchronously.
 * Wraps execa with friendly error handling.
 */
export async function tmux(args: string[]): Promise<string> {
  logger.debug(`tmux ${args.join(' ')}`);
  try {
    const result = await execa('tmux', args);
    return result.stdout.trim();
  } catch (error: unknown) {
    const err = error as { code?: string; stderr?: string; message?: string };

    if (err.code === 'ENOENT') {
      throw new CLIError(
        'tmux is not installed. Please install tmux 3.0+ to use Command Post.\n' +
          '  macOS: brew install tmux\n' +
          '  Linux: sudo apt install tmux',
        ExitCode.TmuxError,
      );
    }

    // "no server running" or "no sessions" is not necessarily an error
    if (err.stderr?.includes('no server running') || err.stderr?.includes('no sessions')) {
      return '';
    }

    throw new CLIError(
      `tmux command failed: ${err.stderr ?? err.message ?? 'unknown error'}`,
      ExitCode.TmuxError,
    );
  }
}

/** Checks whether tmux is available on the system. */
export async function isTmuxAvailable(): Promise<boolean> {
  try {
    await execa('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
}
