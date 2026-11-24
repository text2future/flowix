import type { AgentConversationReference } from '@features/agent/public/new-conversation-api';
import { getFileIconKind } from '@features/content/public/content-api';
import { displayTitleFromFilename } from '@/lib/utils';
import { notebookRelativeDirectoryPath, samePath } from '@/lib/path';

export interface WorkspaceHeaderCollectionContext {
  indexPath: string;
  notebookPath?: string | null;
  notebookId?: string | null;
  collectionPath?: string | null;
  collectionId?: string | null;
  name?: string | null;
  supportsNotes?: boolean;
  isFolder?: boolean;
}

export interface WorkspaceHeaderAgentReferenceInput {
  document?: { path: string; notebookId: string | null; relativePath: string | null } | null;
  media?: { path: string; notebookId: string | null } | null;
  collection?: WorkspaceHeaderCollectionContext | null;
  notebookId: string | null;
  notebookPath: string | null;
}

function collectionPathFromIndex(indexPath: string): string {
  const trimmed = indexPath.replace(/[\\/]+$/, '');
  return trimmed.replace(/[\\/]\.index\.ya?ml$/i, '') || trimmed;
}

function fileReference(path: string): AgentConversationReference {
  return { kind: 'file', path, displayName: displayTitleFromFilename(path) || path.split(/[\\/]/).pop() || path };
}

function collectionReference(
  collection: WorkspaceHeaderCollectionContext,
): AgentConversationReference | null {
  const notebookId = collection.notebookId;
  if (!notebookId) return null;
  const collectionPath = collection.collectionPath || collectionPathFromIndex(collection.indexPath);
  return {
    kind: 'collection',
    notebookId,
    collectionId: collection.collectionId ?? null,
    collectionPath,
    indexPath: collection.indexPath,
    displayName: collection.name?.trim() || displayTitleFromFilename(collectionPath) || '集合',
    ...(collection.supportsNotes ? { supportsNotes: true } : {}),
  };
}

function documentReference(
  document: NonNullable<WorkspaceHeaderAgentReferenceInput['document']>,
  notebookId: string | null,
  notebookPath: string | null,
): AgentConversationReference {
  const resolvedNotebookId = document.notebookId ?? notebookId;
  const relativePath = document.relativePath
    ?? (notebookPath ? notebookRelativeDirectoryPath(notebookPath, document.path) : null);
  if (getFileIconKind(document.path) === 'note' && resolvedNotebookId && relativePath) {
    const filename = document.path.split(/[\\/]/).pop() || relativePath.split('/').pop() || relativePath;
    return {
      kind: 'note',
      notebookId: resolvedNotebookId,
      relativePath,
      filename,
      title: displayTitleFromFilename(filename) || filename,
    };
  }
  return fileReference(document.path);
}

/** Normalize the active surface into the card model shared by all header hosts. */
export function resolveWorkspaceHeaderAgentReference(
  input: WorkspaceHeaderAgentReferenceInput,
): AgentConversationReference | null {
  const activePath = input.media?.path ?? input.document?.path ?? null;
  const collectionIsActive = input.collection
    && (!activePath || samePath(activePath, input.collection.indexPath));
  if (collectionIsActive && input.collection) {
    const collection = collectionReference(input.collection);
    if (collection) return collection;
  }
  if (input.media) return fileReference(input.media.path);
  if (input.document) return documentReference(input.document, input.notebookId, input.notebookPath);
  return input.collection ? collectionReference(input.collection) : null;
}
