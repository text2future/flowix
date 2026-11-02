'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useSessionViewChannel, attachSessionViewCapture, useSessionScrollRecovery } from '@features/workspace/public/session-view-state-api';

import { files, mediaResources } from '@platform/tauri/client';
import type { SurfacePresentationUpdate, SurfaceState } from '@features/workspace/model/surface-contract';
import { workspaceSurfaceAppearance } from '@features/workspace/public/surface-api';
import videoCardPlaceholder from '@/assets/placeholder-video-card.jpg';
import { getNotebookVideoPreview } from './video-preview-cache';
import { WorkspaceSurfaceStateView } from './workspace-surface-state-view';

type MediaKind = 'image' | 'video';
type ReportPresentation = (update: SurfacePresentationUpdate) => void;
type PreviewProps = {
  filePath: string;
  notebookPath: string;
  retry: () => void;
  reportPresentation?: ReportPresentation;
};
const LOADING: SurfaceState = {
  status: 'loading', loadingMode: 'blocking', retainContent: false,
};

function filenameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

function mediaError(filePath: string, retry: () => void, error?: unknown): SurfaceState {
  return {
    status: 'error',
    message: { key: 'document.file.unavailable', fallbackText: error instanceof Error ? error.message : filenameFromPath(filePath) },
    actions: [{ id: 'retry', label: { key: 'error.retry' }, enabled: true, run: retry }],
  };
}

/** Standalone previews use the same state UI; workspace hosts own its presentation. */
function MediaPreviewState({ filePath, state, reportPresentation, children }: {
  filePath: string; state: SurfaceState; reportPresentation?: ReportPresentation; children?: ReactNode;
}) {
  useEffect(() => {
    reportPresentation?.({ title: filenameFromPath(filePath), state });
  }, [filePath, reportPresentation, state]);
  return reportPresentation ? children : <WorkspaceSurfaceStateView
    state={state} appearance={workspaceSurfaceAppearance('media')} keepContentMounted>
    {children}
  </WorkspaceSurfaceStateView>;
}

function ImageResourcePreview({ filePath, notebookPath, retry, reportPresentation }: PreviewProps) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  useSessionScrollRecovery(scroller, `image:${filePath}`);
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<SurfaceState>(LOADING);
  useEffect(() => {
    let cancelled = false;
    void files.readImage(filePath, notebookPath).then((dataUrl) => {
      if (cancelled) return;
      if (dataUrl) setSrc(dataUrl);
      else setState(mediaError(filePath, retry));
    }).catch((error: unknown) => {
      if (!cancelled) setState(mediaError(filePath, retry, error));
    });
    return () => { cancelled = true; };
  }, [filePath, notebookPath, retry]);

  return <MediaPreviewState filePath={filePath} state={state} reportPresentation={reportPresentation}>
    {src && <div ref={setScroller} className="flex h-full w-full items-center justify-center overflow-auto p-6">
      <img src={src} alt={filenameFromPath(filePath)} className="block max-h-full max-w-full rounded-lg object-contain"
        onLoad={() => setState({ status: 'ready' })} onError={() => setState(mediaError(filePath, retry))} />
    </div>}
  </MediaPreviewState>;
}

function VideoResourcePreview({ filePath, notebookPath, retry, reportPresentation }: PreviewProps) {
  const [state, setState] = useState<SurfaceState>(LOADING);
  const [authorized, setAuthorized] = useState(false);
  const recovery = useSessionViewChannel(`video:${filePath}`);
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let ready = false;
    const restore = () => {
      const saved = recovery?.read();
      if (saved?.kind === 'media') {
        video.currentTime = Number.isFinite(video.duration) ? Math.min(saved.currentTime, video.duration) : saved.currentTime;
        video.volume = saved.volume;
        video.muted = saved.muted;
        video.playbackRate = saved.playbackRate;
      }
      ready = true;
    };
    const capture = attachSessionViewCapture(recovery, () => ready ? ({ kind: 'media', currentTime: video.currentTime,
      volume: video.volume, muted: video.muted, playbackRate: video.playbackRate }) : null);
    const schedule = () => { if (ready) capture.schedule(); };
    video.addEventListener('loadedmetadata', restore);
    const events = ['timeupdate', 'seeked', 'volumechange', 'ratechange', 'pause'];
    events.forEach((event) => video.addEventListener(event, schedule));
    if (video.readyState >= 1) restore();
    return () => {
      video.removeEventListener('loadedmetadata', restore);
      events.forEach((event) => video.removeEventListener(event, schedule));
      capture.dispose();
    };
  }, [authorized, recovery]);
  const [poster, setPoster] = useState(videoCardPlaceholder);
  const src = useMemo(() => files.toAssetUrl(filePath), [filePath]);

  // Establish notebook access before mounting the native asset URL.
  useEffect(() => {
    let cancelled = false;
    const requestId = crypto.randomUUID();
    void mediaResources.get(filePath, notebookPath).then(() => {
      if (cancelled) return;
      setAuthorized(true);
      void getNotebookVideoPreview(filePath, notebookPath, requestId).then((preview) => {
        if (!cancelled && preview) setPoster(preview);
      }).catch(() => undefined);
    }).catch((error: unknown) => {
      if (!cancelled) setState(mediaError(filePath, retry, error));
    });
    return () => {
      cancelled = true;
      void mediaResources.cancelThumbnail(requestId).catch(() => undefined);
    };
  }, [filePath, notebookPath, retry]);

  return <MediaPreviewState filePath={filePath} state={state} reportPresentation={reportPresentation}>
    {authorized && <div className="flex h-full w-full items-center justify-center overflow-auto p-6">
      <video ref={videoRef} src={src} poster={poster} controls preload="metadata" playsInline
        className="media-resource-video block h-auto max-h-full max-w-full rounded-lg object-contain"
        aria-label={filenameFromPath(filePath)} onLoadedMetadata={() => setState({ status: 'ready' })}
        onError={() => setState(mediaError(filePath, retry))} />
    </div>}
  </MediaPreviewState>;
}

export function MediaResourceView({ filePath, notebookPath, resourceKind, reportPresentation }: {
  filePath: string; notebookPath: string | null; resourceKind: MediaKind; reportPresentation?: ReportPresentation;
}) {
  const [retryCount, setRetryCount] = useState(0);
  const retry = useCallback(() => setRetryCount((count) => count + 1), []);
  const unavailableState = useMemo<SurfaceState>(() => ({
    status: 'unavailable', reason: 'unsupported',
    message: { key: 'document.file.unavailable', fallbackText: filenameFromPath(filePath) },
  }), [filePath]);
  const props = { filePath, notebookPath: notebookPath ?? '', retry, reportPresentation };
  const key = `${filePath}:${notebookPath}:${resourceKind}:${retryCount}`;
  return <div className="flex h-full min-w-0 flex-col bg-[var(--agent-bg,var(--document-bg))]">
    <div className="relative flex min-h-0 flex-1"><div className="min-w-0 flex-1">
      {!notebookPath ? <MediaPreviewState filePath={filePath} state={unavailableState} reportPresentation={reportPresentation} />
        : resourceKind === 'image' ? <ImageResourcePreview key={key} {...props} /> : <VideoResourcePreview key={key} {...props} />}
    </div></div>
  </div>;
}
