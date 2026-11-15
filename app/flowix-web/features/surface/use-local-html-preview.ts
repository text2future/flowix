import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { agent, dialogs, externalDocuments, files, notebookAssets, notes, type FileBrowserDirectoriesChangedEvent } from '@platform/tauri/client';
import type { AppLanguage } from '@/lib/i18n';
import type { LocalHtmlLink } from '@/lib/local-html-link';
import { subscribe } from '@platform/tauri/event-bus';
import { subscribeNotebookChanges } from '@platform/tauri/notebook-change-events';
import { canonicalPath } from '@/lib/path';
import { getWorkspaceMemoState } from '@features/memo/public/workspace-api';
import { uploadInChunks } from '@features/editor/public/attachment-upload-api';
import { openSkillMarketUi } from './public/open-skill-market-ui';
import { marketInstallFailure } from './market-install-handler';
import {
  HTML_EMBED_MAX_INFLIGHT,
  HTML_EMBED_KINDS,
  HTML_EMBED_PROTOCOL,
  HTML_EMBED_PROTOCOL_VERSION,
  checkEmbedProtocol,
  embedErrorPayload,
  type HtmlEmbedErrorCode,
} from '@/lib/html-embed-api';
import { HTML_DATA_KINDS, invalidateHtmlDataCache, resolveHtmlDataRequest, type HtmlDataKind, type HtmlProductTheme } from './html-data-bridge';

export const HTML_PREVIEW_TIMEOUT_MS = 10_000;
/**
 * Must match the page SDK's own queue limit (`local_html_preview.js`): the SDK
 * already refuses the 17th pending request, so a smaller cap here only turns
 * a page's parallel reads into `E_BUSY` for no reason. The number itself comes
 * from the contract so the catalog quotes the cap the host really enforces.
 */
const HTML_DATA_MAX_INFLIGHT = HTML_EMBED_MAX_INFLIGHT;
/**
 * Auto-save writes at ~0.5 Hz; coalescing keeps one dashboard repaint per burst
 * instead of one per keystroke-driven save.
 */
const HTML_DATA_CHANGED_DEBOUNCE_MS = 250;
export type HtmlPreviewPhase = 'reading' | 'loading' | 'ready' | 'timeout' | 'error';

/** One hook instance belongs to one keyed file/open attempt. Native asset URLs
 * preserve relative resources; the scoped read authorizes and validates the entry.
 */
