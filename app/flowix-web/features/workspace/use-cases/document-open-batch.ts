import { canonicalPath } from '@/lib/path';
import { dialogs, files } from '@platform/tauri/client';
import { requestExternalDocumentOpen, type ExternalDocumentOpenRequest } from '@platform/open-target/types';
import { resolveFileBrowserContext } from './file-browser-context';
import { openWorkspaceSurface } from '../public/session-opening-api';
import { columnAtIndex } from '../public/session-api';

type FileHost = 0 | 1;
export interface DocumentOpenItem {
  path: string;
  index: FileHost;
  /** Retained on failure, so retry never copies an already-imported file again. */
  importedPaths: Record<string, string>;
}
export interface DocumentOpenFailure {
  path: string;
  error: unknown;
}

export function createDocumentOpenBatch(request: ExternalDocumentOpenRequest): DocumentOpenItem[] {
  const paths = [...new Map(request.filePaths.filter((path) => path.trim()).map((path) => [canonicalPath(path), path])).values()];
  return paths.map((path, index) => ({
    path,
    index: request.destination === 1 || index > 0 ? 1 : 0,
    importedPaths: {},
  }));
}

/** Uses the same file type and notebook resolution as normal workspace navigation. */
export async function openDocumentFile(path: string, index: FileHost) {
  const columnId = columnAtIndex(index);
  const location = await files.resolveLocation(path);
  path = location.path;
  const context = resolveFileBrowserContext(path, {
    notebookContextPath: location.path,
    notebookId: location.notebookId, scopePath: location.notebookPath, folderPath: null,
    fileTreeVisible: true, fileTreeWidth: 220,
  });
  const target = { kind: 'external' as const, path, scopePath: context.scopePath, fileBrowser: context };
  return openWorkspaceSurface({ columnId, target, options: { notebookId: context.notebookId } });
}

/** Both actions share placement, ownership, duplicate activation and per-file retry. */
export async function executeDocumentOpenBatch(
  items: readonly DocumentOpenItem[],
  importTo?: { path: string },
): Promise<{ remaining: DocumentOpenItem[]; failures: DocumentOpenFailure[] }> {
  const remaining: DocumentOpenItem[] = [];
  const failures: DocumentOpenFailure[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = { ...items[index], importedPaths: { ...items[index].importedPaths } };
    try {
      let path = item.path;
      if (importTo) {
        const root = canonicalPath(importTo.path);
        path = item.importedPaths[root] ?? await files.importFile(item.path, importTo.path, importTo.path);
        item.importedPaths[root] = path;
      }
      const result = await openDocumentFile(path, item.index);
      if (result.status === 'cancelled') {
        remaining.push(item, ...items.slice(index + 1));
        break;
      }
    } catch (error) {
      remaining.push(item);
      failures.push({ path: item.path, error });
    }
  }
  return { remaining, failures };
}

/** The native picker grants access and submits a complete batch to the shared dialog. */
export async function selectDocumentsToOpen(): Promise<void> {
  const filePaths = await dialogs.selectFiles({ multiple: true });
  if (filePaths?.length) requestExternalDocumentOpen({ filePaths, source: 'picker', destination: 0 });
}
