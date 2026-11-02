'use client';

import { useSessionWebRuntimeStore } from '@features/workspace/public/session-web-api';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, Globe, RotateCw, X } from 'lucide-react';
import { canonicalUrl } from '@/lib/url';
import {
  createWorkspaceWebRuntime,
  moveWorkspaceWebHistory,
  navigateWorkspaceWebRuntime,
  reloadWorkspaceWebRuntime,
  replaceWorkspaceWebRuntimeUrl,
} from '@features/workspace/public/surface-runtime-api';
import type { WorkspaceWebRuntime } from '@features/workspace/public/surface-runtime-api';
import {
  getSelectedNotebookSnapshot,
  subscribeSelectedNotebook,
} from '@features/memo/public/selected-notebook-api';
import { agent } from '@platform/tauri/client';
import type { ProjectSkillSource } from '@platform/tauri/client/agent';
import {
  NOTEBOOK_SKILLS_CHANGED_EVENT,
  notifyNotebookSkillsChanged,
} from '@features/agent/public/notebook-skills-api';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { openUrl } from '@platform/tauri/opener';
import { SkillMarketLoadingSkeleton } from '@shared/ui/skill-market-loading-skeleton';
import { connectWebFrameScrollbar } from '@shared/ui/web-frame-scrollbar';
import type { WorkspaceSurfaceRendererData, WorkspaceSurfaceRenderContext, WorkspaceWebNavigationPort } from './workspace-surface-renderer-contract';

import { skillMarketLanguageForUrl, skillMarketOriginForUrl, skillMarketUrlForLanguage } from './skill-market-origin';
import { isSkillInstallationUnavailable } from './skill-market-install-error';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isValidSkillSource(value: unknown): value is ProjectSkillSource | null | undefined {
  return value === undefined || value === null || (isRecord(value)
    && typeof value.repository === 'string' && value.repository.length <= 200
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository)
    && typeof value.directory === 'string' && value.directory.length <= 512
    && (value.revision === undefined || value.revision === null
      || (typeof value.revision === 'string' && /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(value.revision))));
}

function isValidSkillArchive(value: unknown, id: string, origin: string): value is { url: string; source?: ProjectSkillSource | null } {
  return isRecord(value) && value.url === `${origin}/skills/archives/${id}.zip` && isValidSkillSource(value.source);
}

