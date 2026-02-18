export {
  collectCloseoutData,
  findPrdPath,
  scanOutputDir,
} from './data-collector.js';
export type {
  CloseoutData,
  TaskSummary,
  EventSummary,
  AgentSummary,
  OutputFileSummary,
} from './data-collector.js';
export {
  buildActualsMarkdown,
  buildReportMarkdown,
  injectActualsIntoPrd,
} from './actuals-builder.js';

// Re-export CloseoutManager from lifecycle (canonical location)
// so consumers can import from the closeout barrel or the lifecycle barrel.
export { CloseoutManager } from '../lifecycle/closeout-manager.js';
export type {
  CloseoutResult,
  CloseoutState,
  SpawnFn,
} from '../lifecycle/closeout-manager.js';
