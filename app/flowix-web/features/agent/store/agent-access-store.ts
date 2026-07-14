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
  AgentAccessDefaultRuntime,
  AgentAccessEntry,
} from "@/lib/types/agent-access";
import type { AgentTypeKey, FilesConfig } from "@/types/agent";

// This store mirrors `~/.flowix/agent-access.json`.
// It owns defaults for newly created agent-thread-card instances and keeps the
// legacy/global entries list for compatibility. Real conversation runs should
// use the instance runtime config (`runtimeConfig.files` -> workspacePaths).

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
   * 取消所有 workspace 标志 ── 用户取消勾选最后一个 folder 之后调用。
   *
   * 故意不 addFolder 当前笔记本路径: 那会留下"workspace 标志在新增 entry
   * 上"的视觉残留, 不符合"全部清空 → 没有 workspace 样式"的 UX 预期。
   * 真正的兜底由 `agent-runtime-spec::buildAgentRuntimeConfig` 的 cascade
   * 接手 ── primaryWorkspace 兜底链最后落到 `cwd` (= systemReminderDirectory,
   * 也就是用户当前 notebook 的路径, 提交消息时已注入)。
   */
  clearWorkspace: () => Promise<void>;

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

  setDefaultRuntime: (
    agentType: AgentTypeKey,
    patch: AgentAccessDefaultRuntime,
  ) => Promise<void>;
  setDefaultFiles: (files: FilesConfig) => Promise<void>;
}

const EMPTY_CONFIG: AgentAccessConfig = { version: 1, entries: [], defaults: {} };

