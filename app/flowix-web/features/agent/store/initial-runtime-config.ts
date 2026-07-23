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
 *   - 用户调整过文件下拉窗后，`defaults.files` 是新卡片的权威快照，
 *     完整继承勾选与取消勾选。
 *   - 尚无默认快照时，取最近冻结 instance 与全局 enabled 的并集，兼容
 *     历史数据和首次使用。
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
import { normalizeWorkspacePath } from "@features/agent/runtime/workspace-path";

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

  const hasDefaultFiles = defaultFiles !== undefined;
  const workspace = hasDefaultFiles
    ? defaultWorkspace || notebookWorkspace || undefined
    : seedWorkspace || notebookWorkspace || undefined;

  // defaults.files 一旦存在，就代表用户最近一次在文件下拉窗中确认的完整
  // 选择。此时不能再与全局 enabled 或冻结 seed 取并集，否则被取消勾选的
  // 路径会在新卡片里重新出现。没有快照时才沿用旧的并集初始化逻辑。
  const folders = Array.from(
    new Set(
      (hasDefaultFiles
        ? defaultFolders
        : [...seedFolders, ...foldersFromAccess]
      ).filter((path) => path && path.length),
    ),
  );
  const notebooks = Array.from(
    new Set(
      (hasDefaultFiles
        ? defaultNotebooks
        : [...seedNotebooks, ...notebooksFromAccess]
      ).filter((path) => path && path.length),
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
