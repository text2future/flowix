/**
 * Parse YAML meta information from message content
 * Format: ---\nselecteditem: "/path"\n---\ncontent
 *
 * Also extracts a leading `<citation>…</citation>` block if present. The
 * citation may appear before or after the YAML frontmatter; we strip it from
 * the markdown body before passing it on to the renderer, and surface it as
 * a first-class piece of meta so the message bubble can render it as a card.
 */

export interface ParsedMeta {
  meta: {
    selecteditem?: string;
  };
  citation?: string;
  content: string;
}

const CITATION_RE = /^<citation>\n([\s\S]*?)\n<\/citation>\n?/;

function extractCitation(raw: string): { citation?: string; rest: string } {
  const match = raw.match(CITATION_RE);
  if (!match) {
    return { rest: raw };
  }
  return {
    citation: match[1],
    rest: raw.slice(match[0].length),
  };
}

export function parseYamlMeta(content: string): ParsedMeta {
  // Pull the citation first (it lives at the very top of the payload) so the
  // YAML matcher below still anchors on `^---\n`.
  const { citation, rest } = extractCitation(content);

  const yamlMatch = rest.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (yamlMatch) {
    const yamlStr = yamlMatch[1];
    const messageContent = yamlMatch[2];
    // Parse {selecteditem: "/path"} format
    const selectedItemMatch = yamlStr.match(/selecteditem:\s*"([^"]+)"/);
    return {
      meta: { selecteditem: selectedItemMatch?.[1] },
      citation,
      content: messageContent,
    };
  }
  return { meta: {}, citation, content: rest };
}