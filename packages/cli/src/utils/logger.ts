import chalk from 'chalk';

let verbose = false;

/** Enable or disable verbose logging. */
export function setVerbose(enabled: boolean): void {
  verbose = enabled;
  if (enabled) {
    process.env['CP_VERBOSE'] = '1';
  }
}

/** Returns whether verbose mode is active. */
export function isVerbose(): boolean {
  return verbose;
}

export const logger = {
  debug(message: string): void {
    if (verbose) {
      console.error(chalk.gray(`[debug] ${message}`));
    }
  },

  info(message: string): void {
    console.log(message);
  },

  warn(message: string): void {
    console.error(chalk.yellow(`Warning: ${message}`));
  },

  error(message: string): void {
    console.error(chalk.red(`Error: ${message}`));
  },

  success(message: string): void {
    console.log(chalk.green(message));
  },
};
