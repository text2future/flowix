/**
 * "通过链接打开笔记" — 唯一对外入口。
 *
 * 设计:
 *   - `openNoteByTarget` 是真正的打开动作, 接收已解析的 `ResolvedOpenTarget`
 *     (后端 `open_memo_by_target` IPC 解析的产物), 做:
 *       1. 跨 notebook 切换 (若需要)
 *       2. upsertMemo + setSelectedMemo (**早于** openMemoDocument, 与
 *          `note-link/view-note.ts::openNoteReference` 同步, 关掉 enqueueTransition
 *          窗口期间 activeMemoSession.memoId 滞后的问题)
 *       3. openMemoDocument ── 走 document-store 的串行化
 *
 *   - `openNoteByDeepLink` / `openNoteByPhysicalPath` 是**热路径入口**, 接收
 *     原始字符串, 委托后端 IPC 解析。 物理路径粘贴的 NoteReference 双击也
 *     走这个, 替代 `openNoteReference` 里 4 步手操 ── 后端权威解析 + emit
 *     走相同 pipeline, 行为统一。
 *
 *   - `mountOpenTargetListener` 是**单订阅者**, 挂在 app.tsx 顶层, 跨窗口
 *     同步通过 Tauri 事件总线承担 (跟 `external-markdown-opened` 同形)。
 */

import { memos as memosClient } from '@platform/tauri/client';
import { useMemoStore, type MemoItem, type Notebook } from '@features/memo';
import { resolveAbsolutePath } from '@platform/open-target/path-helper';
import type { ResolvedOpenTarget } from '@platform/open-target/types';
import { openMemoTarget } from '@features/workspace/use-cases/workspace-navigation';

/**
 * 把 ResolvedOpenTarget 喂给 document-store。 跨 notebook 时先切 notebook,
 * 预置目标 selectedMemo, 再加载目标列表并打开文档。
 *
 * 跟 `note-link/view-note.ts::openNoteReference` 同源, 但这里 ResolvedOpenTarget 来自
 * 后端权威解析 (memoId / notebookId / absolutePath 全部校验过)。
 */
export async function openNoteByTarget(resolved: ResolvedOpenTarget): Promise<void> {
  const store = useMemoStore.getState();
  const memoItem: MemoItem = { ...resolved.memo, isOpen: true };

  // The navigation facade owns notebook switching, list hydration, memo
  // selection, document opening, commit, and rollback.
  const targetNotebook: Notebook | null = store.notebooks.find(
    (nb) => nb.id === resolved.notebookId,
  ) ?? null;

  await openMemoTarget({
    memoId: resolved.memoId,
    path: resolveAbsolutePath(resolved),
    notebookId: resolved.notebookId,
    notebookPath: resolved.notebookPath,
    memo: memoItem,
    notebook: targetNotebook,
  });
}

/**
 * 入口: 深链 `flowix://...` ── 直接调后端 IPC 解析 + 打开。
 * 主窗口 listener 收到 `flowix:open-target` 事件时也是同样的逻辑。
 */
export async function openNoteByDeepLink(url: string): Promise<void> {
  const resolved = await memosClient.openMemoByTarget(url, { emitEvent: false });
  if (!resolved) {
    // eslint-disable-next-line no-console
    console.warn('[openByTarget] openMemoByTarget returned null for', url);
    throw new Error(`Unable to resolve note target: ${url}`);
  }
  await openNoteByTarget(resolved);
}

/**
 * 入口: 物理路径 / 物理路径的 `file://` URL ── 走同一条 IPC, 后端按 OpenTarget
 * 解析。 NoteReference 双击也走这里 (替代原 `openNoteReference` 的 4 步手操)。
 */
export async function openNoteByPhysicalPath(rawPath: string): Promise<void> {
  await openNoteByDeepLink(rawPath);
}

/**
 * 入口: 直接按 memoId 打开 ── 走 `flowix://memo/<id>` 深链语法。
 *
 * NoteReference 卡片以 `memoId` (memo 稳定 id) 作为第一公民;
 * 双击时优先用 memoId 反查, 跨 notebook / 笔记改名 / 笔记被搬都不断链,
 * 只要 memo 还存在 (后端 memo index 找得到) 就能打开。
 *
 * 失败语义:
 * - memoId 缺失 / 后端 resolve 失败 (memo 被删) → 返回 null, 调用方走 stale 流程.
 * - 后端 emit `flowix:open-target` 跟 `openNoteByDeepLink` 走同一事件, 跨窗口同步一致.
 */
export async function openNoteByMemoId(memoId: string): Promise<boolean> {
  const resolved = await resolveMemoById(memoId);
  if (!resolved) return false;
  await openNoteByTarget(resolved);
  return true;
}

/**
 * 轻量解析: 按 memoId 反查最新 memo 元数据, 不触发打开动作。
 *
 * 用途: noteReference NodeView 渲染时 (mount + update) 异步校验并刷新
 * `notebookName` / `title`, 避免 markdown 里缓存的旧名与磁盘上的真实名
 * 长期不一致。 仅调用后端 `openMemoByTarget` (走 memo index), 不动
 * document-store / notebook 切换状态, 不 emit `flowix:open-target` 事件。
 *
 * 失败语义:
 * - memoId 缺失 / 后端解析失败 (memo 被删) → 返回 null.
 *   调用方据此落 stale.
 */
export async function resolveMemoById(memoId: string): Promise<ResolvedOpenTarget | null> {
  if (!memoId) return null;
  return memosClient.openMemoByTarget(`flowix://memo/${memoId}`, { emitEvent: false });
}

/**
 * 轻量解析: 按物理路径反查最新 memo 元数据, 不触发打开动作。
 *
 * 用途: noteReference 物理路径粘贴场景 — paste 时 `tryMatchPhysicalMemoPath`
 * 仅同步拿到 path + notebookId, 没 memoId; mount 后用 path 反查补 memoId
 * 并写回 attrs. 同一份 `openMemoByTarget` 入口, 后端按 PhysicalPath 分支
 * 走 memo index filename 匹配.
 *
 * 失败语义: 同 `resolveMemoById`.
 */
export async function resolveMemoByPath(rawPath: string): Promise<ResolvedOpenTarget | null> {
  if (!rawPath) return null;
  return memosClient.openMemoByTarget(rawPath, { emitEvent: false });
}

/** Resolve an Obsidian wiki/relative Markdown target through the memo index. */
export async function resolveMemoByObsidianTarget(rawTarget: string): Promise<ResolvedOpenTarget | null> {
  let target = rawTarget.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  try { target = decodeURIComponent(target); } catch { /* preserve malformed input */ }
  const targetLower = target.toLowerCase();
  const targetWithMd = targetLower.endsWith('.md') ? targetLower : `${targetLower}.md`;
  const basename = targetWithMd.split('/').pop() ?? targetWithMd;
  const title = basename.replace(/\.md$/i, '');
  const items = await memosClient.searchMentionNotes(title, 200);
  const match = items.find((item) => {
    const filename = String(item.filename ?? '').replace(/\\/g, '/').toLowerCase();
    const path = String(item.originalPath ?? '').replace(/\\/g, '/').toLowerCase();
    return filename === targetWithMd
      || filename.endsWith(`/${targetWithMd}`)
      || path.endsWith(`/${targetWithMd}`)
      || (basename === filename.split('/').pop() && String(item.title ?? '').toLowerCase() === title);
  });
  return match?.id ? resolveMemoById(match.id) : null;
}
