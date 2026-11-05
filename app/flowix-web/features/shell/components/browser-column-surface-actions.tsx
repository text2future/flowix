import { useMemo } from 'react';
import {
  documentIdentityFromFile, readLatestDocumentContent, resolveDocumentTitlebarTarget, captureLatestDocumentContent,
  useDocumentEditorMode, setDocumentEditorMode, useDocumentCommands,
  type DocumentTitlebarProps, type DocumentTitlebarTarget,
} from '@features/document/public/header-api';
import type { WorkspaceHeaderModel } from '@features/workspace/public/header-api';
import type { WorkspaceColumnId } from '@features/workspace/public/surface-api';
import { requireFileDisplayIdentity } from '@/lib/file-display-registry';
import { notebookRelativeDirectoryPath } from '@/lib/path';
import { useShellSelectedNotebook } from '@features/memo/public/note-creation-api';
import { useMediaActions } from '../hooks/use-media-actions';
import { WorkspaceHeaderContentActions } from './workspace-header-content-actions';

/** File-browser sessions bind commands to their own editor, regardless of physical placement. */
export function WorkspaceDocumentHeaderActions({ path, scopePath, notebookId, header, collectionPath, surfaceId, onToggleMemoEditorMode, iconButtonClass, columnId }: {
  columnId: WorkspaceColumnId;
  path: string;
  scopePath: string | null;
  notebookId: string | null;
  header: Pick<WorkspaceHeaderModel, 'sourceKind' | 'documentControls' | 'showEditorFontSwitcher' | 'showEditorModeToggle'>;
  collectionPath: string | null;
  surfaceId?: string;
  onToggleMemoEditorMode?: (surfaceId: string) => void | Promise<void>;
  iconButtonClass: string;
}) {
  const fileIdentity = useMemo(() => requireFileDisplayIdentity(path), [path]);
  const identity = useMemo(() => documentIdentityFromFile(fileIdentity), [fileIdentity]);
  const selectedNotebook = useShellSelectedNotebook();
  const relativePath = scopePath ? notebookRelativeDirectoryPath(scopePath, path) : null;
  const target = useMemo<DocumentTitlebarTarget>(() => resolveDocumentTitlebarTarget(fileIdentity, {
    fileIdentity, scopePath, notebookId, relativePath,
    indexable: header.sourceKind === 'file-markdown' && Boolean(notebookId) && relativePath !== null,
  }, selectedNotebook?.path ?? null), [fileIdentity, header.sourceKind, notebookId, relativePath, scopePath, selectedNotebook?.path]);
  const editorMode = useDocumentEditorMode(columnId, identity);
  const commands = useDocumentCommands({
    currentDocumentPath: path,
    getCurrentDocumentContent: () => readLatestDocumentContent(identity, columnId),
    getCurrentDocumentEditor: () => null,
    pdfHost: columnId,
  });
  const actions: DocumentTitlebarProps['actions'] = {
    onCopyLink: () => { void commands.handleCopyLink(); },
    onCopyFullText: () => { void commands.handleCopyFullText(); },
    onExportMarkdown: () => { void commands.handleExportMarkdown(); },
    onSaveAsTemplate: () => { void commands.handleSaveAsTemplate(); },
    onExportWord: () => { void commands.handleExportWord(); },
    onExportPdf: () => { void commands.handleExportPdf(); },
    onDeleteExternalFile: () => { window.dispatchEvent(new CustomEvent('flowix:request-delete-external-file', {
      detail: { filePath: path, notebookPath: scopePath },
    })); },
  };
  return <WorkspaceHeaderContentActions iconButtonClass={iconButtonClass}
    collection={collectionPath ? { indexPath: collectionPath, notebookPath: scopePath, notebookId } : null}
    document={{ target, capabilities: header.documentControls, actions,
      showEditorFontSwitcher: header.showEditorFontSwitcher, showEditorModeToggle: header.showEditorModeToggle,
      editorMode, onSetEditorMode: (mode) => {
        if (mode === editorMode) return;
        if (header.sourceKind === 'file-markdown' && onToggleMemoEditorMode && surfaceId) {
          void onToggleMemoEditorMode(surfaceId);
        } else {
          captureLatestDocumentContent(identity, columnId);
          setDocumentEditorMode(columnId, identity, mode);
        }
      },
    }} />;
}

/** Both columns use the same media command hook and menu component. */
export function BrowserColumnMediaActions({ filePath, notebookPath, notebookId, collectionPath, iconButtonClass }: {
  filePath: string; notebookPath: string | null; notebookId: string | null; collectionPath: string | null; iconButtonClass: string;
}) {
  const target = useMemo(() => ({ filePath, notebookPath }), [filePath, notebookPath]);
  const actions = useMediaActions(target);
  return <WorkspaceHeaderContentActions iconButtonClass={iconButtonClass}
    collection={collectionPath ? { indexPath: collectionPath, notebookPath, notebookId } : null}
    media={{ onCopyLink: actions.handleCopyMediaLink, onRevealInFileManager: actions.handleRevealMedia,
      onRequestDelete: notebookPath ? actions.handleRequestDeleteMedia : undefined }} />;
}
