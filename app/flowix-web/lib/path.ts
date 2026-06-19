/**
 * Cross-platform path utilities for joining notebook and memo paths.
 * On Mac/Linux, uses forward slashes; on Windows, handles both \\ and /.
 *
 * v3 改造: filename 改成磁盘文件名 (含 .md, 不再带 #memoid 后缀),
 * 因此 extractMemoIdFromPath / generateMemoFilename / MEMO_ID_FILENAME_PATTERN
 * 全部移除。memo id 由后端 index.json 持有, 前端从 memo 结构读。
 */

export function joinNotebookMemoPath(notebookPath: string, memoPath: string | null | undefined): string | null {
  if (!memoPath) return null;

  // Remove trailing slashes from notebook path
  const cleanNotebook = notebookPath.replace(/[\\/]+$/, '');
  // Remove leading slashes from memo path
  const cleanMemo = memoPath.replace(/^[\\/]+/, '');

  // Use forward slash as separator - works on all platforms
  return `${cleanNotebook}/${cleanMemo}`;
}

/**
 * 给文档实例生成唯一 key:
 * - memo 文档: 走 `memo:${memoId}` 形式 (memoId 由调用方提供, 不再从路径解析)
 * - 外部文件: 退化为 `path:${path}` 形式
 *
 * 该函数仅作为"外部文件"分支的兜底入口; memo 文档应直接用 `memo:${memoId}`。
 */
export function getDocumentInstanceKey(path: string): string {
  return `path:${path}`;
}

export function isWindowsPlatform(): boolean {
  return /Windows/i.test(navigator.userAgent) || /Win/i.test(navigator.platform);
}

/**
 * v3 stub — 原本 v3 改造已移除本函数 (memo id 由 index.json
 * 持有, 不从 path 解析)。但 buffer-registry.ts 在双 Map 设计
 * 中仍 import 本函数作为 classifyPath 的 fallback 判定, 这里
 * 以 stub 形式保留导出以保证模块加载。调用方
 * 遇到 stub 返回 null 会走 external 分支, 不影响现有语义。
 */
export function extractMemoIdFromPath(_path: string): string | null {
  return null;
}

/**
 * 跨平台 path 归一: \ → /, 重复 / 压缩。不动大小写 (文件系统权威)。
 * 这个语义是 memo 文档 path 索引的唯一标准 —— buffer / document-store /
 * 事件路径比较都走这里, 不要在其他文件重复定义。
 */
export function canonicalPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/');
}
