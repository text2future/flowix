'use client';

import { lazy, Suspense, useEffect, useState } from "react";
import { ErrorBoundary } from "@shared/error-boundary";
import { Toaster } from "sonner";
import { useUserSettings } from "@features/preferences/hooks/use-user-settings";
import { useUserSettingsStore } from "@features/preferences/store/user-settings-store";
import { useApplyFontSettings } from "@features/preferences/hooks/use-apply-font-settings";
import { useMemoEvents } from "@features/memo/hooks/use-memo-events";
import { useAgentEvents } from "@features/agent/hooks/use-agent-events";
import { ThemeProvider } from "@features/theme";
import { ShortcutsProvider } from "@features/shortcuts";
import { I18nProvider } from "@features/i18n";
import { TooltipProvider } from "@shared/ui/tooltip";
// Side-effect import — 触发 ./lib/shortcuts/actions.ts 顶部的 defineAction()
// 把所有 action 注册到全局注册表, 后面 ShortcutsProvider 挂的 keydown 监听
// 才能从 listActions() 读到。 overrides 取自 UserSettings.shortcuts, 用户在
// 偏好设置里改的快捷键 200ms debounce 落盘后, 跨窗口通过 'user-config-changed'
// 事件同步 (见下方 useEffect)。
import "@features/shortcuts/actions";
import { listenToUserConfigChanges, listenToAgentAccessChanges } from "@platform/tauri/client";
import { useAgentAccessStore } from "@features/agent/store/agent-access-store";
import { useAgentRuntimeStore } from "@features/agent/store/agent-runtime-store";
import { useAgentConversationStore } from "@features/agent/store/agent-conversation-store";
import { prewarmNotebookCache, invalidateNotebookCache } from "@features/editor/extensions/note-link";
import { invalidateMentionNotes } from "@features/editor/extensions/note-mention";
import { invalidateMentionTags } from "@features/editor/extensions/tag-mention";
import { registerMemoEventHandler } from "@/lib/memo-dispatcher";
import {
  mountOpenTargetListener,
  unmountOpenTargetListener,
} from "@platform/open-target";

const MainLayout = lazy(() =>
  import("@features/shell").then((module) => ({ default: module.MainLayout }))
);

const PreferencesView = lazy(() =>
  import("@features/preferences").then((module) => ({ default: module.PreferencesView }))
);

const FixedNoteWindow = lazy(() =>
  import("./FixedNoteWindow").then((module) => ({ default: module.FixedNoteWindow }))
);

function AppToaster() {
  return (
    <Toaster
      className="flowix-toaster"
      position="top-center"
      richColors={false}
      closeButton={false}
    />
  );
}

