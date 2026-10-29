import { invoke } from '@tauri-apps/api/core';
import { setUncaughtErrorPersister } from '@/lib/global-error';
import { isTauriDesktopRuntime } from './runtime';

/**
 * 把未捕获的前端错误镜像进应用日志。
 *
 * WebView 控制台没有任何捕获通道，没有这条链路时，一个未处理的 rejection
 * 除了一个用户无法处置的 toast 之外不留痕迹。降级是刻意设计：诊断通道绝不
 * 抛出、也不阻塞监听器分发（去重留在 `lib/global-error` 里）。
 */
export function installFrontendErrorPersistence(): void {
  if (!isTauriDesktopRuntime()) return;
  setUncaughtErrorPersister((report) => {
    void invoke('record_frontend_error', {
      kind: report.kind,
      message: report.message,
      stack: report.stack ?? null,
    }).catch(() => undefined);
  });
}
