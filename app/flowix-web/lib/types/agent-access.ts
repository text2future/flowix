/**
 * Agent 访问目录 (可访问文件夹) — 镜像后端 `app/flowix-desktop/src/agent_access.rs`
 * 的 `AgentAccessConfig` / `AgentAccessEntry` / `AgentAccessKind`。
 *
 * 真源在 `~/.flowix/agent-access.json` (后端 `agent_access::AgentAccessStore`),
 * 前端走 `lib/tauri/client.ts::agentAccess` IPC 读写。 整份 set 走乐观更新,
 * 跨窗口同步靠后端 emit 的 `agent-access-changed` 事件。
 */

import type {
  AgentCodexReasoningEffort,
  AgentHarnessPreset,
  AgentPermissionMode,
  AgentTypeKey,
  FilesConfig,
} from "@/types/agent";

/**
 * Responsibility split for `~/.flowix/agent-access.json`:
 *
 * - `defaults`: default runtime values copied into a newly created
 *   agent-thread-card instance; file defaults are legacy read-only data.
 * - `entries`: global access registry used to authorize notebook add-dirs.
 * - actual per-run file permission: instance `runtimeConfig.files`, sent as
 *   IPC `runtimeConfig.{agent}.workspacePaths`.
 */

export type AgentAccessKind = "notebook" | "folder";

export interface AgentAccessEntry {
  id: string;
  kind: AgentAccessKind;
  path: string;
  name: string;
  enabled: boolean;
  /** @deprecated Workspace selection is notebook-owned; retained for v1 JSON. */
  workspace?: boolean;
  addedAt: number;
  updatedAt: number;
  /** 运行时由后端重算: 该 path 在磁盘上是否还存在。 失联目录保留在列表,
   *  UI 据此灰显 + 强制禁用勾选框。 */
  missing: boolean;
}

export interface AgentAccessDefaultRuntime {
  model?: { key: string; providerId?: string };
  access?: { sandbox: AgentPermissionMode };
  reasoningEffort?: AgentCodexReasoningEffort;
  /** DeepSeek Harness tool presentation mode. */
  mode?: AgentHarnessPreset;
}

/**
 * Legacy `defaults.files` global key retained for read-only migration of old
 * installations. New writes always target notebook `.flowix/agent.json`.
 */
export const DEFAULT_FILES_GLOBAL_KEY = "_global";

/**
 * Legacy notebook-indexed files defaults. This type is retained so old config
 * files can be read and migrated; it is no longer the write target.
 *
 * 老版本 `defaults.files` 是单个 `FilesConfig` 对象, 读取时由
 * `normalizeFilesDefaults` 归一化到 `{ _global: <old> }`, 写入时始终落索引。
 */
export type AgentAccessFilesDefaults = Record<string, FilesConfig>;

export interface AgentAccessDefaults {
  runtime?: Partial<Record<AgentTypeKey, AgentAccessDefaultRuntime>>;
  files?: AgentAccessFilesDefaults;
}

export interface AgentAccessConfig {
  version: number; // 当前 = 1
  entries: AgentAccessEntry[];
  defaults?: AgentAccessDefaults;
}

/** Notebook-local `.flowix/agent.json`. The notebook itself is always cwd;
 * `addDirs` contains only additional runtime roots. */
export interface NotebookAddDir {
  id: string;
  path: string;
  label: string;
  enabled: boolean;
}

export interface NotebookAgentConfig {
  version: 1;
  revision: number;
  addDirs: NotebookAddDir[];
}
