import { useBrowserColumnStore } from '@features/workspace/store/browser-column-store';

export type BrowserColumnDocumentFlush = (
  options?: { silent?: boolean },
) => Promise<boolean>;

interface ActiveFlushRegistration {
  tabId: string;
  flush: BrowserColumnDocumentFlush;
  discard: (() => void) | null;
}

let activeFlushRegistration: ActiveFlushRegistration | null = null;
let navigationChain: Promise<unknown> = Promise.resolve();

/**
 * Register the editor currently mounted for a BrowserColumn tab.
 *
 * The registration is deliberately module-scoped rather than component-local:
 * a memo can be opened by an Agent, a file tree, a deep link, or a restored
 * tab, and all of those paths must use the same save-before-unmount barrier.
 */
export function registerBrowserColumnDocumentFlush(
  tabId: string,
  flush: BrowserColumnDocumentFlush | null,
  discard: (() => void) | null = null,
): void {
  if (flush) {
    activeFlushRegistration = { tabId, flush, discard };
    return;
  }
  if (activeFlushRegistration?.tabId === tabId) {
    activeFlushRegistration = null;
  }
}

export async function flushActiveBrowserColumnDocument(
  options?: { silent?: boolean },
): Promise<boolean> {
  const activeTabId = useBrowserColumnStore.getState().activeTabId;
  const registration = activeFlushRegistration;
  if (!activeTabId || !registration || registration.tabId !== activeTabId) return true;

  try {
    return await registration.flush(options);
  } catch (error) {
    console.error('[BrowserColumn] Failed to flush active tab before navigation', error);
    return false;
  }
}

export function discardActiveBrowserColumnDocument(): void {
  activeFlushRegistration?.discard?.();
}

/**
 * Serialize every operation which can replace or unmount the active tab.
 * `null` means the operation was rejected because the active editor could not
 * be flushed; callers must leave the current tab intact in that case.
 */
export function enqueueBrowserColumnNavigation<T>(
  operation: () => T | Promise<T>,
  options: { flush?: boolean; silentFlush?: boolean } = {},
): Promise<T | null> {
  const run = navigationChain
    .catch(() => undefined)
    .then(async () => {
      if (options.flush !== false
        && !await flushActiveBrowserColumnDocument({ silent: options.silentFlush })) return null;
      return await operation();
    });
  navigationChain = run.catch(() => undefined);
  return run;
}

export function activateBrowserColumnTab(tabId: string): Promise<boolean | null> {
  return enqueueBrowserColumnNavigation(() => {
    const state = useBrowserColumnStore.getState();
    if (!state.tabs.some((tab) => tab.id === tabId)) return false;
    state.commitTab(tabId);
    return true;
  });
}

export function resetBrowserColumnCoordinator(): void {
  activeFlushRegistration = null;
  navigationChain = Promise.resolve();
}
