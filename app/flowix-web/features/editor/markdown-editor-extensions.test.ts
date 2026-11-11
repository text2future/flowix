import { describe, expect, it } from 'vitest';
import { createMarkdownEditorExtensions } from './markdown-editor-extensions';

/**
 * Locks the order of the editor extension registry.
 *
 * Event handling is governed by extension priority, but document parsing and
 * schema construction follow this array, so reordering is never a cosmetic
 * change. The registry is grouped by concern (schema/text, blocks, markdown
 * spec, document chrome, interaction); this snapshot is what proves a regroup
 * did not move anything.
 */
const EXPECTED_EXTENSION_ORDER = [
  'starterKit',
  'bold',
  'literalUnderscoreStrong',
  'paragraph',
  'listItem',
  'orderedList',
  'markdownEscape',
  'htmlStrongFallback',
  'legacyAdjacentStrongMarkdown',
  'preservedHtmlBlock',
  'preservedHtmlInline',
  'attachmentLink',
  'link',
  'linkSelectionHighlight',
  'codeBlock',
  'mathBlock',
  'webCard',
  'videoEmbed',
  'tableReference',
  'mediaLibraryReference',
  'highlight',
  'tablePlugin',
  'taskList',
  'taskItem',
  'markdown',
  'placeholder',
  'tag',
  'managedPasteRules',
  'markdownPaste',
  'frontmatter',
  'noteReference',
  'suggestion-@',
  'suggestion-[[',
  'suggestion-#',
  'blockGapCursor',
  'editorFirstBlockMark',
  'horizontalRuleBackspace',
  'stableCaret',
  'agentThreadCard',
  'slashMenu',
  'tabCharacter',
  'tabAgentRun',
  'searchAndReplace',
  'menuPin',
  'blockDrag',
  'listTypeShortcuts',
];

function registryNames(): string[] {
  return createMarkdownEditorExtensions({
    getOwnerPath: () => undefined,
    getAttachmentNotebookId: () => undefined,
    workspaceHost: 'column-1',
    getPlaceholder: () => '',
  }).map((extension) => extension.name);
}

describe('createMarkdownEditorExtensions', () => {
  it('registers the same extensions in the same order', () => {
    expect(registryNames()).toEqual(EXPECTED_EXTENSION_ORDER);
  });

  it('registers each extension once', () => {
    const names = registryNames();
    expect(names.length).toBe(new Set(names).size);
  });
});
