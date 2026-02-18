/**
 * appendEvent — Append a system event to events.jsonl.
 *
 * Simple atomic-append implementation. Each event is a single JSON line.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getEventsPath } from '../utils/paths.js';
import type { SystemEvent } from './types.js';

/**
 * Append a system event to the project's events.jsonl file.
 *
 * Uses synchronous append for atomicity on single lines (POSIX guarantees
 * atomic writes for small payloads under PIPE_BUF / 4096 bytes).
 *
 * @param projectPath - Absolute path to the project root
 * @param event - The system event to append
 */
export async function appendEvent(
  projectPath: string,
  event: SystemEvent,
): Promise<void> {
  const eventsPath = getEventsPath(projectPath);
  mkdirSync(dirname(eventsPath), { recursive: true });
  appendFileSync(eventsPath, JSON.stringify(event) + '\n', 'utf-8');
}
