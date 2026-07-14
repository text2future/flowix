import type { Editor, JSONContent } from '@tiptap/core';
import YAML from 'yaml';
import type { ManagedPasteRule } from '@features/editor/extensions/paste-rules/types';
import { handleFileUpload } from '@features/editor/extensions/attachment-link/upload/plugin';
import { filterFilesByMimeTypes } from '@features/editor/extensions/attachment-link/upload/file-source';
import { tryMatchPhysicalMemoPath } from '@features/editor/extensions/note-link';
import { containsLooseCodeBlock } from '@features/editor/extensions/paste-rules/code-block-detector';
import {
  containsMarkdownTable,
  FENCED_CODE_BLOCK_RE,
  hasLeadingFrontmatter,
  looksLikeMarkdownBlock,
  parseMarkdownForPaste,
} from '@features/editor/extensions/paste-rules/markdown';
import {
  HTML_TABLE_RE,
  RICH_HTML_RE,
  hasMeaningfulInlineHtml,
  isStandaloneHtmlTable,
} from '@features/editor/extensions/paste-rules/html';
import {
  htmlTableToTableContent,
  looksLikeTsvTable,
  tsvToTableContent,
} from '@features/editor/extensions/paste-rules/table';

const ASSET_MARKDOWN_LINK_RE = /^\s*!?\[[^\]\n]*\]\((?:asset:\/\/|https?:\/\/asset\.localhost\/)[^)]+\)\s*$/i;

