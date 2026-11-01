import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { externalDocuments, files } from '@platform/tauri/client';
import type { LocalHtmlLink } from '@/lib/local-html-link';
import { HTML_DATA_KINDS, resolveHtmlDataRequest, type HtmlDataKind } from './html-data-bridge';

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
    dataInflight.current += 1;
    void resolveHtmlDataRequest(kind as HtmlDataKind, { notebookId, scopePath }, params)
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
      }
    };
    const iframe = iframeRef.current;
    iframe?.addEventListener('error', fail);
    window.addEventListener('message', onMessage);
    probe();
    return () => {
      iframe?.removeEventListener('error', fail);
      window.removeEventListener('message', onMessage);
    };
  }, [fail, handleDataRequest, probe, ready, src]);

  return { iframeRef, src, content, phase, backgroundColor, onLoad: probe };
}
