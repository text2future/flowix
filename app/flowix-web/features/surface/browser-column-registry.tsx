'use client';

import { FileBrowserView, type FileBrowserViewSurface } from './file-browser-view';
import { openBrowserColumnTarget, selectBrowserColumnFile } from '@features/workspace/use-cases/browser-column-navigation';

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ComponentProps,
  type FormEvent,
  type ReactNode,
} from 'react';
import { ArrowLeft, ArrowRight, Globe, RotateCw } from 'lucide-react';
import { LazyAgentConversationDetail } from '@features/agent/components/lazy-agent-conversation-detail';
import { DocumentContainer } from '@features/document/components/document-container';
import {
  useBrowserColumnStore,
  type BrowserColumnTab,
  type BrowserColumnWebNavigationPhase,
  type BrowserColumnWebRuntime,
} from '@features/workspace/store/browser-column-store';
import { canonicalUrl } from '@features/workspace/store/workspace-content-identity';
import { getCurrentWindow } from '@platform/tauri/window';
import {
  BrowserColumnWebviewManager,
  type BrowserColumnWebviewBounds,
} from './browser-column-webview-manager';

const BROWSER_COLUMN_NAVIGATION_EVENT = 'flowix-browser-column-navigation';
interface BrowserColumnNavigationEvent {
  webviewLabel: string;
  url: string;
  phase: BrowserColumnWebNavigationPhase;
}

export type BrowserColumnSurfaceCapability =
  | 'edit'
  | 'search'
  | 'web-navigation'
  | 'stream-conversation'
  | 'fullscreen'
  | 'fit'
  | 'zoom';

interface SurfaceBase {
  instanceKey: string;
  tabId: string;
  /** Changes whenever the host layout may have moved the native child. */
  layoutKey: string;
  /** DOM portals cannot cover a native child WebView. */
  nativeOverlayOpen: boolean;
}

export interface BrowserDocumentSurface extends SurfaceBase {
  kind: 'document';
  props: ComponentProps<typeof DocumentContainer>;
}

export interface BrowserFileBrowserSurface extends SurfaceBase, FileBrowserViewSurface {}

export interface BrowserWebSurface extends SurfaceBase {
  kind: 'web';
  url: string;
  title: string;
  runtime: BrowserColumnWebRuntime | null;
}

export interface BrowserArtifactSurface extends SurfaceBase {
  kind: 'artifact';
  props: { memoId: string; transitionId?: number };
}

export interface BrowserAgentConversationSurface extends SurfaceBase {
  kind: 'agent-conversation';
  instanceId: string;
}

export type BrowserColumnSurface =
  | BrowserDocumentSurface
  | BrowserFileBrowserSurface
  | BrowserWebSurface
  | BrowserArtifactSurface
  | BrowserAgentConversationSurface;

export type BrowserColumnSurfaceKind = BrowserColumnSurface['kind'];

export interface BrowserColumnSurfaceDefinition {
  capabilities: readonly BrowserColumnSurfaceCapability[];
  render: (surface: BrowserColumnSurface) => ReactNode;
}

export type BrowserColumnDocumentFlush = (() => Promise<boolean>) | null;
export type BrowserColumnFlushRegistration = (flush: BrowserColumnDocumentFlush) => void;

let externalWebviewSequence = 0;

