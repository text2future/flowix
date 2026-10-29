import { createRoot } from "react-dom/client";

import App from "@app/app";
import { installDesktopShutdown } from "@app/desktop-shutdown";
import "@/styles/index.css";
import "sonner/dist/styles.css";
import { initTauriClient } from "@platform/tauri/client";
import { installFrontendErrorPersistence } from "@platform/tauri/frontend-errors";
import { getPlatform } from "@/lib/shortcuts/platform";

import { createLogger } from '@/lib/logger';
import { installGlobalErrorHandlers } from '@/lib/global-error';
const logger = createLogger('desktop entry');
const isMac = navigator.platform.toUpperCase().includes("MAC");
document.documentElement.dataset.platform = isMac ? "mac" : "non-mac";
document.documentElement.dataset.os = getPlatform();

// React 渲染之前的异常不经过任何错误边界；必须在启动最早期安装，
// 否则初始化阶段的崩溃既无日志也无提示。
installGlobalErrorHandlers();
// 早于任何渲染注册，保证初始化阶段的崩溃也进应用日志。
installFrontendErrorPersistence();

// The desktop bridge is initialized by the desktop entry.
try {
  initTauriClient();
} catch (error) {
  logger.error('Failed to initialize Tauri', { error });
}

installDesktopShutdown();

createRoot(document.getElementById("root")!).render(<App />);