function parsedFrontmatterData(yamlContent: string): Record<string, unknown> {
  try {
    const parsed = YAML.parse(yamlContent) || {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const { key: _ignored, ...rest } = parsed as Record<string, unknown>;
    return rest;
  } catch {
    return {};
  }
}

export function mergeFrontmatterYaml(currentYaml: string, pastedYaml: string): {
  yamlContent: string;
  parsedData: Record<string, unknown>;
} {
  const current = parsedFrontmatterData(currentYaml);
  const pasted = parsedFrontmatterData(pastedYaml);
  const currentRaw = YAML.parse(currentYaml) || {};
  const existingKey = currentRaw && typeof currentRaw === 'object' && !Array.isArray(currentRaw)
    ? (currentRaw as Record<string, unknown>).key
    : undefined;
  const merged = existingKey === undefined
    ? { ...current, ...pasted }
    : { key: existingKey, ...current, ...pasted };
  const yamlContent = YAML.stringify(merged, { lineWidth: 0 }).trimEnd();

  return {
    yamlContent,
    parsedData: parsedFrontmatterData(yamlContent),
  };
}

function insertMarkdownPaste(markdown: string, editor: Editor): boolean {
  const parsed = parseMarkdownForPaste(markdown, editor);
  return mergePastedFrontmatterIntoExisting(parsed, editor)
    || editor.commands.insertContent(parsed);
}

function mergePastedFrontmatterIntoExisting(parsed: JSONContent | string, editor: Editor): boolean {
  if (typeof parsed === 'string') return false;

  const pastedNodes = parsed.content ?? [];
  const pastedFrontmatter = pastedNodes[0];
  if (pastedFrontmatter?.type !== 'frontmatter') return false;

  const currentFrontmatter = editor.state.doc.firstChild;
  if (currentFrontmatter?.type.name !== 'frontmatter') return false;

  const merged = mergeFrontmatterYaml(
    String(currentFrontmatter.attrs.yamlContent ?? ''),
    String(pastedFrontmatter.attrs?.yamlContent ?? ''),
  );
  const tr = editor.state.tr.setNodeMarkup(0, undefined, {
    ...currentFrontmatter.attrs,
    yamlContent: merged.yamlContent,
    parsedData: merged.parsedData,
  });
  editor.view.dispatch(tr);

  const rest = pastedNodes.slice(1);
  if (rest.length === 0) return true;

  return editor.commands.insertContent({
    ...parsed,
    content: rest,
  });
}

export function createManagedPasteRules(options: {
  allowedMimeTypes?: string[];
} = {}): ManagedPasteRule[] {
  const rules: ManagedPasteRule[] = [
    {
      id: 'files',
      kind: 'files',
      priority: 1000,
      match: ({ files }) => filterFilesByMimeTypes(files, options.allowedMimeTypes).length > 0,
      run: ({ view, files }) => {
        const filteredFiles = filterFilesByMimeTypes(files, options.allowedMimeTypes);
        void handleFileUpload(view, filteredFiles, view.state.selection.from);
        return 'handled';
      },
    },
    {
      id: 'physical-memo-path',
      kind: 'physical-path',
      priority: 900,
      match: ({ text, editor }) => {
        const trimmed = text.trim();
        return !!trimmed &&
          !/[\r\n]/.test(trimmed) &&
          !!editor.schema.nodes.noteReference &&
          !!tryMatchPhysicalMemoPath(trimmed);
      },
      run: ({ text, editor }) => {
        const hit = tryMatchPhysicalMemoPath(text.trim());
        if (!hit || !editor.schema.nodes.noteReference) return 'continue';

        editor.commands.insertContent({
          type: 'noteReference',
          attrs: hit,
        });
        return 'handled';
      },
    },
    {
      id: 'asset-markdown-link',
      kind: 'asset-link',
      priority: 800,
      match: ({ text }) => ASSET_MARKDOWN_LINK_RE.test(text),
      run: ({ text, editor }) => {
        const markdown = text.replace(/\r\n/g, '\n');
        return insertMarkdownPaste(markdown, editor)
          ? 'handled'
          : 'continue';
      },
    },
    {
      id: 'loose-code-block',
      kind: 'loose-code-block',
      priority: 790,
      match: ({ text }) => containsLooseCodeBlock(text),
      run: ({ text, editor }) => {
        const markdown = text.replace(/\r\n/g, '\n');
        return insertMarkdownPaste(markdown, editor)
          ? 'handled'
          : 'continue';
      },
    },
    {
      id: 'markdown-table',
      kind: 'markdown-table',
      priority: 770,
      match: ({ text }) => containsMarkdownTable(text),
      run: ({ text, editor }) => {
        const markdown = text.replace(/\r\n/g, '\n');
        return insertMarkdownPaste(markdown, editor)
          ? 'handled'
          : 'continue';
      },
    },
    {
      id: 'frontmatter-markdown',
      kind: 'markdown-block',
      priority: 765,
      match: ({ text }) => hasLeadingFrontmatter(text),
      run: ({ text, editor }) => {
        const markdown = text.replace(/\r\n/g, '\n');
        return insertMarkdownPaste(markdown, editor)
          ? 'handled'
          : 'continue';
      },
    },
    {
      id: 'html-table',
      kind: 'html-table',
      priority: 760,
      match: ({ html, editor }) => !!editor.schema.nodes.table && HTML_TABLE_RE.test(html) && isStandaloneHtmlTable(html),
      run: ({ html, editor }) => {
        const content = htmlTableToTableContent(html);
        if (!content) return 'default';
        return editor.commands.insertContent(content) ? 'handled' : 'default';
      },
    },
    {
      id: 'tsv-table',
      kind: 'tsv-table',
      priority: 750,
      match: ({ text, html, types, editor }) => {
        if (!editor.schema.nodes.table) return false;
        if (html.trim().length > 0 && HTML_TABLE_RE.test(html)) return false;
        return types.includes('text/plain') && looksLikeTsvTable(text);
      },
      run: ({ text, editor }) => {
        const content = tsvToTableContent(text);
        if (!content) return 'continue';
        return editor.commands.insertContent(content)
          ? 'handled'
          : 'continue';
      },
    },
    {
      id: 'rich-html',
      kind: 'rich-html',
      priority: 700,
      match: ({ html }) => html.trim().length > 0 && RICH_HTML_RE.test(html),
      run: () => 'default',
    },
    {
      id: 'rich-inline-html',
      kind: 'rich-inline-html',
      priority: 650,
      match: ({ html }) => html.trim().length > 0 && hasMeaningfulInlineHtml(html),
      run: () => 'default',
    },
    {
      id: 'markdown-block',
      kind: 'markdown-block',
      priority: 600,
      match: ({ text }) => !!text && (FENCED_CODE_BLOCK_RE.test(text) || looksLikeMarkdownBlock(text)),
      run: ({ text, editor }) => {
        const markdown = text.replace(/\r\n/g, '\n');
        return insertMarkdownPaste(markdown, editor)
          ? 'handled'
          : 'continue';
      },
    },
  ];

  return rules.sort((a, b) => b.priority - a.priority);
}
