/**
 * Per-path mutable buffer for a document. The 3 fields here used to be
 * module-singleton refs in useDocumentContent; now they live in a
 * module-level Map<filePath, DocumentBuffer> owned by buffer-registry so
 * switching memos doesn't trample the previously-open memo's pending
 * state, and so the document store can coordinate save flushes without
 * going through module-singleton closer hooks.
 *
 *   - `content`         — the live working content. Updated on every
 *                         keystroke (handleChange).
 *   - `lastSavedContent` — the last content successfully written to disk.
 *                         Used as the CAS expected value.
 *   - `pendingContent`  — the content waiting to be written, if any.
 *                         Cleared by onSaved when content == written.
 */
export interface DocumentBuffer {
  content: string;
  lastSavedContent: string;
  pendingContent: string | null;
}

export function emptyDocumentBuffer(): DocumentBuffer {
  return { content: '', lastSavedContent: '', pendingContent: null };
}