/** Work owns a view-local web session; Browser injects its tab runtime port. */
function useLocalWebNavigation(url: string, viewId: string) {
  const initial = useMemo(() => createWorkspaceWebRuntime(url), [url]);
  const runtime = useSessionWebRuntimeStore((state) => state.runtimes[viewId] ?? initial);
  const current = useRef(runtime);
  current.current = runtime;
  const port = useMemo<WorkspaceWebNavigationPort>(() => {
    const commit = (next: WorkspaceWebRuntime | null) => {
      if (!next) return;
      current.current = next;
      useSessionWebRuntimeStore.getState().setRuntime(viewId, next);
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
  }, [viewId]);
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
    const parsed = new URL(url);
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

export function WebRenderer({ surface, context }: {
  surface: Extract<WorkspaceSurfaceRendererData, { kind: 'web' }>;
  context: WorkspaceSurfaceRenderContext;
}) {
  const { language } = useI18n();
  const local = useLocalWebNavigation(surface.url, context.viewId);
  const port = context.webNavigation ?? local.port;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const embedTimeoutRef = useRef<number | null>(null);
  const runtime = context.webNavigation ? surface.runtime ?? port.getRuntime() : local.runtime;
  const lastLoadedUrlRef = useRef(runtime && !runtime.isLoading ? runtime.currentUrl : null);
  const currentUrl = runtime?.currentUrl ?? surface.url;
  const reloadToken = runtime?.reloadToken ?? 0;
  const skillMarketOrigin = skillMarketOriginForUrl(currentUrl, import.meta.env.DEV);
  const isSkillMarket = skillMarketOrigin !== null;
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

  useEffect(() => {
    const frame = iframeRef.current;
    if (!skillMarketOrigin || !frame) return;
    const sendTheme = () => {
      const target = frame.contentWindow;
      if (!target) return;
      try {
        // An iframe starts as same-origin about:blank while its cross-origin
        // navigation is pending. Don't post to that document with the market
        // origin as the target; it produces a postMessage origin error.
        if (target.location.origin !== skillMarketOrigin) return;
      } catch {
        // Reading location is blocked once the expected cross-origin page loads.
      }
      const root = document.documentElement;
      const style = getComputedStyle(root);
      const colors: Record<string, string> = {};
      for (const token of ['background', 'document-bg', 'foreground', 'document-foreground', 'card', 'muted', 'muted-foreground', 'hover-bg', 'border', 'primary', 'primary-foreground', 'ring']) {
        const value = style.getPropertyValue(`--${token}`).trim();
        if (value) colors[token] = value;
      }
      target.postMessage({ type: 'flowix:skill-market:language', language }, skillMarketOrigin);
      target.postMessage({
        type: 'flowix:skill-market:theme',
        colorScheme: style.colorScheme.includes('dark') ? 'dark' : 'light',
        colors,
      }, skillMarketOrigin);
    };
    const handleReady = (event: MessageEvent<unknown>) => {
      if (event.origin === skillMarketOrigin && event.source === frame.contentWindow
        && isRecord(event.data) && event.data.type === 'flowix:skill-market:ready') sendTheme();
    };
    const observer = new MutationObserver(sendTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
    frame.addEventListener('load', sendTheme);
    window.addEventListener('message', handleReady);
    sendTheme();
    return () => {
      observer.disconnect();
      frame.removeEventListener('load', sendTheme);
      window.removeEventListener('message', handleReady);
    };
  }, [currentUrl, skillMarketOrigin, reloadToken, language]);

  useEffect(() => {
    let active = true;
    const frame = iframeRef.current;
    if (!skillMarketOrigin || !frame?.contentWindow) return;

    let contextGeneration = 0;
    const sendMarketContext = async () => {
      const generation = ++contextGeneration;
      const selectedNotebook = getSelectedNotebookSnapshot();
      const notebookAvailable = Boolean(selectedNotebook?.path && !selectedNotebook.missing);
      let installedSkillIds: string[] = [];
      if (notebookAvailable && selectedNotebook) {
        try {
          const skills = await agent.readNotebookAgentSkills(selectedNotebook.path);
          installedSkillIds = skills.map((skill) => skill.id);
        } catch {
          // The install command performs its own registered-notebook check.
        }
      }
      const currentNotebook = getSelectedNotebookSnapshot();
      if (!active || !frame.contentWindow || generation !== contextGeneration
        || currentNotebook?.id !== selectedNotebook?.id || currentNotebook?.path !== selectedNotebook?.path
        || currentNotebook?.missing !== selectedNotebook?.missing) return;
      frame.contentWindow.postMessage({
        type: 'flowix:skill-market:context',
        language,
        notebookId: notebookAvailable ? selectedNotebook?.id ?? null : null,
        notebookAvailable,
        notebookName: selectedNotebook?.name ?? '',
        installedSkillIds,
      }, skillMarketOrigin);
    };

    const handleMarketMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== skillMarketOrigin || event.source !== frame.contentWindow || !isRecord(event.data)) return;
      if (event.data.type === 'flowix:skill-market:ready') {
        const title = language === 'en-US' ? 'Skill Market' : '技能市场';
        setPageTitle(title);
        port.updateMetadata({ title, icon: browserFaviconForUrl(currentUrl) });
        void sendMarketContext();
        return;
      }
      if (event.data.type !== 'flowix:skill-market:install') return;

      const requestId = typeof event.data.requestId === 'string' && event.data.requestId.length <= 128
        ? event.data.requestId
        : '';
      const notebookId = typeof event.data.notebookId === 'string' ? event.data.notebookId : '';
      const skill = isRecord(event.data.skill) ? event.data.skill : null;
      const id = typeof skill?.id === 'string' ? skill.id : '';
      const displayName = typeof skill?.displayName === 'string' ? skill.displayName.trim() : '';
      const archive = skill?.archive;
      const validSkill = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)
        && id.length <= 64
        && displayName.length > 0
        && displayName.length <= 200
        && isValidSkillArchive(archive, id, skillMarketOrigin);

      const respond = (result: Record<string, unknown>) => {
        if (!active || !frame.contentWindow || !requestId) return;
        frame.contentWindow.postMessage({
          type: 'flowix:skill-market:install-result',
          requestId,
          notebookId,
          ...result,
        }, skillMarketOrigin);
      };

      if (!notebookId) {
        respond({ success: false, code: 'no_notebook', message: '请先选择笔记本后再安装。' });
        return;
      }
      if (!requestId || !validSkill) {
        respond({ success: false, code: 'invalid_package', message: '技能内容格式无效。' });
        return;
      }

      void (async () => {
        const notebook = getSelectedNotebookSnapshot();
        if (!notebook?.path || notebook.missing || notebook.id !== notebookId) {
          respond({ success: false, code: 'notebook_changed', message: '笔记本已切换，请在当前笔记本重新安装。' });
          return;
        }
        try {
          if (!isValidSkillArchive(archive, id, skillMarketOrigin)) return;
          await agent.installCodexProjectSkillZip(notebook.path, id, archive);
          toast.success(language === 'en-US' ? 'Installed successfully' : '安装成功');
          notifyNotebookSkillsChanged({ notebookId: notebook.id, notebookPath: notebook.path });
          respond({ success: true, notebookName: notebook.name });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/already exists/i.test(message)) {
            respond({
              success: false,
              code: 'already_exists',
              notebookName: notebook.name,
              message: '同名技能文件已存在，本次未安装；如正在安装，请稍后重试。',
            });
          } else if (isSkillInstallationUnavailable(message)) {
            respond({ success: false, code: 'installation_unsupported', message: '版本过低，请升级后再试' });
          } else {
            console.error('Failed to install skill from the Flowix Skill Market:', error);
            respond({ success: false, message: message.trim() ? `技能安装失败：${message}` : '技能下载或安装失败，请检查网络及笔记本目录权限后重试。' });
          }
        }
      })();
    };

    const handleSkillsChanged = () => { void sendMarketContext(); };
    window.addEventListener(NOTEBOOK_SKILLS_CHANGED_EVENT, handleSkillsChanged);
    window.addEventListener('message', handleMarketMessage);
    const unsubscribeNotebook = subscribeSelectedNotebook(() => {
      void sendMarketContext();
    });
    void sendMarketContext();

    return () => {
      active = false;
      window.removeEventListener(NOTEBOOK_SKILLS_CHANGED_EVENT, handleSkillsChanged);
      window.removeEventListener('message', handleMarketMessage);
      unsubscribeNotebook();
    };
  }, [currentUrl, skillMarketOrigin, port, reloadToken, language]);

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
      setShowEmbedTimeout(true);
      reportRuntime({ isLoading: false, error: '网页可能禁止嵌入或加载超时' });
    }, 6_000);
    return () => {
      if (embedTimeoutRef.current !== null) window.clearTimeout(embedTimeoutRef.current);
      embedTimeoutRef.current = null;
    };
  }, [currentUrl, reloadToken, reportRuntime]);

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
  }, [currentUrl, pageTitle, reportRuntime, port]);

  useEffect(() => {
    const error = runtime?.error;
    const isLoading = runtime?.isLoading ?? true;
    context.reportPresentation?.({
      title: pageTitle,
      icon: browserFaviconForUrl(currentUrl) ?? undefined,
      state: error
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
  }, [context.reportPresentation, currentUrl, isSkillMarket, pageTitle, port.reload, runtime?.error, runtime?.isLoading]);

  const handleOpenInSystemBrowser = useCallback(() => {
    void openUrl(currentUrl).catch(() => {
      reportRuntime({ error: '无法在系统浏览器中打开' });
    });
  }, [currentUrl, reportRuntime]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--background)]">
      {context.webAddressBarVisible !== false && <form
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
      {context.webAddressBarVisible !== false && addressError && <div className="shrink-0 px-3 py-1 text-[10px] text-[var(--destructive)]">{addressError}</div>}
      <div className="relative min-h-0 min-w-0 flex-1 bg-[var(--background)]">
        <iframe
          key={`${context.viewId}:${currentUrl}:${reloadToken}`}
          ref={iframeRef}
          title={isSkillMarket ? (isEnglishMarket ? 'Skill Market' : '技能市场') : surface.title ?? browserTitleForUrl(currentUrl)}
          src={currentUrl}
          onLoad={handleIframeLoad}
          onError={() => {
            reportRuntime({ isLoading: false, error: isEnglishMarket ? 'Unable to load this page' : '网页加载失败' });
            setShowEmbedTimeout(true);
          }}
          className="h-full w-full border-0"
          referrerPolicy="no-referrer"
        />
        {isSkillMarket && (runtime?.isLoading ?? true) && !runtime?.error && !showEmbedTimeout && (
          <div className="absolute inset-0 z-10"><SkillMarketLoadingSkeleton /></div>
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
              <p className="text-sm text-[var(--muted-foreground)]">{isEnglishMarket ? 'This page may block embedding or may have timed out.' : '网页可能禁止嵌入或加载超时'}</p>
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
