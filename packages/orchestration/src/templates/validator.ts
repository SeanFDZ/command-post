/**
 * Template validator — checks that a template has the required structure
 * for its role.
 */

import type { AgentRole, TemplateValidationResult } from '../types/index.js';
import { extractPlaceholders } from './filler.js';

/** Required sections per role (heading text that must appear). */
const REQUIRED_SECTIONS: Record<AgentRole, string[]> = {
  orchestrator: [
    'Your Assignment',
    'Domain Ownership',
    'Core Responsibilities',
    'Task Distribution Strategy',
    'Approval Management',
    'Context Management',
    'Audit Compliance',
  ],
  po: [
    'Your Assignment',
    'Domain Ownership',
    'Core Responsibilities',
    'Receiving Audit Reports',
    'Decision Making Pattern',
    'Backlog Management',
    'Context Management',
  ],
  security: [
    'Your Assignment',
    'Core Responsibilities',
    'Security Review Pattern',
    'Vulnerability Categories & Examples',
    'Reporting Format',
    'Escalation to Orchestrator',
    'Context Management',
  ],
  worker: [
    'Your Assignment',
    'Domain Expertise',
    'Task Acceptance Pattern',
    'Task Execution',
    'Context Awareness',
    'Handoff Signal',
    'Error Handling',
    'Audit & Logging',
  ],
  'audit-agent': [
    'Your Assignment',
    'Audit Scope',
    'Monitoring Pattern',
    'Compliance Verification',
    'Error Detection',
    'Incident Response',
    'Context Lifecycle Audit',
    'Reporting',
  ],
  'audit': [
    'Your Assignment',
    'Audit Scope',
    'Monitoring Pattern',
    'Compliance Verification',
    'Error Detection',
    'Incident Response',
    'Context Lifecycle Audit',
    'Reporting',
  ],
  'context-monitor': [
    'Your Assignment',
    'Context Tracking',
    'Usage Predictions',
    'Graceful Degradation Strategy',
    'Memory Snapshot Management',
    'Handoff Coordination',
    'Recovery Protocol',
    'Lifecycle Reporting',
  ],
  'tech-docs': [
    'Your Assignment',
    'Domain Expertise',
    'Documentation Responsibilities',
    'Task Acceptance Pattern',
    'Documentation Execution',
    'Quality Standards',
    'Context Awareness',
    'Error Handling',
    'Audit & Logging',
  ],
  'user-guide': [
    'Your Assignment',
    'Domain Expertise',
    'Documentation Responsibilities',
    'Task Acceptance Pattern',
    'Documentation Execution',
    'Quality Standards',
    'Context Awareness',
    'Error Handling',
    'Audit & Logging',
  ],
  testing: [
    'Your Assignment',
    'Domain Expertise',
    'Testing Responsibilities',
    'Task Acceptance Pattern',
    'Test Execution',
    'Test Quality Standards',
    'Context Awareness',
    'Error Handling',
    'Audit & Logging',
  ],
  'closeout-writer': [
    'Your Task',
    'Output',
    'Important',
    'When Done',
  ],
  'closeout-auditor': [
    'Your Task',
    'Output',
    'Important',
  ],
  'prd-discovery-orchestrator': [],
  'prd-discovery-market-researcher': [],
  'prd-discovery-technical-analyst': [],
  'prd-discovery-ux-researcher': [],
  'prd-refiner': [],
  'ticket-refiner': [],
};

/** Minimum set of placeholders every template must contain. */
const CORE_PLACEHOLDERS = ['agent_id', 'agent_domain'];

/**
 * Validate a template's structure for the given role.
 *
 * Checks:
 * 1. All required sections are present (as markdown headings).
 * 2. Core placeholders ({agent_id}, {agent_domain}) exist.
 * 3. Template is non-empty markdown.
 */
export function validateTemplate(
  role: string,
  template: string,
): TemplateValidationResult {
  const errors: string[] = [];
  const missingSections: string[] = [];

  // Basic checks
  if (!template || template.trim().length === 0) {
    errors.push('Template is empty');
    return { valid: false, role, placeholders: [], missingSections: [], errors };
  }

  // Check required sections
  const requiredSections = REQUIRED_SECTIONS[role as AgentRole];
  if (!requiredSections) {
    errors.push(`Unknown role "${role}"`);
    return { valid: false, role, placeholders: [], missingSections: [], errors };
  }

  for (const section of requiredSections) {
    // Look for the section as a markdown heading at any level
    const pattern = new RegExp(`^#{1,6}\\s+${escapeRegex(section)}`, 'm');
    if (!pattern.test(template)) {
      missingSections.push(section);
    }
  }

  if (missingSections.length > 0) {
    errors.push(
      `Missing required sections: ${missingSections.join(', ')}`,
    );
  }

  // Check core placeholders
  const placeholders = extractPlaceholders(template);
  for (const p of CORE_PLACEHOLDERS) {
    if (!placeholders.includes(p)) {
      errors.push(`Missing core placeholder: {${p}}`);
    }
  }

  return {
    valid: errors.length === 0,
    role,
    placeholders,
    missingSections,
    errors,
  };
}

/** Escape special regex characters. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
