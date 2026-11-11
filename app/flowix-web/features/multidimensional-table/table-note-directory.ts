/** Notebook-relative directory for notes created by a table. */
export function tableNoteDirectory(collectionId: string): string {
  if (!/^col_[a-zA-Z0-9_-]+$/.test(collectionId)) throw new Error('多维表格 ID 无效');
  return `.flowix/database/${collectionId}`;
}
