import { canonicalDirectoryPath, joinNotebookMemoPath } from '@/lib/path';
import { files } from '@platform/tauri/client';

export async function createUniqueNotebookFile(
  notebookPath: string,
  relativeFolder: string | null | undefined,
  fileStem: string,
  extension: string,
  content: string,
): Promise<{ filePath: string; relativePath: string }> {
  const notebookRoot = canonicalDirectoryPath(notebookPath);
  const folderPath = relativeFolder
    ? joinNotebookMemoPath(notebookRoot, relativeFolder)
    : notebookRoot;
  if (!folderPath) throw new Error('集合目录无效');

  let existingNames = new Set(
    (await files.getDirChildren(folderPath)).map((entry) => entry.name.toLocaleLowerCase()),
  );
  let suffix = 1;
  while (true) {
    const filename = `${fileStem}${suffix === 1 ? '' : ` (${suffix})`}${extension}`;
    const key = filename.toLocaleLowerCase();
    if (existingNames.has(key)) {
      suffix += 1;
      continue;
    }

    const relativePath = [relativeFolder, filename].filter(Boolean).join('/');
    const filePath = joinNotebookMemoPath(notebookRoot, relativePath);
    if (!filePath) throw new Error('集合文件路径无效');
    try {
      await files.create(filePath, content, notebookRoot);
      return { filePath, relativePath };
    } catch (error) {
      existingNames = new Set(
        (await files.getDirChildren(folderPath)).map((entry) => entry.name.toLocaleLowerCase()),
      );
      if (!existingNames.has(key)) throw error;
      suffix += 1;
    }
  }
}
