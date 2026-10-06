import { files, mediaResources } from '@platform/tauri/client';

/** Read a cached notebook-scoped video poster through the native thumbnail pipeline. */
export async function getNotebookVideoPreview(
  filePath: string,
  notebookPath: string,
  requestId = crypto.randomUUID(),
): Promise<string | null> {
  try {
    const cachedFile = await mediaResources.thumbnail(
      filePath,
      notebookPath,
      'video',
      requestId,
    );
    return cachedFile ? files.toAssetUrl(cachedFile) : null;
  } catch {
    return null;
  }
}
