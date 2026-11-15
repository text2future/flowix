import type { DocumentResourceContext } from '@/lib/document-resource-context';
import type { LocalLinkContext } from '@/lib/local-link-reference';
import type { Editor, JSONContent } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';

export type PasteRuleResult = 'handled' | 'continue' | 'default';

export type PasteKind =
  | 'video-link'
  | 'files'
  | 'local-document-link'
  | 'markdown-mime'
  | 'asset-link'
  | 'loose-code-block'
  | 'markdown-table'
  | 'html-table'
  | 'tsv-table'
  | 'markdown-block';

export interface PasteContext extends DocumentResourceContext {
  editor: Editor;
  view: EditorView;
  linkContext?: LocalLinkContext;
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
