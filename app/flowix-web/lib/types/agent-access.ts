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
  AgentPermissionMode,
  AgentTypeKey,
  FilesConfig,
} from "@/types/agent";

/**
 * Responsibility split for `~/.flowix/agent-access.json`:
 *
 * - `defaults`: default runtime/files values copied into a newly created
 *   agent-thread-card instance.
 * - `entries`: legacy/global access registry and default candidates used by
 *   old instances or instances without `runtimeConfig.files`.
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
  workspace?: boolean;
  addedAt: number;
  updatedAt: number;
  /** 运行时由后端重算: 该 path 在磁盘上是否还存在。 失联目录保留在列表,
   *  UI 据此灰显 + 强制禁用勾选框。 */
  missing: boolean;
}

export interface AgentAccessDefaultRuntime {
  model?: { key: string };
  access?: { sandbox: AgentPermissionMode };
  reasoningEffort?: AgentCodexReasoningEffort;
}

export interface AgentAccessDefaults {
  runtime?: Partial<Record<AgentTypeKey, AgentAccessDefaultRuntime>>;
  files?: FilesConfig;
}

export interface AgentAccessConfig {
  version: number; // 当前 = 1
  entries: AgentAccessEntry[];
  defaults?: AgentAccessDefaults;
}
