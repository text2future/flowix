/**
 * Path-based content currently shown in the main column.
 *
 * 位置 0 始终是紧邻笔记列表的列，交换时实例随 index 移动。
 * 因此列表选中与文件树高亮只读主内容区，与焦点无关——焦点可以停在辅助栏，
 * 那不代表用户在看它。
 *
 * Kept as a narrow public entry (not a barrel) so tree components never touch
 * the stores.
 */
import { useBrowserColumnStore } from '../store/browser-column-store';
import { useColumnTarget } from '../store/column-navigation';
import type { WorkColumnTarget } from '../store/work-column-target';

function filePath(target: WorkColumnTarget): string | null {
  if (target.kind === 'external') return target.path;
  if (target.kind === 'file-browser') return target.activeFilePath;
  if (target.kind === 'media') return target.filePath;
  if (target.kind === 'table' || target.kind === 'media-library' || target.kind === 'collection') return target.filePath;
  return null;
}

/**
 * The main column wins; only when it shows no file do we fall back to the side
 * column, and only while that column is actually on screen.
 */
export function resolveActiveFilePath(input: {
  mainPath: string | null;
  sidePath: string | null;
  sideVisible: boolean;
}): string | null {
  if (input.mainPath) return input.mainPath;
  return input.sideVisible ? input.sidePath : null;
}

export function useActiveFilePath(): string | null {
  const visible = useBrowserColumnStore((state) => state.visible);
  const mainPath = filePath(useColumnTarget(0));
  const sidePath = filePath(useColumnTarget(1));
  return resolveActiveFilePath({ mainPath, sidePath, sideVisible: visible });
}
