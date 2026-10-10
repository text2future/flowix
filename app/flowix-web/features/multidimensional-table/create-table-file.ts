import { sanitizeFileName } from '@/lib/export-utils';
import { createUniqueNotebookFile } from '@features/collection/create-unique-notebook-file';
import { createTableDocument, serializeTableDocument, type MultidimensionalTableDocument, type TableViewType } from './model';

export async function createTableDocumentFile(
  notebookPath: string,
  relativeFolder: string | null | undefined,
  name: string,
  initialViewType: TableViewType = 'table',
): Promise<{ filePath: string; relativePath: string; name: string; table: MultidimensionalTableDocument }> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('请输入多维表格名称');

  const sanitizedName = sanitizeFileName(trimmedName);
  const fileStem = sanitizedName.replace(/\.table\.yml$/i, '');
  if (!fileStem) throw new Error('多维表格名称无效');

  const table = createTableDocument(initialViewType, fileStem);
  const { filePath, relativePath } = await createUniqueNotebookFile(
    notebookPath,
    relativeFolder,
    fileStem,
    '.table.yml',
    serializeTableDocument(table),
  );
  return { filePath, relativePath, name: fileStem, table };
}