function App() {
  const [hash, setHash] = useState(() => window.location.hash);
  // 全局应用用户在 Preferences → Format 中选择的字体设置。
  // 主窗口 / 偏好设置窗口都会挂载 App, 因此两侧都会即时同步。
  const { settings } = useUserSettings();
  const loadInitial = useUserSettingsStore((s) => s.loadInitial);
  const flushPending = useUserSettingsStore((s) => s.flushPending);
  useApplyFontSettings(settings.format);

  // 跨窗口订阅后端 `memo-event` (统一事件总线) — 用户 / Agent / 外部工具
  // 任何一方的笔记变更都走这条管道, 前端一个监听器派发到 memo-store。
  // 挂顶层让主窗口和偏好设置窗口都同步。
  useMemoEvents();

  // 跨窗口订阅后端 `agent-chunk` ── 多 thread 后台并行时, 唯一一份
  // listener 按 `chunk.thread_id` 派发到 chat-store 的
  // `threadStates[tid]`, 互不串台。 与 useMemoEvents 同形, 也在
  // App 顶层挂 (主窗口 / 偏好窗口共享同一份 store 派发)。
  useAgentEvents();

  // 启动加载一次, 卸载前 flush 防止拖动滑块过程中关窗丢改动
  useEffect(() => {
    loadInitial();
    return () => {
      void flushPending();
    };
  }, [loadInitial, flushPending]);

  const refreshAgentRuntime = useAgentRuntimeStore((s) => s.refresh);
  useEffect(() => {
    void refreshAgentRuntime({ force: true });
  }, [refreshAgentRuntime]);

  const hydrateAgentConversations = useAgentConversationStore(
    (s) => s.hydrateFromBackend,
  );
  useEffect(() => {
    void hydrateAgentConversations();
  }, [hydrateAgentConversations]);

  // 跨窗口同步: 另一窗口成功写入 ~/.flowix/preference.json 后, 后端 emit
  // 'user-config-changed', 收到后从磁盘重新 loadInitial — 保证两窗口
  // 的 useUserSettingsStore 收敛。ai_config 由 agent 段自己监听 (见
  // windows/preferences/sections/agent.tsx)。
  useEffect(() => {
    // 走 event-bus: subscribe 返回的 UnlistenFn 直接走 cleanup。
    return listenToUserConfigChanges((kind) => {
      if (kind === "preference") {
        void loadInitial();
      }
    });
  }, [loadInitial]);

  // 跨窗口同步: agent_access 列表 (用户勾选 / 加删 folder / notebook 改名)
  // 任一变更都让两窗口重新 loadInitial, 收敛两份独立的 zustand 树。
  useEffect(() => {
    return registerMemoEventHandler(() => {
      invalidateMentionNotes();
      invalidateMentionTags();
    });
  }, []);

  const loadAgentAccess = useAgentAccessStore((s) => s.loadInitial);
  useEffect(() => {
    void loadAgentAccess();
    // 走 event-bus: subscribe 返回的 UnlistenFn 直接走 cleanup。
    return listenToAgentAccessChanges(() => {
      void loadAgentAccess();
      // notebook 增删改也会 emit 该事件 — 顺便把 noteReference 的 notebook 缓存
      // 推倒重来, 让粘贴物理路径转卡片的判定始终拿最新 path 列表。
      invalidateNotebookCache();
      invalidateMentionNotes();
      invalidateMentionTags();
      void prewarmNotebookCache();
    });
  }, [loadAgentAccess]);

  // 粘贴笔记物理路径 → noteReference 卡片的判定需要 notebook 列表常驻内存
  // (同步路径, 不能在 paste 事件里 await IPC)。在主窗口 / 偏好窗口都挂顶层,
  // 用户冷启动后第一次粘贴就能命中。
  useEffect(() => {
    void prewarmNotebookCache();
  }, []);

  // 全局"通过链接打开笔记"监听器 ── 后端 `flowix:open-target` 事件统一派发到
  // 主窗口 (preferences 窗口 listener 内部 no-op)。 触发源:
  //   - 外部深链 `flowix://memo/<id>` (冷启动 / 二次启动)
  //   - single-instance 二次启动带的 argv 走深链
  //   - Agent 工具 / 跨窗口 IPC emit
  // 顶层挂保证两个 webview 各自 listener 都 ready, Tauri 事件由后端 emit
  // 持久化, 后挂的也能收到 (单订阅者模式已在用)。
  useEffect(() => {
    void mountOpenTargetListener();
    return () => {
      unmountOpenTargetListener();
    };
  }, []);

  useEffect(() => {
    const loading = document.getElementById("app-loading");
    if (loading) loading.remove();
  }, []);

  useEffect(() => {
    const handleHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", handleHashChange);

    return () => {
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, []);

  if (hash.startsWith("#note-window")) {
    return (
      <ErrorBoundary>
        <AppToaster />
        <I18nProvider language={settings.language}>
        <ThemeProvider>
          <TooltipProvider>
            <ShortcutsProvider overrides={settings.shortcuts}>
              <Suspense fallback={null}>
                <FixedNoteWindow />
              </Suspense>
            </ShortcutsProvider>
          </TooltipProvider>
        </ThemeProvider>
        </I18nProvider>
      </ErrorBoundary>
    );
  }

  // Check if this is a preferences view
  if (hash.startsWith("#preferences")) {
    const tab = hash.split("/")[1] || undefined;
    return (
      <ErrorBoundary>
        <AppToaster />
        <I18nProvider language={settings.language}>
        <ThemeProvider>
          {/*
            overrides 来自 UserSettings.shortcuts — loadInitial() 从后端拉,
            setShortcutOverride 写入即 200ms debounce 落盘。
            keydown 监听挂在 window, 主窗口和偏好窗口各自一个 webview,
            因此 Provider 在两个 return 分支里都要包, 跨窗口同步由
            Tauri 'user-config-changed' 事件承担 (下方 useEffect 监听)。
          */}
          <TooltipProvider>
            <ShortcutsProvider overrides={settings.shortcuts}>
              <Suspense fallback={null}>
                <PreferencesView initialTab={tab} />
              </Suspense>
            </ShortcutsProvider>
          </TooltipProvider>
        </ThemeProvider>
        </I18nProvider>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <AppToaster />
      <I18nProvider language={settings.language}>
      <ThemeProvider>
        <TooltipProvider>
          <ShortcutsProvider overrides={settings.shortcuts}>
            <Suspense fallback={null}>
              <MainLayout />
            </Suspense>
          </ShortcutsProvider>
        </TooltipProvider>
      </ThemeProvider>
      </I18nProvider>
    </ErrorBoundary>
  );
}

export default App;
