import type { Editor, JSONContent } from '@tiptap/core';
import { normalizeLooseCodeBlocks } from '@features/editor/extensions/paste-rules/code-block-detector';
import type { ParsedPasteContent } from '@features/editor/extensions/paste-rules/types';

const CODE_MARK = 'code';
const CODE_BLOCK = 'codeBlock';

export const FENCED_CODE_BLOCK_RE = /(^|\r?\n)(```|~~~)[^\r\n]*\r?\n[\s\S]*?\r?\n\2(?=\r?\n|$)/;

const MARKDOWN_BLOCK_PATTERNS: RegExp[] = [
  /(^|\r?\n)#{1,6}\s+\S/,
  /(^|\r?\n)\s{0,3}[-*+]\s+\S/,
  /(^|\r?\n)\s{0,3}\d+[.)]\s+\S/,
  /(^|\r?\n)\s{0,3}[-*+]\s+\[[ xX]\]\s+/,
  /(^|\r?\n)>\s+/,
  /(^|\r?\n)```/,
  /(^|\r?\n)~~~/,
  /(^|\r?\n)\s{0,3}[-*_]{3,}\s*(?:\r?\n|$)/,
  /(^|\r?\n)\|.*\|/,
];

const MARKDOWN_TABLE_SEPARATOR_RE = /^:?-{3,}:?$/;
const FRONTMATTER_BLOCK_RE = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

function splitMarkdownTableLine(line: string): string[] {
  const trimmed = line.trim();
  const withoutLeadingPipe = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const withoutOuterPipes = withoutLeadingPipe.endsWith('|')
    ? withoutLeadingPipe.slice(0, -1)
    : withoutLeadingPipe;
  return withoutOuterPipes.split('|').map(cell => cell.trim());
}

export function looksLikeMarkdownBlock(text: string): boolean {
  return MARKDOWN_BLOCK_PATTERNS.some(pattern => pattern.test(text));
}

export function hasLeadingFrontmatter(text: string): boolean {
  return FRONTMATTER_BLOCK_RE.test(text);
}

export function containsMarkdownTable(text: string): boolean {
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerCells = splitMarkdownTableLine(lines[index]);
    const separatorCells = splitMarkdownTableLine(lines[index + 1]);

    if (headerCells.length < 2 || separatorCells.length !== headerCells.length) {
      continue;
    }

    if (separatorCells.every(cell => MARKDOWN_TABLE_SEPARATOR_RE.test(cell))) {
      return true;
    }
  }

  return false;
}

function normalizeCodeMarks(node: JSONContent, parentType?: string): JSONContent {
  const normalized: JSONContent = { ...node };

  if (parentType === CODE_BLOCK) {
    delete normalized.marks;
  } else if (normalized.type === 'text' && normalized.marks?.some(mark => mark.type === CODE_MARK)) {
    normalized.marks = normalized.marks.filter(mark => mark.type === CODE_MARK);
  }

  if (normalized.content) {
    normalized.content = normalized.content.map(child => normalizeCodeMarks(child, normalized.type));
  }

  return normalized;
}

export function parseMarkdownForPaste(markdown: string, editor: Editor): ParsedPasteContent {
  const parsed = editor.markdown?.parse(normalizeLooseCodeBlocks(markdown));
  return parsed ? normalizeCodeMarks(parsed) : markdown;
}
