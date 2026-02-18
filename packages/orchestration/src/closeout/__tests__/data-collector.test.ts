import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findPrdPath, scanOutputDir, collectCloseoutData } from '../data-collector.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'closeout-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('findPrdPath', () => {
  it('should find PRD.md in project root', async () => {
    const prdPath = join(tmpDir, 'PRD.md');
    await fs.writeFile(prdPath, '# Test PRD');
    const result = await findPrdPath(tmpDir);
    expect(result).toBe(prdPath);
  });

  it('should find COMMAND-POST.md when PRD.md is missing', async () => {
    const cpPath = join(tmpDir, 'COMMAND-POST.md');
    await fs.writeFile(cpPath, '# Test Command Post');
    const result = await findPrdPath(tmpDir);
    expect(result).toBe(cpPath);
  });

  it('should prefer PRD.md over Command Post.md', async () => {
    await fs.writeFile(join(tmpDir, 'PRD.md'), '# PRD');
    await fs.writeFile(join(tmpDir, 'COMMAND-POST.md'), '# Command Post');
    const result = await findPrdPath(tmpDir);
    expect(result).toBe(join(tmpDir, 'PRD.md'));
  });

  it('should return null when neither file exists', async () => {
    const result = await findPrdPath(tmpDir);
    expect(result).toBeNull();
  });
});

describe('scanOutputDir', () => {
  it('should return empty array for non-existent directory', async () => {
    const result = await scanOutputDir(join(tmpDir, 'nonexistent'));
    expect(result).toEqual([]);
  });

  it('should scan files with sizes and dates', async () => {
    const outputDir = join(tmpDir, 'output');
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(join(outputDir, 'file1.ts'), 'export const x = 1;');
    await fs.writeFile(join(outputDir, 'file2.ts'), 'export const y = 2;');

    const result = await scanOutputDir(outputDir);
    expect(result).toHaveLength(2);
    expect(result[0].relativePath).toMatch(/^file[12]\.ts$/);
    expect(result[0].sizeBytes).toBeGreaterThan(0);
    expect(result[0].lastModified).toBeTruthy();
  });

  it('should recursively scan nested directories', async () => {
    const outputDir = join(tmpDir, 'output');
    await fs.mkdir(join(outputDir, 'sub', 'deep'), { recursive: true });
    await fs.writeFile(join(outputDir, 'root.ts'), 'a');
    await fs.writeFile(join(outputDir, 'sub', 'mid.ts'), 'b');
    await fs.writeFile(join(outputDir, 'sub', 'deep', 'leaf.ts'), 'c');

    const result = await scanOutputDir(outputDir);
    expect(result).toHaveLength(3);
    const paths = result.map((r) => r.relativePath).sort();
    expect(paths).toEqual(['root.ts', 'sub/deep/leaf.ts', 'sub/mid.ts']);
  });
});

describe('collectCloseoutData', () => {
  it('should return partial data when no .spaces directory exists', async () => {
    const result = await collectCloseoutData(tmpDir);
    expect(result.projectName).toBeTruthy();
    expect(result.tasks).toEqual([]);
    expect(result.events).toEqual([]);
    expect(result.agents).toEqual([]);
    expect(result.outputFiles).toEqual([]);
    expect(result.startTime).toBeTruthy();
    expect(result.endTime).toBeTruthy();
    expect(result.totalDuration).toBeTruthy();
  });

  it('should find PRD path', async () => {
    await fs.writeFile(join(tmpDir, 'PRD.md'), '# My PRD');
    const result = await collectCloseoutData(tmpDir);
    expect(result.prdPath).toBe(join(tmpDir, 'PRD.md'));
  });

  it('should scan output files', async () => {
    const outputDir = join(tmpDir, '.command-post', 'output');
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(join(outputDir, 'result.ts'), 'done');

    const result = await collectCloseoutData(tmpDir);
    expect(result.outputFiles).toHaveLength(1);
    expect(result.outputFiles[0].relativePath).toBe('result.ts');
  });

  it('should read tasks from .command-post/tasks', async () => {
    const tasksDir = join(tmpDir, '.command-post', 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    const task = {
      id: 'task-001',
      title: 'Build login',
      feature: 'auth',
      domain: 'frontend',
      assigned_to: 'worker-1',
      assigned_by: 'orchestrator',
      status: 'approved',
      prd_sections: [],
      plan: { steps: [], current_step: 0, estimated_steps_remaining: 0 },
      progress: { summary: 'Done' },
      dependencies: { blocked_by: [], blocks: [] },
      audit: { compliance_score: 0.95 },
      context: { usage_percent: 0.5, handoff_count: 0 },
      timestamps: {
        created: '2026-01-01T00:00:00Z',
        last_updated: '2026-01-01T01:00:00Z',
        started: '2026-01-01T00:10:00Z',
        completed: '2026-01-01T01:00:00Z',
      },
    };
    await fs.writeFile(join(tasksDir, 'task-001.json'), JSON.stringify(task));

    const result = await collectCloseoutData(tmpDir);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].id).toBe('task-001');
    expect(result.tasks[0].status).toBe('approved');
    expect(result.tasks[0].complianceScore).toBe(0.95);
  });

  it('should never throw, even with corrupted data', async () => {
    const tasksDir = join(tmpDir, '.command-post', 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(join(tasksDir, 'task-bad.json'), 'not json');

    const result = await collectCloseoutData(tmpDir);
    // Should still return data, just empty tasks
    expect(result.tasks).toEqual([]);
    expect(result.projectName).toBeTruthy();
  });

  it('should derive project name from directory', async () => {
    const result = await collectCloseoutData(tmpDir);
    expect(result.projectName).toBeTruthy();
    expect(typeof result.projectName).toBe('string');
  });

  it('should calculate total duration', async () => {
    const result = await collectCloseoutData(tmpDir);
    expect(result.totalDuration).toMatch(/^\d+[hms]/);
  });
});