export function useLocalHtmlPreview(
  filePath: string,
  scopePath: string | null,
  onLink?: (link: LocalHtmlLink) => void,
  notebookId?: string | null,
  language: AppLanguage = 'zh-CN',
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
    const respond = (
      requestId: string,
      result: { payload: unknown } | { code: HtmlEmbedErrorCode; message: string },
    ) => {
      iframeRef.current?.contentWindow?.postMessage({
        type: 'flowix:local-html-data-response',
        protocol: HTML_EMBED_PROTOCOL,
        version: HTML_EMBED_PROTOCOL_VERSION,
        requestId,
        // `error` stays for pages written before error codes existed.
        ...('payload' in result
          ? { ok: true, payload: result.payload }
          : { ok: false, code: result.code, error: result.message }),
      }, '*');
    };
    const requestId = typeof data.requestId === 'string' && data.requestId.length <= 64
      ? data.requestId
      : null;
    if (!requestId) return;
    if (dataInflight.current >= HTML_DATA_MAX_INFLIGHT) {
      return respond(requestId, { code: 'E_BUSY', message: 'too many inflight data requests' });
    }
    // Pages written before the protocol field existed omit both keys and keep
    // working; a page that declares a version must match this host exactly.
    const protocol = checkEmbedProtocol(data);
    if (!protocol.ok) return respond(requestId, { code: protocol.code, message: protocol.message });
    const kind = data.kind;
    if (typeof kind !== 'string' || !HTML_DATA_KINDS.includes(kind as HtmlDataKind)) {
      return respond(requestId, { code: 'E_UNSUPPORTED', message: 'unsupported kind' });
    }
    // Each resolver decides whether it needs a notebook: the palette answers
    // for a page opened outside one, notebook reads refuse with E_SCOPE there.
    const params = data.params !== null && typeof data.params === 'object' && !Array.isArray(data.params)
      ? data.params as Record<string, unknown>
      : null;
    if (kind === 'capabilities') {
      return respond(requestId, { payload: { protocol: HTML_EMBED_PROTOCOL, version: HTML_EMBED_PROTOCOL_VERSION, kinds: HTML_EMBED_KINDS, scope: notebookId && scopePath ? 'notebook' : 'external', authorization: 'open-page' } });
    }
    if (kind === 'dismiss-html-notice') {
      if (!notebookId || !scopePath) return respond(requestId, { code: 'E_SCOPE', message: 'notebook unavailable' });
      const notebook = getWorkspaceMemoState().notebooks.find((item) => item.id === notebookId);
      const root = notebook && canonicalPath(notebook.path).replace(/\/+$/, '');
      if (!root || canonicalPath(scopePath).replace(/\/+$/, '') !== root
        || !canonicalPath(filePath).startsWith(`${root}/`) || !/\.html?$/i.test(filePath)) {
        return respond(requestId, { code: 'E_SCOPE', message: 'page is outside the notebook' });
      }
      const id = params?.id;
      if (typeof id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(id)) {
        return respond(requestId, { code: 'E_INVALID', message: 'invalid notice id' });
      }
      dataInflight.current += 1;
      void (async () => {
        const marker = `<meta name="flowix-dismissed-notice" content="${id}">`;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const original = await externalDocuments.read(filePath, scopePath);
          if (original.includes(marker)) return { dismissed: true };
          if (!/<\/head\s*>/i.test(original)) throw new Error('HTML head unavailable');
          const updated = original.replace(/<\/head\s*>/i, `${marker}\n</head>`);
          const result = await externalDocuments.write({ filePath, scopePath, content: updated, expectedContent: original });
          if (result.status === 'saved') return { dismissed: true };
          if (result.status !== 'conflict') throw new Error(result.status === 'error' ? result.message : 'HTML file unavailable');
        }
        throw new Error('HTML changed while saving notice');
      })().then((payload) => respond(requestId, { payload }))
        .catch((error: unknown) => respond(requestId, embedErrorPayload(error)))
        .finally(() => { dataInflight.current -= 1; });
      return;
    }
    if (kind === 'select-note-images' || kind === 'upload-note-image') {
      if (!notebookId || !scopePath) return respond(requestId, { code: 'E_SCOPE', message: 'notebook unavailable' });
      const notebook = getWorkspaceMemoState().notebooks.find((item) => item.id === notebookId);
      const notebookRoot = notebook && canonicalPath(notebook.path).replace(/\/+$/, '');
      if (!notebookRoot || canonicalPath(scopePath).replace(/\/+$/, '') !== notebookRoot
        || !canonicalPath(filePath).startsWith(`${notebookRoot}/`)) {
        return respond(requestId, { code: 'E_SCOPE', message: 'page is outside the notebook' });
      }
      if (kind === 'upload-note-image') {
        const file = params?.file;
        const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
        if (!(file instanceof File) || !extensions[file.type] || file.size === 0 || file.size > 20 * 1024 * 1024) {
          return respond(requestId, { code: 'E_INVALID', message: 'INVALID_IMAGE_FILE' });
        }
        dataInflight.current += 1;
        const filename = `pasted-${crypto.randomUUID()}.${extensions[file.type]}`;
        void uploadInChunks(file, filename, { notebookId }).then((saved) => {
          const prefix = `${notebookRoot}/attachments/`;
          const path = canonicalPath(saved.path);
          if (!path.startsWith(prefix)) throw new Error('图片保存位置无效');
          respond(requestId, { payload: { relativePath: path.slice(notebookRoot.length + 1) } });
        }).catch((error: unknown) => respond(requestId, embedErrorPayload(error)))
          .finally(() => { dataInflight.current -= 1; });
        return;
      }
      dataInflight.current += 1;
      void (async () => {
        const selected = await dialogs.selectFiles({ accept: 'image/*', multiple: true }) ?? [];
        if (selected.length > 20) throw new Error('最多选择 20 张图片');
        const images: string[] = [];
        const prefix = `${canonicalPath(scopePath).replace(/\/$/, '')}/`;
        for (const path of selected) {
          if (!/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|tiff?|heic|heif)$/i.test(path)) throw new Error('请选择图片文件');
          const saved = await notebookAssets.saveFromPath(path, { notebookId });
          const absolute = saved?.path && canonicalPath(saved.path);
          if (!absolute || !absolute.startsWith(prefix + 'attachments/')) throw new Error('图片保存位置无效');
          images.push(absolute.slice(prefix.length));
        }
        return { images };
      })().then((payload) => respond(requestId, { payload }))
        .catch((error: unknown) => respond(requestId, embedErrorPayload(error)))
        .finally(() => { dataInflight.current -= 1; });
      return;
    }
    if (kind === 'create-note') {
      if (!notebookId || !scopePath) return respond(requestId, { code: 'E_SCOPE', message: 'notebook unavailable' });
      const folder = params?.parentRelativePath;
      const body = params?.content;
      const id = params?.clientRequestId;
      const images = params?.images ?? [];
      if (typeof folder !== 'string' || typeof body !== 'string' || !body.trim()
        || new TextEncoder().encode(body).length > 65536 || typeof id !== 'string'
        || !/^[A-Za-z0-9_-]{16,128}$/.test(id) || !Array.isArray(images)
        || images.length > 20 || images.some((path) => typeof path !== 'string' || path.length > 4096)) {
        return respond(requestId, { code: 'E_INVALID', message: 'invalid create-note parameters' });
      }
      dataInflight.current += 1;
      void notes.createFromHtml(notebookId, filePath, folder, body, id, images as string[])
        .then((relativePath) => respond(requestId, { payload: {
          relativePath,
          href: `flowix://open?notebookId=${encodeURIComponent(notebookId)}&f=${encodeURIComponent(relativePath)}`,
        } }))
        .catch((error: unknown) => respond(requestId, embedErrorPayload(error)))
        .finally(() => { dataInflight.current -= 1; });
      return;
    }
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
    void resolveHtmlDataRequest(kind as HtmlDataKind, { notebookId: notebookId ?? null, scopePath, productTheme }, params)
      .then((payload) => respond(requestId, { payload }))
      .catch((error: unknown) => respond(requestId, embedErrorPayload(error)))
      .finally(() => { dataInflight.current -= 1; });
  }, [filePath, notebookId, scopePath]);

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
      } else if (event.data.type === 'flowix:local-html-open-market-view') {
        const requestId = typeof event.data.requestId === 'string' && event.data.requestId.length <= 64
          ? event.data.requestId
          : '';
        const respond = (success: boolean, error?: string) => {
          iframeRef.current?.contentWindow?.postMessage({
            type: 'flowix:local-html-open-market-view-result',
            requestId,
            success,
            ...(error ? { error } : {}),
          }, '*');
        };
        if (!requestId) return;
        const isQuickStartGuide = filePath.replace(/\\/g, '/').split('/').pop() === '快速开始指南.html';
        if (!scopePath || !isQuickStartGuide || event.data.view !== 'templates') {
          respond(false, '无法打开技能市场知识库视图。');
          return;
        }
        void openSkillMarketUi('templates', 1, 'html-link').then((opened) => {
          if (opened) respond(true);
          else respond(false, '无法打开技能市场知识库视图，请重试。');
        });
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
        }).then((result) => respond(true, result)).catch((error: unknown) => {
          const failure = marketInstallFailure(error);
          const message = failure.code === 'already_exists' ? '模板已安装或与现有文件冲突，请检查后重试。'
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
  }, [fail, filePath, handleDataRequest, language, notifyProductThemeChanged, probe, ready, scopePath, src]);

  /**
   * A workbench that is left open is only useful if it stops being a snapshot.
   * Every change inside the notebook that opened this page drops the resolver
   * cache and tells the page to re-read; the page decides what that means
   * (auto-pulled kinds re-fetch by themselves, imperative pages use
   * `flowix.onInvalidate`).
   *
   * Note-level changes come through the notebook-change boundary, which already
   * dedupes command receipts and external-tool writes. Directory changes cover
   * what that boundary does not model (collection files, attachments).
   */
  useEffect(() => {
    if (!notebookId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const notify = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        invalidateHtmlDataCache();
        // No `kinds`: the host cannot know which of the page's cards depend on
        // the path that changed, and a stale card is worse than a redundant read.
        iframeRef.current?.contentWindow?.postMessage({ type: 'flowix:local-html-data-changed' }, '*');
      }, HTML_DATA_CHANGED_DEBOUNCE_MS);
    };
    const stopNotebook = subscribeNotebookChanges((change) => {
      if (change.notebookId === notebookId) notify();
    });
    const stopDirectories = subscribe<FileBrowserDirectoriesChangedEvent>('file-browser-directories-changed', (event) => {
      if (!scopePath || canonicalPath(event.rootPath) !== canonicalPath(scopePath)) return;
      notify();
    });
    const stopPreferences = subscribe<{ notebookPath: string; defaultCreateFolderChanged: boolean }>(
      'notebook-view-preferences-changed', (event) => {
        if (scopePath && event.defaultCreateFolderChanged && canonicalPath(event.notebookPath) === canonicalPath(scopePath)) notify();
      },
    );
    return () => {
      stopNotebook();
      stopDirectories();
      stopPreferences();
      if (timer) clearTimeout(timer);
    };
  }, [notebookId, scopePath]);

  return { iframeRef, src, content, phase, backgroundColor, onLoad: probe };
}
