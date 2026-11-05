import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { agent, externalDocuments, files } from '@platform/tauri/client';
import type { LocalHtmlLink } from '@/lib/local-html-link';
import { marketInstallFailure } from './market-install-handler';
import { HTML_DATA_KINDS, resolveHtmlDataRequest, type HtmlDataKind, type HtmlProductTheme } from './html-data-bridge';

export const HTML_PREVIEW_TIMEOUT_MS = 10_000;
const HTML_DATA_MAX_INFLIGHT = 8;
export type HtmlPreviewPhase = 'reading' | 'loading' | 'ready' | 'timeout' | 'error';

/** One hook instance belongs to one keyed file/open attempt. Native asset URLs
 * preserve relative resources; the scoped read authorizes and validates the entry.
 */
export function useLocalHtmlPreview(
  filePath: string,
  scopePath: string | null,
  onLink?: (link: LocalHtmlLink) => void,
  notebookId?: string | null,
) {
  const linkCallback = useRef(onLink);
  linkCallback.current = onLink;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [content, setContent] = useState<string | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [phase, setPhase] = useState<HtmlPreviewPhase>('reading');
  const [backgroundColor, setBackgroundColor] = useState<string | null>(null);
  const active = useRef(false);
  const terminal = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearTimer = useCallback(() => clearTimeout(timer.current), []);
  const ready = useCallback(() => {
    if (!active.current || terminal.current) return;
    clearTimer();
    setPhase('ready');
  }, [clearTimer]);
  const fail = useCallback(() => {
    if (!active.current) return;
    terminal.current = true;
    clearTimer();
    setPhase('error');
  }, [clearTimer]);

  useEffect(() => {
    let cancelled = false;
    active.current = true;
    terminal.current = false;
    timer.current = setTimeout(() => {
      // A late read cannot mount a frame after its authorization attempt expired.
      terminal.current = true;
      setPhase('timeout');
    }, HTML_PREVIEW_TIMEOUT_MS);
    void externalDocuments.read(filePath, scopePath).then((text) => {
      if (cancelled || terminal.current) return;
      clearTimer();
      setContent(text);
      setSrc(files.toAssetUrl(filePath));
      setPhase('loading');
      timer.current = setTimeout(() => setPhase('timeout'), HTML_PREVIEW_TIMEOUT_MS);
    }).catch(() => { if (!cancelled && !terminal.current) fail(); });
    return () => {
      cancelled = true;
      active.current = false;
      clearTimer();
    };
  }, [clearTimer, fail, filePath, scopePath]);

  const probe = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'flowix:local-html-document-probe' }, '*');
  }, []);

  const notifyProductThemeChanged = useCallback(() => {
    const target = iframeRef.current?.contentWindow;
    if (!target) return;
    target.postMessage({
      type: 'flowix:local-html-data-changed',
      kinds: ['product-theme'],
    }, '*');
  }, []);

  const dataInflight = useRef(0);
  const handleDataRequest = useCallback((data: Record<string, unknown>) => {
    const respond = (requestId: string, ok: boolean, payload?: unknown, error?: string) => {
      iframeRef.current?.contentWindow?.postMessage({
        type: 'flowix:local-html-data-response', requestId, ok,
        ...(ok ? { payload } : { error }),
      }, '*');
    };
    const requestId = typeof data.requestId === 'string' && data.requestId.length <= 64
      ? data.requestId
      : null;
    if (!requestId) return;
    if (dataInflight.current >= HTML_DATA_MAX_INFLIGHT) return respond(requestId, false, undefined, 'busy');
    const kind = data.kind;
    if (typeof kind !== 'string' || !HTML_DATA_KINDS.includes(kind as HtmlDataKind)) {
      return respond(requestId, false, undefined, 'unsupported-kind');
    }
    if (!notebookId) return respond(requestId, false, undefined, 'notebook-unavailable');
    const params = data.params !== null && typeof data.params === 'object' && !Array.isArray(data.params)
      ? data.params as Record<string, unknown>
      : null;
    const root = document.documentElement;
    const styles = window.getComputedStyle(root);
    const productTheme: HtmlProductTheme = {
      id: root.dataset.theme ?? null,
      tokens: {
        background: styles.getPropertyValue('--background').trim(),
        foreground: styles.getPropertyValue('--foreground').trim(),
        secondaryForeground: styles.getPropertyValue('--secondary-foreground').trim(),
        mutedForeground: styles.getPropertyValue('--muted-foreground').trim(),
        border: styles.getPropertyValue('--border').trim(),
        brand: styles.getPropertyValue('--brand').trim(),
        card: styles.getPropertyValue('--card').trim(),
      },
    };
    dataInflight.current += 1;
    void resolveHtmlDataRequest(kind as HtmlDataKind, { notebookId, scopePath, productTheme }, params)
      .then((payload) => respond(requestId, true, payload))
      .catch((error: unknown) => respond(requestId, false, undefined, error instanceof Error ? error.message : String(error)))
      .finally(() => { dataInflight.current -= 1; });
  }, [notebookId, scopePath]);

  useLayoutEffect(() => {
    if (!src) return;
    const onMessage = (event: MessageEvent) => {
      // Opaque origins cannot identify a frame. Bind messages to this attempt's
      // window and entry (hash changes are same-document navigation). Payloads
      // never grant file access; native document reads still enforce scope.
      if (!active.current || terminal.current || event.source !== iframeRef.current?.contentWindow
        || typeof event.data?.url !== 'string') return;
      try {
        const entry = new URL(event.data.url);
        entry.hash = '';
        if (entry.href !== src) return;
      } catch { return; }
      if (event.data.type === 'flowix:local-html-background') {
        // The native bridge sends opaque RGB only, never arbitrary CSS from a page.
        const color = typeof event.data.color === 'string' && event.data.color.length <= 32
          ? /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(event.data.color)
          : null;
        if (color && color.slice(1).every((value) => Number(value) <= 255)) {
          setBackgroundColor(`rgb(${color[1]}, ${color[2]}, ${color[3]})`);
        }
      } else if (event.data.type === 'flowix:local-html-document-ready') ready();
      else if (event.data.type === 'flowix:local-html-link'
        && typeof event.data.href === 'string'
        && event.data.href.length <= 8192
        && (event.data.baseHref === null || (typeof event.data.baseHref === 'string' && event.data.baseHref.length <= 8192))) {
        linkCallback.current?.({ href: event.data.href, baseHref: event.data.baseHref });
      } else if (event.data.type === 'flowix:local-html-data-request') {
        handleDataRequest(event.data);
      } else if (event.data.type === 'flowix:local-html-template-install') {
        const requestId = typeof event.data.requestId === 'string' && event.data.requestId.length <= 64
          ? event.data.requestId
          : '';
        const templateId = typeof event.data.templateId === 'string' ? event.data.templateId : '';
        const respond = (success: boolean, result?: { path: string; templateId: string }, error?: string) => {
          iframeRef.current?.contentWindow?.postMessage({
            type: 'flowix:local-html-template-install-result',
            requestId,
            success,
            ...(success ? { result } : { error }),
          }, '*');
        };
        if (!requestId) return;
        const isQuickStartGuide = filePath.replace(/\\/g, '/').split('/').pop() === '快速开始指南.html';
        if (!scopePath || !isQuickStartGuide || templateId !== 'self-media-management') {
          respond(false, undefined, !scopePath ? 'Notebook unavailable' : 'Template is not supported');
          return;
        }
        const archiveOrigin = import.meta.env.DEV ? 'http://localhost:8088' : 'https://skills.flowix.cc';
        void agent.installNotebookTemplateZip(scopePath, templateId, {
          url: `${archiveOrigin}/templates/archives/${templateId}.zip`,
          // This guide action explicitly installs its featured example. Market installs use manifest metadata.
          targetDirectory: '自媒体管理',
        }).then((result) => respond(true, result)).catch((error: unknown) => {
          const failure = marketInstallFailure(error);
          const message = failure.code === 'already_exists' ? '同名模板目录已存在，本次没有覆盖任何内容。'
            : failure.code === 'permission_denied' ? '笔记本目录无写入权限。'
              : failure.code === 'installation_unsupported' ? '请升级 Flowix 后重试。' : '模板安装失败，请检查网络后重试。';
          respond(false, undefined, message);
        });
      }
    };
    const iframe = iframeRef.current;
    iframe?.addEventListener('error', fail);
    window.addEventListener('message', onMessage);
    const themeObserver = new MutationObserver(notifyProductThemeChanged);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style', 'class'],
    });
    probe();
    return () => {
      iframe?.removeEventListener('error', fail);
      window.removeEventListener('message', onMessage);
      themeObserver.disconnect();
    };
  }, [fail, filePath, handleDataRequest, notifyProductThemeChanged, probe, ready, scopePath, src]);

  return { iframeRef, src, content, phase, backgroundColor, onLoad: probe };
}
