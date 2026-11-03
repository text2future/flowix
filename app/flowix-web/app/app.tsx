'use client';

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { StartupEntryScreen, StartupGate } from "./startup-screen";
import { useWorkspaceStartupStore, applyNativeStartupStatus, isWorkspaceInteractive } from "@/lib/store/workspace-startup-store";
import { ErrorBoundary } from "@shared/error-boundary";
import { toast, useToastHostRequested } from "@/lib/toast";
import { useAppPreferencesViewModel } from "@features/preferences/public/app-api";
import { useApplyFontSettings } from "@features/preferences/public/app-api";
import { ThemeProvider } from "@features/theme";
import { NativeEditMenuBridge, ShortcutsProvider } from "@features/shortcuts";
import { I18nProvider } from "@/lib/i18n";
import { TooltipProvider } from "@shared/ui/tooltip";
import "@features/shortcuts/actions";
import { boot, listenToUserConfigChanges, windows } from "@platform/tauri/client";
import { syncUserConfigChange } from "./user-config-sync";
import { useAgentWorkspaceWindowLifecycle } from "./use-agent-workspace-window-lifecycle";
import {
  invalidateDshModelConfigs,
  refreshAgentRuntime as requestAgentRuntimeRefresh,
  subscribeAgentPersistenceError,
} from "@features/agent/public/app-api";
import { createLogger } from "@/lib/logger";
import { createErrorReport, reportUncaughtError } from "@/lib/global-error";
import { GlobalErrorToaster } from "./global-error-toaster";
import { ActionableNoticeHost } from "@features/notifications/actionable-notice-host";
import { translate, type AppLanguage } from "@/lib/i18n";

// Keep memo notification hosts out of the startup graph.
const DocumentSaveNotifications = lazy(() => import('@features/document/public/app-api')
  .then(module => ({ default: module.DocumentSaveNotifications })));

// 提示宿主同样不进启动图: 首屏几乎不会弹 toast, 而 sonner 本身 ~34KB。
// 只有 lib/toast 收到第一条提示时才请求挂载 (见 useToastHostRequested)。
const ToastHost = lazy(() => import('./toast-host').then(module => ({ default: module.ToastHost })));

const logger = createLogger("app");

/**
 * React 渲染错误已经由 ErrorBoundary 展示 fallback UI，这里只补上“留痕”：
 * 进入全局错误缓冲，让崩溃可被诊断，但不额外弹 toast。
 */
function handleRenderError(error: Error): void {
  reportUncaughtError(createErrorReport("boundary", error, "react-boundary"), { notify: false });
}

function removeAppLoading() {
  document.getElementById("app-loading")?.remove();
}

const MainWindow = lazy(() =>
  import("./main-window/main-window")
    .then((module) => ({ default: module.MainWindow }))
    .catch((error) => {
      // A packaged Tauri WebView can fail to resolve a lazy chunk while the
      // root document itself has already loaded. Do not leave the static
      // startup spinner covering the error boundary forever in that case.
      removeAppLoading();
      throw error;
    })
);

const PreferencesView = lazy(() =>
  import("@features/preferences").then((module) => ({ default: module.PreferencesView }))
);

const MainWindowEffects = lazy(() =>
  import("./main-window-effects").then((module) => ({ default: module.MainWindowEffects }))
);

const AgentWindowEffects = lazy(() =>
  import("./agent-window-effects").then((module) => ({ default: module.AgentWindowEffects }))
);

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined'
    && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

function AgentWorkspaceLifecycle({ deferUntilStage3 = false }: { deferUntilStage3?: boolean }) {
  useAgentWorkspaceWindowLifecycle({ deferUntilStage3 });
  return null;
}

function MainWindowShortcuts({ children, overrides }: React.ComponentProps<typeof ShortcutsProvider>) {
  const interactive = useWorkspaceStartupStore(isWorkspaceInteractive);
  return (
    <ShortcutsProvider overrides={overrides} enabled={interactive}>
      {interactive && <NativeEditMenuBridge />}
      {children}
    </ShortcutsProvider>
  );
}

function AppToaster({ language }: { language: AppLanguage }) {
  // 走公开的 window 事件契约，而不是订阅 agent-data-store：
  // 根组件只需要"缓存写失败"这一个信号，不该为它把整个 store 拖进启动图。
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const lastPersistenceError = useRef<string | null>(null);
  const toastHostRequested = useToastHostRequested();

  useEffect(() => subscribeAgentPersistenceError(setPersistenceError), []);

  useEffect(() => {
    if (!persistenceError) {
      lastPersistenceError.current = null;
      return;
    }
    if (lastPersistenceError.current === persistenceError) return;
    lastPersistenceError.current = persistenceError;
    toast.error(translate(language, "preferences.agents.cacheWriteFailed"));
  }, [language, persistenceError]);

  return (
    <>
    {toastHostRequested && (
      <Suspense fallback={null}>
        <ToastHost className="flowix-toaster" />
      </Suspense>
    )}
    <Suspense fallback={null}><DocumentSaveNotifications /></Suspense>
    <ActionableNoticeHost />
    </>
  );
}

function AppReadySignal() {
  useEffect(() => {
    removeAppLoading();
  }, []);

  return null;
}

function MainWindowReadySignal() {
  useEffect(() => {
    removeAppLoading();
    void windows.showMain().catch((error) => {
      logger.error("show main window failed", { error });
    });
  }, []);

  return null;
}

