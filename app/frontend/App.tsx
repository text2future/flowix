'use client';

import { lazy, Suspense, useEffect, useState } from "react";
import { ErrorBoundary } from "./components/error-boundary";
import { Toaster } from "sonner";
import { useUserSettings } from "./hooks/useUserSettings";
import { useApplyFontSettings } from "./hooks/useApplyFontSettings";
import { useApplyTheme } from "./hooks/useApplyTheme";

const MainLayout = lazy(() =>
  import("./windows/main/main-layout").then((module) => ({ default: module.MainLayout }))
);

const PreferencesView = lazy(() =>
  import("./windows/preferences/preferences-view").then((module) => ({ default: module.PreferencesView }))
);

function AppToaster() {
  return <Toaster position="top-center" richColors={false} closeButton={false} />;
}

function App() {
  const [hash, setHash] = useState(() => window.location.hash);
  // 全局应用用户在 Preferences → Format 中选择的字体设置。
  // 主窗口 / 偏好设置窗口都会挂载 App, 因此两侧都会即时同步。
  const { settings } = useUserSettings();
  useApplyFontSettings(settings);
  useApplyTheme(settings.theme);

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

  // Check if this is a preferences view
  if (hash.startsWith("#preferences")) {
    const tab = hash.split("/")[1] || undefined;
    return (
      <ErrorBoundary>
        <AppToaster />
        <Suspense fallback={null}>
          <PreferencesView initialTab={tab} />
        </Suspense>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <AppToaster />
      <Suspense fallback={null}>
        <MainLayout />
      </Suspense>
    </ErrorBoundary>
  );
}

export default App;