function browserTitleForUrl(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function browserFaviconForUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

function BrowserWebSurfaceView({ surface }: { surface: BrowserWebSurface }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const webviewManagerRef = useRef<BrowserColumnWebviewManager | null>(null);
  const nativeOverlayOpenRef = useRef(surface.nativeOverlayOpen);
  nativeOverlayOpenRef.current = surface.nativeOverlayOpen;
  const isNativeTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const runtime = surface.runtime;
  const currentUrl = runtime?.currentUrl ?? surface.url;
  const reloadToken = runtime?.reloadToken ?? 0;
  const [address, setAddress] = useState(currentUrl);
  const [addressError, setAddressError] = useState<string | null>(null);
  const setWebRuntime = useBrowserColumnStore((state) => state.setWebRuntime);
  const navigateWebTab = useBrowserColumnStore((state) => state.navigateWebTab);
  const goBackWebTab = useBrowserColumnStore((state) => state.goBackWebTab);
  const goForwardWebTab = useBrowserColumnStore((state) => state.goForwardWebTab);
  const reloadWebTab = useBrowserColumnStore((state) => state.reloadWebTab);
  const updateTabMetadata = useBrowserColumnStore((state) => state.updateTabMetadata);

  useEffect(() => {
    setAddress(currentUrl);
  }, [currentUrl]);

  useEffect(() => {
    if (runtime) return;
    setWebRuntime(surface.tabId, {
      currentUrl: surface.url,
      history: [surface.url],
      historyIndex: 0,
      reloadToken: 0,
      isLoading: false,
      error: null,
    });
  }, [runtime, setWebRuntime, surface.tabId, surface.url]);

  const reportRuntime = useCallback((patch: Partial<BrowserColumnWebRuntime>) => {
    const current = useBrowserColumnStore.getState().webRuntimes[surface.tabId] ?? {
      currentUrl,
      history: [currentUrl],
      historyIndex: 0,
      reloadToken,
      isLoading: false,
      error: null,
    };
    setWebRuntime(surface.tabId, { ...current, ...patch });
  }, [currentUrl, reloadToken, setWebRuntime, surface.tabId]);

  const handleNavigate = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = canonicalUrl(address);
    if (!normalized) {
      setAddressError('请输入 http:// 或 https:// 地址');
      return;
    }
    setAddressError(null);
    setAddress(normalized);
    navigateWebTab(surface.tabId, normalized);
    updateTabMetadata(surface.tabId, {
      icon: browserFaviconForUrl(normalized),
      title: browserTitleForUrl(normalized),
    });
  }, [address, navigateWebTab, surface.tabId, updateTabMetadata]);

  const handleIframeLoad = useCallback(() => {
    const iframe = iframeRef.current;
    let loadedUrl = currentUrl;
    let pageTitle = '';
    try {
      const href = iframe?.contentWindow?.location.href;
      loadedUrl = canonicalUrl(href ?? '') ?? currentUrl;
      pageTitle = iframe?.contentDocument?.title?.trim() ?? '';
    } catch {
      // Cross-origin pages intentionally do not expose their URL/title to the
      // host document. Keep the address bar and tab title at their last known
      // values in that case.
    }

    const runtimeNow = useBrowserColumnStore.getState().webRuntimes[surface.tabId];
    if (runtimeNow && loadedUrl !== runtimeNow.currentUrl) {
      const history = runtimeNow.history.slice(0, runtimeNow.historyIndex + 1);
      if (history[history.length - 1] !== loadedUrl) history.push(loadedUrl);
      reportRuntime({
        currentUrl: loadedUrl,
        history,
        historyIndex: history.length - 1,
        isLoading: false,
        error: null,
      });
    } else {
      reportRuntime({ isLoading: false, error: null });
    }
    updateTabMetadata(surface.tabId, {
      title: pageTitle || browserTitleForUrl(loadedUrl),
      icon: browserFaviconForUrl(loadedUrl),
    });
  }, [currentUrl, reportRuntime, surface.tabId, updateTabMetadata]);

  const readBounds = useCallback((): BrowserColumnWebviewBounds | null => {
    const viewport = viewportRef.current;
    if (!viewport) return null;
    const rect = viewport.getBoundingClientRect();
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }, []);

  const syncBounds = useCallback(() => {
    const bounds = readBounds();
    if (bounds) webviewManagerRef.current?.setBounds(bounds);
  }, [readBounds]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !isNativeTauri) return;

    const label = `browser-column-webpage-${++externalWebviewSequence}`;
    const currentWindow = getCurrentWindow();
    let disposed = false;
    let unlistenNavigation: (() => void) | null = null;
    let unlistenWindowResize: (() => void) | null = null;
    let unlistenScaleChanged: (() => void) | null = null;
    try {
      reportRuntime({ isLoading: true, error: null });
      void currentWindow.listen<BrowserColumnNavigationEvent>(
        BROWSER_COLUMN_NAVIGATION_EVENT,
        (event) => {
          const payload = event.payload;
          if (disposed || payload?.webviewLabel !== label) return;
          const normalized = canonicalUrl(payload.url);
          if (!normalized) return;
          const phase = payload.phase;
          if (phase !== 'navigating' && phase !== 'started' && phase !== 'finished') return;
          const synced = useBrowserColumnStore.getState().syncWebTabNavigation(
            surface.tabId,
            normalized,
            phase,
          );
          if (!synced) return;
          updateTabMetadata(surface.tabId, {
            title: browserTitleForUrl(normalized),
            icon: browserFaviconForUrl(normalized),
          });
        },
      ).then((unlisten) => {
        if (disposed) unlisten();
        else unlistenNavigation = unlisten;
      }).catch(() => undefined);

      const initialBounds = readBounds();
      if (!initialBounds) return;
      const manager = new BrowserColumnWebviewManager(currentWindow, {
        label,
        url: currentUrl,
        bounds: initialBounds,
        onCreated: () => {
          if (disposed) return;
          reportRuntime({ isLoading: false, error: null });
          manager.setVisible(!nativeOverlayOpenRef.current);
          syncBounds();
        },
        onError: (event) => {
          console.error('Failed to create browser-column webpage WebView', event);
          if (!disposed) reportRuntime({ isLoading: false, error: '网页视图创建失败' });
        },
      });
      webviewManagerRef.current = manager;
      manager.setVisible(!nativeOverlayOpenRef.current);

      const observer = new ResizeObserver(syncBounds);
      observer.observe(viewport);
      window.addEventListener('resize', syncBounds);
      const visualViewport = window.visualViewport;
      visualViewport?.addEventListener('resize', syncBounds);
      visualViewport?.addEventListener('scroll', syncBounds);
      void currentWindow.onResized(() => syncBounds()).then((unlisten) => {
        if (disposed) unlisten();
        else unlistenWindowResize = unlisten;
      }).catch(() => undefined);
      void currentWindow.onScaleChanged(() => syncBounds()).then((unlisten) => {
        if (disposed) unlisten();
        else unlistenScaleChanged = unlisten;
      }).catch(() => undefined);
      return () => {
        disposed = true;
        unlistenNavigation?.();
        unlistenWindowResize?.();
        unlistenScaleChanged?.();
        observer.disconnect();
        window.removeEventListener('resize', syncBounds);
        visualViewport?.removeEventListener('resize', syncBounds);
        visualViewport?.removeEventListener('scroll', syncBounds);
        if (webviewManagerRef.current === manager) webviewManagerRef.current = null;
        manager.dispose();
      };
    } catch (error) {
      console.error('Failed to initialize browser-column webpage WebView', error);
      reportRuntime({ isLoading: false, error: '网页视图初始化失败' });
    }
  }, [currentUrl, isNativeTauri, readBounds, reloadToken, reportRuntime, syncBounds]);

  useEffect(() => {
    if (!isNativeTauri) return;
    webviewManagerRef.current?.setVisible(!surface.nativeOverlayOpen);
  }, [isNativeTauri, surface.nativeOverlayOpen]);

  // Width changes are observed by ResizeObserver, but a column can also move
  // horizontally while keeping the same size. Track the host transition after
  // every layout-key change so native and DOM geometry converge together.
  useEffect(() => {
    if (!isNativeTauri) return;
    let frame = 0;
    const deadline = performance.now() + 300;
    const trackLayout = () => {
      syncBounds();
      if (performance.now() < deadline) frame = requestAnimationFrame(trackLayout);
    };
    trackLayout();
    return () => cancelAnimationFrame(frame);
  }, [isNativeTauri, surface.layoutKey, syncBounds]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--background)]">
      <form
        onSubmit={handleNavigate}
        className="flex shrink-0 items-center gap-1 border-b border-[var(--divider)] bg-[var(--bg-titlebar)] px-2 py-1.5"
      >
        <button
          type="button"
          aria-label="后退"
          title="后退"
          disabled={!runtime || runtime.historyIndex <= 0}
          onClick={() => goBackWebTab(surface.tabId)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] disabled:opacity-35"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="前进"
          title="前进"
          disabled={!runtime || runtime.historyIndex >= runtime.history.length - 1}
          onClick={() => goForwardWebTab(surface.tabId)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] disabled:opacity-35"
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="重新加载"
          title="重新加载"
          onClick={() => reloadWebTab(surface.tabId)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </button>
        <div className="flex min-w-0 flex-1 items-center rounded-md border border-[var(--border)] bg-[var(--background)] px-2">
          <Globe className="mr-1.5 h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" />
          <input
            aria-label="网页地址"
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setAddressError(null);
            }}
            className="h-7 min-w-0 flex-1 bg-transparent text-xs text-[var(--foreground)] outline-none"
            spellCheck={false}
          />
        </div>
        {runtime?.isLoading && <span className="shrink-0 text-[10px] text-[var(--muted-foreground)]">加载中</span>}
        {runtime?.error && <span className="shrink-0 text-[10px] text-red-500">{runtime.error}</span>}
      </form>
      {addressError && <div className="shrink-0 px-3 py-1 text-[10px] text-red-500">{addressError}</div>}
      <div ref={viewportRef} className="relative min-h-0 min-w-0 flex-1 bg-white">
        {!isNativeTauri && (
          <iframe
            key={`${surface.tabId}:${currentUrl}:${reloadToken}`}
            ref={iframeRef}
            title={surface.title}
            src={currentUrl}
            onLoad={handleIframeLoad}
            onError={() => reportRuntime({ isLoading: false, error: '网页加载失败' })}
            className="h-full w-full border-0"
            referrerPolicy="no-referrer"
          />
        )}
      </div>
    </div>
  );
}

