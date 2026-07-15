'use client';

import { lazy, Suspense, useEffect, useState } from "react";
import { ErrorBoundary } from "@shared/error-boundary";
import { Toaster } from "sonner";
import { useUserSettings } from "@features/preferences/hooks/use-user-settings";
import { useUserSettingsStore } from "@features/preferences/store/user-settings-store";
import { useApplyFontSettings } from "@features/preferences/hooks/use-apply-font-settings";
import { ThemeProvider } from "@features/theme";
import { ShortcutsProvider } from "@features/shortcuts";
import { I18nProvider } from "@features/i18n";
import { TooltipProvider } from "@shared/ui/tooltip";
import "@features/shortcuts/actions";
import { listenToUserConfigChanges, windows } from "@platform/tauri/client";

const MainLayout = lazy(() =>
  import("@features/shell").then((module) => ({ default: module.MainLayout }))
);

const PreferencesView = lazy(() =>
  import("@features/preferences").then((module) => ({ default: module.PreferencesView }))
);

const FixedNoteWindow = lazy(() =>
  import("./fixed-note-window").then((module) => ({ default: module.FixedNoteWindow }))
);

const MainWindowEffects = lazy(() =>
  import("./main-window-effects").then((module) => ({ default: module.MainWindowEffects }))
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

function MainWindowReadySignal() {
  useEffect(() => {
    void windows.showMain().catch((error) => {
      console.error("Failed to show main window", error);
    });
  }, []);

  return null;
}

function App() {
  const [hash, setHash] = useState(() => window.location.hash);
  const { settings } = useUserSettings();
  const loadInitial = useUserSettingsStore((s) => s.loadInitial);
  const flushPending = useUserSettingsStore((s) => s.flushPending);
  useApplyFontSettings(settings.format);

  useEffect(() => {
    loadInitial();
    return () => {
      void flushPending();
    };
  }, [loadInitial, flushPending]);

  useEffect(() => {
    return listenToUserConfigChanges((kind) => {
      if (kind === "preference") {
        void loadInitial();
      }
    });
  }, [loadInitial]);

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

  const isNoteWindow = hash.startsWith("#note-window");
  const isPreferencesWindow = hash.startsWith("#preferences");

  if (isNoteWindow) {
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

  if (isPreferencesWindow) {
    const tab = hash.split("/")[1] || undefined;
    return (
      <ErrorBoundary>
        <AppToaster />
        <I18nProvider language={settings.language}>
          <ThemeProvider>
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
          <Suspense fallback={null}>
            <MainWindowEffects />
          </Suspense>
          <TooltipProvider>
            <ShortcutsProvider overrides={settings.shortcuts}>
              <Suspense fallback={null}>
                <MainLayout />
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
