/** Note creation and selection for shell commands, without importing list or navigation views. */
import { useNoteStore } from '../store/note-store';
import { noteRepository } from '../services/note-repository';
import { notes as noteApi, type NoteTemplate } from '@platform/tauri/client';
export type { NoteTemplate };
/** View kinds a notebook document can be created as, shared with the shell menus. */
export { MEMO_CREATE_VIEW_OPTIONS } from '../components/memo-create-view-options';

export function useShellSelectedNotebook() {
  return useNoteStore((state) => state.selectedNotebook);
}

/** Create a note; pass `parentRelativePath` to land it in a specific folder ('' = root). */
export async function createShellNote(notebookId: string, parentRelativePath?: string) {
  const created = await noteRepository.create(undefined, notebookId, parentRelativePath);
  useNoteStore.getState().upsertCreatedNote(created);
  return created;
}

export function listShellNoteTemplates(): Promise<NoteTemplate[]> {
  return noteApi.listTemplates();
}

export async function createShellNoteFromTemplate(templateId: string, notebookId: string) {
  const created = await noteApi.createFromTemplate(templateId, notebookId);
  useNoteStore.getState().upsertCreatedNote(created);
  return created;
}
