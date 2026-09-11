'use client';

import { lazy, Suspense, useEffect, useState } from "react";
import { ErrorBoundary } from "@shared/error-boundary";
import { Toaster } from "sonner";
import { useAppPreferencesViewModel } from "@features/preferences/public/app-api";
import { useAppAgentRuntimeViewModel } from "@features/agent/public/app-api";
import { useApplyFontSettings } from "@features/preferences/public/app-api";
import { ThemeProvider } from "@features/theme";
import { NativeSelectAllBridge, ShortcutsProvider } from "@features/shortcuts";
import { I18nProvider } from "@/lib/i18n";
import { TooltipProvider } from "@shared/ui/tooltip";
import "@features/shortcuts/actions";
import { listenToUserConfigChanges, windows } from "@platform/tauri/client";
import { syncUserConfigChange } from "./user-config-sync";
import { invalidateDshModelConfigs } from "@features/agent/public/app-api";
import { createLogger } from "@/lib/logger";

const logger = createLogger("app");

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

function removeAppLoading() {
  document.getElementById("app-loading")?.remove();
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

function App() {
  const [hash, setHash] = useState(() => window.location.hash);
  const {
    language,
    format,
    shortcutOverrides,
    loadInitial,
    flushPending,
  } = useAppPreferencesViewModel();
  const { refreshAgentRuntime } = useAppAgentRuntimeViewModel();
  useApplyFontSettings(format);

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
        refreshAgentRuntime: () => refreshAgentRuntime({ force: true }),
      });
    });
  }, [loadInitial, refreshAgentRuntime]);

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
      <ErrorBoundary language={language}>
        <AppToaster />
        <I18nProvider language={language}>
          <ThemeProvider>
            <TooltipProvider>
              <ShortcutsProvider overrides={shortcutOverrides}>
              <NativeSelectAllBridge />
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
    <ErrorBoundary language={language}>
      <AppToaster />
      <I18nProvider language={language}>
        <ThemeProvider>
          <Suspense fallback={null}>
            <AgentWindowEffects />
          </Suspense>
          <Suspense fallback={null}>
            <MainWindowEffects />
          </Suspense>
          <TooltipProvider>
            <ShortcutsProvider overrides={shortcutOverrides}>
              <NativeSelectAllBridge />
              <Suspense fallback={null}>
                <MainWindow />
                <MainWindowReadySignal />
              </Suspense>
            </ShortcutsProvider>
          </TooltipProvider>
        </ThemeProvider>
      </I18nProvider>
    </ErrorBoundary>
  );
}

export default App;
