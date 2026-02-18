import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SpawnQueue, type SpawnQueueEntry, type BudgetValidation } from '../../src/lifecycle/spawn-queue.js';
import { getProjectRoot } from '@command-post/core';

// Helper: Create a minimal task object for testing
function makeTask(id: string, status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'resolved' = 'completed') {
  return {
    id,
    title: `Task ${id}`,
    description: 'Test task',
    status,
    assignedAgent: 'test-agent',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: status === 'completed' || status === 'resolved' ? new Date().toISOString() : undefined,
  };
}

// Helper: Create topology.json in test project
async function writeTopology(projectPath: string, domains: any[]): Promise<void> {
  const spacesRoot = getProjectRoot(projectPath);
  const topologyPath = path.join(spacesRoot, 'topology.json');
  const topology = {
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    domains,
    total_agents: domains.reduce((sum: number, d: any) => sum + d.agents.length, 0),
  };
  fs.writeFileSync(topologyPath, JSON.stringify(topology, null, 2), 'utf-8');
}

describe('SpawnQueue', () => {
  let projectPath: string;
  let queue: SpawnQueue;

  beforeEach(async () => {
    projectPath = fs.mkdtempSync(path.join(process.cwd(), 'test-spawn-queue-'));
    // SpawnQueue constructor creates .command-post/spawn-queue/ with recursive: true
    queue = new SpawnQueue(projectPath, 25);
  });

  afterEach(() => {
    if (fs.existsSync(projectPath)) {
      fs.rmSync(projectPath, { recursive: true, force: true });
    }
  });

  describe('constructor', () => {
    it('should initialize with default max agents (25)', () => {
      const q = new SpawnQueue(projectPath);
      expect(q.getActiveAgentCount()).toBe(0);
    });

    it('should initialize with custom max agents', () => {
      const q = new SpawnQueue(projectPath, 50);
      expect(q.getActiveAgentCount()).toBe(0);
    });

    it('should create spawn-queue directory', () => {
      const queueDir = path.join(getProjectRoot(projectPath), 'spawn-queue');
      expect(fs.existsSync(queueDir)).toBe(true);
    });

    it('should load persisted queue entries from disk', async () => {
      const domains = [
        {
          name: 'sales',
          agents: [
            { id: 'po-sales-1', role: 'po', domain: 'sales', assigned_features: [], model_preference: 'default' },
          ],
        },
      ];
      await writeTopology(projectPath, domains);

      const entry1 = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Scale capacity',
      });

      const queue2 = new SpawnQueue(projectPath, 25);
      const reloaded = queue2.getQueue();
      expect(reloaded).toHaveLength(1);
      expect(reloaded[0].id).toBe(entry1.id);
    });
  });

  describe('enqueue', () => {
    beforeEach(async () => {
      const domains = [
        {
          name: 'sales',
          agents: [
            { id: 'po-sales-1', role: 'po', domain: 'sales', assigned_features: [], model_preference: 'default' },
          ],
        },
      ];
      await writeTopology(projectPath, domains);
    });

    it('should create a queue entry with generated ID (sq-{uuid})', async () => {
      const entry = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Scale capacity',
      });

      expect(entry.id).toMatch(/^sq-[0-9a-f\-]+$/);
    });

    it('should set createdAt timestamp', async () => {
      const before = new Date();
      const entry = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Scale capacity',
      });
      const after = new Date();

      const createdAt = new Date(entry.createdAt);
      expect(createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should set default domainDependencyThreshold to 1.0', async () => {
      const entry = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
      });

      expect(entry.domainDependencyThreshold).toBe(1.0);
    });

    it('should allow custom domainDependencyThreshold', async () => {
      const entry = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
        domainDependencyThreshold: 0.5,
      });

      expect(entry.domainDependencyThreshold).toBe(0.5);
    });

    it('should initialize empty arrays for dependencies and features if not provided', async () => {
      const entry = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
      });

      expect(entry.taskDependencies).toEqual([]);
      expect(entry.domainDependencies).toEqual([]);
      expect(entry.suggestedFeatures).toEqual([]);
    });

    it('should persist entry to disk', async () => {
      const entry = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
      });

      const queueDir = path.join(getProjectRoot(projectPath), 'spawn-queue');
      const filePath = path.join(queueDir, `${entry.id}.json`);
      expect(fs.existsSync(filePath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(content.id).toBe(entry.id);
    });
  });

  describe('validateBudget', () => {
    beforeEach(async () => {
      const domains = [
        {
          name: 'sales',
          agents: [
            { id: 'po-sales-1', role: 'po', domain: 'sales', assigned_features: [], model_preference: 'default' },
            { id: 'worker-sales-1', role: 'worker', domain: 'sales', assigned_features: [], model_preference: 'default' },
          ],
        },
        {
          name: 'marketing',
          agents: [
            { id: 'po-marketing-1', role: 'po', domain: 'marketing', assigned_features: [], model_preference: 'default' },
          ],
        },
      ];
      await writeTopology(projectPath, domains);
    });

    it('should reject if domain does not exist', async () => {
      const result = await queue.validateBudget('nonexistent', 'worker', 'po-sales-1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not found in topology');
    });

    it('should reject if role is not worker or audit', async () => {
      const result = await queue.validateBudget('sales', 'po', 'po-sales-1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('cannot be spawned');
    });

    it('should reject if requesting agent is not a PO for the domain', async () => {
      const result = await queue.validateBudget('sales', 'worker', 'worker-sales-1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('is not a PO');
    });

    it('should reject audit role if requesting agent is not a PO', async () => {
      const result = await queue.validateBudget('sales', 'audit', 'worker-sales-1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('is not a PO');
    });

    it('should respect maxPerDomain limit', async () => {
      const queueWithDomainLimit = new SpawnQueue(projectPath, 25, 2);
      const result = await queueWithDomainLimit.validateBudget('sales', 'worker', 'po-sales-1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('at capacity');
    });

    it('should allow spawn when within budget', async () => {
      const result = await queue.validateBudget('sales', 'worker', 'po-sales-1');
      expect(result.allowed).toBe(true);
    });

    it('should calculate availableSlots correctly', async () => {
      const result = await queue.validateBudget('sales', 'worker', 'po-sales-1');
      expect(result.availableSlots).toBe(25 - 3); // 3 agents in topology (2 sales + 1 marketing)
    });

    it('should return currentActiveAgents count', async () => {
      const result = await queue.validateBudget('sales', 'worker', 'po-sales-1');
      expect(result.currentActiveAgents).toBe(3); // 2 in sales + 1 in marketing
    });

    it('should return currentDomainAgents count', async () => {
      const result = await queue.validateBudget('sales', 'worker', 'po-sales-1');
      expect(result.currentDomainAgents).toBe(2);
    });

    it('should reject when instance at capacity', async () => {
      const smallQueue = new SpawnQueue(projectPath, 3); // Max 3, currently have 3
      const result = await smallQueue.validateBudget('marketing', 'worker', 'po-marketing-1');
      expect(result.allowed).toBe(false); // Rejected — at capacity
      expect(result.reason).toContain('will be queued');
    });
  });

  describe('markSpawned', () => {
    beforeEach(async () => {
      const domains = [
        {
          name: 'sales',
          agents: [
            { id: 'po-sales-1', role: 'po', domain: 'sales', assigned_features: [], model_preference: 'default' },
          ],
        },
      ];
      await writeTopology(projectPath, domains);
    });

    it('should update entry status to spawned', async () => {
      const entry = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
      });

      queue.markSpawned(entry.id, 'worker-sales-2');

      const updated = queue.getQueue().find((e) => e.id === entry.id);
      expect(updated?.status).toBe('spawned');
    });

    it('should set spawnedAgentId', async () => {
      const entry = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
      });

      queue.markSpawned(entry.id, 'worker-sales-2');

      const updated = queue.getQueue().find((e) => e.id === entry.id);
      expect(updated?.spawnedAgentId).toBe('worker-sales-2');
    });

    it('should set resolvedAt timestamp', async () => {
      const entry = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
      });

      const before = new Date();
      queue.markSpawned(entry.id, 'worker-sales-2');
      const after = new Date();

      const updated = queue.getQueue().find((e) => e.id === entry.id);
      const resolvedAt = new Date(updated?.resolvedAt ?? '');
      expect(resolvedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(resolvedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('markRejected', () => {
    beforeEach(async () => {
      const domains = [
        {
          name: 'sales',
          agents: [
            { id: 'po-sales-1', role: 'po', domain: 'sales', assigned_features: [], model_preference: 'default' },
          ],
        },
      ];
      await writeTopology(projectPath, domains);
    });

    it('should update entry status to rejected', async () => {
      const entry = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
      });

      queue.markRejected(entry.id, 'Budget exceeded');

      const updated = queue.getQueue().find((e) => e.id === entry.id);
      expect(updated?.status).toBe('rejected');
    });

    it('should set rejectionReason', async () => {
      const entry = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
      });

      queue.markRejected(entry.id, 'Budget exceeded');

      const updated = queue.getQueue().find((e) => e.id === entry.id);
      expect(updated?.rejectionReason).toBe('Budget exceeded');
    });

    it('should set resolvedAt timestamp', async () => {
      const entry = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
      });

      const before = new Date();
      queue.markRejected(entry.id, 'Test reason');
      const after = new Date();

      const updated = queue.getQueue().find((e) => e.id === entry.id);
      const resolvedAt = new Date(updated?.resolvedAt ?? '');
      expect(resolvedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(resolvedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('checkDependencies', () => {
    beforeEach(async () => {
      const domains = [
        {
          name: 'sales',
          agents: [
            { id: 'po-sales-1', role: 'po', domain: 'sales', assigned_features: [], model_preference: 'default' },
          ],
        },
      ];
      await writeTopology(projectPath, domains);
    });

    it('should return true if no task dependencies', async () => {
      const entry: SpawnQueueEntry = {
        id: 'sq-test',
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
        status: 'pending',
        taskDependencies: [],
        domainDependencies: [],
        domainDependencyThreshold: 1.0,
        suggestedFeatures: [],
        createdAt: new Date().toISOString(),
      };

      const result = await queue.checkDependencies(entry);
      expect(result).toBe(true);
    });

    it('should return false if task resolver not set', async () => {
      const entry: SpawnQueueEntry = {
        id: 'sq-test',
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
        status: 'pending',
        taskDependencies: ['task-1'],
        domainDependencies: [],
        domainDependencyThreshold: 1.0,
        suggestedFeatures: [],
        createdAt: new Date().toISOString(),
      };

      const result = await queue.checkDependencies(entry);
      expect(result).toBe(false);
    });

    it('should return true if all tasks completed', async () => {
      const entry: SpawnQueueEntry = {
        id: 'sq-test',
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
        status: 'pending',
        taskDependencies: ['task-1', 'task-2'],
        domainDependencies: [],
        domainDependencyThreshold: 1.0,
        suggestedFeatures: [],
        createdAt: new Date().toISOString(),
      };

      queue.setTaskResolver((taskId) => {
        if (taskId === 'task-1' || taskId === 'task-2') {
          return makeTask(taskId, 'completed');
        }
        return null;
      });

      const result = await queue.checkDependencies(entry);
      expect(result).toBe(true);
    });

    it('should return false if any task not completed', async () => {
      const entry: SpawnQueueEntry = {
        id: 'sq-test',
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
        status: 'pending',
        taskDependencies: ['task-1', 'task-2'],
        domainDependencies: [],
        domainDependencyThreshold: 1.0,
        suggestedFeatures: [],
        createdAt: new Date().toISOString(),
      };

      queue.setTaskResolver((taskId) => {
        if (taskId === 'task-1') return makeTask(taskId, 'completed');
        if (taskId === 'task-2') return makeTask(taskId, 'in_progress');
        return null;
      });

      const result = await queue.checkDependencies(entry);
      expect(result).toBe(false);
    });

    it('should accept resolved status as complete', async () => {
      const entry: SpawnQueueEntry = {
        id: 'sq-test',
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
        status: 'pending',
        taskDependencies: ['task-1'],
        domainDependencies: [],
        domainDependencyThreshold: 1.0,
        suggestedFeatures: [],
        createdAt: new Date().toISOString(),
      };

      queue.setTaskResolver((taskId) => makeTask(taskId, 'resolved'));

      const result = await queue.checkDependencies(entry);
      expect(result).toBe(true);
    });
  });

  describe('generateAgentId', () => {
    beforeEach(async () => {
      const domains = [
        {
          name: 'sales',
          agents: [
            { id: 'po-sales-1', role: 'po', domain: 'sales', assigned_features: [], model_preference: 'default' },
            { id: 'worker-sales-1', role: 'worker', domain: 'sales', assigned_features: [], model_preference: 'default' },
            { id: 'worker-sales-2', role: 'worker', domain: 'sales', assigned_features: [], model_preference: 'default' },
          ],
        },
      ];
      await writeTopology(projectPath, domains);
    });

    it('should generate ID with format {role}-{domain}-{nextNumber}', () => {
      const id = queue.generateAgentId('worker', 'sales');
      expect(id).toBe('worker-sales-3');
    });

    it('should increment from existing agents', () => {
      const id = queue.generateAgentId('worker', 'sales');
      expect(id).toMatch(/^worker-sales-3$/);
    });

    it('should scan spawned queue entries as well', async () => {
      const domains = [
        {
          name: 'marketing',
          agents: [
            { id: 'po-marketing-1', role: 'po', domain: 'marketing', assigned_features: [], model_preference: 'default' },
          ],
        },
      ];
      await writeTopology(projectPath, domains);

      const entry = await queue.enqueue({
        requestedBy: 'po-marketing-1',
        domain: 'marketing',
        role: 'audit',
        reason: 'Test',
      });

      queue.markSpawned(entry.id, 'audit-marketing-1');

      const nextId = queue.generateAgentId('audit', 'marketing');
      expect(nextId).toBe('audit-marketing-2');
    });

    it('should start at 1 for role+domain with no existing agents', async () => {
      const domains = [
        {
          name: 'hr',
          agents: [
            { id: 'po-hr-1', role: 'po', domain: 'hr', assigned_features: [], model_preference: 'default' },
          ],
        },
      ];
      await writeTopology(projectPath, domains);

      const id = queue.generateAgentId('worker', 'hr');
      expect(id).toBe('worker-hr-1');
    });
  });

  describe('getActiveAgentCount', () => {
    it('should count topology agents', async () => {
      const domains = [
        {
          name: 'sales',
          agents: [
            { id: 'po-sales-1', role: 'po', domain: 'sales', assigned_features: [], model_preference: 'default' },
            { id: 'worker-sales-1', role: 'worker', domain: 'sales', assigned_features: [], model_preference: 'default' },
          ],
        },
        {
          name: 'marketing',
          agents: [
            { id: 'po-marketing-1', role: 'po', domain: 'marketing', assigned_features: [], model_preference: 'default' },
          ],
        },
      ];
      await writeTopology(projectPath, domains);

      const count = queue.getActiveAgentCount();
      expect(count).toBe(3);
    });

    it('should include spawned queue entries', async () => {
      const domains = [
        {
          name: 'sales',
          agents: [
            { id: 'po-sales-1', role: 'po', domain: 'sales', assigned_features: [], model_preference: 'default' },
          ],
        },
      ];
      await writeTopology(projectPath, domains);

      const entry = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
      });

      queue.markSpawned(entry.id, 'worker-sales-2');

      const count = queue.getActiveAgentCount();
      expect(count).toBe(2);
    });
  });

  describe('getDomainAgentCount', () => {
    beforeEach(async () => {
      const domains = [
        {
          name: 'sales',
          agents: [
            { id: 'po-sales-1', role: 'po', domain: 'sales', assigned_features: [], model_preference: 'default' },
            { id: 'worker-sales-1', role: 'worker', domain: 'sales', assigned_features: [], model_preference: 'default' },
          ],
        },
        {
          name: 'marketing',
          agents: [
            { id: 'po-marketing-1', role: 'po', domain: 'marketing', assigned_features: [], model_preference: 'default' },
          ],
        },
      ];
      await writeTopology(projectPath, domains);
    });

    it('should count domain agents from topology', () => {
      const count = queue.getDomainAgentCount('sales');
      expect(count).toBe(2);
    });

    it('should include spawned entries for the domain', async () => {
      const entry = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
      });

      queue.markSpawned(entry.id, 'worker-sales-2');

      const count = queue.getDomainAgentCount('sales');
      expect(count).toBe(3);
    });

    it('should return 0 for nonexistent domain', () => {
      const count = queue.getDomainAgentCount('nonexistent');
      expect(count).toBe(0);
    });
  });

  describe('getQueuedCount', () => {
    beforeEach(async () => {
      const domains = [
        {
          name: 'sales',
          agents: [
            { id: 'po-sales-1', role: 'po', domain: 'sales', assigned_features: [], model_preference: 'default' },
          ],
        },
      ];
      await writeTopology(projectPath, domains);
    });

    it('should count pending and queued entries', async () => {
      const entry1 = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test 1',
      });

      const entry2 = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test 2',
      });

      const count = queue.getQueuedCount();
      expect(count).toBe(2);
    });

    it('should exclude spawned entries', async () => {
      const entry1 = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test 1',
      });

      const entry2 = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test 2',
      });

      queue.markSpawned(entry1.id, 'worker-sales-2');

      const count = queue.getQueuedCount();
      expect(count).toBe(1);
    });

    it('should exclude rejected entries', async () => {
      const entry1 = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test 1',
      });

      queue.markRejected(entry1.id, 'Test rejection');

      const count = queue.getQueuedCount();
      expect(count).toBe(0);
    });
  });

  describe('getNext', () => {
    beforeEach(async () => {
      const domains = [
        {
          name: 'sales',
          agents: [
            { id: 'po-sales-1', role: 'po', domain: 'sales', assigned_features: [], model_preference: 'default' },
          ],
        },
      ];
      await writeTopology(projectPath, domains);
    });

    it('should return next queued entry', async () => {
      const entry = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
      });

      const next = queue.getNext();
      expect(next?.id).toBe(entry.id);
    });

    it('should return null if no queued entries', () => {
      const next = queue.getNext();
      expect(next).toBeNull();
    });

    it('should skip entries not in queued status', async () => {
      const entry = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
        taskDependencies: ['task-1'],
      });

      const next = queue.getNext();
      // Entry is in dependency_wait, not queued
      expect(next).toBeNull();
    });
  });

  describe('setTaskResolver and setDomainProgressResolver', () => {
    it('should store task resolver', () => {
      const resolver = (taskId: string) => makeTask(taskId, 'completed');
      queue.setTaskResolver(resolver);
      // Verified through checkDependencies test
    });

    it('should store domain progress resolver', () => {
      const resolver = (domain: string) => 0.5;
      queue.setDomainProgressResolver(resolver);
      // Verified through evaluateEntry test
    });
  });

  describe('evaluateEntry', () => {
    beforeEach(async () => {
      const domains = [
        {
          name: 'sales',
          agents: [
            { id: 'po-sales-1', role: 'po', domain: 'sales', assigned_features: [], model_preference: 'default' },
          ],
        },
        {
          name: 'marketing',
          agents: [
            { id: 'po-marketing-1', role: 'po', domain: 'marketing', assigned_features: [], model_preference: 'default' },
          ],
        },
      ];
      await writeTopology(projectPath, domains);
    });

    it('should return dependency_wait if task dependencies not met', async () => {
      const entry = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
        taskDependencies: ['task-1'],
      });

      queue.setTaskResolver((taskId) => (taskId === 'task-1' ? makeTask(taskId, 'pending') : null));

      const status = await queue.evaluateEntry(entry);
      expect(status).toBe('dependency_wait');
    });

    it('should return dependency_wait if domain dependencies not met', async () => {
      const entry = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
        domainDependencies: ['marketing'],
        domainDependencyThreshold: 1.0,
      });

      queue.setDomainProgressResolver((domain) => (domain === 'marketing' ? 0.5 : 0));

      const status = await queue.evaluateEntry(entry);
      expect(status).toBe('dependency_wait');
    });

    it('should return ready if all dependencies met and budget allows', async () => {
      const entry = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
        taskDependencies: ['task-1'],
        domainDependencies: ['marketing'],
      });

      queue.setTaskResolver((taskId) => makeTask(taskId, 'completed'));
      queue.setDomainProgressResolver((domain) => 1.0);

      const status = await queue.evaluateEntry(entry);
      expect(status).toBe('ready');
    });

    it('should persist updated status to disk', async () => {
      const entry = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
      });

      await queue.evaluateEntry(entry);

      const queueDir = path.join(getProjectRoot(projectPath), 'spawn-queue');
      const filePath = path.join(queueDir, `${entry.id}.json`);
      const persisted = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(persisted.status).toBe('queued');
    });
  });

  describe('release', () => {
    beforeEach(async () => {
      const domains = [
        {
          name: 'sales',
          agents: [
            { id: 'po-sales-1', role: 'po', domain: 'sales', assigned_features: [], model_preference: 'default' },
          ],
        },
      ];
      await writeTopology(projectPath, domains);
    });

    it('should re-evaluate dependency_wait entries', async () => {
      const entry = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
        taskDependencies: ['task-1'],
      });

      queue.setTaskResolver((taskId) => makeTask(taskId, 'pending'));
      await queue.evaluateEntry(entry);

      // Update resolver to resolve the dependency
      queue.setTaskResolver((taskId) => makeTask(taskId, 'completed'));

      const released = await queue.release();
      expect(released).toHaveLength(1);
      expect(released[0].id).toBe(entry.id);
    });

    it('should return empty array if no entries transition', async () => {
      const entry = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
      });

      const released = await queue.release();
      expect(released).toHaveLength(0);
    });
  });

  describe('getQueue', () => {
    beforeEach(async () => {
      const domains = [
        {
          name: 'sales',
          agents: [
            { id: 'po-sales-1', role: 'po', domain: 'sales', assigned_features: [], model_preference: 'default' },
          ],
        },
      ];
      await writeTopology(projectPath, domains);
    });

    it('should return a copy of the queue', async () => {
      const entry = await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
      });

      const queueCopy = queue.getQueue();
      expect(queueCopy).toHaveLength(1);
      expect(queueCopy[0].id).toBe(entry.id);
    });

    it('should return a copy (modifications should not affect internal state)', async () => {
      await queue.enqueue({
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Test',
      });

      const queueCopy = queue.getQueue();
      queueCopy.push({
        id: 'sq-fake',
        requestedBy: 'po-sales-1',
        domain: 'sales',
        role: 'worker',
        reason: 'Fake',
        status: 'pending',
        taskDependencies: [],
        domainDependencies: [],
        domainDependencyThreshold: 1.0,
        suggestedFeatures: [],
        createdAt: new Date().toISOString(),
      });

      expect(queue.getQueue()).toHaveLength(1);
    });
  });
});
