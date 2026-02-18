/**
 * Custom error classes for @command-post/core operations.
 */

/** Thrown when schema validation fails on input data. */
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly path: string,
    public readonly details: unknown[] = [],
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Thrown when a file system read/write operation fails. */
export class FileSystemError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'FileSystemError';
  }
}

/** Thrown when a file lock cannot be acquired after retries. */
export class LockTimeoutError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
  ) {
    super(message);
    this.name = 'LockTimeoutError';
  }
}

/** Thrown when a requested resource (task, message, config) is not found. */
export class NotFoundError extends Error {
  constructor(
    message: string,
    public readonly resourceType: string,
    public readonly resourceId: string,
  ) {
    super(message);
    this.name = 'NotFoundError';
  }
}