export const useAgentAccessStore = create<AgentAccessState>((set, get) => ({
  config: EMPTY_CONFIG,
  isLoading: false,

  loadInitial: async () => {
    set({ isLoading: true });
    try {
      // 直接以磁盘真值落库 ── workspace 不再做"第一个 enabled 自动升主空间"
      // 的派生。 历史数据如果已经写入过 workspace, 这里原样保留; 新装或
      // 用户主动清空的情况下, 没有 workspace 也合法 (允许用户完全不要主
      // 空间, 由其它 entry 单独决定访问范围)。
      const config = await agentAccess.get();
      set({ config, isLoading: false });
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
    // 关闭 workspace folder 的勾选 = "撤销工作空间选中"。 此时 workspace
    // 必须给出一个新的承载者, 否则 workspace 与 enabled 的不变量
    // (workspace=true ⇒ enabled=true) 会被打破, 也与"列表第一个"fallback
    // 契约冲突。 于是: 先把目标 enabled 翻成 nextEnabled, 再从剩余 enabled
    // folder 中取第一个作为新 workspace; 没有则清空 workspace 标志。
    const shouldReassignWorkspace =
      entry.workspace === true && !nextEnabled;
    const nextEntries = prev.entries.map((e) =>
      e.id === id
        ? {
            ...e,
            enabled: nextEnabled,
            updatedAt: Date.now(),
          }
        : e,
    );
    const optimistic = shouldReassignWorkspace
      ? reassignWorkspaceToFirstEnabled(prev, nextEntries)
      : { ...prev, entries: nextEntries };
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
    const now = Date.now();
    // 显式路径: 目标设 workspace=true + enabled=true; 其它清空 workspace
    // (enabled 保留用户原值)。 updatedAt 只刷"实际动了"两条 ── 老 workspace
    // 退出位置 (demote) 与新 workspace 进入位置 (promote), 其它不动, 避免
    // 整批 entry 被无谓标记 dirty。
    const optimistic = {
      ...prev,
      entries: prev.entries.map((e) => {
        const isTarget = e.id === id;
        const wasWorkspace = e.workspace === true;
        if (!isTarget && !wasWorkspace) return e;
        return {
          ...e,
          workspace: isTarget,
          enabled: isTarget ? true : e.enabled,
          updatedAt: now,
        };
      }),
    };
    set({ config: optimistic });
    try {
      await agentAccess.set(optimistic);
    } catch (e) {
      console.error("agentAccess.setWorkspace failed, rolling back:", e);
      await get().loadInitial();
    }
  },

  clearWorkspace: async () => {
    const prev = get().config;
    if (!prev.entries.some((e) => e.workspace === true)) return;
    const now = Date.now();
    const optimistic = {
      ...prev,
      entries: prev.entries.map((e) =>
        e.workspace
          ? { ...e, workspace: false, updatedAt: now }
          : e,
      ),
    };
    set({ config: optimistic });
    try {
      await agentAccess.set(optimistic);
    } catch (e) {
      console.error("agentAccess.clearWorkspace failed, rolling back:", e);
      await get().loadInitial();
    }
  },

  addFolder: async (path: string, name?: string) => {
    const entry = makeLocalFolderEntry(path, name);
    const prev = get().config;
    // 新加的 folder: enabled=true, workspace=false ── 不再隐式自动升级为
    // workspace (避免"加文件夹就变主空间"的副作用)。
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

  removeFolder: async (id: string) => {
    const prev = get().config;
    const entry = prev.entries.find((e) => e.id === id);
    if (!entry || entry.kind !== "folder") return;
    // 删除 workspace folder 同样算"撤销工作空间选中": workspace 标志随条
    // 目消失, 此时按契约必须把它重新指派给列表里第一个 enabled folder, 否
    // 则 workspace 槽位空悬, 跟"workspace 唯一且有承载"的语义对不上。
    const shouldReassignWorkspace = entry.workspace === true;
    const nextEntries = prev.entries.filter((e) => e.id !== id);
    const optimistic = shouldReassignWorkspace
      ? reassignWorkspaceToFirstEnabled(prev, nextEntries)
      : { ...prev, entries: nextEntries };
    set({ config: optimistic });
    try {
      await agentAccess.set(optimistic);
    } catch (e) {
      console.error("agentAccess.removeFolder failed, rolling back:", e);
      await get().loadInitial();
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

  setDefaultFiles: async (files) => {
    const prev = get().config;
    const optimistic: AgentAccessConfig = {
      ...prev,
      defaults: {
        ...(prev.defaults ?? {}),
        files: {
          workspace: files.workspace,
          folders: [...files.folders],
          notebooks: [...files.notebooks],
        },
      },
    };
    set({ config: optimistic });
    try {
      await agentAccess.set(optimistic);
    } catch (e) {
      console.error("agentAccess.setDefaultFiles failed, rolling back:", e);
      await get().loadInitial();
    }
  },
}));

/**
 * workspace 槽位兜底 ── 当 workspace entry 被移除或被关闭时, 在剩余
 * enabled entry 中挑第一个作为新 workspace (folder 优先, 其次 notebook ──
 * 与弹窗渲染顺序一致), 保持"workspace 唯一"的契约。 没有可用 candidate 时
 * 把 workspace 标志全清空, 允许空悬。
 */
function reassignWorkspaceToFirstEnabled(
  prev: AgentAccessConfig,
  nextEntries: AgentAccessEntry[],
): AgentAccessConfig {
  // folder 优先, 其次 notebook ── 与弹窗渲染顺序 (folder section 在前) 一致,
  // 保证 "选中的第一个" 兜底落到 folder 上, 没 folder 才轮到 notebook。
  const promoteId =
    nextEntries.find(
      (e) => e.kind === "folder" && e.enabled && !e.missing,
    )?.id ??
    nextEntries.find(
      (e) => e.kind === "notebook" && e.enabled && !e.missing,
    )?.id;
  const now = Date.now();
  const entries = nextEntries.map((e) => {
    const shouldBeWorkspace = e.id === promoteId;
    if (e.workspace === shouldBeWorkspace) return e;
    return {
      ...e,
      workspace: shouldBeWorkspace,
      // promote 时强制 enabled=true, 与 setWorkspace 语义一致 ──
      // workspace 槽位永远允许 AI 访问。
      enabled: shouldBeWorkspace ? true : e.enabled,
      updatedAt: now,
    };
  });
  return { ...prev, entries };
}

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
