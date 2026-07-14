/**
 * 把 ResolvedOpenTarget.absolutePath 规整成 document-store 期望的形态。
 *
 * 物理路径 / 深链两种来源都最终落到 `absolutePath` 字符串。 拼接规则跟
 * 前端 `lib/path.ts::joinNotebookMemoPath` 对齐, 避免 document-store 拿到
 * 斜杠不一致的路径导致 IPC read 失败。
 */

import type { ResolvedOpenTarget } from '@platform/open-target/types';

export function resolveAbsolutePath(resolved: ResolvedOpenTarget): string {
  // v3 改造: 后端已拼好 `notebookPath/{filename}.md` (filename 即磁盘文件名, 含 .md,
  // 无 #memoid 后缀)。这里仅做斜杠归一化 + 重复斜杠压缩, 跟 `document-store.ts::canonicalPath` 保持一致。
  return resolved.absolutePath.replace(/\\/g, '/').replace(/\/+/g, '/');
}
