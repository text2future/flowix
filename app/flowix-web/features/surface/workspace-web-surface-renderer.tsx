'use client';

import { useSessionWebRuntime } from '@features/workspace/public/session-web-api';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, Globe, RotateCw, X } from 'lucide-react';
import { createLogger } from '@/lib/logger';
import { canonicalUrl } from '@/lib/url';
import {
  createWorkspaceWebRuntime,
  moveWorkspaceWebHistory,
  navigateWorkspaceWebRuntime,
  reloadWorkspaceWebRuntime,
  replaceWorkspaceWebRuntimeUrl,
} from '@features/workspace/public/surface-runtime-api';
import type { WorkspaceWebRuntime } from '@features/workspace/public/surface-runtime-api';
import { useI18n } from '@/lib/i18n';
import { openUrl } from '@platform/tauri/opener';
import { connectWebFrameScrollbar } from '@shared/ui/web-frame-scrollbar';
import type { WorkspaceSurfaceRendererData, WorkspaceSurfaceRenderContext, WorkspaceWebNavigationPort } from './workspace-surface-renderer-contract';

import { isLocalSkillMarketUiUrl, skillMarketLanguageForUrl, skillMarketOriginForUrl, skillMarketUrlForLanguage } from './skill-market-origin';
import { useMarketBridge } from './use-market-bridge';
import { MarketUiRenderer } from './market-ui-renderer';
import { marketUiRootUrl, marketUiViewForUrl } from '@shared/lib/market-ui-url';

const marketLogger = createLogger('skill-market');

/** Work owns a view-local web session; Browser injects its tab runtime port. */
function useLocalWebNavigation(url: string) {
  const initial = useMemo(() => createWorkspaceWebRuntime(url), [url]);
  const { runtime, setRuntime } = useSessionWebRuntime(initial);
  const current = useRef(runtime);
  current.current = runtime;
  const port = useMemo<WorkspaceWebNavigationPort>(() => {
    const commit = (next: WorkspaceWebRuntime | null) => {
      if (!next) return;
      current.current = next;
      setRuntime(next);
    };
    return {
      getRuntime: () => current.current,
      setRuntime: commit,
      navigate: (address) => commit(navigateWorkspaceWebRuntime(current.current, address)),
      back: () => commit(moveWorkspaceWebHistory(current.current, -1)),
      forward: () => commit(moveWorkspaceWebHistory(current.current, 1)),
      reload: () => commit(reloadWorkspaceWebRuntime(current.current)),
      updateMetadata: () => {},
    };
  }, [setRuntime]);
  return { runtime, port };
}

function browserTitleForUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (skillMarketOriginForUrl(url, import.meta.env.DEV)) {
      return skillMarketLanguageForUrl(url) === 'en-US' ? 'Skill Market' : '技能市场';
    }
    return parsed.hostname || url;
  } catch {
    return url;
  }
}

