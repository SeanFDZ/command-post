import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectStructure, readInbox } from '@command-post/core';
import {
  applyDegradation,
  selectDegradationStrategy,
} from '../../src/index.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'cp-deg-'));
}

describe('selectDegradationStrategy', () => {
  it('returns none for <40%', () => {
    expect(selectDegradationStrategy(30)).toBe('none');
    expect(selectDegradationStrategy(39)).toBe('none');
  });

  it('returns reduce for 40-60%', () => {
    expect(selectDegradationStrategy(40)).toBe('reduce');
    expect(selectDegradationStrategy(55)).toBe('reduce');
  });

  it('returns compress for 60-70%', () => {
    expect(selectDegradationStrategy(60)).toBe('compress');
    expect(selectDegradationStrategy(69)).toBe('compress');
  });

  it('returns offload for >=70%', () => {
    expect(selectDegradationStrategy(70)).toBe('offload');
    expect(selectDegradationStrategy(95)).toBe('offload');
  });

  it('respects configured strategy override', () => {
    expect(selectDegradationStrategy(60, 'compress')).toBe('compress');
    expect(selectDegradationStrategy(90, 'reduce')).toBe('reduce');
  });

  it('falls through to auto-select when configured as none', () => {
    expect(selectDegradationStrategy(65, 'none')).toBe('compress');
  });
});

describe('applyDegradation', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await makeTempDir();
    await initProjectStructure(projectPath, {
      project: { name: 'test', version: '1.0.0' },
      orchestration: { hierarchy: 'flat', domains: ['default'] },
      communication: { inbox_format: 'json', task_format: 'json', contracts_directory: '.command-post/contracts' },
      paths: { output_dir: './output' },
    });
  });

  afterEach(async () => {
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  it('applies none strategy', async () => {
    const result = await applyDegradation(projectPath, 'worker-1', 'orchestrator-1', 'none');
    expect(result.applied).toBe(true);
    expect(result.strategy).toBe('none');
    expect(result.details).toContain('waiting for handoff');
  });

  it('applies reduce strategy — sends message to orchestrator', async () => {
    const result = await applyDegradation(projectPath, 'worker-1', 'orchestrator-1', 'reduce');
    expect(result.applied).toBe(true);
    expect(result.details).toContain('reduce task complexity');

    // Verify the message was sent to the orchestrator's inbox
    const messages = await readInbox(projectPath, 'orchestrator-1');
    expect(messages.length).toBe(1);
    expect(messages[0].type).toBe('lifecycle_command');
    expect((messages[0].body as Record<string, unknown>).command).toBe('reduce_task_complexity');
  });

  it('applies compress strategy — sends message to agent', async () => {
    const result = await applyDegradation(projectPath, 'worker-1', 'orchestrator-1', 'compress');
    expect(result.applied).toBe(true);

    const messages = await readInbox(projectPath, 'worker-1');
    expect(messages.length).toBe(1);
    expect((messages[0].body as Record<string, unknown>).command).toBe('compress_history');
  });

  it('applies offload strategy — sends message to agent', async () => {
    const result = await applyDegradation(projectPath, 'worker-1', 'orchestrator-1', 'offload');
    expect(result.applied).toBe(true);

    const messages = await readInbox(projectPath, 'worker-1');
    expect(messages.length).toBe(1);
    expect((messages[0].body as Record<string, unknown>).command).toBe('offload_context');
    expect(messages[0].priority).toBe('critical');
  });
});