function useUnexpectedControlInputGuard() {
  useEffect(() => {
    const controlCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
    const handleBeforeInput = (event: Event) => {
      const inputEvent = event as InputEvent;
      if (inputEvent.isComposing) return;
      if (
        inputEvent.inputType !== "insertText" &&
        inputEvent.inputType !== "insertReplacementText"
      ) return;

      const data = inputEvent.data;
      if (!data || !controlCharacters.test(data)) return;

      // macOS WebKit can turn ArrowRight into an insertText event containing
      // U+001D. Block accidental ASCII control text across native fields and
      // contenteditable surfaces while leaving IME composition untouched.
      inputEvent.preventDefault();
    };

    document.addEventListener("beforeinput", handleBeforeInput, true);
    return () => document.removeEventListener("beforeinput", handleBeforeInput, true);
  }, []);
}

function App() {
  useUnexpectedControlInputGuard();
  const [hash, setHash] = useState(() => window.location.hash);
  const {
    language,
    format,
    shortcutOverrides,
    loadInitial,
    flushPending,
  } = useAppPreferencesViewModel();
  useApplyFontSettings(format);


  useEffect(() => {
    const setNativeReady = () => useWorkspaceStartupStore.setState((state) => (
      state.nativePhase === 'ready'
        && state.nativeStage === 'workspacePreparation'
        && state.nativeStep === 'ready'
        && state.nativeError === null
        && state.nativeProgress === null
        ? state
        : { ...state, nativePhase: 'ready', nativeStage: 'workspacePreparation', nativeStep: 'ready', nativeError: null, nativeProgress: null }
    ));
    if (hash.startsWith("#preferences") || !isTauriRuntime()) {
      setNativeReady();
      return;
    }
    let active = true;
    const refresh = async () => {
      try {
        let status = await boot.getStartupStatus();
        while (active) {
          applyNativeStartupStatus(status);
          if (status.phase === 'ready' || status.phase === 'failed') break;
          status = await boot.waitForStartupStatusChange(status);
        }
      } catch {
        if (active) setNativeReady();
      }
    };
    void refresh();
    return () => {
      active = false;
    };
  }, [hash]);

  useEffect(() => {
    const root = document.documentElement;
    const handleFocus = () => { root.dataset.windowFocused = "true"; };
    const handleBlur = () => { root.dataset.windowFocused = "false"; };
    root.dataset.windowFocused = String(document.hasFocus());
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
      delete root.dataset.windowFocused;
    };
  }, []);

  useEffect(() => {
    void windows.applyMenuLanguage(language).catch((error) => {
      logger.error("apply native menu language failed", { error });
    });
  }, [language]);

  useEffect(() => {
    // The static loading screen is only a first-paint fallback. It must not
    // depend on a lazy route resolving: if a packaged chunk is unavailable,
    // ErrorBoundary should be visible instead of an endless spinner.
    removeAppLoading();

    const isAuxiliaryWindow = hash.startsWith("#preferences");
    if (!isAuxiliaryWindow) {
      void windows.showMain().catch((error) => {
        logger.error("show main window failed during app bootstrap", { error });
      });
    }
  }, [hash]);

  useEffect(() => {
    loadInitial();
    return () => {
      void flushPending();
    };
  }, [loadInitial, flushPending]);

  useEffect(() => {
    return listenToUserConfigChanges((kind) => {
      if (kind === "dsh_config") invalidateDshModelConfigs();
      syncUserConfigChange(kind, {
        reloadPreferences: loadInitial,
        // 公开入口只暴露命令，store 由它内部动态加载，根组件不持有 agent 状态。
        refreshAgentRuntime: () => requestAgentRuntimeRefresh({ force: true }),
      });
    });
  }, [loadInitial]);

  useEffect(() => {
    const handleHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", handleHashChange);

    return () => {
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, []);

  const isPreferencesWindow = hash.startsWith("#preferences");

  if (isPreferencesWindow) {
    const tab = hash.split("/")[1] || undefined;
    return (
      <ErrorBoundary language={language} onError={handleRenderError}>
        <I18nProvider language={language}>
          <AgentWorkspaceLifecycle />
          <AppToaster language={language} />
          <GlobalErrorToaster />
          <ThemeProvider>
            <TooltipProvider>
              <ShortcutsProvider overrides={shortcutOverrides}>
              <NativeEditMenuBridge />
              <Suspense fallback={null}>
                <PreferencesView initialTab={tab} />
                <AppReadySignal />
              </Suspense>
              </ShortcutsProvider>
            </TooltipProvider>
          </ThemeProvider>
        </I18nProvider>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary language={language} resetKeys={[hash]} onError={handleRenderError}>
      <I18nProvider language={language}>
        <ThemeProvider>
          <StartupGate>
            <AgentWorkspaceLifecycle deferUntilStage3 />
            <AppToaster language={language} />
            <GlobalErrorToaster />
            <Suspense fallback={null}>
              <AgentWindowEffects />
            </Suspense>
            <Suspense fallback={null}>
              <MainWindowEffects />
            </Suspense>
            <TooltipProvider>
              <MainWindowShortcuts overrides={shortcutOverrides}>
                <Suspense fallback={<StartupEntryScreen />}>
                  <MainWindow />
                  <MainWindowReadySignal />
                </Suspense>
              </MainWindowShortcuts>
            </TooltipProvider>
          </StartupGate>
        </ThemeProvider>
      </I18nProvider>
    </ErrorBoundary>
  );
}

export default App;
