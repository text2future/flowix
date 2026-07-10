/**
 * "通过链接打开笔记"模块 — 公开 API 入口。
 *
 * 设计:
 *   - 后端 `open_target/handler.rs` 接收 `raw: String`, 解析 + emit
 *     `flowix:open-target` 事件, 然后通过 `openMemoByTarget` IPC 把
 *     `ResolvedOpenTarget` 同步返回给调用方 (供不依赖事件的前端路径用)。
 *   - 监听者 (`mountOpenTargetListener`) 负责把"系统 / single-instance /
 *     Agent 触发"的打开请求转成 UI 动作, 挂在 App.tsx 顶层。
 *   - 主动入口 (`openNoteByDeepLink` / `openNoteByPhysicalPath` /
 *     `openNoteByMemoId`) 供 noteReference 双击、Agent 工具调用、跨窗口
 *     等热路径用, 同步走完整 IPC 解析, 不依赖事件订阅。
 *   - 轻量解析 (`resolveMemoById` / `resolveMemoByPath`) 不触发打开动作,
 *     仅返回 ResolvedOpenTarget, 用于 noteReference mount/update 时异步
 *     校验并刷新 attrs.
 *
 * 用法:
 *   - App.tsx 顶层:
 *       useEffect(() => { void mountOpenTargetListener(); return unmount; }, []);
 *   - noteReference 双击:
 *       await openNoteByMemoId(memoId);
 *   - noteReference mount/update 异步校验:
 *       const r = await resolveMemoById(memoId);
 */

export {
  openNoteByTarget,
  openNoteByDeepLink,
  openNoteByPhysicalPath,
  openNoteByMemoId,
  resolveMemoById,
  resolveMemoByPath,
} from '@platform/open-target/opener';

export {
  mountOpenTargetListener,
  unmountOpenTargetListener,
} from '@platform/open-target/listener';

export type { ResolvedOpenTarget } from '@platform/open-target/types';
export { FLOWIX_OPEN_TARGET_EVENT } from '@platform/open-target/types';
