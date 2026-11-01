'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';

import { useI18n } from '@/lib/i18n';
import { countTextUnits, extractBodyContent } from '@features/document/components/session/document-utils';
import { documentIdentityFromFile, documentIdentityKey } from '@features/document/store/document-identity';
import { useDocumentMetricsStore } from '@features/document/store/document-metrics-store';
import { subscribeExternalDocumentChanges } from '@features/document/store/external-document-watch';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';
import { useDocumentStore } from '@features/document/store/document-store';
import { workspaceSurfaceAppearance } from '@features/workspace/public/surface-api';
import { WorkspaceSurfaceStateView } from './workspace-surface-state-view';
import { useLocalHtmlPreview } from './use-local-html-preview';
import { DocumentContainer } from '@features/document/components/document-container';
import { connectWebFrameScrollbar } from '@shared/ui/web-frame-scrollbar';
import { useDocumentEditorMode, setDocumentEditorMode } from '@features/document/store/document-editor-view-store';
import type { SurfacePresentationUpdate, SurfaceState } from '@features/workspace/model/surface-contract';
import type { DocumentContentStatus } from '@features/document/components/session/types';
import { openHtmlLink } from '@features/workspace/public/html-link-api';
import { toast } from '@/lib/toast';
import type { LocalHtmlLink } from '@/lib/local-html-link';

type DocumentProps = ComponentProps<typeof DocumentContainer>;

type HtmlResourceProps = {
  filePath: string;
  scopePath: string | null;
  documentProps: DocumentProps;
  reportPresentation?: (update: SurfacePresentationUpdate) => void;
};

export function HtmlResourceView(props: HtmlResourceProps) {
  return <HtmlResourceSession key={JSON.stringify([props.filePath, props.scopePath])} {...props} />;
}

function HtmlResourceSession({ filePath, scopePath, documentProps, reportPresentation }: HtmlResourceProps) {
  const host = documentProps.workspaceHost ?? 'main-third';
  const identity = useMemo(() => documentIdentityFromFile(documentProps.fileIdentity), [documentProps.fileIdentity]);
  // Share the note's host-scoped mode preference; 'rich' renders the HTML preview.
  const mode = useDocumentEditorMode(host, identity);
  const [previewRetry, setPreviewRetry] = useState(0);
  const retryPreview = useCallback(() => setPreviewRetry((current) => current + 1), []);
  useEffect(() => subscribeExternalDocumentChanges(filePath, scopePath, retryPreview), [filePath, retryPreview, scopePath]);
  const showSource = useCallback(() => setDocumentEditorMode(host, identity, 'source'), [host, identity]);
  const onDocumentResolved = useCallback((available: boolean) => {
    if (documentProps.documentSessionMode !== 'isolated' && documentProps.transitionId != null) {
      useDocumentStore.getState().finishDocumentTransition(documentProps.transitionId, available ? 'ready' : 'unavailable');
    }
  }, [documentProps.documentSessionMode, documentProps.transitionId]);

  return (
    <div className="relative h-full min-h-0 min-w-0">
      <div className="absolute inset-0 min-h-0 min-w-0">
        {mode === 'source' ? (
          <HtmlSourceView documentProps={documentProps} scopePath={scopePath} reportPresentation={reportPresentation} />
        ) : (
          <HtmlPreview key={previewRetry} filePath={filePath} scopePath={scopePath}
            documentProps={documentProps} retry={retryPreview} showSource={showSource} onDocumentResolved={onDocumentResolved}
            reportPresentation={reportPresentation} />
        )}
      </div>
    </div>
  );
}

const HTML_APPEARANCE = workspaceSurfaceAppearance('file-html');

