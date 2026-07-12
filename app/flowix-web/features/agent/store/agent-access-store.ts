/**
 * Agent 可访问目录 store ── zustand 镜像后端
 * `~/.flowix/agent-access.json` 的整份 config。 与 `user-settings-store`
 * 不同, 本 store 没有 persist (后端是真源), 走 IPC + 跨窗口事件同步。
 *
 * 写操作 (`toggle` / `addFolder` / `removeFolder`) 走乐观更新: 本地先
 * 改 `entries` 再 `await agentAccess.set` 整份, 失败时 `loadInitial`
 * 回滚到磁盘真值。 跨窗口同步靠 app.tsx 顶层挂的 `listenToAgentAccessChanges`,
 * 收到事件后从磁盘拉整份覆盖内存。
 */

import { create } from "zustand";
import { agentAccess } from "@platform/tauri/client";
import type {
  AgentAccessConfig,
  AgentAccessEntry,
  AgentAccessKind,
} from "@/lib/types/agent-access";

export type AgentAccessErrorCode =
  "not-selected" | "already-tracked" | "save-failed";

export interface AgentAccessState {
  config: AgentAccessConfig;
  isLoading: boolean;

  /** 从磁盘拉整份 config ── 启动 / 跨窗口事件 / 写失败回滚都走它。 */
  loadInitial: () => Promise<void>;

  /**
   * 翻转单条 entry 的 enabled 状态。 乐观更新, 失败回滚。
   * missing=true 的条目仍然允许 toggle (用户可能想"先放着, 目录恢复后
   * 就能用"), 真正拒绝 Agent 访问的是 `ToolScope` 那一层 (看 `missing`)。
   */
  toggle: (id: string) => Promise<void>;

  /** 设置唯一主工作空间。主空间同时保持 enabled=true。 */
  setWorkspace: (id: string) => Promise<void>;

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

  /** 删 folder ── kind != Folder 由后端 no-op。 */
  removeFolder: (id: string) => Promise<void>;
}

const EMPTY_CONFIG: AgentAccessConfig = { version: 1, entries: [] };

function normalizeWorkspaceSelection(
  config: AgentAccessConfig,
): AgentAccessConfig {
  const firstFolderIndex = config.entries.findIndex(
    (entry) => entry.kind === "folder" && entry.enabled && !entry.missing,
  );
  const entries = config.entries.map((entry, index) => ({
    ...entry,
    workspace: index === firstFolderIndex,
  }));

  return { ...config, entries };
}

export const useAgentAccessStore = create<AgentAccessState>((set, get) => ({
  config: EMPTY_CONFIG,
  isLoading: false,

  loadInitial: async () => {
    set({ isLoading: true });
    try {
      const config = await agentAccess.get();
      set({ config: normalizeWorkspaceSelection(config), isLoading: false });
    } catch (e) {
      // 静默失败 ── 与 `user-settings-store.loadInitial` 同形, 把
      // 错误信息留给后续用户操作触发。 UI 在 config.entries 为空时
      // 会渲染空状态, 不会卡死。
      console.error("agentAccess.loadInitial failed:", e);
      set({ isLoading: false });
    }
  },

  toggle: async (id: string) => {
    const prev = get().config;
    const entry = prev.entries.find((e) => e.id === id);
    if (!entry) return;
    const nextEnabled = !entry.enabled;
    const optimistic = normalizeWorkspaceSelection({
      ...prev,
      entries: prev.entries.map((e) =>
        e.id === id
          ? {
              ...e,
              enabled: nextEnabled,
              workspace: nextEnabled ? e.workspace : false,
              updatedAt: Date.now(),
            }
          : e,
      ),
    });
    set({ config: optimistic });
    try {
      await agentAccess.set(optimistic);
    } catch (e) {
      console.error("agentAccess.toggle failed, rolling back:", e);
      await get().loadInitial();
    }
  },

  setWorkspace: async (id: string) => {
    const prev = get().config;
    const entry = prev.entries.find((e) => e.id === id);
    if (!entry || entry.missing) return;
    const optimistic = normalizeWorkspaceSelection({
      ...prev,
      entries: prev.entries.map((e) => ({
        ...e,
        workspace: e.id === id,
        enabled: e.id === id ? true : e.enabled,
        updatedAt: e.id === id || e.workspace ? Date.now() : e.updatedAt,
      })),
    });
    set({ config: optimistic });
    try {
      await agentAccess.set(optimistic);
    } catch (e) {
      console.error("agentAccess.setWorkspace failed, rolling back:", e);
      await get().loadInitial();
    }
  },

  addFolder: async (path: string, name?: string) => {
    const entry = makeLocalFolderEntry(path, name);
    const prev = get().config;
    const optimistic = normalizeWorkspaceSelection({
      ...prev,
      entries: [...prev.entries, entry],
    });
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

  removeFolder: async (id: string) => {
    const prev = get().config;
    const entry = prev.entries.find((e) => e.id === id);
    if (!entry || entry.kind !== ("folder" satisfies AgentAccessKind)) return;
    const optimistic = normalizeWorkspaceSelection({
      ...prev,
      entries: prev.entries.filter((e) => e.id !== id),
    });
    set({ config: optimistic });
    try {
      await agentAccess.set(optimistic);
    } catch (e) {
      console.error("agentAccess.removeFolder failed, rolling back:", e);
      await get().loadInitial();
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
    workspace: false,
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
