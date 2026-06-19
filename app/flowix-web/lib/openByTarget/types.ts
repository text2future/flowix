/**
 * "通过链接打开笔记"模块 — 类型定义
 *
 * 后端 `open_target/handler.rs::open_memo_by_target` 返回的结构, 跨 IPC 边界
 * (camelCase) 与前端一致。 解构后直接喂给 `useDocumentStore.openMemoDocument`。
 *
 * 流程:
 *   openNoteByDeepLink / openNoteByPhysicalPath
 *     ↓ invoke('open_memo_by_target')
 *   backend parser → resolver → ResolvedOpenTarget
 *     ↓ emit('flowix:open-target', payload)
 *   main layout listener → openNoteByTarget(payload)
 *     → 切 notebook (若需要) + setSelectedMemo + openMemoDocument
 */

export interface ResolvedOpenTarget {
  memoId: string;
  notebookId: string;
  notebookName: string;
  notebookPath: string;
  /** 磁盘上的绝对路径, 由 index.json + memo 命名约定拼出 */
  absolutePath: string;
  /** memo filename (用于显示 / stale check) */
  memoTitle: string;
}

/** Tauri event 名 — 跟后端 `handler.rs` 的 emit("flowix:open-target", ...) 同步 */
export const FLOWIX_OPEN_TARGET_EVENT = 'flowix:open-target';
