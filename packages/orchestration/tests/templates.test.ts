import { describe, it, expect } from 'vitest';
import {
  loadTemplate,
  fillTemplate,
  extractPlaceholders,
  validateTemplate,
  listTemplateRoles,
} from '../src/index.js';

describe('Template Loader', () => {
  it('loads the orchestrator template', async () => {
    const tmpl = await loadTemplate('orchestrator');
    expect(tmpl).toContain('# Agent: {agent_id}');
    expect(tmpl).toContain('## Role: Orchestrator');
  });

  it('loads the worker template', async () => {
    const tmpl = await loadTemplate('worker');
    expect(tmpl).toContain('## Role: Worker');
  });

  it('loads the audit-agent template', async () => {
    const tmpl = await loadTemplate('audit-agent');
    expect(tmpl).toContain('## Role: Audit Agent');
  });

  it('loads the context-monitor template', async () => {
    const tmpl = await loadTemplate('context-monitor');
    expect(tmpl).toContain('## Role: Context Monitor');
  });

  it('loads the po template', async () => {
    const tmpl = await loadTemplate('po');
    expect(tmpl).toContain('## Role: Product Owner');
  });

  it('loads the security template', async () => {
    const tmpl = await loadTemplate('security');
    expect(tmpl).toContain('## Role: Security Reviewer');
  });

  it('throws on unknown role', async () => {
    await expect(loadTemplate('unknown')).rejects.toThrow('Unknown template role');
  });

  it('loads the audit template (alias for audit-agent)', async () => {
    const tmpl = await loadTemplate('audit');
    expect(tmpl).toContain('## Role: Audit Agent');
  });

  it('lists all template roles', () => {
    const roles = listTemplateRoles();
    expect(roles).toContain('orchestrator');
    expect(roles).toContain('po');
    expect(roles).toContain('security');
    expect(roles).toContain('worker');
    expect(roles).toContain('audit');
    expect(roles).toContain('audit-agent');
    expect(roles).toContain('context-monitor');
    expect(roles).toContain('tech-docs');
    expect(roles).toContain('user-guide');
    expect(roles).toContain('testing');
    expect(roles).toContain('closeout-writer');
    expect(roles).toContain('closeout-auditor');
    expect(roles).toContain('prd-discovery-orchestrator');
    expect(roles).toContain('prd-discovery-market-researcher');
    expect(roles).toContain('prd-discovery-technical-analyst');
    expect(roles).toContain('prd-discovery-ux-researcher');
    expect(roles).toContain('prd-refiner');
    expect(roles).toContain('ticket-refiner');
    expect(roles).toHaveLength(18);
  });
});

describe('Template Filler', () => {
  it('replaces placeholders with values', () => {
    const tmpl = '# Agent: {agent_id}\n## Domain: {agent_domain}';
    const filled = fillTemplate(tmpl, {
      agent_id: 'worker-1',
      agent_domain: 'authentication',
    });
    expect(filled).toBe('# Agent: worker-1\n## Domain: authentication');
  });

  it('replaces all occurrences of a placeholder', () => {
    const tmpl = '{name} says hello to {name}';
    const filled = fillTemplate(tmpl, { name: 'Alice' });
    expect(filled).toBe('Alice says hello to Alice');
  });

  it('leaves unknown placeholders intact', () => {
    const tmpl = '{known} and {unknown}';
    const filled = fillTemplate(tmpl, { known: 'replaced' });
    expect(filled).toBe('replaced and {unknown}');
  });

  it('handles empty variables gracefully', () => {
    const tmpl = '{a} and {b}';
    const filled = fillTemplate(tmpl, {});
    expect(filled).toBe('{a} and {b}');
  });
});

describe('Placeholder Extraction', () => {
  it('extracts unique placeholders from a template', () => {
    const tmpl = '{agent_id} owns {feature_list} in {agent_domain}';
    const placeholders = extractPlaceholders(tmpl);
    expect(placeholders).toContain('agent_id');
    expect(placeholders).toContain('feature_list');
    expect(placeholders).toContain('agent_domain');
    expect(placeholders).toHaveLength(3);
  });

  it('deduplicates repeated placeholders', () => {
    const tmpl = '{a} {a} {b}';
    const placeholders = extractPlaceholders(tmpl);
    expect(placeholders).toHaveLength(2);
  });

  it('ignores non-placeholder braces (code blocks, etc.)', () => {
    // Placeholders must be lowercase letters/underscores/digits starting with a letter
    const tmpl = '{agent_id} and {123invalid} and {Valid}';
    const placeholders = extractPlaceholders(tmpl);
    expect(placeholders).toContain('agent_id');
    expect(placeholders).toHaveLength(1);
  });
});

