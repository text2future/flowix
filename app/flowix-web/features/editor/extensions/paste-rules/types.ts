import type { Editor, JSONContent } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';

export type PasteRuleResult = 'handled' | 'continue' | 'default';

export type PasteKind =
  | 'files'
  | 'physical-path'
  | 'asset-link'
  | 'loose-code-block'
  | 'markdown-table'
  | 'html-table'
  | 'tsv-table'
  | 'rich-inline-html'
  | 'rich-html'
  | 'markdown-block';

export interface PasteContext {
  editor: Editor;
  view: EditorView;
  event: ClipboardEvent;
  types: string[];
  text: string;
  html: string;
  files: File[];
}

export interface ManagedPasteRule {
  id: string;
  kind: PasteKind;
  priority: number;
  match: (ctx: PasteContext) => boolean;
  run: (ctx: PasteContext) => PasteRuleResult;
}

export type ParsedPasteContent = JSONContent | string;
