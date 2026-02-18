import lockfile from 'proper-lockfile';
import { LockTimeoutError } from '../errors.js';

/**
 * Options for file lock acquisition.
 */
export interface LockOptions {
  /** Number of retry attempts (default: 3) */
  retries?: number;
  /** Minimum timeout between retries in ms (default: 100) */
  minTimeout?: number;
  /** Maximum timeout between retries in ms (default: 1000) */
  maxTimeout?: number;
  /** Lock stale threshold in ms (default: 5000) */
  stale?: number;
}

const DEFAULT_LOCK_OPTIONS: Required<LockOptions> = {
  retries: 10,
  minTimeout: 50,
  maxTimeout: 2000,
  stale: 5000,
};

/**
 * Executes an operation while holding an exclusive file lock.
 * Uses proper-lockfile with exponential backoff retries.
 *
 * @param filePath - Path to the file to lock
 * @param operation - Async function to execute while lock is held
 * @param options - Lock configuration options
 * @returns The result of the operation
 * @throws {LockTimeoutError} If the lock cannot be acquired after retries
 */
export async function withFileLock<T>(
  filePath: string,
  operation: () => Promise<T>,
  options?: LockOptions,
): Promise<T> {
  const opts = { ...DEFAULT_LOCK_OPTIONS, ...options };
  let release: (() => Promise<void>) | undefined;

  try {
    release = await lockfile.lock(filePath, {
      retries: {
        retries: opts.retries,
        minTimeout: opts.minTimeout,
        maxTimeout: opts.maxTimeout,
      },
      stale: opts.stale,
    });
  } catch (err) {
    throw new LockTimeoutError(
      `Could not acquire lock on ${filePath} after ${opts.retries} retries: ${err instanceof Error ? err.message : String(err)}`,
      filePath,
    );
  }

  try {
    return await operation();
  } finally {
    if (release) {
      await release();
    }
  }
}
