import { useMemo } from 'react';
import {
  documentIdentityFromFile, ExternalDocumentActions, MediaActions, readLatestDocumentContent,
  useDocumentEditorMode, setDocumentEditorMode, useDocumentCommands,
  type DocumentTitlebarProps, type DocumentTitlebarTarget,
} from '@features/document/public/shell-api';
import type { WorkspaceHeaderModel } from '@features/workspace/public/header-api';
import { requireFileDisplayIdentity } from '@/lib/file-display-registry';
import { notebookRelativeDirectoryPath } from '@/lib/path';
import { useMediaActions } from '../hooks/use-media-actions';

/** Browser supplies host-bound commands to the shared document domain menu. */
export function BrowserColumnDocumentActions({ path, scopePath, notebookId, header, collectionPath, surfaceId, onToggleMemoEditorMode, iconButtonClass }: {
  path: string;
  scopePath: string | null;
  notebookId: string | null;
  header: WorkspaceHeaderModel;
  collectionPath: string | null;
  surfaceId: string;
  onToggleMemoEditorMode: (surfaceId: string) => void | Promise<void>;
  iconButtonClass: string;
}) {
  const fileIdentity = useMemo(() => requireFileDisplayIdentity(path), [path]);
  const identity = useMemo(() => documentIdentityFromFile(fileIdentity), [fileIdentity]);
  const relativePath = scopePath ? notebookRelativeDirectoryPath(scopePath, path) : null;
  const target = useMemo<DocumentTitlebarTarget>(() => ({
    fileIdentity, scopePath, notebookId, relativePath,
    indexable: header.sourceKind === 'file-markdown' && Boolean(notebookId) && relativePath !== null,
    isOutsideCurrentNotebook: relativePath === null,
  }), [fileIdentity, header.sourceKind, notebookId, relativePath, scopePath]);
  const editorMode = useDocumentEditorMode('browser-column', identity);
  const commands = useDocumentCommands({
    currentDocumentPath: path,
    getCurrentDocumentContent: () => readLatestDocumentContent(identity, 'browser-column'),
    getCurrentDocumentEditor: () => null,
    pdfHost: 'browser-column',
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
  return <ExternalDocumentActions target={target} iconButtonClass={iconButtonClass}
    capabilities={header.documentControls} actions={actions}
    collectionDisplayIndexPath={collectionPath ?? undefined}
    showEditorFontSwitcher={header.showEditorFontSwitcher} showEditorModeToggle={header.showEditorModeToggle}
    editorMode={editorMode} onSetEditorMode={(mode) => {
      if (mode === editorMode) return;
      if (header.sourceKind === 'file-html') setDocumentEditorMode('browser-column', identity, mode);
      else void onToggleMemoEditorMode(surfaceId);
    }} />;
}

/** Both columns use the same media command hook and menu component. */
export function BrowserColumnMediaActions({ filePath, notebookPath, collectionPath, iconButtonClass }: {
  filePath: string; notebookPath: string | null; collectionPath: string | null; iconButtonClass: string;
}) {
  const target = useMemo(() => ({ filePath, notebookPath }), [filePath, notebookPath]);
  const actions = useMediaActions(target);
  return <MediaActions iconButtonClass={iconButtonClass} collectionDisplayIndexPath={collectionPath ?? undefined}
    onCopyLink={actions.handleCopyMediaLink} onRevealInFileManager={actions.handleRevealMedia}
    onRequestDelete={notebookPath ? actions.handleRequestDeleteMedia : undefined} />;
}
