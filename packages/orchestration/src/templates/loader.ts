/**
 * Template loader — reads agent role templates from the templates/ directory.
 */

import { promises as fs } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentRole } from '../types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Maps role aliases to their template filename.
 * 'audit' is an alias for 'audit-agent' since the template file is audit-agent.md.
 */
const ROLE_TO_FILENAME: Readonly<Record<string, string>> = {
  'audit': 'audit-agent',
};

/** Resolve the absolute path to a template file by role. */
function templatePath(role: AgentRole): string {
  const filename = ROLE_TO_FILENAME[role] ?? role;
  // From src/templates/ → ../../templates/{filename}.md
  return resolve(__dirname, '..', '..', 'templates', `${filename}.md`);
}

/** Valid template role names (all AgentRole values). */
const VALID_ROLES: ReadonlySet<string> = new Set<AgentRole>([
  'orchestrator',
  'po',
  'audit',
  'audit-agent',
  'worker',
  'context-monitor',
  'security',
  'tech-docs',
  'user-guide',
  'testing',
  'closeout-writer',
  'closeout-auditor',
  'prd-discovery-orchestrator',
  'prd-discovery-market-researcher',
  'prd-discovery-technical-analyst',
  'prd-discovery-ux-researcher',
  'prd-refiner',
  'ticket-refiner',
]);

/**
 * Load a raw markdown template for the given agent role.
 *
 * @param role — one of 'orchestrator', 'worker', 'audit', 'audit-agent', 'context-monitor', 'po', 'security', 'tech-docs', 'user-guide', 'testing'
 * @returns the raw markdown string with {placeholders} intact
 * @throws if the role is unknown or the file cannot be read
 */
export async function loadTemplate(role: string): Promise<string> {
  if (!VALID_ROLES.has(role)) {
    throw new Error(
      `Unknown template role "${role}". Valid roles: ${[...VALID_ROLES].join(', ')}`,
    );
  }
  const path = templatePath(role as AgentRole);
  return fs.readFile(path, 'utf-8');
}

/**
 * List all available template roles.
 */
export function listTemplateRoles(): AgentRole[] {
  return [...VALID_ROLES] as AgentRole[];
}
