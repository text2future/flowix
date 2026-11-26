import type { DocumentResourceContext } from '@/lib/document-resource-context';
import type { EditorImageContext } from './editor-image-source';
import type { Editor } from '@tiptap/core';
import type { ReactNode } from 'react';
import type { EditorLinkContext } from '@features/editor/editor-link-resolution';
import type { ClipboardSnapshot } from '@features/editor/extensions/paste-rules/clipboard';
import type { WorkspaceColumnId } from '@features/workspace/public/host-api';
import type { SearchPanelControlProps } from './use-search-panel-state';

export type MarkdownEditorProps = SearchPanelControlProps & {
  /** Absolute or notebook-relative path of the note owning editor uploads. */
  ownerPath?: string;
  /** Workspace surface hosting this editor, passed to surface-aware NodeViews. */
  workspaceHost?: WorkspaceColumnId;
  /** Read the current path when an upload starts, including after a rename. */
  getAttachmentContext?: () => DocumentResourceContext;
  propertyTargetId?: string;
  onPropertyAreaHoverChange?: (hovered: boolean) => void;
  onViewSourceMode?: () => void;
  transitionId?: number | null;
  content: string;
  editable?: boolean;
  placeholder?: string;
  onChange?: (markdown: string) => void;
  /** Schedule capture on the owning document clock, without serializing on input. */
  onDirty?: () => void;
  className?: string;
  onEditorScroll?: (scrollTop: number) => void;
  autoFocus?: boolean;
  onBeforeCreate?: (editor: Editor) => void;
  onEditingFinished?: () => void;
  /** Move focus from the first editable body block to the title. */
  onFocusTitle?: () => void;
  /** Append the first editable body line to the existing title. */
  /** Return false when the title update was refused; the body block is then preserved. */
  onAppendToTitle?: (title: string) => void | boolean | Promise<boolean>;
  /**
   * Navigation context for in-content links: relative path hrefs resolve
   * against `documentPath` and route through `openLocalPath` (supplied by the
   * document layer). Omitted contexts fall back to the historic web opener.
   */
  linkContext?: EditorLinkContext;
  imageContext?: EditorImageContext;
  /** Content in the document scroller that stays outside ProseMirror. */
  header?: ReactNode;
}

export interface PendingExternalContent {
  content: string;
  localEditVersion: number;
}

export interface MarkdownEditorHandle {
  flushPendingChanges: () => string | null;
  commitPropertyDraft?: () => void;
  getCurrentMarkdown: () => string;
  revealSourceLocation?: (location: { line: number; column?: number }) => { clamped: boolean } | null;
  revealSourceAnchor?: (anchor: string) => boolean | null;
  /** Reveal a GitHub-slug heading anchor in the rich text view (scroll only). */
  revealHeadingAnchor?: (anchor: string) => boolean | null;
  focusStart?: () => void;
  moveTitleToBody?: (trailingContent: string) => void;
  pasteToBody?: (snapshot: ClipboardSnapshot) => boolean;
}

