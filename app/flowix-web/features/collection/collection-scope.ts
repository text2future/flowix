'use client';

/**
 * 数据域取值范围 → 笔记本相对目录。
 *
 * 一个集合可能落在任意位置，而 `dataset.source` 只描述「相对谁、多深」：
 *   - `notebook`：整个笔记本（没有目录限制）；
 *   - `folder`：明确给出的相对目录；
 *   - `containing_folder`：集合体所在目录。
 *
 * 媒体库面板与集合顶部的图片导览都要用同一份换算，所以只放这里一处。
 */
import { canonicalDirectoryPath } from '@/lib/path';
import type { CollectionDepth, CollectionSource } from './model';

export interface CollectionScope {
  /** 笔记本相对目录；空串表示笔记本根。 */
  relativePath: string;
  depth: CollectionDepth;
}

export function resolveCollectionScope(
  source: CollectionSource | undefined,
  collectionFilePath: string,
  notebookPath: string | null,
): CollectionScope | undefined {
  if (!source || !notebookPath || source.scope === 'notebook') return undefined;
  if (source.scope === 'folder') return { relativePath: source.path ?? '', depth: source.depth };
  const root = canonicalDirectoryPath(notebookPath).replace(/\/$/, '');
  const folder = canonicalDirectoryPath(collectionFilePath.replace(/[\\/][^\\/]*$/, '')).replace(/\/$/, '');
  if (folder === root) return { relativePath: '', depth: source.depth };
  if (!folder.startsWith(`${root}/`)) return undefined;
  return { relativePath: folder.slice(root.length + 1).replace(/\\/g, '/'), depth: source.depth };
}
