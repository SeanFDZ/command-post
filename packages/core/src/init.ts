/**
 * Project structure initialization — creates the .command-post/ directory tree.
 *
 * Used primarily by tests and project bootstrapping.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  getProjectRoot,
  getAgentsDir,
  getMessagesDir,
  getTasksDir,
  getEventsDir,
  getMemorySnapshotsDir,
  getContractsDir,
} from './utils/paths.js';

export interface InitConfig {
  project: { name: string; version: string };
  orchestration?: { hierarchy?: string; domains?: string[] };
  communication?: { inbox_format?: string; task_format?: string; contracts_directory?: string };
  paths?: { output_dir?: string };
}

/**
 * Create the full .command-post/ directory structure.
 */
export async function initProjectStructure(
  projectPath: string,
  _config?: InitConfig,
): Promise<void> {
  const dirs = [
    getProjectRoot(projectPath),
    getAgentsDir(projectPath),
    getMessagesDir(projectPath),
    getTasksDir(projectPath),
    getEventsDir(projectPath),
    getMemorySnapshotsDir(projectPath),
    getContractsDir(projectPath),
    join(getProjectRoot(projectPath), 'spawn-requests'),
  ];

  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }
}
