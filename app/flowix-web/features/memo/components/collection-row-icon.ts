import { isMediaLibraryFilename, isTableDocumentFilename } from '@/lib/utils';

/** The three collections a notebook tree row can stand for. */
export type RowCollectionType = 'table' | 'media_library' | 'work_documents';

interface RowCollectionTypeSource {
  /**
   * Collection type reported by the notebook index. Only pinned rows carry it:
   * they render the collection title instead of a filename, so the index is
   * their only icon source.
   */
  collectionType?: string | null;
  /** Text the row classifies filenames by; a pinned row's title has no suffix. */
  fileName: string;
  hasTableIdentity?: boolean;
  hasMediaLibraryIdentity?: boolean;
  workDocumentsCollection?: boolean;
}

/**
 * Which collection a tree row represents, or `undefined` for a plain file.
 *
 * Order matters: the index type wins because pinned rows have no filename to
 * read, then the catalog identity, then the filename suffix that freshly read
 * directories rely on. `.index.yaml` matches both suffix predicates, so the
 * suffix branch keeps the original "neither, until the index tells us" rule
 * instead of guessing a type from the ambiguous name.
 */
export function resolveRowCollectionType({
  collectionType,
  fileName,
  hasTableIdentity = false,
  hasMediaLibraryIdentity = false,
  workDocumentsCollection = false,
}: RowCollectionTypeSource): RowCollectionType | undefined {
  if (
    collectionType === 'table'
    || collectionType === 'media_library'
    || collectionType === 'work_documents'
  ) {
    return collectionType;
  }
  if (workDocumentsCollection) return 'work_documents';
  if (hasTableIdentity) return 'table';
  if (hasMediaLibraryIdentity) return 'media_library';
  if (isTableDocumentFilename(fileName) && !isMediaLibraryFilename(fileName)) return 'table';
  if (isMediaLibraryFilename(fileName) && !isTableDocumentFilename(fileName)) return 'media_library';
  return undefined;
}
