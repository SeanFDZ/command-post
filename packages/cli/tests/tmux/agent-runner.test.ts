import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  writeRunnerScript,
  buildRunnerCommand,
  getRunnerScriptPath,
} from '../../src/tmux/agent-runner.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-runner-test-'));
  // Create the .command-post directory structure needed by the runner
  const cpRoot = path.join(tmpDir, '.command-post');
  for (const dir of ['agents', 'messages', 'events']) {
    await fs.mkdir(path.join(cpRoot, dir), { recursive: true });
  }
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('agent-runner', () => {
  describe('getRunnerScriptPath', () => {
    it('returns path inside .command-post/agents/{agentId}/', () => {
      const p = getRunnerScriptPath(tmpDir, 'worker-1');
      expect(p).toContain('.command-post');
      expect(p).toContain('agents');
      expect(p).toContain('worker-1');
      expect(p).toContain('runner.sh');
    });
  });

  describe('writeRunnerScript', () => {
    it('creates an executable bash script', async () => {
      const scriptPath = await writeRunnerScript({
        projectPath: tmpDir,
        agentId: 'worker-frontend-1',
        role: 'worker',
        domain: 'frontend',
      });

      const stat = await fs.stat(scriptPath);
      expect(stat.isFile()).toBe(true);

      // Check it's executable (mode & 0o111 should be non-zero)
      expect(stat.mode & 0o111).toBeGreaterThan(0);
    });

    it('includes correct shebang and agent ID', async () => {
      const scriptPath = await writeRunnerScript({
        projectPath: tmpDir,
        agentId: 'worker-auth-1',
        role: 'worker',
        domain: 'authentication',
      });

      const content = await fs.readFile(scriptPath, 'utf-8');
      expect(content).toMatch(/^#!\/usr\/bin\/env bash/);
      expect(content).toContain('AGENT_ID="worker-auth-1"');
      expect(content).toContain('ROLE="worker"');
      expect(content).toContain('DOMAIN="authentication"');
    });

    it('includes max turns and cooldown configuration', async () => {
      const scriptPath = await writeRunnerScript({
        projectPath: tmpDir,
        agentId: 'worker-1',
        role: 'worker',
        domain: 'frontend',
        maxTurns: 25,
        cooldownSeconds: 10,
      });

      const content = await fs.readFile(scriptPath, 'utf-8');
      expect(content).toContain('MAX_TURNS=25');
      expect(content).toContain('COOLDOWN=10');
    });

    it('uses --print mode by default', async () => {
      const scriptPath = await writeRunnerScript({
        projectPath: tmpDir,
        agentId: 'worker-1',
        role: 'worker',
        domain: 'frontend',
        printMode: true,
      });

      const content = await fs.readFile(scriptPath, 'utf-8');
      expect(content).toContain('claude --print --dangerously-skip-permissions');
    });

    it('supports interactive mode', async () => {
      const scriptPath = await writeRunnerScript({
        projectPath: tmpDir,
        agentId: 'worker-1',
        role: 'worker',
        domain: 'frontend',
        printMode: false,
      });

      const content = await fs.readFile(scriptPath, 'utf-8');
      // Should NOT have --print
      expect(content).toContain('claude --dangerously-skip-permissions');
      expect(content).not.toContain('claude --print');
    });

    it('includes inbox reading logic', async () => {
      const scriptPath = await writeRunnerScript({
        projectPath: tmpDir,
        agentId: 'worker-1',
        role: 'worker',
        domain: 'frontend',
      });

      const content = await fs.readFile(scriptPath, 'utf-8');
      expect(content).toContain('read_inbox_summary');
      expect(content).toContain('has_shutdown_signal');
      expect(content).toContain('is_paused');
    });

    it('includes heartbeat logging', async () => {
      const scriptPath = await writeRunnerScript({
        projectPath: tmpDir,
        agentId: 'worker-1',
        role: 'worker',
        domain: 'frontend',
      });

      const content = await fs.readFile(scriptPath, 'utf-8');
      expect(content).toContain('log_event');
      expect(content).toContain('agent_heartbeat');
      expect(content).toContain('runner_started');
      expect(content).toContain('turn_started');
      expect(content).toContain('turn_completed');
    });

    it('includes project path and instructions reference', async () => {
      const scriptPath = await writeRunnerScript({
        projectPath: tmpDir,
        agentId: 'worker-1',
        role: 'worker',
        domain: 'frontend',
      });

      const content = await fs.readFile(scriptPath, 'utf-8');
      expect(content).toContain(`PROJECT_PATH="${tmpDir}"`);
      expect(content).toContain('INSTRUCTIONS=');
      expect(content).toContain('INSTRUCTIONS.md');
    });

    it('uses .command-post paths (not .spaces)', async () => {
      const scriptPath = await writeRunnerScript({
        projectPath: tmpDir,
        agentId: 'worker-1',
        role: 'worker',
        domain: 'frontend',
      });

      const content = await fs.readFile(scriptPath, 'utf-8');
      expect(content).toContain('.command-post');
      expect(content).not.toContain('.spaces');
    });

    it('references .command-post/ in safety prompt', async () => {
      const scriptPath = await writeRunnerScript({
        projectPath: tmpDir,
        agentId: 'worker-1',
        role: 'worker',
        domain: 'frontend',
      });

      const content = await fs.readFile(scriptPath, 'utf-8');
      expect(content).toContain('.command-post/ (agent communication');
    });
  });

  describe('buildRunnerCommand', () => {
    it('returns a bash command to run the script', () => {
      const cmd = buildRunnerCommand('/path/to/runner.sh');
      expect(cmd).toBe("bash '/path/to/runner.sh'");
    });

    it('escapes single quotes in path', () => {
      const cmd = buildRunnerCommand("/path/with'quote/runner.sh");
      expect(cmd).toContain("'\\''");
    });
  });
});
