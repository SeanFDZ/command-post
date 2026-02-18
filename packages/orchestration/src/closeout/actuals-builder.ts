/**
 * Actuals Builder — transforms CloseoutData into markdown output.
 *
 * Generates the ## Actuals section for PRD injection and a standalone
 * BUILD-REPORT.md. Heading names are carefully matched to the patterns
 * expected by version-loader.ts extractActuals().
 */

import matter from 'gray-matter';
import type { CloseoutData } from './data-collector.js';

// ── Actuals Section Builder ──────────────────────────────────────────

/**
 * Generate the ## Actuals markdown section from closeout data.
 *
 * CRITICAL: Heading names must match these regexes in version-loader.ts:
 *   - /completed\s+features/i  → "### Completed Features"
 *   - /deferred\s+features/i   → "### Deferred Features"
 *   - /lessons?\s+learned/i    → "### Lessons Learned"
 */
export function buildActualsMarkdown(data: CloseoutData): string {
  let md = '## Actuals\n\n';

  // Completed Features — tasks with status 'approved'
  md += '### Completed Features\n';
  const completedTasks = data.tasks.filter((t) => t.status === 'approved');
  if (completedTasks.length > 0) {
    for (const task of completedTasks) {
      md += `- ${task.feature}: ${task.title}\n`;
    }
  } else {
    md += '- (None yet)\n';
  }

  md += '\n';

  // Deferred Features — tasks with status 'pending', 'blocked', or 'failed'
  md += '### Deferred Features\n';
  const deferredTasks = data.tasks.filter((t) =>
    ['pending', 'blocked', 'failed'].includes(t.status),
  );
  if (deferredTasks.length > 0) {
    for (const task of deferredTasks) {
      const reason = task.status === 'failed' ? 'failed during build' :
        task.status === 'blocked' ? 'blocked by dependencies' :
          'not started in this version';
      md += `- ${task.feature}: ${reason}\n`;
    }
  } else {
    md += '- (None)\n';
  }

  md += '\n';

  // Lessons Learned — derived from build patterns
  md += '### Lessons Learned\n';
  const lessons = deriveLessons(data);
  if (lessons.length > 0) {
    for (const lesson of lessons) {
      md += `- ${lesson}\n`;
    }
  } else {
    md += '- (None)\n';
  }

  return md;
}

// ── Lessons Derivation ───────────────────────────────────────────────

function deriveLessons(data: CloseoutData): string[] {
  const lessons: string[] = [];

  // Lesson from failed tasks
  const failedCount = data.tasks.filter((t) => t.status === 'failed').length;
  if (failedCount > 0) {
    lessons.push(`${failedCount} task(s) failed during build — review audit findings for root causes`);
  }

  // Lesson from handoffs
  const totalHandoffs = data.agents.reduce((sum, a) => sum + a.handoffCount, 0);
  if (totalHandoffs > 0) {
    lessons.push(`${totalHandoffs} context handoff(s) occurred — consider breaking large features into smaller tasks`);
  }

  // Lesson from low compliance scores
  const lowCompliance = data.tasks.filter((t) => t.complianceScore < 0.7);
  if (lowCompliance.length > 0) {
    lessons.push(`${lowCompliance.length} task(s) had compliance scores below 70% — tighten acceptance criteria`);
  }

  // Lesson about build duration
  if (data.agents.length > 0) {
    lessons.push(`Build used ${data.agents.length} agent(s) over ${data.totalDuration}`);
  }

  return lessons;
}

// ── BUILD-REPORT.md Builder ──────────────────────────────────────────

/**
 * Generate a comprehensive BUILD-REPORT.md from closeout data.
 */
