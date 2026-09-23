import type { Editor, JSONContent } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';

export type PasteRuleResult = 'handled' | 'continue' | 'default';

export type PasteKind =
  | 'files'
  | 'physical-path'
  | 'markdown-mime'
  | 'asset-link'
  | 'loose-code-block'
  | 'markdown-table'
  | 'html-table'
  | 'tsv-table'
  | 'markdown-block';

export interface PasteContext {
  editor: Editor;
  view: EditorView;
  /** The memo that owns attachments inserted by this editor instance. */
  memoId?: string;
  event: ClipboardEvent;
  types: string[];
  markdown: string;
  text: string;
  html: string;
  uriList: string[];
  files: File[];
  sourceMime: string;
}

export interface ManagedPasteRule {
  id: string;
  kind: PasteKind;
  priority: number;
  match: (ctx: PasteContext) => boolean;
  run: (ctx: PasteContext) => PasteRuleResult;
}

export type ParsedPasteContent = JSONContent | string;
