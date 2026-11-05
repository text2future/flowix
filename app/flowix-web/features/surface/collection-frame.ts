import type { BrowserColumnEntry } from '@features/workspace/public/browser-column-api';
import type { WorkColumnSurface } from './types';

/**
 * Work header 的「···」按它找集合：文件夹入口就是 `<folder>/.index.yaml`，
 * 集合文件入口用它自己的路径。
 *
 * 这里刻意不从 `@features/collection/public/folder-api` 借 `collectionIndexPathForFolder`：
 * 那条路径会把集合文件会话（以及表格 / 媒体 / 列表模型）拉进 header 的静态闭包，
 * 而这里只需要拼一个字符串。两处的约定由各自的注释钉住。
 */
export function collectionIndexPath(surface: WorkColumnSurface | null): string | null {
  switch (surface?.kind) {
    case 'file-browser': return surface.collectionDisplay || surface.collectionType ? surface.activeFilePath : null;
    case 'folder-collection': return `${surface.folderPath.replace(/[\\/]+$/, '')}/.index.yaml`;
    case 'table-file':
    case 'media-library-file':
    case 'work-documents-file': return surface.fileIdentity.path;
    default: return null;
  }
}

/** Browser adapters use the same collection index convention as Work. */
export function browserCollectionIndexPath(entry: BrowserColumnEntry | null): string | null {
  const target = entry?.target;
  if (target?.kind === 'folder-collection') return `${target.folderPath.replace(/[\\/]+$/, '')}/.index.yaml`;
  if (target?.kind === 'file-browser' && (target.collectionDisplay || target.collectionType)) return target.activeFilePath;
  return null;
}
