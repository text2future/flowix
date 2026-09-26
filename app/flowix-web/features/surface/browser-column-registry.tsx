'use client';

import type { FileBrowserViewSurface } from './file-browser-view';
import { openBrowserColumnTarget, selectBrowserColumnFile } from '@features/workspace/use-cases/browser-column-navigation';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ComponentProps,
  type FormEvent,
  type ReactNode,
} from 'react';
import { ChevronLeft, ChevronRight, Globe, RotateCw, X } from 'lucide-react';
import { LazyAgentConversationDetail } from '@features/agent/components/lazy-agent-conversation-detail';
import { DocumentContainer, UnavailableFileView } from '@features/document/components/document-container';
import { MediaResourceView } from './media-resource-view';
import { LazyPluginDocumentView } from '@features/plugin/public/surface-api';
import { SurfaceSuspenseHost } from '@shared/ui/surface-suspense-host';
import { externalFileViewKind } from '@features/editor/public/code-file';
import { HtmlResourceView } from './html-resource-view';
import { CodeSurfaceView } from './code-surface-view';
import {
  useBrowserColumnStore,
  type BrowserColumnTab,
  type BrowserColumnWebRuntime,
} from '@features/workspace/store/browser-column-store';
import { canonicalUrl } from '@features/workspace/store/workspace-content-identity';
import { openUrl } from '@platform/tauri/opener';

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
}

export interface BrowserDocumentSurface extends SurfaceBase {
  kind: 'document';
  props: ComponentProps<typeof DocumentContainer>;
}

export interface BrowserMediaSurface extends SurfaceBase {
  kind: 'media';
  filePath: string;
  notebookId: string;
  notebookPath: string;
  resourceKind: 'image' | 'video';
}

export interface BrowserFileBrowserSurface extends SurfaceBase, FileBrowserViewSurface {
  documentProps: ComponentProps<typeof DocumentContainer>;
}

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
  | BrowserMediaSurface
  | BrowserFileBrowserSurface
  | BrowserWebSurface
  | BrowserArtifactSurface
  | BrowserAgentConversationSurface;

export type BrowserColumnSurfaceKind = BrowserColumnSurface['kind'];

/** Titlebar skin owned by the surface currently mounted in Browser Column. */
export type BrowserColumnSurfaceChrome = 'document' | 'agent' | 'media';

export interface BrowserColumnSurfaceDefinition {
  chrome: BrowserColumnSurfaceChrome;
  capabilities: readonly BrowserColumnSurfaceCapability[];
  render: (surface: BrowserColumnSurface) => ReactNode;
}