const PluginDocumentView = lazy(() =>
  import('@features/plugin/plugin-document-view').then((module) => ({
    default: module.PluginDocumentView,
  })),
);

function BrowserDocumentSurfaceView({ surface }: { surface: BrowserDocumentSurface }) {
  return <DocumentContainer {...surface.props} />;
}

function BrowserFileBrowserSurfaceView({ surface }: { surface: BrowserFileBrowserSurface }) {
  return <FileBrowserView surface={surface} />;
}

function BrowserArtifactSurfaceView({ surface }: { surface: BrowserArtifactSurface }) {
  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">正在加载插件产物…</div>}>
      <PluginDocumentView {...surface.props} />
    </Suspense>
  );
}

function BrowserAgentConversationSurfaceView({ surface }: { surface: BrowserAgentConversationSurface }) {
  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">正在加载 Agent 对话…</div>}>
      <LazyAgentConversationDetail instanceId={surface.instanceId} />
    </Suspense>
  );
}

type SurfaceOfKind<K extends BrowserColumnSurfaceKind> = Extract<BrowserColumnSurface, { kind: K }>;

function defineSurface<K extends BrowserColumnSurfaceKind>(
  kind: K,
  options: {
    capabilities?: readonly BrowserColumnSurfaceCapability[];
    component: ComponentType<{ surface: SurfaceOfKind<K> }>;
  },
): BrowserColumnSurfaceDefinition {
  const Component = options.component;
  return Object.freeze({
    capabilities: Object.freeze([...(options.capabilities ?? [])]),
    render(surface: BrowserColumnSurface) {
      if (surface.kind !== kind) {
        throw new Error(`BrowserColumn surface registry mismatch: expected '${kind}', received '${surface.kind}'`);
      }
      return <Component surface={surface as SurfaceOfKind<K>} />;
    },
  });
}

