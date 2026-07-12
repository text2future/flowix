/**
 * 给新创建的 AgentConversationInstance 填一份"初始 runtime_config",
 * 让 instance 自身成为 cwd / folders / notebooks 的真源 ── 而不是每次
 * send 时再走前端全局 store 的兜底链。
 *
 * 这是修复 "重启产品后, 已存在的 thread card resume 时 cwd 缺失"
 * (Claude Code CLI exit 1: Please provide a directory path) 的核心改动。
 *
 * 之前的实现:
 *   createInstance 时 runtimeConfig = null, cwd 兜底链完全靠前端全局状态
 *   (memoStore.selectedNotebook / agentAccessStore.entries) ── 但这些
 *   是 zustand 内存 + 异步 hydrate 的状态, 启动 race 窗口内可能全部为空。
 *
 * 现在的实现:
 *   createInstance 时同步读 `memoState.selectedNotebook?.path` 和
 *   `agentAccessState.config.entries`, 写到 instance.runtime_config:
 *     - files.workspace = selectedNotebook.path  (主 cwd)
 *     - files.folders    = enabled folder paths
 *     - files.notebooks  = enabled notebook paths
 *     - cwd             = files.workspace         (冗余字段, 见 types/agent.ts 注释)
 *
 *   字段全为空时 (启动 race 窗口还在), helper 仍然返回一个 RuntimeConfig,
 *   但 fields 都是 undefined / []. 此时旧 instance 的兜底链仍然能 cover
 *   (1) 系统提示目录 / (2) Rust 兜底到 session 元数据.
 */
import type { RuntimeConfig } from "@/types/agent";
import { useAgentAccessStore } from "@features/agent/store/agent-access-store";
import { normalizeContextValue } from "@features/agent/store/context-block";
import { useMemoStore } from "@features/memo/store/memo-store";

/**
 * 与 `agent-runtime-spec::normalizeWorkspacePath` 同语义, 但作为模块级
 * 私有复制, 避免循环 import (`agent-runtime-spec` 也依赖 store)。
 * 注意: 任何逻辑变更需要同步两处, 这是临时折中, 后续要把这个函数
 * 抽到 `lib/path/normalize-workspace.ts` 一类的共享模块。
 */
function normalizeWorkspacePath(path: string | null | undefined): string {
  return normalizeContextValue(path).replace(/[\\/]+$/, "");
}

/**
 * 同步读全局 store, 构造一份 "实例创建那一刻" 的 runtime_config 快照.
 *
 * 重要: 不要传 `cwd` 参数. cwd 必读 selectedNotebook, 不允许从
 * `userPayload.systemReminderDirectory` 派生 ── 那等价于此 helper 不存在.
 */
export function buildInitialInstanceRuntimeConfig(): RuntimeConfig {
  const memoState = useMemoStore.getState();
  const accessState = useAgentAccessStore.getState();

  const workspace = normalizeWorkspacePath(memoState.selectedNotebook?.path);

  const enabledEntries = accessState.config.entries.filter(
    (entry) => entry.enabled && !entry.missing,
  );

  const folders: string[] = [];
  const notebooks: string[] = [];

  for (const entry of enabledEntries) {
    const path = normalizeWorkspacePath(entry.path);
    if (!path) continue;
    if (entry.kind === "folder") folders.push(path);
    else if (entry.kind === "notebook") notebooks.push(path);
  }

  return {
    files: {
      workspace: workspace || undefined,
      folders: Array.from(new Set(folders)),
      notebooks: Array.from(new Set(notebooks)),
    },
    cwd: workspace || undefined,
  };
}
