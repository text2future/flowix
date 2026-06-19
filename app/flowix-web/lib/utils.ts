import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Format a timestamp (ms) to a consistent YYYY/M/D HH:mm string
 */
export function formatDateTime(timestamp: number | null | undefined): string {
  if (!timestamp) return ''
  const d = new Date(timestamp)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 展示用笔记名 ── 把磁盘文件名 (`Hello.md` / `untitled-2026-06-14.md` / `Foo-1.md`)
 * 剥掉末尾 `.md` 后缀, 供 UI 列表 / dropdown / 搜索结果 / 导出文件名等展示场景。
 *
 * 物理路径拼接 / index.json `filename` key 跟磁盘对齐, **不要** 走本函数
 * (走 `lib/path` 里的 `joinNotebookMemoPath`)。
 *
 * 边界:
 * - 空字符串 / `undefined` / `null` → 原样返回 (空串)
 * - 不区分大小写: `.MD` / `.Md` / `.markdown` 一并剥掉 (跟后端
 *   `IsMd` 判定的 `.md` / `.markdown` 后缀口径一致)
 * - 多个后缀 (例如 `Foo.md.bak`) 不动, 避免误剥
 */
export function displayTitleFromFilename(filename: string | null | undefined): string {
  if (!filename) return '';
  return filename.replace(/\.(md|markdown)$/i, '');
}
