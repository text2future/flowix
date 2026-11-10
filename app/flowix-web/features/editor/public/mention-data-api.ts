/**
 * Mention data shared with the shell and other features.
 *
 * These are plain data/query modules — no ProseMirror, no Node views — which is
 * what lets `app/main-window-effects.tsx` and other features invalidate the
 * mention caches without importing the editor's extension tree. Node views and
 * the Tiptap spec stay private to `features/editor`.
 */
export {
  invalidateMentionNotes,
  queryMentionNotes,
  toNoteReferenceAttrs,
  type MentionNoteItem,
} from '../extensions/note-mention/note-mention-data';
export {
  filterMentionTags,
  invalidateMentionTags,
  queryMentionTags,
  setNotebookIdProvider,
  type MentionTagItem,
} from '../extensions/tag-mention/tag-mention-data';
