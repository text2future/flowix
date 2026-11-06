import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { files, skillMarketUi } from '@platform/tauri/client';
import { useI18n } from '@/lib/i18n';
import { createLogger } from '@/lib/logger';
import { marketUiAssetUrl, type MarketUiView } from '@shared/lib/market-ui-url';
import { connectWebFrameScrollbar } from '@shared/ui/web-frame-scrollbar';
import { skillMarketOriginForUrl } from './skill-market-origin';
import { useMarketBridge } from './use-market-bridge';
import type { WorkspaceSurfaceRenderContext } from './workspace-surface-renderer-contract';

const logger = createLogger('market-ui');

/** The view opens before native resource preparation; its loading belongs to the content area. */
export function MarketUiRenderer({ view, context }: { view: MarketUiView; context: WorkspaceSurfaceRenderContext }) {
  const { t, language } = useI18n();
  const [attempt, setAttempt] = useState(0);
  const requestKey = `${language}:${view}:${attempt}`;
  const [page, setPage] = useState<{ key: string; url: string | null; ready: boolean; loaded: boolean; failed: boolean }>({ key: requestKey, url: null, ready: false, loaded: false, failed: false });
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const current = page.key === requestKey;
  const url = current ? page.url : null;
  const failed = current && page.failed;
  const loading = !current || (!page.ready && !failed);
  const title = t(view === 'skills' ? 'agent.empty.skillMarket' : 'memo.fileTree.knowledgeBase');
  const retry = useCallback(() => setAttempt(value => value + 1), []);

  useEffect(() => {
    let active = true;
    setPage({ key: requestKey, url: null, ready: false, loaded: false, failed: false });
    void skillMarketUi.ensure(language).then(result => {
      if (!active) return;
      const entry = marketUiAssetUrl(files.toAssetUrl(result.entryPath));
      if (view === 'templates') entry.searchParams.set('view', 'templates');
      setPage({ key: requestKey, url: entry.href, ready: result.cached, loaded: false, failed: false });
    }).catch(error => {
      if (!active) return;
      logger.warn('Failed to prepare market UI', { error: String(error) });
      setPage({ key: requestKey, url: null, ready: false, loaded: false, failed: true });
    });
    return () => { active = false; };
  }, [requestKey, language, view]);

  const markReady = useCallback(() => {
    setPage(value => value.key === requestKey ? { ...value, ready: true, failed: false } : value);
  }, [requestKey]);
  useMarketBridge({ iframeRef, origin: url ? skillMarketOriginForUrl(url) : null, currentUrl: url ?? '', reloadToken: attempt, language, onReady: markReady });

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !url) return;
    return connectWebFrameScrollbar(iframe);
  }, [url, attempt]);

  useEffect(() => {
    if (!url || page.loaded) return;
    const timeout = window.setTimeout(() => setPage(value => value.key === requestKey ? { ...value, failed: true } : value), 15_000);
    return () => window.clearTimeout(timeout);
  }, [url, page.loaded, requestKey]);

  const reportPresentation = context.reportPresentation;
  useEffect(() => {
    reportPresentation?.({ title, state: loading
      ? { status: 'loading', loadingMode: 'background', retainContent: true }
      : { status: 'ready' } });
  }, [title, loading, reportPresentation]);

  return (
    <div className="relative h-full min-h-0 w-full bg-[var(--background)]" aria-busy={loading}>
      {url && <iframe
        key={`${requestKey}:${url}`}
        ref={iframeRef}
        src={url}
        title={title}
        className="h-full w-full border-0"
        onLoad={() => {
          setPage(value => value.key === requestKey ? { ...value, ready: true, loaded: true, failed: false } : value);
          markReady();
        }}
        onError={() => setPage(value => value.key === requestKey ? { ...value, failed: true } : value)}
        referrerPolicy="no-referrer"
      />}
      {loading && <div className="absolute inset-0 flex items-center justify-center bg-[var(--background)]" role="status" aria-label={t('memo.fileTree.loading')}>
        <LoaderCircle className="h-6 w-6 flowix-spin text-[var(--muted-foreground)]" aria-hidden="true" />
      </div>}
      {failed && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--background)] text-sm text-[var(--muted-foreground)]">
        <p>{language === 'en-US' ? 'Unable to load this page. Please retry.' : '页面加载失败，请重试。'}</p>
        <button type="button" onClick={retry} className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[var(--foreground)]">{language === 'en-US' ? 'Retry' : '重试'}</button>
      </div>}
    </div>
  );
}
