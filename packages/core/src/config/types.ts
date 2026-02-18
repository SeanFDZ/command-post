import { z } from 'zod';

/** Zod schema for project config matching config.schema.json. */
export const ProjectConfigSchema = z.object({
  project: z.object({
    name: z.string(),
    version: z.string().regex(/^\d+\.\d+\.\d+.*$/),
  }),
  orchestration: z.object({
    hierarchy: z.enum(['pm-po-agent', 'po-agent', 'flat']),
    domains: z.array(z.string()).min(1),
    max_agents_per_domain: z.number().int().min(1).optional(),
  }),
  agents: z.object({
    context_monitor: z.object({
      type: z.enum(['daemon', 'agent']).optional().default('agent'),
      threshold: z.number().min(0).max(1).default(0.8),
      warning_threshold: z.number().min(0).max(1).optional().default(0.70),
      poll_interval: z.number().int().min(1).default(60),
      poll_interval_seconds: z.number().int().positive().optional().default(30),
      snapshot_timeout_seconds: z.number().int().positive().optional().default(120),
      detection_method: z.enum(['transcript', 'statusline']).optional().default('transcript'),
    }).optional(),
    audit: z.object({
      run_on: z.enum(['ready_for_review', 'scheduled', 'manual']).default('ready_for_review'),
      compliance_threshold: z.number().min(0).max(1).default(0.9),
      cross_domain: z.boolean().default(true),
    }).optional(),
    workers: z.object({
      lateral_messaging: z.boolean().default(true),
      cc_orchestrator: z.boolean().default(false),
    }).optional(),
  }),
  communication: z.object({
    inbox_format: z.enum(['json']).default('json'),
    task_format: z.enum(['json']).default('json'),
    contracts_directory: z.string().default('.command-post/contracts'),
  }),
  human_gates: z.object({
    require_approval: z.array(z.string()).default([]),
    notification: z.object({
      slack_webhook: z.string().url().nullable().optional(),
    }).optional(),
  }).optional(),
  git: z.object({
    auto_commit: z.boolean().default(true),
    branch_strategy: z.enum(['per-domain', 'per-agent', 'trunk']).default('per-domain'),
    push_remote: z.boolean().default(true),
  }).optional(),
  paths: z.object({
    output_dir: z.string().default('./output'),
    previous_output: z.string().optional(),
    previous_project: z.string().optional(),
  }),
});

/** TypeScript type for project configuration. */
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/** Agent assignment within a topology domain. */
const AgentAssignmentSchema = z.object({
  id: z.string(),
  role: z.enum(['orchestrator', 'po', 'audit', 'worker', 'context-monitor', 'security', 'coordinator', 'specialist']),
  domain: z.string().nullable().optional(),
  assigned_features: z.array(z.string()).optional(),
  model_preference: z.string().nullable().optional(),
});

/** Domain entry within topology. */
const TopologyDomainSchema = z.object({
  name: z.string(),
  complexity: z.enum(['low', 'medium', 'high']),
  feature_count: z.number().int().min(0),
  agents: z.array(AgentAssignmentSchema),
});

/** Zod schema for topology config matching topology.schema.json. */
export const TopologyConfigSchema = z.object({
  project_name: z.string(),
  hierarchy: z.enum(['pm-po-agent', 'po-agent', 'flat']),
  generated_at: z.string().datetime(),
  domains: z.array(TopologyDomainSchema),
  total_agents: z.number().int().min(0),
  estimated_token_budget: z.number().int().min(0).nullable().optional(),
});

/** TypeScript type for topology configuration. */
export type TopologyConfig = z.infer<typeof TopologyConfigSchema>;

/** Public API surface for configuration operations. */
export interface ConfigAPI {
  /** Load and validate config.yaml. */
  loadConfig(projectPath: string): Promise<ProjectConfig>;
  /** Load and validate topology.yaml. */
  loadTopology(projectPath: string): Promise<TopologyConfig>;
}
