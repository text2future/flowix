import type { RefObject } from 'react';
import type { ClipboardSnapshot } from '@features/editor/extensions/paste-rules/clipboard';
import type { DocumentEditorMode } from '@features/document/store/document-editor-view-store';

import {
  MemoTitleEditor,
  type MemoTitleBodyNavigation,
  type MemoTitleEditorHandle,
} from './memo-title-editor';

interface SourceMemoTitleRowProps {
  memoId: string;
  filename: string;
  editable: boolean;
  autoFocus?: boolean;
  onMoveToBody: (request: MemoTitleBodyNavigation) => void;
  onPasteToBody?: (snapshot: ClipboardSnapshot) => void;
  editorMode?: DocumentEditorMode;
  onToggleEditorMode?: () => void;
  titleRef?: RefObject<MemoTitleEditorHandle | null>;
}

/**
 * The memo title for source mode. It is intentionally separate from the rich
 * document header: CodeMirror mounts this row inside its own scrollDOM, so
 * the title follows source text and uses the same monospace line geometry.
 */
export function SourceMemoTitleRow({
  memoId,
  filename,
  editable,
  autoFocus = false,
  onMoveToBody,
  onPasteToBody,
  editorMode,
  onToggleEditorMode,
  titleRef,
}: SourceMemoTitleRowProps) {
  return (
    <div className="source-memo-title-row">
      <MemoTitleEditor
        ref={titleRef}
        memoId={memoId}
        filename={filename}
        editable={editable}
        autoFocus={autoFocus}
        useDocumentSelection
        allowReadOnlyBoundaryNavigation={false}
        showPropertiesToggle={false}
        onMoveToBody={onMoveToBody}
        onPasteToBody={onPasteToBody}
        editorMode={editorMode}
        onToggleEditorMode={onToggleEditorMode}
      />
    </div>
  );
}
