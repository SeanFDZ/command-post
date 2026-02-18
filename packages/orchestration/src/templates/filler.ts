/**
 * Template filler — replaces {placeholders} with actual values.
 */

/**
 * Replace all `{placeholder}` tokens in a template with corresponding values.
 *
 * Placeholders use simple curly brace syntax: `{agent_id}`, `{feature_list}`, etc.
 * Only placeholders whose keys appear in `variables` are replaced; unmatched
 * placeholders are left intact so downstream processors can fill them.
 *
 * @param template  — raw markdown template with {placeholders}
 * @param variables — key-value map of placeholder names to replacement strings
 * @returns the filled template
 */
export function fillTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    // Replace all occurrences of {key} with the value.
    // Use a global regex so every instance is replaced.
    const pattern = new RegExp(`\\{${escapeRegex(key)}\\}`, 'g');
    result = result.replace(pattern, value);
  }
  return result;
}

/**
 * Extract all placeholder names from a template.
 *
 * @returns deduplicated array of placeholder names (without braces)
 */
export function extractPlaceholders(template: string): string[] {
  const matches = template.matchAll(/\{([a-z_][a-z0-9_]*)\}/g);
  const names = new Set<string>();
  for (const m of matches) {
    names.add(m[1]);
  }
  return [...names];
}

/** Escape special regex characters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