describe('Template Validator', () => {
  it('validates the orchestrator template', async () => {
    const tmpl = await loadTemplate('orchestrator');
    const result = validateTemplate('orchestrator', tmpl);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.missingSections).toHaveLength(0);
    expect(result.placeholders).toContain('agent_id');
    expect(result.placeholders).toContain('agent_domain');
  });

  it('validates the worker template', async () => {
    const tmpl = await loadTemplate('worker');
    const result = validateTemplate('worker', tmpl);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('validates the audit-agent template', async () => {
    const tmpl = await loadTemplate('audit-agent');
    const result = validateTemplate('audit-agent', tmpl);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('validates the context-monitor template', async () => {
    const tmpl = await loadTemplate('context-monitor');
    const result = validateTemplate('context-monitor', tmpl);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('validates the po template', async () => {
    const tmpl = await loadTemplate('po');
    const result = validateTemplate('po', tmpl);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('validates the security template', async () => {
    const tmpl = await loadTemplate('security');
    const result = validateTemplate('security', tmpl);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('validates the audit template (alias for audit-agent)', async () => {
    const tmpl = await loadTemplate('audit');
    const result = validateTemplate('audit', tmpl);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('loads the tech-docs template', async () => {
    const tmpl = await loadTemplate('tech-docs');
    expect(tmpl).toContain('## Role: Technical Documentation Worker');
  });

  it('loads the user-guide template', async () => {
    const tmpl = await loadTemplate('user-guide');
    expect(tmpl).toContain('## Role: User Guide Documentation Worker');
  });

  it('loads the testing template', async () => {
    const tmpl = await loadTemplate('testing');
    expect(tmpl).toContain('## Role: Testing/QA Worker');
  });

  it('validates the tech-docs template', async () => {
    const tmpl = await loadTemplate('tech-docs');
    const result = validateTemplate('tech-docs', tmpl);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('validates the user-guide template', async () => {
    const tmpl = await loadTemplate('user-guide');
    const result = validateTemplate('user-guide', tmpl);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('validates the testing template', async () => {
    const tmpl = await loadTemplate('testing');
    const result = validateTemplate('testing', tmpl);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails on empty template', () => {
    const result = validateTemplate('orchestrator', '');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Template is empty');
  });

  it('fails on unknown role', () => {
    const result = validateTemplate('unknown', '# Stuff');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Unknown role');
  });

  it('detects missing sections', () => {
    const partialTemplate = '# Agent: {agent_id}\n## Domain: {agent_domain}\n### Your Assignment\nStuff';
    const result = validateTemplate('orchestrator', partialTemplate);
    expect(result.valid).toBe(false);
    expect(result.missingSections.length).toBeGreaterThan(0);
  });

  it('detects missing core placeholders', () => {
    // Build a template with all sections but no placeholders
    const tmpl = `# Agent: static-id
## Role: Orchestrator
### Your Assignment
text
### Domain Ownership
text
### Core Responsibilities
text
### Task Distribution Strategy
text
### Approval Management
text
### Context Management
text
### Audit Compliance
text`;
    const result = validateTemplate('orchestrator', tmpl);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('agent_id'))).toBe(true);
  });
});

describe('Full Template Workflow', () => {
  it('loads, fills, and validates a template end-to-end', async () => {
    const raw = await loadTemplate('worker');
    const filled = fillTemplate(raw, {
      agent_id: 'worker-auth-1',
      agent_domain: 'authentication',
      relevant_sections: '## Section 3.1: Authentication\nLogin, signup, OAuth',
      feature_list: 'Login Page, Signup Page, OAuth Integration',
      dependent_agents: '- orchestrator-1\n- worker-auth-2',
      workflow_instructions: '1. Read inbox\n2. Execute task\n3. Report results',
    });

    expect(filled).toContain('worker-auth-1');
    expect(filled).toContain('authentication');
    expect(filled).toContain('Login Page, Signup Page');
    expect(filled).not.toContain('{agent_id}');
    expect(filled).not.toContain('{agent_domain}');
  });
});