function HtmlPreview({ filePath, scopePath, documentProps, reportPresentation, retry, showSource, onDocumentResolved }: {
  filePath: string;
  scopePath: string | null;
  reportPresentation?: HtmlResourceProps['reportPresentation'];
  documentProps: DocumentProps;
  retry: () => void;
  showSource: () => void;
  onDocumentResolved: (available: boolean) => void;
}) {
  const { t } = useI18n();
  const onLink = useCallback((link: LocalHtmlLink) => {
    void openHtmlLink(link, filePath, scopePath, documentProps.notebookId ?? null).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error));
    });
  }, [documentProps.notebookId, filePath, scopePath]);
  const { iframeRef, src, content, phase, backgroundColor, onLoad } = useLocalHtmlPreview(
    filePath, scopePath, onLink, documentProps.notebookId ?? null,
  );
  const focused = useWorkspaceFocusStore((state) => state.focusedHostId === (documentProps.workspaceHost ?? 'main-third'));
  const documentKey = documentIdentityKey(documentIdentityFromFile(documentProps.fileIdentity));
  const charCount = useMemo(() => content === null ? 0 : countTextUnits(extractBodyContent(content)), [content]);
  const metadataCallback = useRef(documentProps.onMetainfoData);
  metadataCallback.current = documentProps.onMetainfoData;
  useEffect(() => {
    if (content === null) return;
    metadataCallback.current?.({
      memoContent: content, memoPath: null, charCount, tokenCount: Math.ceil(charCount / 4),
      createdAt: '', updatedAt: '', isFavorited: false, frontmatterMeta: {},
    });
  }, [charCount, content]);
  useEffect(() => {
    if (!focused) return;
    if (content !== null) useDocumentMetricsStore.getState().setCharCount(documentKey, charCount);
    return () => useDocumentMetricsStore.getState().clear(documentKey);
  }, [charCount, content, documentKey, focused]);
  const waiting = phase === 'reading' || phase === 'loading';
  const failed = phase === 'error' || phase === 'timeout';
  useEffect(() => {
    reportPresentation?.({ headerBackgroundColor: phase === 'ready' ? backgroundColor : null });
    return () => reportPresentation?.({ headerBackgroundColor: null });
  }, [backgroundColor, phase, reportPresentation]);
  useEffect(() => {
    reportPresentation?.({ state: waiting
      ? { status: 'loading', loadingMode: 'background', retainContent: true }
      : { status: 'ready' } });
  }, [reportPresentation, waiting]);
  useEffect(() => {
    if (src) onDocumentResolved(true);
    else if (failed) onDocumentResolved(false);
  }, [failed, onDocumentResolved, src]);
  useEffect(() => {
    const iframe = iframeRef.current;
    if (iframe) return connectWebFrameScrollbar(iframe);
  }, [iframeRef, src]);

  return <div className="absolute inset-0 min-h-0 min-w-0">
    {src && <iframe ref={iframeRef} title={filePath.split(/[\\/]/).pop() ?? filePath}
      src={src} onLoad={onLoad} sandbox="allow-scripts" referrerPolicy="no-referrer"
      className="absolute inset-0 h-full w-full border-0 bg-white" />}
    {waiting && <div role="status" className="pointer-events-none absolute left-3 top-3 z-10 rounded-lg bg-[var(--card)] px-3 py-2 text-xs text-[var(--muted-foreground)] shadow-sm">
      {t('htmlResource.loading')}
    </div>}
    {failed && <div className="absolute inset-0 z-10">
      <WorkspaceSurfaceStateView appearance={HTML_APPEARANCE} state={{
        status: 'error', message: { key: phase === 'timeout' ? 'htmlResource.timeout' : 'document.file.unavailable' },
        actions: [
          { id: 'retry', label: { key: 'error.retry' }, enabled: true, run: retry },
          { id: 'source', label: { key: 'htmlResource.source' }, enabled: true, run: showSource },
        ],
      }} />
    </div>}
  </div>;
}

function HtmlSourceView({ documentProps, scopePath, reportPresentation }: Pick<HtmlResourceProps, 'documentProps' | 'scopePath' | 'reportPresentation'>) {
  const [contentState, setContentState] = useState<DocumentContentStatus>({ status: 'loading', retainContent: false });
  const state: SurfaceState = contentState.status === 'ready' ? { status: 'ready' }
    : contentState.status === 'loading' ? { status: 'loading', loadingMode: 'blocking', retainContent: false }
    : { status: 'error', message: contentState.status === 'missing-note'
        ? { key: 'document.load.missingNoteTitle' }
        : { key: 'error.unexpected', fallbackText: contentState.message },
      actions: [{ id: 'retry', label: { key: 'error.retry' }, enabled: true, run: contentState.retry }] };
  useEffect(() => {
    reportPresentation?.({ state: contentState.status === 'loading'
      ? { status: 'loading', loadingMode: 'background', retainContent: true }
      : { status: 'ready' } });
  }, [contentState.status, reportPresentation]);
  return <WorkspaceSurfaceStateView state={state} appearance={HTML_APPEARANCE} keepContentMounted>
    <DocumentContainer {...documentProps} onContentStateChange={setContentState}
      isExternalDocument externalScopePath={scopePath} readOnly />
  </WorkspaceSurfaceStateView>;
}
