import type { Editor, JSONContent } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { mergeFrontmatterYaml } from '@features/document/properties/frontmatter-model';
import type { ManagedPasteRule, PasteContext, PasteRuleResult } from '@features/editor/extensions/paste-rules/types';
import { handleFileUpload } from '@features/editor/extensions/attachment-link/upload/plugin';
import { filterFilesByMimeTypes } from '@features/editor/extensions/attachment-link/upload/file-source';
import { tryMatchPhysicalMemoPath } from '@features/editor/extensions/note-link';
import { containsLooseCodeBlock } from '@features/editor/extensions/paste-rules/code-block-detector';
import {
  containsMarkdownTable,
  FENCED_CODE_BLOCK_RE,
  hasLeadingFrontmatter,
  looksLikeMarkdown,
  parseMarkdownForPaste,
} from '@features/editor/extensions/paste-rules/markdown';
import { HTML_TABLE_RE, isStandaloneHtmlTable } from '@features/editor/extensions/paste-rules/html';
import {
  htmlTableToTableContent,
  looksLikeTsvTable,
  tsvToTableContent,
} from '@features/editor/extensions/paste-rules/table';

const ASSET_MARKDOWN_LINK_RE = /^\s*!?\[[^\]\n]*\]\((?:asset:\/\/|https?:\/\/asset\.localhost\/)[^)]+\)\s*$/i;

/**
 * Managed paste rules must still produce one user-visible history event.
 * Starting a fresh history group here also prevents a paste from merging
 * into the immediately preceding typing transaction.
 */
function insertPastedContent(content: JSONContent | string, editor: Editor): boolean {
  // Keep the pure rule tests lightweight: production editors always expose
  // Tiptap's chain API, while these tests use a minimal command stub.
  if (typeof editor.chain !== 'function') {
    return editor.commands.insertContent(content);
  }

  return editor
    .chain()
    .command(({ tr }) => {
      closeHistory(tr);
      return true;
    })
    .insertContent(content)
    .run();
}

function insertMarkdownPaste(
  markdown: string,
  editor: Editor,
  options: { normalizeLooseCodeBlocks?: boolean } = {},
): boolean {
  const parsed = parseMarkdownForPaste(markdown, editor, options);
  return mergePastedFrontmatterIntoExisting(parsed, editor)
    || insertPastedContent(parsed, editor);
}

function mergePastedFrontmatterIntoExisting(parsed: JSONContent | string, editor: Editor): boolean {
  if (typeof parsed === 'string') return false;

  const pastedNodes = parsed.content ?? [];
  const pastedFrontmatter = pastedNodes[0];
  if (pastedFrontmatter?.type !== 'frontmatter') return false;

  const currentFrontmatter = editor.state.doc.firstChild;
  if (currentFrontmatter?.type.name !== 'frontmatter') return false;

  const yamlContent = mergeFrontmatterYaml(
    String(currentFrontmatter.attrs.yamlContent ?? ''),
    String(pastedFrontmatter.attrs?.yamlContent ?? ''),
  );
  const rest = pastedNodes.slice(1);
  const chain = editor
    .chain()
    .command(({ tr }) => {
      closeHistory(tr);
      tr.setNodeMarkup(0, undefined, {
        ...currentFrontmatter.attrs,
        yamlContent,
      });
      return true;
    });

  if (rest.length === 0) return chain.run();

  return chain
    .insertContent({
      ...parsed,
      content: rest,
    })
    .run();
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
      run: ({ view, files, memoId }) => {
        const filteredFiles = filterFilesByMimeTypes(files, options.allowedMimeTypes);
        void handleFileUpload(view, filteredFiles, view.state.selection.from, undefined, memoId);
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

        insertPastedContent({
          type: 'noteReference',
          attrs: hit,
        }, editor);
        return 'handled';
      },
    },
    {
      id: 'markdown-mime',
      kind: 'markdown-mime',
      priority: 805,
      match: ({ markdown }) => markdown.trim().length > 0,
      run: ({ markdown, editor }) => insertMarkdownPaste(markdown, editor, {
        normalizeLooseCodeBlocks: false,
      })
        ? 'handled'
        : 'continue',
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
        return insertPastedContent(content, editor) ? 'handled' : 'default';
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
        return insertPastedContent(content, editor)
          ? 'handled'
          : 'continue';
      },
    },
    {
      id: 'markdown-block',
      kind: 'markdown-block',
      priority: 600,
      match: ({ text }) => !!text && (FENCED_CODE_BLOCK_RE.test(text) || looksLikeMarkdown(text)),
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

/**
 * Run the application-specific part of the paste pipeline against an
 * already-normalized clipboard snapshot. Native ProseMirror paste events are
 * not the only entry point anymore: a memo title can split a paste and route
 * the remaining payload into the body editor.
 */
export function executeManagedPasteRules(
  ctx: PasteContext,
  rules: ManagedPasteRule[] = createManagedPasteRules(),
): PasteRuleResult {
  for (const rule of rules) {
    let result: PasteRuleResult;
    try {
      if (!rule.match(ctx)) continue;
      result = rule.run(ctx);
    } catch (err) {
      console.warn('[paste-rules] rule failed:', {
        ruleId: rule.id,
        kind: rule.kind,
        error: err,
      });
      continue;
    }

    if (result === 'handled' || result === 'default') return result;
  }

  return 'continue';
}
