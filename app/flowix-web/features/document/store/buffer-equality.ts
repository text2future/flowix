import YAML from 'yaml';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---(?:\n|$)/;

function sortMappingKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortMappingKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortMappingKeys(child)]),
  );
}

function normalizeBody(body: string): string {
  return body
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

function normalizeYaml(yamlContent: string): string {
  const document = YAML.parseDocument(yamlContent);
  if (document.errors.length > 0) {
    // Invalid YAML must remain byte-sensitive so an edit is never mistaken
    // for an unchanged document and silently discarded.
    return `invalid:${yamlContent.trim()}`;
  }
  return `valid:${JSON.stringify(sortMappingKeys(document.toJS()))}`;
}

/**
 * Normalize Markdown for editor dirty-state comparisons.
 *
 * Line endings and harmless YAML formatting/key-order changes are ignored,
 * while YAML values remain part of the comparison. In particular, changing
 * frontmatter `tags` is a real document edit and must trigger autosave/CAS.
 */
export function normalizeForEquality(content: string): string {
  const normalized = content.replace(/\r\n?/g, '\n');
  const match = FRONTMATTER_RE.exec(normalized);
  if (!match) {
    return JSON.stringify({
      frontmatter: null,
      body: normalizeBody(normalized),
    });
  }
  return JSON.stringify({
    frontmatter: normalizeYaml(match[1] ?? ''),
    body: normalizeBody(normalized.slice(match[0].length)),
  });
}

export function isContentSemanticallyEqual(a: string, b: string): boolean {
  if (a === b) return true;
  return normalizeForEquality(a) === normalizeForEquality(b);
}
