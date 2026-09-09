/**
 * Agent 可访问目录 store ── zustand 镜像后端
 * `~/.flowix/agent-access.json` 的整份 config。 与 `user-settings-store`
 * 不同, 本 store 没有 persist (后端是真源), 走 IPC + 跨窗口事件同步。
 *
 * 写操作 (`addFolder`) 走乐观更新: 本地先
 * 改 `entries` 再 `await agentAccess.set` 整份, 失败时 `loadInitial`
 * 回滚到磁盘真值。 跨窗口同步靠 app.tsx 顶层挂的 `listenToAgentAccessChanges`,
 * 收到事件后从磁盘拉整份覆盖内存。
 */

import { create } from "zustand";
import { agentAccess } from "@platform/tauri/client";
import type {
  AgentAccessConfig,
  AgentAccessDefaultRuntime,
  AgentAccessEntry,
  NotebookAgentConfig,
} from "@/lib/types/agent-access";
import type { AgentTypeKey, FilesConfig } from "@/types/agent";

// This store mirrors `~/.flowix/agent-access.json`.
// It owns defaults for newly created agent-thread-card instances and keeps the
// global entries list (folder metadata pool: name / missing / bookmark).
// Real conversation runs derive cwd from the current notebook and add-dir
// roots from that notebook's `.flowix/agent.json` (see
// agent-runtime-spec::buildAgentRuntimeConfig), not from instance.files.

export type AgentAccessErrorCode =
  "not-selected" | "already-tracked" | "save-failed";

export interface AgentAccessState {
  config: AgentAccessConfig;
  notebookConfigs: Record<string, NotebookAgentConfig>;
  isLoading: boolean;

  /** 从磁盘拉整份 config ── 启动 / 跨窗口事件 / 写失败回滚都走它。 */
  loadInitial: () => Promise<void>;
/**
   * 加一个 folder。 走后端 picker 让用户挑本地目录, 后端同时保存
   * macOS security-scoped bookmark。路径已存在 (notebook 同路径或
   * 已加的 folder) 时后端返回 `PathConflict`, UI 弹 toast 但不动 store。
   */
  addFolderFromPicker: () => Promise<
    | { ok: true; entry: AgentAccessEntry }
    | { ok: false; code: AgentAccessErrorCode }
  >;

  /**
   * 直接以给定路径加 folder ── 跳过 dialog picker, 给测试 / 偏好窗口
   * 等场景复用。 UI 层用 `addFolderFromPicker`。
   */
  addFolder: (
    path: string,
    name?: string,
  ) => Promise<
    | { ok: true; entry: AgentAccessEntry }
    | { ok: false; code: AgentAccessErrorCode }
  >;

  setDefaultRuntime: (
    agentType: AgentTypeKey,
    patch: AgentAccessDefaultRuntime,
  ) => Promise<void>;
  /** Persist notebook add-dir roots to `.flowix/agent.json`. */
  setDefaultFiles: (
    notebookId: string | null | undefined,
    files: FilesConfig,
  ) => Promise<boolean>;
}

const EMPTY_CONFIG: AgentAccessConfig = { version: 1, entries: [], defaults: {} };

