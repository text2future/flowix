import { resolveLocalHtmlLink, type LocalHtmlLink } from '@/lib/local-html-link';
import { files } from '@platform/tauri/client';
import { openUrl } from '@platform/tauri/opener';
import { openNoteByDeepLink } from '@features/memo/public/note-navigation-api';
import { publishHeadingAnchorRequest } from '@features/document/public/heading-navigation-api';
import { resolveFileBrowserContext } from './file-browser-context';
import { openWorkspaceSurface } from '../public/open-surface-api';

/** HTML links use the same file classification, save barrier and history as other opens. */
export async function openHtmlLink(link: LocalHtmlLink, sourcePath: string, scopePath: string | null, sourceNotebookId: string | null = null): Promise<void> {
  const target = resolveLocalHtmlLink(link, sourcePath);
  if (target.kind === 'external') return openUrl(target.url);
  if (target.kind === 'flowix') {
    return openNoteByDeepLink(target.url, null, { destination: 1, source: 'html-link' });
  }
  if (target.kind === 'web') {
    await openWorkspaceSurface({ index: 1, source: 'html-link', target: { kind: 'web', url: target.url } });
    return;
  }
  const location = await files.resolveLocation(target.path);
  // Capture the source's notebook context, including its attached resource roots.
  // Never carry its scope onto the linked file or depend on global selection.
  const source = resolveFileBrowserContext(sourcePath, {
    notebookId: sourceNotebookId, scopePath, folderPath: null, fileTreeVisible: true, fileTreeWidth: 220,
  });
  const context = resolveFileBrowserContext(location.path, {
    notebookContextPath: location.path,
    notebookId: location.notebookId ?? source.notebookId,
    scopePath: location.notebookPath, folderPath: null, fileTreeVisible: true, fileTreeWidth: 220,
  });
  const opened = await openWorkspaceSurface({
    index: 1, source: 'html-link',
    target: { kind: 'external', path: location.path, scopePath: context.scopePath, fileBrowser: context },
    options: { notebookId: context.notebookId },
  });
  if (opened.status !== 'cancelled' && /\.(md|markdown)$/i.test(location.path)) {
    publishHeadingAnchorRequest(location.path, opened.location, target.anchor);
  }
}
