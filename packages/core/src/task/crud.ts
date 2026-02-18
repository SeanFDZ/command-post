/**
 * Task CRUD operations — minimal file-system implementations.
 *
 * Tasks are stored as individual JSON files under .command-post/tasks/{taskId}.json.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { getTasksDir, getTaskPath } from '../utils/paths.js';
import type { TaskObject } from './types.js';

/**
 * Create a new task file.
 */
export async function createTask(
  projectPath: string,
  task: TaskObject,
): Promise<TaskObject> {
  const dir = getTasksDir(projectPath);
  await fs.mkdir(dir, { recursive: true });
  const filePath = getTaskPath(projectPath, task.id);
  await fs.writeFile(filePath, JSON.stringify(task, null, 2), 'utf-8');
  return task;
}

/**
 * Get a task by ID, or null if not found.
 */
export async function getTask(
  projectPath: string,
  taskId: string,
): Promise<TaskObject | null> {
  const filePath = getTaskPath(projectPath, taskId);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as TaskObject;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Update a task by merging fields. Returns the updated task.
 */
export async function updateTask(
  projectPath: string,
  taskId: string,
  updates: Partial<TaskObject>,
): Promise<TaskObject> {
  const existing = await getTask(projectPath, taskId);
  if (!existing) {
    throw new Error(`Task "${taskId}" not found.`);
  }
  const merged = { ...existing, ...updates, id: existing.id } as TaskObject;
  merged.timestamps = {
    ...existing.timestamps,
    ...updates.timestamps,
    last_updated: new Date().toISOString(),
  };
  const filePath = getTaskPath(projectPath, taskId);
  await fs.writeFile(filePath, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

/**
 * List all tasks, optionally filtered.
 */
export async function listTasks(
  projectPath: string,
  filters?: { status?: string; assignee?: string; domain?: string },
): Promise<TaskObject[]> {
  const dir = getTasksDir(projectPath);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const tasks: TaskObject[] = [];
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    try {
      const content = await fs.readFile(join(dir, file), 'utf-8');
      const task = JSON.parse(content) as TaskObject;
      if (filters?.status && task.status !== filters.status) continue;
      if (filters?.assignee && task.assigned_to !== filters.assignee) continue;
      if (filters?.domain && task.domain !== filters.domain) continue;
      tasks.push(task);
    } catch {
      // Skip malformed files
    }
  }
  return tasks;
}
