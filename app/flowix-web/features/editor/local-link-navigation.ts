import { files } from '@platform/tauri/client';
import { encodeDocumentComponent, resolveDocumentRelativeHref } from '@/lib/document-relative-path';
import { samePath } from '@/lib/path';
import { toast } from '@/lib/toast';
import { translate } from '@/lib/i18n';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { confirmCrossNotebookLink } from './components/cross-notebook-link-confirm';
import type { ResolvedEditorLocalLink } from './editor-link-resolution';

/** Shared policy for Wiki and Markdown clicks, after lexical path parsing. */
export async function prepareLocalLinkNavigation(
  target: ResolvedEditorLocalLink,
  documentPath?: string,
  options: { notebooks?: readonly { id: string; name: string }[]; isCurrent?: () => boolean } = {},
) {
  const isCurrent = options.isCurrent ?? (() => true);
  const source = documentPath ? await files.resolveLocation(documentPath) : null;
  if (!isCurrent()) return null;
  let location;
  if (target.notebookNoteName && source?.notebookId && source.notebookPath) {
    const candidate = resolveDocumentRelativeHref(`./${encodeDocumentComponent(target.notebookNoteName)}.md`,
      `${source.notebookPath.replace(/[\\/]+$/, '')}/_source.md`);
    if (candidate) {
      const note = await files.resolveLocation(candidate.path);
      if (note.isDirectory === false) location = note;
    }
  }
  location ??= await files.resolveLocation(target.path);
  if (!isCurrent()) return null;
  if (location.isDirectory == null && target.fallbackPath && target.fallbackPath !== target.path) {
    location = await files.resolveLocation(target.fallbackPath);
    if (!isCurrent()) return null;
  }
  if (location.isDirectory == null) {
    throw new Error(translate(getCurrentAppLanguage(), 'errors.friendly.linkOpen'));
  }
  if (source && location.notebookId && location.notebookId !== source.notebookId) {
    const notebook = options.notebooks?.find(item => item.id === location.notebookId);
    const destination = { id: location.notebookId, name: notebook?.name
      ?? location.notebookPath?.split(/[\\/]/).filter(Boolean).pop() ?? location.notebookId };
    if (!await confirmCrossNotebookLink(source.notebookId, destination) || !isCurrent()) return null;
  }
  const isCurrentDocument = Boolean(source && !location.isDirectory && samePath(source.path, location.path));
  if (isCurrentDocument) toast.info(translate(getCurrentAppLanguage(), 'editor.link.currentDocument'));
  return { location, isCurrentDocument };
}
