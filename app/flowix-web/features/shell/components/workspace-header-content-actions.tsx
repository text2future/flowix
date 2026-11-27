import type { ComponentProps } from 'react';
import type { WorkspaceColumnId } from '@features/workspace/public/surface-api';
import {
  ExternalDocumentActions, ExternalTitlebarBadge, MediaActions, NoteShareControl,
} from '@features/document/public/header-api';
import { CollectionDisplayMenu } from '@features/collection/public/header-api';
import { WorkspaceAgentHeaderAction } from './workspace-agent-header-action';
import { useShellNotebooks } from '@features/memo/public/shell-api';
import { useShellSelectedNotebook } from '@features/memo/public/note-creation-api';
import {
  resolveWorkspaceHeaderAgentReference,
  type WorkspaceHeaderCollectionContext,
} from '@features/shell/model/workspace-header-agent-reference';

type DocumentActions = Omit<ComponentProps<typeof ExternalDocumentActions>, 'iconButtonClass' | 'visible' | 'collectionDisplay'>;
type MediaActionProps = Omit<ComponentProps<typeof MediaActions>, 'iconButtonClass' | 'collectionDisplay'>;

/** Content menus are shared across sessions and physical hosts. Adapters only bind commands. */
export function WorkspaceHeaderContentActions({ document, media, collection, collectionHost, notebookId, mediaReference, iconButtonClass }: {
  document?: DocumentActions;
  media?: MediaActionProps;
  collection?: WorkspaceHeaderCollectionContext | null;
  collectionHost?: WorkspaceColumnId;
  notebookId?: string | null;
  mediaReference?: { path: string; notebookId: string | null } | null;
  iconButtonClass: string;
}) {
  const selectedNotebook = useShellSelectedNotebook();
  const notebooks = useShellNotebooks();
  const collectionContext = collection ? { ...collection,
    notebookPath: collection.notebookPath ?? document?.target.scopePath,
    notebookId: collection.notebookId ?? document?.target.notebookId,
  } : null;
  const resolvedNotebookId = document?.target.notebookId
    ?? mediaReference?.notebookId
    ?? collectionContext?.notebookId
    ?? notebookId
    ?? selectedNotebook?.id
    ?? null;
  const resolvedNotebookPath = notebooks.find((item) => item.id === resolvedNotebookId)?.path
    ?? (selectedNotebook?.id === resolvedNotebookId ? selectedNotebook.path : null)
    ?? collectionContext?.notebookPath
    ?? null;
  const agentReference = resolveWorkspaceHeaderAgentReference({
    document: document?.target ? {
      path: document.target.fileIdentity.path,
      notebookId: document.target.notebookId,
      relativePath: document.target.relativePath,
    } : null,
    media: mediaReference,
    collection: collectionContext,
    notebookId: resolvedNotebookId,
    notebookPath: resolvedNotebookPath,
  });
  const headerAgentAction = collectionHost
    ? <WorkspaceAgentHeaderAction host={collectionHost}
        notebookId={resolvedNotebookId}
        reference={agentReference}
        iconButtonClass={iconButtonClass} />
    : null;
  if (media) return <>
    {headerAgentAction}
    <MediaActions {...media} iconButtonClass={iconButtonClass} collectionDisplay={collectionContext} />
  </>;
  if (document) return <>
    {headerAgentAction}
    <ExternalTitlebarBadge target={document.target} />
    <ExternalDocumentActions key={`${document.target.fileIdentity.displayId}:${document.target.fileIdentity.path}`} {...document} iconButtonClass={iconButtonClass} collectionDisplay={collectionContext} />
  </>;
  if (collectionContext) return <>
    {headerAgentAction}
    {collectionContext.isFolder && collectionContext.collectionPath && <NoteShareControl
      key={collectionContext.collectionPath} filePath={collectionContext.collectionPath} kind="folder" flushDocument={async () => true} iconButtonClass={iconButtonClass} />}
    <CollectionDisplayMenu {...collectionContext} iconButtonClass={iconButtonClass} />
  </>;
  return <>{headerAgentAction}</>;
}