export function buildReportMarkdown(data: CloseoutData): string {
  let md = `# Build Report: ${data.projectName}\n\n`;

  // Summary
  md += '## Summary\n\n';
  md += `- **Build Duration**: ${data.totalDuration}\n`;
  md += `- **Start Time**: ${data.startTime}\n`;
  md += `- **End Time**: ${data.endTime}\n`;
  md += `- **Agent Count**: ${data.agents.length}\n`;
  md += `- **PRD**: ${data.prdPath ?? 'Not found'}\n\n`;

  // Task Summary
  md += '## Task Summary\n\n';
  const approved = data.tasks.filter((t) => t.status === 'approved').length;
  const inProgress = data.tasks.filter((t) =>
    ['in_progress', 'assigned', 'in_review', 'ready_for_review', 'needs_revision'].includes(t.status),
  ).length;
  const failed = data.tasks.filter((t) => t.status === 'failed').length;
  const deferred = data.tasks.filter((t) => ['pending', 'blocked'].includes(t.status)).length;

  md += `| Status | Count |\n`;
  md += `|--------|-------|\n`;
  md += `| Completed (approved) | ${approved} |\n`;
  md += `| In Progress | ${inProgress} |\n`;
  md += `| Failed | ${failed} |\n`;
  md += `| Deferred | ${deferred} |\n`;
  md += `| **Total** | **${data.tasks.length}** |\n\n`;

  // Task Details
  if (data.tasks.length > 0) {
    md += '### Task Details\n\n';
    md += '| ID | Feature | Domain | Status | Compliance |\n';
    md += '|----|---------|--------|--------|------------|\n';
    for (const task of data.tasks) {
      md += `| ${task.id} | ${task.feature} | ${task.domain} | ${task.status} | ${(task.complianceScore * 100).toFixed(0)}% |\n`;
    }
    md += '\n';
  }

  // Agent Summary
  if (data.agents.length > 0) {
    md += '## Agents\n\n';
    md += '| ID | Role | Domain | Status | Handoffs |\n';
    md += '|----|------|--------|--------|----------|\n';
    for (const agent of data.agents) {
      md += `| ${agent.id} | ${agent.role} | ${agent.domain} | ${agent.status} | ${agent.handoffCount} |\n`;
    }
    md += '\n';
  }

  // File Manifest
  if (data.outputFiles.length > 0) {
    md += '## File Manifest\n\n';
    md += '| File | Size |\n';
    md += '|------|------|\n';
    for (const file of data.outputFiles) {
      const sizeStr = file.sizeBytes >= 1024
        ? `${(file.sizeBytes / 1024).toFixed(1)} KB`
        : `${file.sizeBytes} B`;
      md += `| ${file.relativePath} | ${sizeStr} |\n`;
    }
    md += '\n';
  }

  // Event Timeline (abbreviated)
  if (data.events.length > 0) {
    md += '## Event Timeline\n\n';
    md += `Total events: ${data.events.length}\n\n`;
    // Show first and last 5 events
    const show = data.events.length <= 10
      ? data.events
      : [...data.events.slice(0, 5), ...data.events.slice(-5)];
    md += '| Timestamp | Type | Agent |\n';
    md += '|-----------|------|-------|\n';
    for (const event of show) {
      md += `| ${event.timestamp} | ${event.eventType} | ${event.agentId ?? '-'} |\n`;
    }
    if (data.events.length > 10) {
      md += `| ... | *${data.events.length - 10} more events* | ... |\n`;
    }
    md += '\n';
  }

  return md;
}

// ── PRD Injection ────────────────────────────────────────────────────

/**
 * Inject Actuals section into an existing PRD.
 *
 * Uses gray-matter to parse frontmatter. Sets `data.commandPost.status = 'built'`
 * and `data.commandPost.built_at = ISO timestamp`. If `## Actuals` exists, replaces
 * it; otherwise appends at end. Follows the injectManningSection pattern from
 * prd-updater.ts.
 */
export function injectActualsIntoPrd(prdRaw: string, actualsMarkdown: string): string {
  const { data, content } = matter(prdRaw);

  // Update frontmatter
  if (!data.commandPost) {
    data.commandPost = {};
  }
  data.commandPost.status = 'built';
  data.commandPost.built_at = new Date().toISOString();

  // Check if ## Actuals header exists
  const actualsHeaderRegex = /^##\s+Actuals/m;
  let updatedContent = content;

  if (actualsHeaderRegex.test(content)) {
    // Replace existing Actuals section
    const actualsStart = content.search(actualsHeaderRegex);
    const remainingContent = content.substring(actualsStart);

    // Find the next ## header after the Actuals section
    const afterActualsHeader = remainingContent.substring('## Actuals'.length);
    const nextHeaderMatch = afterActualsHeader.match(/^##\s+/m);

    if (nextHeaderMatch && nextHeaderMatch.index !== undefined) {
      const nextHeaderPos = actualsStart + '## Actuals'.length + nextHeaderMatch.index;
      updatedContent = content.substring(0, actualsStart) + actualsMarkdown + '\n' + content.substring(nextHeaderPos);
    } else {
      // Actuals is the last section — replace everything from Actuals to end
      updatedContent = content.substring(0, actualsStart) + actualsMarkdown;
    }
  } else {
    // Append Actuals section at the end
    updatedContent = content.trimEnd() + '\n\n' + actualsMarkdown;
  }

  return matter.stringify(updatedContent, data);
}
