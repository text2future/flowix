/**
 * 给新创建的 AgentConversationInstance 填一份"初始 runtime_config",
 * 让 instance 自身成为 cwd / folders / notebooks 的真源 ── 而不是每次
 * send 时再走前端全局 store 的兜底链。
 *
 * 这是修复 "重启产品后, 已存在的 thread card resume 时 cwd 缺失"
 * (Claude Code CLI exit 1: Please provide a directory path) 的核心改动。
 *
 * Workspace 优先级 (新建 instance 时同步读):
 *   1. **最近冻结 instance 的 workspace**  ── `selectLatestFrozenFileSeed`,
 *      用户在 instance A 主动调整完后未发消息前的 "上次偏好", 关 app 后从
 *      SQLite hydrate 仍能取到。
 *   2. 当前 selectedNotebook.path           ── 用户当前打开的笔记本
 *   3. undefined                            ── 让 dispatch 拦截
 *
 * folders / notebooks:
 *   - 取最近冻结 instance 的 folders + notebooks 与全局 enabled 的并集。
 *   - 没冻结 instance 时直接走 `useAgentAccessStore.config.entries`。
 *
 * 关键约束: instance 创建后, 用户在 popover 里的调整写到 instance.files,
 * 直到首次发送 (`sendMessageToThread` 触发 `lockInstanceFileSeed`) 才打
 * 上 `_frozen=true` 标记。 在那之前, 用户取消/勾选、点 avatar 改主空间 ──
 * 这些 instance 的最新 files 又会成为下一次 `buildInitialInstanceRuntimeConfig`
 * 的种子。 这就是 "instance A 的最新设置 → instance B 注入默认修改值" 的
 * 主链路。
 *
 * 冻结后: instance.files 已是只读真值, "上次偏好" 锁定在那一瞬。后续用户
 * 再调整 instance A 不再影响 instance B 的初始化 ── 因为 A 已经冻结, 新的
 * instance B 看到的是冻结那一刻的 A。
 */
import type { AgentTypeKey, RuntimeConfig } from "@/types/agent";
import { useAgentAccessStore } from "@features/agent/store/agent-access-store";
import {
  selectLatestFrozenFileSeed,
  useAgentConversationStore,
} from "@features/agent/store/agent-conversation-store";
import { useMemoStore } from "@features/memo/store/memo-store";

/**
 * 与 `agent-runtime-spec::normalizeWorkspacePath` 同语义, 但作为模块级
 * 私有复制, 避免循环 import (`agent-runtime-spec` 也依赖 store)。
 * 注意: 任何逻辑变更需要同步两处, 这是临时折中, 后续要把这个函数
 * 抽到 `lib/path/normalize-workspace.ts` 一类的共享模块。
 */
function normalizeWorkspacePath(path: string | null | undefined): string {
  return (path ?? "").replace(/\r\n/g, "\n").trim().replace(/[\\/]+$/, "");
}

/**
 * 同步读全局 store, 构造一份 "实例创建那一刻" 的 runtime_config 快照.
 *
 * 重要: 不要传 `cwd` 参数. cwd 必读 cascade, 不允许从
 * `userPayload.systemReminderDirectory` 派生 ── 那等价于此 helper 不存在.
 */
export function buildInitialInstanceRuntimeConfig(
  agentType: AgentTypeKey = "flowix",
): RuntimeConfig {
  const memoState = useMemoStore.getState();
  const accessState = useAgentAccessStore.getState();
  const frozenSeed = selectLatestFrozenFileSeed(
    useAgentConversationStore.getState(),
  );

  // 1. 优先用上次冻结 instance 里的 workspace ── 用户上次在 popover 里调
  // 整过的值, 关 app 后从 SQLite 仍能取到。
  const seedWorkspace = normalizeWorkspacePath(frozenSeed?.workspace);
  const seedFolders = (frozenSeed?.folders ?? []).map(normalizeWorkspacePath);
  const seedNotebooks = (frozenSeed?.notebooks ?? []).map(normalizeWorkspacePath);
  const defaultFiles = accessState.config.defaults?.files;
  const defaultWorkspace = normalizeWorkspacePath(defaultFiles?.workspace);
  const defaultFolders = (defaultFiles?.folders ?? []).map(normalizeWorkspacePath);
  const defaultNotebooks = (defaultFiles?.notebooks ?? []).map(normalizeWorkspacePath);

  // 2. 兜底到当前 selectedNotebook.path
  const notebookWorkspace = normalizeWorkspacePath(
    (memoState.selectedNotebook as { path?: string } | null | undefined)?.path,
  );

  const enabledEntries = accessState.config.entries.filter(
    (entry) => entry.enabled && !entry.missing,
  );

  const foldersFromAccess: string[] = [];
  const notebooksFromAccess: string[] = [];

  for (const entry of enabledEntries) {
    const path = normalizeWorkspacePath(entry.path);
    if (!path) continue;
    if (entry.kind === "folder") foldersFromAccess.push(path);
    else if (entry.kind === "notebook") notebooksFromAccess.push(path);
  }

  const workspace =
    defaultWorkspace || seedWorkspace || notebookWorkspace || undefined;
  // 冻结种子里的 folders/notebooks + 全局 enabled ── 只要有一处存在都算上,
  // dedupe 用 Set, 剔除空串。 用户上次勾的目录 (即便全局 toggle off 了) 也保留。
  const folders = Array.from(
    new Set(
      [...defaultFolders, ...seedFolders, ...foldersFromAccess].filter(
        (path) => path && path.length,
      ),
    ),
  );
  const notebooks = Array.from(
    new Set(
      [...defaultNotebooks, ...seedNotebooks, ...notebooksFromAccess].filter(
        (path) => path && path.length,
      ),
    ),
  );
  const defaultRuntime = accessState.config.defaults?.runtime?.[agentType];

  return {
    ...(defaultRuntime?.model ? { model: defaultRuntime.model } : {}),
    ...(defaultRuntime?.access ? { access: defaultRuntime.access } : {}),
    ...(defaultRuntime?.reasoningEffort
      ? { reasoningEffort: defaultRuntime.reasoningEffort }
      : {}),
    files: {
      workspace,
      folders,
      notebooks,
    },
    cwd: workspace,
  };
}
