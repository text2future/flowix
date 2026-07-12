/**
 * 主工作目录单一 cascade ── UI 按钮 label 与运行时 cwd 共用, 保证
 * "按钮写什么、CLI 跑在哪" 永远一致。
 *
 * 优先级 (instance 优先, 全局信息是"默认不配置时"的兜底, 最后落到
 * 用户当前打开的 notebook):
 *
 *   1. instance.workspace              ─ 用户在本 thread 显式设的主空间
 *   2. instance.folders[0]             ─ 用户在本 thread 勾选的第一个 folder
 *   3. instance.notebooks[0]           ─ 同上, notebook 维度
 *   4. global.firstWorkspace           ─ 全局 entry.workspace=true 的那条
 *   5. global.firstEnabled             ─ 全局 enabled 的第一个 entry
 *   6. cwd                             ─ systemReminderDirectory (当前 notebook 路径)
 *   7. empty
 *
 * 设计要点:
 *   - label 与运行时 cwd 用同一个函数 resolve, 一处改两边同步;
 *   - instance 有值时永远优先 ── 这是用户在本 thread 卡里显式设的状态;
 *   - 全局 `entry.workspace=true` / `entry.enabled` 只是默认状态, 没配
 *     instance 时才生效;
 *   - 返回 `source` 字段让 UI 能显示"为什么是这条" (e.g. (当前笔记本)),
 *     避免"按钮文案看不出 cwd 在哪"。
 */
import type { FilesConfig } from "@/types/agent";
import type { AgentAccessEntry } from "@/lib/types/agent-access";
import { normalizeContextValue } from "@features/agent/store/context-block";

export type PrimaryWorkspaceSource =
  | { kind: "instance.workspace"; path: string }
  | { kind: "instance.folders[0]"; path: string }
  | { kind: "instance.notebooks[0]"; path: string }
  | { kind: "global.firstWorkspace"; path: string }
  | { kind: "global.firstEnabled"; path: string }
  | { kind: "cwd"; path: string }
  | { kind: "empty" };

export interface ResolvePrimaryWorkspaceInput {
  /** 当前 instance.runtimeConfig.files ── 存在优先 */
  instanceFiles?: FilesConfig;
  /** 当前用户选中的 notebook 路径 ── cwd 兜底链最后一环 */
  cwd?: string;
  /**
   * 全局 enabled entry 列表 ── 用于 "global.firstWorkspace" /
 *   "global.firstEnabled" 兜底。 在 test / SSR 场景下可显式传入, 否则
 *   调用方需自行从 useAgentAccessStore 同步读。
 */
  globalEntries?: AgentAccessEntry[];
}

/**
 * 严格按字面顺序短路: 第一段命中即返回, 后续全跳过; 兜底链最后落到 `empty`。
 */
export function resolvePrimaryWorkspace(
  input: ResolvePrimaryWorkspaceInput,
): PrimaryWorkspaceSource {
  const normalize = (path: string | null | undefined): string | undefined => {
    const v = normalizeContextValue(path).replace(/[\\/]+$/, "");
    return v || undefined;
  };

  // 1. instance.workspace ─ 命中即返回, 不看 missing。
  const instanceWorkspace = normalize(input.instanceFiles?.workspace);
  if (instanceWorkspace) {
    return { kind: "instance.workspace", path: instanceWorkspace };
  }

  // 2. instance.folders[0]
  const instanceFolder0 = normalize(input.instanceFiles?.folders?.[0]);
  if (instanceFolder0) {
    return { kind: "instance.folders[0]", path: instanceFolder0 };
  }

  // 3. instance.notebooks[0]
  const instanceNotebook0 = normalize(input.instanceFiles?.notebooks?.[0]);
  if (instanceNotebook0) {
    return { kind: "instance.notebooks[0]", path: instanceNotebook0 };
  }

  const entries = input.globalEntries ?? [];

  // 4. global.firstWorkspace ── 全局主空间 (用户点 avatar 设的)。
  const globalWorkspaceEntry = entries.find(
    (entry) => entry.workspace && !entry.missing,
  );
  const globalWorkspacePath = normalize(globalWorkspaceEntry?.path);
  if (globalWorkspacePath) {
    return { kind: "global.firstWorkspace", path: globalWorkspacePath };
  }

  // 5. global.firstEnabled ── entry.workspace=false 但 enabled=true 的 folder。
  // 优先 folder (用户主动加的目录), 再考虑 notebook ── 与旧 `getFirstEnabledAgentFolderPath`
  // + notebook 后补的语义一致, 避免 notebook 抢走 folder 的 cwd 默认值。
  const firstEnabledEntry =
    entries.find(
      (entry) =>
        entry.kind === "folder" && entry.enabled && !entry.missing,
    ) ??
    entries.find((entry) => entry.enabled && !entry.missing);
  const firstEnabledPath = normalize(firstEnabledEntry?.path);
  if (firstEnabledPath) {
    return { kind: "global.firstEnabled", path: firstEnabledPath };
  }

  // 6. cwd (systemReminderDirectory / selectedNotebook.path)
  const cwdPath = normalize(input.cwd);
  if (cwdPath) {
    return { kind: "cwd", path: cwdPath };
  }

  // 7. empty
  return { kind: "empty" };
}
