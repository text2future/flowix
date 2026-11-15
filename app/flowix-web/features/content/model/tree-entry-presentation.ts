import { displayTitleFromFilename, isCollectionIndexFilename, isMediaLibraryFilename, isTableDocumentFilename } from '@/lib/utils';
import { classifyFileContent, resourceKindFromPath, type ResourceKind } from './content-kind';

export type RowCollectionType = 'table' | 'media_library' | 'work_documents';

export interface RowCollectionTypeSource {
  collectionType?: string | null;
  fileName: string;
  hasTableIdentity?: boolean;
  hasMediaLibraryIdentity?: boolean;
  workDocumentsCollection?: boolean;
}

export function resolveRowCollectionType(source: RowCollectionTypeSource): RowCollectionType | undefined {
  const { collectionType, fileName, workDocumentsCollection, hasTableIdentity, hasMediaLibraryIdentity } = source;
  if (collectionType === 'table' || collectionType === 'media_library' || collectionType === 'work_documents') return collectionType;
  if (workDocumentsCollection) return 'work_documents';
  if (hasTableIdentity) return 'table';
  if (hasMediaLibraryIdentity) return 'media_library';
  const isTable = isTableDocumentFilename(fileName);
  const isMedia = isMediaLibraryFilename(fileName);
  if (isTable && !isMedia) return 'table';
  if (isMedia && !isTable) return 'media_library';
  return undefined;
}

export function treeEntryPresentation(entry: {
  name: string;
  fullPath: string;
  type: string;
  resourceKind?: ResourceKind | null;
}, source: Omit<RowCollectionTypeSource, 'fileName'> & { isPinnedCollection?: boolean } = {}) {
  const isFolder = entry.type === 'folder';
  const contentKind = isFolder ? null : classifyFileContent(entry.fullPath);
  const resourceKind = isFolder ? null : entry.resourceKind ?? resourceKindFromPath(entry.name);
  const isNote = resourceKind === 'note';
  const collectionType = isFolder ? undefined : resolveRowCollectionType({ ...source, fileName: entry.name });
  const isCollectionIndex = !isFolder && isCollectionIndexFilename(entry.name);
  const isHtmlFile = contentKind === 'html';
  const isExtensionlessDocument = isNote || collectionType === 'table' || collectionType === 'media_library'
    || isCollectionIndex || Boolean(source.isPinnedCollection);
  const folderName = isFolder ? entry.fullPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? entry.name : '';
  const isHiddenFolder = isFolder && folderName.startsWith('.') && folderName !== '.' && folderName !== '..';
  const iconKind = isFolder ? 'folder' : isNote ? 'note' : isHtmlFile ? 'html'
    : collectionType || isCollectionIndex || source.isPinnedCollection ? 'collection' : 'file';
  return {
    resourceKind, isNote, collectionType, isCollectionIndex, isHtmlFile, isExtensionlessDocument, isHiddenFolder, iconKind,
    displayName: !isFolder && (isExtensionlessDocument || isHtmlFile) ? displayTitleFromFilename(entry.name) || entry.name : entry.name,
  } as const;
}
