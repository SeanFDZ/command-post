import path from 'node:path';

/**
 * Path resolution utilities for the .command-post directory structure.
 * All paths are resolved relative to a project root.
 */

/** @returns Root .command-post directory path */
export function getProjectRoot(projectPath: string): string {
  return path.join(projectPath, '.command-post');
}

/** @returns Path to agents directory */
export function getAgentsDir(projectPath: string): string {
  return path.join(getProjectRoot(projectPath), 'agents');
}

/** @returns Path to messages (inboxes) directory */
export function getMessagesDir(projectPath: string): string {
  return path.join(getProjectRoot(projectPath), 'messages');
}

/** @returns Path to a specific agent's inbox file */
export function getInboxPath(projectPath: string, agentId: string): string {
  return path.join(getMessagesDir(projectPath), `${agentId}.json`);
}

/** @returns Path to tasks directory */
export function getTasksDir(projectPath: string): string {
  return path.join(getProjectRoot(projectPath), 'tasks');
}

/** @returns Path to a specific task file */
export function getTaskPath(projectPath: string, taskId: string): string {
  return path.join(getTasksDir(projectPath), `${taskId}.json`);
}

/** @returns Path to events directory */
export function getEventsDir(projectPath: string): string {
  return path.join(getProjectRoot(projectPath), 'events');
}

/** @returns Path to the events.jsonl file */
export function getEventsPath(projectPath: string): string {
  return path.join(getEventsDir(projectPath), 'events.jsonl');
}

/** @returns Path to memory-snapshots directory */
export function getMemorySnapshotsDir(projectPath: string): string {
  return path.join(getProjectRoot(projectPath), 'memory-snapshots');
}

/** @returns Path to config.yaml */
export function getConfigPath(projectPath: string): string {
  return path.join(getProjectRoot(projectPath), 'config.yaml');
}

/** @returns Path to topology.yaml */
export function getTopologyPath(projectPath: string): string {
  return path.join(getProjectRoot(projectPath), 'topology.yaml');
}

/** @returns Path to spawn-log.yaml */
export function getSpawnLogPath(projectPath: string): string {
  return path.join(getProjectRoot(projectPath), 'spawn-log.yaml');
}

/** @returns Path to contracts directory */
export function getContractsDir(projectPath: string): string {
  return path.join(getProjectRoot(projectPath), 'contracts');
}

/** @returns Path to a specific contract file */
export function getContractPath(projectPath: string, filename: string): string {
  return path.join(getContractsDir(projectPath), filename);
}

/**
 * Get the file path for the agent registry.
 * @param projectPath - Absolute path to the project root
 * @returns Absolute path to .command-post/agent-registry.json
 */
export function getAgentRegistryPath(projectPath: string): string {
  return path.join(getProjectRoot(projectPath), 'agent-registry.json');
}
