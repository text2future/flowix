export {
  ComposerNoteReference,
  createNoteReferenceExtension,
  NoteReference,
} from '@features/editor/extensions/note-link/view-note';
export type { NoteReferenceAttrs, NoteReferenceOptions } from '@features/editor/extensions/note-link/view-note';
export {
  tryMatchPhysicalMemoPath,
  prewarmNotebookCache,
  invalidateNotebookCache,
} from '@features/editor/extensions/note-link/memo-resolver';