export const useAgentAccessStore = create<AgentAccessState>((set, get) => ({
  config: EMPTY_CONFIG,
  notebookConfigs: {},
  isLoading: false,

  loadInitial: async () => {
    set({ isLoading: true });
    try {
      // Notebook-local config is the source of truth for add-dir roots.
      const [config, notebookConfigs] = await Promise.all([
        agentAccess.get(),
        agentAccess.getNotebookConfigs?.() ?? Promise.resolve({}),
      ]);
      set({ config, notebookConfigs, isLoading: false });
    } catch (e) {
      // 静默失败 ── 与 `user-settings-store.loadInitial` 同形, 把
      // 错误信息留给后续用户操作触发。 UI 在 config.entries 为空时
      // 会渲染空状态, 不会卡死。
      console.error("agentAccess.loadInitial failed:", e);
      set({ isLoading: false });
    }
  },  addFolder: async (path: string, name?: string) => {
    const entry = makeLocalFolderEntry(path, name);
    const prev = get().config;
    // Global entries are metadata/authorization only; notebook add-dir
    // membership is persisted separately in `.flowix/agent.json`.
    const optimistic = {
      ...prev,
      entries: [...prev.entries, entry],
    };
    set({ config: optimistic });
    try {
      await agentAccess.set(optimistic);
      return { ok: true, entry };
    } catch (e) {
      const reason = extractReason(e);
      if (reason === "path conflict") {
        // 用户选了一个已经跟踪的路径, 不写盘也不留乐观条目 ── 回滚到
        // 真正的"没加"状态, 让用户看到原列表。
        set({ config: prev });
        return { ok: false, code: "already-tracked" };
      }
      console.error("agentAccess.addFolder failed, rolling back:", e);
      await get().loadInitial();
      return { ok: false, code: "save-failed" };
    }
  },

  addFolderFromPicker: async () => {
    try {
      const entry = await agentAccess.addFolderFromPicker();
      if (!entry) {
        return { ok: false, code: "not-selected" };
      }
      await get().loadInitial();
      return { ok: true, entry };
    } catch (e) {
      const reason = extractReason(e);
      if (reason === "path conflict") {
        await get().loadInitial();
        return { ok: false, code: "already-tracked" };
      }
      console.error("agentAccess.addFolderFromPicker failed:", e);
      await get().loadInitial();
      return { ok: false, code: "save-failed" };
    }
  },
  setDefaultRuntime: async (agentType, patch) => {
    const prev = get().config;
    const optimistic: AgentAccessConfig = {
      ...prev,
      defaults: {
        ...(prev.defaults ?? {}),
        runtime: {
          ...(prev.defaults?.runtime ?? {}),
          [agentType]: {
            ...(prev.defaults?.runtime?.[agentType] ?? {}),
            ...patch,
          },
        },
      },
    };
    set({ config: optimistic });
    try {
      await agentAccess.set(optimistic);
    } catch (e) {
      console.error("agentAccess.setDefaultRuntime failed, rolling back:", e);
      await get().loadInitial();
    }
  },

  setDefaultFiles: async (notebookId, files) => {
    if (!notebookId) {
      // Notebook scope is mandatory. Keep the old config read-only for
      // migration, but never write new folder defaults to the global file.
      console.warn("agentAccess.setDefaultFiles ignored without notebookId");
      return false;
    }
    const prevNotebookConfig = get().notebookConfigs[notebookId] ?? {
        version: 1 as const,
        revision: 0,
        addDirs: [],
      };
      const priorByPath = new Map(
        prevNotebookConfig.addDirs.map((directory) => [
          directory.path.trim().replace(/[\\/]+$/, '').toLowerCase(),
          directory,
        ]),
      );
      const nextConfig: NotebookAgentConfig = {
        version: 1,
        revision: prevNotebookConfig.revision,
        addDirs: files.folders.map((path) => {
          const key = path.trim().replace(/[\\/]+$/, '').toLowerCase();
          const existing = priorByPath.get(key);
          return existing ?? {
            id: `dir_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            path,
            label: path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path,
            enabled: true,
          };
        }),
      };
      try {
        const saved = await agentAccess.setNotebookConfig(
          notebookId,
          prevNotebookConfig.revision,
          nextConfig,
        );
        set((state) => ({
          notebookConfigs: { ...state.notebookConfigs, [notebookId]: saved },
        }));
        return true;
      } catch (e) {
        console.error("agentAccess.setDefaultFiles failed:", e);
        await get().loadInitial();
        return false;
      }
  },
}));
/** 在前端构造一条 Folder entry ── 路径 / 名字都是用户给的值, id 用时间戳
 * + 随机段保证与后端 `fld_<6位>` 不冲突即可 (后端写盘后会刷新 missing 字段)。 */
function makeLocalFolderEntry(path: string, name?: string): AgentAccessEntry {
  const trimmed = path.replace(/[\\/]+$/, "");
  const derived = name?.trim() || trimmed.split(/[\\/]/).pop() || trimmed;
  const now = Date.now();
  return {
    id: `fld_${now}_${Math.random().toString(36).slice(2, 6)}`,
    kind: "folder",
    path: trimmed,
    name: derived,
    enabled: true,
    addedAt: now,
    updatedAt: now,
    missing: false,
  };
}

/** 后端 IPC 失败时, Tauri 抛的 Error 里 `message` 是 `String`, 我们要
 * 识别 "path already tracked" 这条 user-facing 消息 → 走"回滚 + 友好
 * 提示"分支。 */
function extractReason(e: unknown): string | null {
  if (e && typeof e === "object" && "message" in e) {
    const msg = (e as { message: unknown }).message;
    if (typeof msg === "string") {
      if (msg.includes("path already tracked")) return "path conflict";
      return msg;
    }
  }
  return null;
}
