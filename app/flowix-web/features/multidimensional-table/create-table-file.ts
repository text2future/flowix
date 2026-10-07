import { sanitizeFileName } from '@/lib/export-utils';
import { canonicalDirectoryPath, joinNotebookMemoPath } from '@/lib/path';
import { files } from '@platform/tauri/client';
import { createTableDocument, serializeTableDocument, type MultidimensionalTableDocument, type TableViewType } from './model';

export async function createTableDocumentFile(
  notebookPath: string,
  relativeFolder: string | null | undefined,
  name: string,
  initialViewType: TableViewType = 'table',
): Promise<{ filePath: string; relativePath: string; name: string; table: MultidimensionalTableDocument }> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('请输入多维表格名称');

  const notebookRoot = canonicalDirectoryPath(notebookPath);
  const folderPath = relativeFolder
    ? joinNotebookMemoPath(notebookRoot, relativeFolder)
    : notebookRoot;
  if (!folderPath) throw new Error('多维表格目录无效');

  const sanitizedName = sanitizeFileName(trimmedName);
  const fileStem = sanitizedName.replace(/\.table\.yml$/i, '');
  if (!fileStem) throw new Error('多维表格名称无效');

  const directoryEntries = await files.getDirChildren(folderPath);
  const existingNames = new Set(directoryEntries.map((entry) => entry.name.toLocaleLowerCase()));
  let filename = `${fileStem}.table.yml`;
  let suffix = 2;
  while (existingNames.has(filename.toLocaleLowerCase())) {
    filename = `${fileStem} (${suffix}).table.yml`;
    suffix += 1;
  }

  const relativePath = [relativeFolder, filename].filter(Boolean).join('/');
  const filePath = joinNotebookMemoPath(notebookRoot, relativePath);
  if (!filePath) throw new Error('多维表格路径无效');
  const table = createTableDocument(initialViewType, fileStem);
  const saved = await files.write(filePath, serializeTableDocument(table), false, notebookRoot);
  if (!saved) throw new Error('创建多维表格失败');
  return { filePath, relativePath, name: fileStem, table };
}
