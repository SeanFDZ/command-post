import chalk from 'chalk';

/** Exit codes for the CLI. */
export const ExitCode = {
  Success: 0,
  GeneralError: 1,
  ValidationError: 2,
  TmuxError: 3,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** CLI-specific error with exit code. */
export class CLIError extends Error {
  constructor(
    message: string,
    public readonly exitCode: ExitCode = ExitCode.GeneralError,
  ) {
    super(message);
    this.name = 'CLIError';
  }
}

/** Error thrown by stub commands that haven't been implemented yet. */
export class NotImplementedError extends CLIError {
  constructor(message = 'Not implemented') {
    super(message, ExitCode.GeneralError);
    this.name = 'NotImplementedError';
  }
}

/** Handles errors at the top level and exits with the appropriate code. */
export function handleError(error: unknown): never {
  if (error instanceof CLIError) {
    console.error(chalk.red(`Error: ${error.message}`));
    process.exit(error.exitCode);
  }

  if (error instanceof Error) {
    if (process.env['CP_VERBOSE'] === '1') {
      console.error(chalk.red(error.stack ?? error.message));
    } else {
      console.error(chalk.red(`Error: ${error.message}`));
    }
    process.exit(ExitCode.GeneralError);
  }

  console.error(chalk.red(`Error: ${String(error)}`));
  process.exit(ExitCode.GeneralError);
}