export type BrowserColumnDocumentFlush = (
  (options?: { silent?: boolean }) => Promise<boolean>
) | null;
export type BrowserColumnFlushRegistration = (
  flush: BrowserColumnDocumentFlush,
  discard?: (() => void) | null,
) => void;

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
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const embedTimeoutRef = useRef<number | null>(null);
  const runtime = surface.runtime;
  const currentUrl = runtime?.currentUrl ?? surface.url;
  const reloadToken = runtime?.reloadToken ?? 0;
  const [address, setAddress] = useState(currentUrl);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [showEmbedTimeout, setShowEmbedTimeout] = useState(false);
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

  useEffect(() => {
    setShowEmbedTimeout(false);
    embedTimeoutRef.current = window.setTimeout(() => setShowEmbedTimeout(true), 6_000);
    return () => {
      if (embedTimeoutRef.current !== null) window.clearTimeout(embedTimeoutRef.current);
      embedTimeoutRef.current = null;
    };
  }, [currentUrl, reloadToken]);

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
      if (embedTimeoutRef.current !== null) window.clearTimeout(embedTimeoutRef.current);
      embedTimeoutRef.current = null;
      setShowEmbedTimeout(false);
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

  const handleOpenInSystemBrowser = useCallback(() => {
    void openUrl(currentUrl).catch(() => {
      reportRuntime({ error: '无法在系统浏览器中打开' });
    });
  }, [currentUrl, reportRuntime]);

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
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="前进"
          title="前进"
          disabled={!runtime || runtime.historyIndex >= runtime.history.length - 1}
          onClick={() => goForwardWebTab(surface.tabId)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] disabled:opacity-35"
        >
          <ChevronRight className="h-3.5 w-3.5" />
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
        {runtime?.isLoading && (
          <span
            role="status"
            aria-label="加载中"
            className="mx-1 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[color-mix(in_oklch,var(--muted-foreground)_26%,transparent)] border-t-[var(--brand)]"
          />
        )}
        {runtime?.error && <span className="shrink-0 text-[10px] text-red-500">{runtime.error}</span>}
      </form>
      {addressError && <div className="shrink-0 px-3 py-1 text-[10px] text-red-500">{addressError}</div>}
      <div className="relative min-h-0 min-w-0 flex-1 bg-white">
        <iframe
          key={`${surface.tabId}:${currentUrl}:${reloadToken}`}
          ref={iframeRef}
          title={surface.title}
          src={currentUrl}
          onLoad={handleIframeLoad}
          onError={() => {
            reportRuntime({ isLoading: false, error: '网页加载失败' });
            setShowEmbedTimeout(true);
          }}
          className="h-full w-full border-0"
          referrerPolicy="no-referrer"
        />
        {showEmbedTimeout && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/90 px-6 backdrop-blur-sm">
            <div className="relative flex max-w-sm flex-col items-center gap-4 rounded-xl border border-[var(--border)] bg-[var(--background)] px-8 py-7 text-center shadow-lg">
              <button
                type="button"
                aria-label="关闭提示"
                title="关闭提示"
                onClick={() => setShowEmbedTimeout(false)}
                className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
              >
                <X className="h-4 w-4" />
              </button>
              <p className="text-sm text-[var(--muted-foreground)]">网页可能禁止嵌入或加载超时</p>
              <button
                type="button"
                onClick={handleOpenInSystemBrowser}
                className="inline-flex h-8 items-center rounded-lg border border-[var(--border)] px-3 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]"
              >
                在系统浏览器中打开
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function BrowserDocumentSurfaceView({ surface }: { surface: BrowserDocumentSurface }) {
  return <DocumentContainer {...surface.props} />;
}

function BrowserMediaSurfaceView({ surface }: { surface: BrowserMediaSurface }) {
  return (
    <MediaResourceView
      filePath={surface.filePath}
      notebookPath={surface.notebookPath}
      resourceKind={surface.resourceKind}
    />
  );
}

function BrowserFileBrowserSurfaceView({ surface }: { surface: BrowserFileBrowserSurface }) {
  if (!surface.activeFilePath) {
    return <CodeSurfaceView props={surface.documentProps} fileTree={surface} />;
  }

  const fileKind = externalFileViewKind(surface.activeFilePath);
  switch (fileKind) {
    case 'markdown':
      return <DocumentContainer {...surface.documentProps} externalEditorMode="markdown" />;
    case 'code':
      return <CodeSurfaceView props={surface.documentProps} fileTree={surface} />;
    case 'image':
    case 'video':
      return <MediaResourceView
        filePath={surface.activeFilePath}
        notebookPath={surface.scopePath}
        resourceKind={fileKind}
      />;
    case 'html':
      return <HtmlResourceView
        filePath={surface.activeFilePath}
        scopePath={surface.scopePath}
        documentProps={surface.documentProps}
      />;
    case 'unavailable':
      return <UnavailableFileView filePath={surface.activeFilePath} openContainingFolder />;
  }

  return <UnavailableFileView filePath={surface.activeFilePath} openContainingFolder />;
}

function BrowserArtifactSurfaceView({ surface }: { surface: BrowserArtifactSurface }) {
  return <LazyPluginDocumentView {...surface.props} />;
}

function BrowserAgentConversationSurfaceView({ surface }: { surface: BrowserAgentConversationSurface }) {
  return <LazyAgentConversationDetail instanceId={surface.instanceId} />;
}

type SurfaceOfKind<K extends BrowserColumnSurfaceKind> = Extract<BrowserColumnSurface, { kind: K }>;

function defineSurface<K extends BrowserColumnSurfaceKind>(
  kind: K,
  options: {
    chrome: BrowserColumnSurfaceChrome;
    capabilities?: readonly BrowserColumnSurfaceCapability[];
    component: ComponentType<{ surface: SurfaceOfKind<K> }>;
  },
): BrowserColumnSurfaceDefinition {
  const Component = options.component;
  return Object.freeze({
    chrome: options.chrome,
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
    chrome: 'document',
    capabilities: ['edit', 'search'],
    component: BrowserDocumentSurfaceView,
  }),
  media: defineSurface('media', {
    chrome: 'media',
    capabilities: ['fullscreen'],
    component: BrowserMediaSurfaceView,
  }),
  'file-browser': defineSurface('file-browser', {
    chrome: 'document',
    capabilities: ['edit', 'search'],
    component: BrowserFileBrowserSurfaceView,
  }),
  web: defineSurface('web', {
    chrome: 'document',
    capabilities: ['web-navigation'],
    component: BrowserWebSurfaceView,
  }),
  artifact: defineSurface('artifact', {
    chrome: 'document',
    capabilities: ['fullscreen', 'fit', 'zoom'],
    component: BrowserArtifactSurfaceView,
  }),
  'agent-conversation': defineSurface('agent-conversation', {
    chrome: 'agent',
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
): BrowserColumnSurface {
  const base = {
    instanceKey: `tab:${tab.id}`,
    tabId: tab.id,
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
    case 'media':
      return {
        ...base,
        kind: 'media',
        filePath: tab.target.filePath,
        notebookId: tab.target.notebookId,
        notebookPath: tab.target.notebookPath,
        resourceKind: tab.target.resourceKind,
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
  const instanceKey = `${surface.kind}:${surface.instanceKey}`;
  const definition = getBrowserColumnSurfaceDefinition(surface);
  return (
    <SurfaceSuspenseHost
      instanceKey={instanceKey}
      loadingTone={definition.chrome}
    >
      <BrowserColumnSurfaceMount surface={surface} />
    </SurfaceSuspenseHost>
  );
}

function BrowserColumnSurfaceMount({ surface }: { surface: BrowserColumnSurface }) {
  return getBrowserColumnSurfaceDefinition(surface).render(surface);
}
