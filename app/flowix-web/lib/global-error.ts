import { createLogger } from '@/lib/logger';

const logger = createLogger('global-error');

export type UncaughtErrorKind = 'error' | 'rejection' | 'boundary';

/**
 * 一次未捕获错误的可序列化快照。
 * 只保留定位所需字段：不记录文档正文、文件路径等用户内容。
 */
export interface UncaughtErrorReport {
  kind: UncaughtErrorKind;
  message: string;
  stack?: string;
  /** 触发源，例如 window error 的 filename 或 'react-boundary'。 */
  source?: string;
  timestamp: number;
}

const MAX_RECENT = 50;
const recent: UncaughtErrorReport[] = [];
const listeners = new Set<(report: UncaughtErrorReport) => void>();
const PERSIST_DEDUPE_MS = 3_000;
let lastPersisted = { message: '', at: 0 };
let persistedTo: ((report: UncaughtErrorReport) => void) | null = null;
let installed = false;

/**
 * Register the backend that mirrors reports into the app log.
 *
 * Injected by the platform layer instead of imported here: `lib` must not talk
 * to Tauri IPC directly, and non-Tauri entrypoints simply never register one.
 */
export function setUncaughtErrorPersister(
  persister: ((report: UncaughtErrorReport) => void) | null,
): void {
  persistedTo = persister;
}

/**
 * Mirror the report into the app log.
 *
 * The WebView console is not captured anywhere, so without this an unhandled
 * rejection leaves no trace beyond a toast the user cannot act on. Best-effort
 * by design: the diagnostic channel must never throw or block the listener
 * fan-out, and repeated identical failures are collapsed to keep the log
 * readable.
 */
function persistReport(report: UncaughtErrorReport): void {
  if (!persistedTo) return;
  const now = Date.now();
  if (lastPersisted.message === report.message && now - lastPersisted.at < PERSIST_DEDUPE_MS) return;
  lastPersisted = { message: report.message, at: now };
  try {
    persistedTo(report);
  } catch (error) {
    logger.error('failed to persist uncaught error', { error });
  }
}

function describe(input: unknown): { message: string; stack?: string } {
  if (input instanceof Error) {
    return { message: input.message || input.name, stack: input.stack };
  }
  if (typeof input === 'string') return { message: input };
  try {
    return { message: JSON.stringify(input) };
  } catch {
    return { message: String(input) };
  }
}

export function createErrorReport(
  kind: UncaughtErrorKind,
  input: unknown,
  source?: string,
): UncaughtErrorReport {
  const { message, stack } = describe(input);
  return { kind, message, stack, source, timestamp: Date.now() };
}

/**
 * 记录一次未捕获错误。
 *
 * `notify: false` 用于已经有 fallback UI 的场景（React 错误边界），
 * 避免同一个错误既显示错误页又弹 toast。
 */
export function reportUncaughtError(
  report: UncaughtErrorReport,
  options: { notify?: boolean } = {},
): void {
  recent.push(report);
  if (recent.length > MAX_RECENT) recent.shift();

  logger.error(report.kind === 'error' ? 'uncaught error' : 'unhandled rejection', {
    message: report.message,
    stack: report.stack ?? '<no stack>',
    source: report.source ?? 'unknown',
  });

  persistReport(report);

  if (options.notify === false) return;
  for (const listener of listeners) {
    try {
      listener(report);
    } catch (listenerError) {
      logger.warn('uncaught error listener failed', {
        message: describe(listenerError).message,
      });
    }
  }
}

/** 订阅“需要提示给用户”的未捕获错误。返回取消订阅函数。 */
export function subscribeUncaughtErrors(
  listener: (report: UncaughtErrorReport) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 最近的未捕获错误，供诊断面板或 bug 反馈附带。 */
export function getRecentUncaughtErrors(): readonly UncaughtErrorReport[] {
  return recent;
}

/**
 * 安装全局兜底。必须在 React 渲染前调用一次（入口处），重复调用无副作用。
 *
 * 覆盖 window.onerror 与 unhandledrejection 两条路径——这两条都不会经过
 * React 错误边界，此前是完全不可观测的黑洞。
 */
export function installGlobalErrorHandlers(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (event) => {
    // 资源加载失败（img/script/link）也会触发 error 事件，但没有错误对象；
    // 这类错误已有各自的降级路径，不进入全局兜底以免淹没真实崩溃。
    if (!(event instanceof ErrorEvent)) return;
    const input = event.error ?? event.message;
    if (!input) return;
    reportUncaughtError(createErrorReport('error', input, event.filename));
  });

  window.addEventListener('unhandledrejection', (event) => {
    reportUncaughtError(createErrorReport('rejection', event.reason));
  });
}
