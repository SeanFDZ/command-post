export { ProjectConfigSchema, TopologyConfigSchema } from './types.js';
export type { ProjectConfig, TopologyConfig, ConfigAPI } from './types.js';

// Agent Registry
export {
  loadAgentRegistry,
  saveAgentRegistry,
  registerAgent,
  updateAgentStatus,
  getActiveAgents,
  getAgentRegistryPath,
  computeProjectHash,
  discoverTranscriptPath,
  AgentRegistryEntrySchema,
  AgentRegistrySchema,
} from './agent-registry.js';
export type {
  AgentRegistryEntry,
  AgentRegistry,
} from './agent-registry.js';