function browserFaviconForUrl(url: string): string | null {
  try {
    if (isLocalSkillMarketUiUrl(url)) return new URL('assets/favicon.ico', marketUiRootUrl(url)).href;
    const parsed = new URL(url);
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

export function WebRenderer(props: {
  surface: Extract<WorkspaceSurfaceRendererData, { kind: 'web' }>;
  context: WorkspaceSurfaceRenderContext;
}) {
  const currentUrl = props.surface.runtime?.currentUrl ?? props.context.webNavigation?.getRuntime()?.currentUrl ?? props.surface.url;
  const view = marketUiViewForUrl(currentUrl);
  return view ? <MarketUiRenderer view={view} context={props.context} /> : <WebPageRenderer {...props} />;
}

function WebPageRenderer({ surface, context }: {
  surface: Extract<WorkspaceSurfaceRendererData, { kind: 'web' }>;
  context: WorkspaceSurfaceRenderContext;
}) {
  const { language } = useI18n();
  const local = useLocalWebNavigation(surface.url);
  const port = context.webNavigation ?? local.port;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const embedTimeoutRef = useRef<number | null>(null);
  const runtime = context.webNavigation ? surface.runtime ?? port.getRuntime() : local.runtime;
  const lastLoadedUrlRef = useRef(runtime && !runtime.isLoading ? runtime.currentUrl : null);
  const currentUrl = runtime?.currentUrl ?? surface.url;
  const reloadToken = runtime?.reloadToken ?? 0;
  const skillMarketOrigin = skillMarketOriginForUrl(currentUrl, import.meta.env.DEV);
  const isSkillMarket = skillMarketOrigin !== null;
  const isLocalMarketUi = isLocalSkillMarketUiUrl(currentUrl);
  const isEnglishMarket = isSkillMarket && language === 'en-US';
  const [address, setAddress] = useState(currentUrl);
  const [pageTitle, setPageTitle] = useState(() => browserTitleForUrl(currentUrl));
  const [addressError, setAddressError] = useState<string | null>(null);
  const [showEmbedTimeout, setShowEmbedTimeout] = useState(false);

  useEffect(() => {
    const localizedUrl = skillMarketUrlForLanguage(currentUrl, language, import.meta.env.DEV);
    if (localizedUrl && localizedUrl !== currentUrl) {
      const current = port.getRuntime();
      port.setRuntime(current ? replaceWorkspaceWebRuntimeUrl(current, localizedUrl) : createWorkspaceWebRuntime(localizedUrl));
      port.updateMetadata({ title: browserTitleForUrl(localizedUrl), icon: browserFaviconForUrl(localizedUrl) });
    }
  }, [currentUrl, language, port]);

  const onMarketReady = useCallback(() => {
    if (embedTimeoutRef.current !== null) window.clearTimeout(embedTimeoutRef.current);
    embedTimeoutRef.current = null;
    setShowEmbedTimeout(false);
    const current = port.getRuntime();
    if (current) port.setRuntime({ ...current, isLoading: false, error: null });
    const title = language === 'en-US' ? 'Skill Market' : '技能市场';
    setPageTitle(title);
    port.updateMetadata({ title, icon: browserFaviconForUrl(currentUrl) });
  }, [language, port, currentUrl]);
  useMarketBridge({ iframeRef, origin: skillMarketOrigin, currentUrl, reloadToken, language, onReady: onMarketReady });

  useEffect(() => {
    setAddress(currentUrl);
    setPageTitle(browserTitleForUrl(currentUrl));
  }, [currentUrl]);

  useEffect(() => {
    if (runtime) return;
    port.setRuntime({
      currentUrl: surface.url,
      history: [surface.url],
      historyIndex: 0,
      reloadToken: 0,
      isLoading: true,
      error: null,
    });
  }, [runtime, port, surface.url]);

  const reportRuntime = useCallback((patch: Partial<WorkspaceWebRuntime>) => {
    const current = port.getRuntime() ?? {
      currentUrl,
      history: [currentUrl],
      historyIndex: 0,
      reloadToken,
      isLoading: true,
      error: null,
    };
    port.setRuntime({ ...current, ...patch });
  }, [currentUrl, reloadToken, port]);

  useEffect(() => {
    setShowEmbedTimeout(false);
    embedTimeoutRef.current = window.setTimeout(() => {
      setShowEmbedTimeout(!isSkillMarket);
      if (isSkillMarket) marketLogger.warn('Market navigation timed out', { origin: skillMarketOrigin, reloadToken });
      reportRuntime({ isLoading: false, error: isSkillMarket
        ? (isEnglishMarket ? 'Market did not respond. Please retry.' : '技能市场未响应，请重试')
        : '网页可能禁止嵌入或加载超时' });
    }, isSkillMarket ? 15_000 : 6_000);
    return () => {
      if (embedTimeoutRef.current !== null) window.clearTimeout(embedTimeoutRef.current);
      embedTimeoutRef.current = null;
    };
  }, [currentUrl, reloadToken, reportRuntime, isSkillMarket, isEnglishMarket, skillMarketOrigin]);

  const handleNavigate = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = canonicalUrl(address);
    if (!normalized) {
      setAddressError('请输入 http:// 或 https:// 地址');
      return;
    }
    setAddressError(null);
    setAddress(normalized);
    port.navigate(normalized);
    port.updateMetadata({
      icon: browserFaviconForUrl(normalized),
      title: browserTitleForUrl(normalized),
    });
  }, [address, port]);

  // The page document is cross-origin, so its scrollbar is rebuilt from inside
  // the frame. Reconnect whenever the frame is recreated (navigate or reload).
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    return connectWebFrameScrollbar(iframe);
  }, [currentUrl, reloadToken]);

  const handleIframeLoad = useCallback(() => {
    const iframe = iframeRef.current;
    if (embedTimeoutRef.current !== null) window.clearTimeout(embedTimeoutRef.current);
    embedTimeoutRef.current = null;
    setShowEmbedTimeout(false);
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
    lastLoadedUrlRef.current = loadedUrl;

    const runtimeNow = port.getRuntime();
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
    const resolvedPageTitle = skillMarketOriginForUrl(loadedUrl, import.meta.env.DEV)
      ? browserTitleForUrl(loadedUrl)
      : pageTitle || browserTitleForUrl(loadedUrl);
    port.updateMetadata({
      title: resolvedPageTitle,
      icon: browserFaviconForUrl(loadedUrl),
    });
    setPageTitle(resolvedPageTitle);
  }, [currentUrl, reportRuntime, port]);

  const reportPresentation = context.reportPresentation;
  useEffect(() => {
    const error = runtime?.error;
    const isLoading = runtime?.isLoading ?? true;
    reportPresentation?.({
      title: pageTitle,
      icon: browserFaviconForUrl(currentUrl) ?? undefined,
      state: error && !isSkillMarket
        ? {
            status: 'error',
            message: { key: 'error.unexpected', fallbackText: error },
            actions: [{ id: 'reload', label: { key: 'error.retry' }, enabled: true, run: port.reload }],
          }
        : isLoading
          ? {
              status: 'loading',
              loadingMode: isSkillMarket || lastLoadedUrlRef.current === currentUrl ? 'background' : 'blocking',
              retainContent: true,
            }
          : { status: 'ready' },
    });
  }, [reportPresentation, currentUrl, isSkillMarket, pageTitle, port.reload, runtime?.error, runtime?.isLoading]);

  const handleOpenInSystemBrowser = useCallback(() => {
    void openUrl(currentUrl).catch(() => {
      reportRuntime({ error: '无法在系统浏览器中打开' });
    });
  }, [currentUrl, reportRuntime]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--background)]">
      {context.webAddressBarVisible !== false && !isLocalMarketUi && <form
        onSubmit={handleNavigate}
        className="flex shrink-0 items-center gap-1 border-b border-[var(--divider)] bg-[var(--bg-titlebar)] px-2 py-1.5"
      >
        <button
          type="button"
          aria-label="后退"
          title="后退"
          disabled={!runtime || runtime.historyIndex <= 0}
          onClick={() => port.back()}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] disabled:opacity-35"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="前进"
          title="前进"
          disabled={!runtime || runtime.historyIndex >= runtime.history.length - 1}
          onClick={() => port.forward()}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] disabled:opacity-35"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="重新加载"
          title="重新加载"
          onClick={() => port.reload()}
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
        <button type="button" aria-label="在系统浏览器中打开" title="在系统浏览器中打开"
          onClick={handleOpenInSystemBrowser}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)]">
          <ArrowUpRight className="h-3.5 w-3.5" />
        </button>
        {runtime?.isLoading && (
          <span
            role="status"
            aria-label="加载中"
            className="mx-1 h-4 w-4 shrink-0 flowix-spin rounded-full border-2 border-[color-mix(in_oklch,var(--muted-foreground)_26%,transparent)] border-t-[var(--brand)]"
          />
        )}
        {runtime?.error && <span className="shrink-0 text-[10px] text-[var(--destructive)]">{runtime.error}</span>}
      </form>}
      {context.webAddressBarVisible !== false && !isLocalMarketUi && addressError && <div className="shrink-0 px-3 py-1 text-[10px] text-[var(--destructive)]">{addressError}</div>}
      <div className="relative min-h-0 min-w-0 flex-1 bg-[var(--background)]">
        <iframe
          key={`${context.viewId}:${currentUrl}:${reloadToken}`}
          ref={iframeRef}
          title={isSkillMarket ? (isEnglishMarket ? 'Skill Market' : '技能市场') : surface.title ?? browserTitleForUrl(currentUrl)}
          src={currentUrl}
          onLoad={handleIframeLoad}
          onError={() => {
            reportRuntime({ isLoading: false, error: isEnglishMarket ? 'Unable to load this page' : '网页加载失败' });
            setShowEmbedTimeout(!isSkillMarket);
          }}
          className="h-full w-full border-0"
          referrerPolicy="no-referrer"
        />
        {isSkillMarket && runtime?.error && (
          <div role="status" className="absolute bottom-3 left-3 right-3 flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-xs shadow-sm">
            <span>{isEnglishMarket ? 'Loading is taking longer than expected.' : '网页加载较慢，可继续等待或重试。'}</span>
            <button type="button" onClick={() => port.reload()} className="shrink-0 underline">{isEnglishMarket ? 'Retry' : '重试'}</button>
            <button type="button" onClick={handleOpenInSystemBrowser} className="shrink-0 underline">{isEnglishMarket ? 'Open in browser' : '浏览器打开'}</button>
          </div>
        )}
        {showEmbedTimeout && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/90 px-6 backdrop-blur-sm">
            <div className="relative flex max-w-sm flex-col items-center gap-4 rounded-xl border border-[var(--border)] bg-[var(--background)] px-8 py-7 text-center shadow-lg">
              <button
                type="button"
                aria-label={isEnglishMarket ? 'Dismiss' : '关闭提示'}
                title={isEnglishMarket ? 'Dismiss' : '关闭提示'}
                onClick={() => setShowEmbedTimeout(false)}
                className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
              >
                <X className="h-4 w-4" />
              </button>
              <p className="text-sm text-[var(--muted-foreground)]">{isSkillMarket ? (isEnglishMarket ? 'The market did not respond. Retry or open it in your browser.' : '技能市场未响应，请重试或在系统浏览器中打开。') : '网页可能禁止嵌入或加载超时'}</p>
              <button type="button" onClick={() => port.reload()}
                className="inline-flex h-8 items-center rounded-lg border border-[var(--border)] px-3 text-xs text-[var(--foreground)]">
                {isEnglishMarket ? 'Retry' : '重试'}
              </button>
              <button
                type="button"
                onClick={handleOpenInSystemBrowser}
                className="inline-flex h-8 items-center rounded-lg border border-[var(--border)] px-3 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]"
              >
                {isEnglishMarket ? 'Open in your browser' : '在系统浏览器中打开'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
