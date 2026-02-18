import fs from 'graceful-fs';
import { FileSystemError } from '../errors.js';

const fsPromises = fs.promises;

/**
 * Atomically writes content to a file using a temporary file + rename pattern.
 * This prevents partial writes or corruption from concurrent reads.
 *
 * @param filePath - Target file path
 * @param content - String content to write
 * @throws {FileSystemError} If the write or rename operation fails
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  try {
    await fsPromises.writeFile(tmpPath, content, 'utf-8');
    await fsPromises.rename(tmpPath, filePath);
  } catch (err) {
    // Clean up tmp file on failure
    try {
      await fsPromises.unlink(tmpPath);
    } catch {
      // ignore cleanup failures
    }
    throw new FileSystemError(
      `Atomic write failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      filePath,
      err,
    );
  }
}
