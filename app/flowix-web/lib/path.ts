/**
 * Cross-platform path utilities for joining notebook and memo paths.
 * On Mac/Linux, uses forward slashes; on Windows, handles both \\ and /.
 *
 * Notes use their notebook-relative path as the stable address. Filenames
 * are the physical disk names, including `.md`; no memo ID is encoded there.
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

export function isWindowsPlatform(): boolean {
  return /Windows/i.test(navigator.userAgent) || /Win/i.test(navigator.platform);
}


/**
 * 跨平台 path 归一: \ → /, 重复 / 压缩。不动大小写 (文件系统权威)。
 * 这个语义是 memo 文档 path 索引的唯一标准 —— buffer / document-store /
 * 事件路径比较都走这里, 不要在其他文件重复定义。
 */
export function canonicalPath(path: string): string {
  const slashes = path.replace(/\\/g, '/');
  const normalized = slashes.replace(/\/+/g, '/');
  return slashes.startsWith('//') ? '/' + normalized : normalized;
}

/** Stable locator key for a local file, independent of any open surface. */
export function fileLocatorKey(path: string): string {
  return `file:${canonicalPath(path)}`;
}

export function canonicalDirectoryPath(path: string): string {
  const canonical = canonicalPath(path);
  const trimmed = canonical.replace(/\/+$/, '');
  return trimmed || (canonical.startsWith('/') ? '/' : canonical);
}

export function parentDirectoryPath(filePath: string, notebookPath: string): string {
  const canonicalFilePath = canonicalPath(filePath).replace(/\/+$/, '');
  const separatorIndex = canonicalFilePath.lastIndexOf('/');
  const parent = separatorIndex >= 0
    ? canonicalFilePath.slice(0, separatorIndex)
    : notebookPath;
  return canonicalDirectoryPath(parent || notebookPath);
}

/** Returns a directory path relative to the notebook root, or null when outside it. */
export function notebookRelativeDirectoryPath(notebookPath: string, directoryPath: string): string | null {
  const root = canonicalDirectoryPath(notebookPath);
  const directory = canonicalDirectoryPath(directoryPath);
  if (directory === root) return '';
  const rootPrefix = root === '/' ? '/' : `${root}/`;
  return directory.startsWith(rootPrefix) ? directory.slice(rootPrefix.length) : null;
}

export function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

/** Whether a path is the directory itself or one of its descendants. */
export function isPathInDirectory(path: string, directoryPath: string): boolean {
  const candidate = pathComparisonKey(path);
  const directory = pathComparisonKey(directoryPath);
  return candidate === directory || candidate.startsWith(directory === '/' ? '/' : `${directory}/`);
}

export function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = canonicalPath(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function fileNameFromPath(filePath: string): string {
  const canonicalFilePath = canonicalPath(filePath).replace(/\/+$/, '');
  return canonicalFilePath.slice(canonicalFilePath.lastIndexOf('/') + 1);
}

/** Destination when moving a file into a directory; discards its original parent directories. */
export function pathInDirectory(directoryPath: string, filePath: string): string {
  const directory = canonicalDirectoryPath(directoryPath);
  const name = fileNameFromPath(filePath);
  return directory === '/' ? `/${name}` : `${directory}/${name}`;
}

/** Filesystem comparison policy shared by notebook ownership and relative links. */
export function pathComparisonKey(path: string): string {
  const value = canonicalDirectoryPath(path);
  return /^[a-z]:(?:\/|$)/i.test(value) || value.startsWith('//') ? value.toLowerCase() : value;
}

export function notebookForPath<T extends { path: string }>(path: string, notebooks: readonly T[]): T | undefined {
  return notebooks.filter(book => isPathInDirectory(path, book.path))
    .reduce<T | undefined>((best, book) => !best || book.path.length > best.path.length ? book : best, undefined);
}