export const browserColumnSurfaceRegistry = Object.freeze({
  document: defineSurface('document', {
    capabilities: ['edit', 'search'],
    component: BrowserDocumentSurfaceView,
  }),
  'file-browser': defineSurface('file-browser', {
    capabilities: ['edit', 'search'],
    component: BrowserFileBrowserSurfaceView,
  }),
  web: defineSurface('web', {
    capabilities: ['web-navigation'],
    component: BrowserWebSurfaceView,
  }),
  artifact: defineSurface('artifact', {
    capabilities: ['fullscreen', 'fit', 'zoom'],
    component: BrowserArtifactSurfaceView,
  }),
  'agent-conversation': defineSurface('agent-conversation', {
    capabilities: ['stream-conversation'],
    component: BrowserAgentConversationSurfaceView,
  }),
} satisfies Record<BrowserColumnSurfaceKind, BrowserColumnSurfaceDefinition>);

export function resolveBrowserColumnSurface(
  tab: BrowserColumnTab,
  readOnly: boolean,
  onFlushReady?: BrowserColumnFlushRegistration,
  webRuntime?: BrowserColumnWebRuntime | null,
  toolbarCollapsed = false,
  onToolbarCollapsedChange?: (collapsed: boolean) => void,
  layoutKey = '',
  nativeOverlayOpen = false,
): BrowserColumnSurface {
  const base = {
    instanceKey: `tab:${tab.id}`,
    tabId: tab.id,
    layoutKey,
    nativeOverlayOpen,
  };
  switch (tab.target.kind) {
    case 'memo':
      return {
        ...base,
        kind: 'document',
        props: {
          filePath: tab.target.filePath,
          memoId: tab.target.memoId,
          notebookId: tab.target.notebookId || null,
          notebookPath: tab.target.notebookPath || null,
          documentSessionMode: 'isolated',
          readOnly,
          onFlushReady,
          toolbarCollapsed,
          onToolbarCollapsedChange,
        },
      };
    case 'file-browser': {
      const target = tab.target;
      return {
        ...base,
        ...target,
        documentProps: {
          filePath: target.activeFilePath ?? '',
          isExternalDocument: true,
          externalScopePath: target.scopePath,
          documentSessionMode: 'isolated',
          readOnly, onFlushReady, toolbarCollapsed, onToolbarCollapsedChange,
        },
        onSelectFile: (path) => { void selectBrowserColumnFile(tab.id, path); },
        onOpenFileInNewTab: (path) => { void openBrowserColumnTarget({ ...target, activeFilePath: path, folderPath: null }, 'open-in-column'); },
        onContextChange: (patch) => useBrowserColumnStore.getState().updateFileBrowserContext(tab.id, patch),
        onSelectFolder: (path) => { void selectBrowserColumnFile(tab.id, null, path); },
        onTreeVisibleChange: (visible) => useBrowserColumnStore.getState().setFileBrowserTreeVisible(tab.id, visible),
        onTreeWidthChange: (width) => useBrowserColumnStore.getState().setFileBrowserTreeWidth(tab.id, width),
      };
    }
    case 'web':
      return {
        ...base,
        kind: 'web',
        url: tab.target.url,
        title: tab.title,
        runtime: webRuntime ?? null,
      };
    case 'artifact':
      return {
        ...base,
        kind: 'artifact',
        props: { memoId: tab.target.pointerMemoId },
      };
    case 'agent_conversation':
      return { ...base, kind: 'agent-conversation', instanceId: tab.target.instanceId };
  }
}

export function getBrowserColumnSurfaceDefinition(
  surface: BrowserColumnSurface,
): BrowserColumnSurfaceDefinition {
  return browserColumnSurfaceRegistry[surface.kind];
}

export function browserColumnSurfaceSupports(
  surface: BrowserColumnSurface,
  capability: BrowserColumnSurfaceCapability,
): boolean {
  return getBrowserColumnSurfaceDefinition(surface).capabilities.includes(capability);
}

export function BrowserColumnSurfaceHost({ surface }: { surface: BrowserColumnSurface }) {
  return (
    <BrowserColumnSurfaceMount
      key={`${surface.kind}:${surface.instanceKey}`}
      surface={surface}
    />
  );
}

function BrowserColumnSurfaceMount({ surface }: { surface: BrowserColumnSurface }) {
  return getBrowserColumnSurfaceDefinition(surface).render(surface);
}
