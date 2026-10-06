'use client';

import { useEffect, useMemo, useState } from 'react';

import { useI18n } from '@/lib/i18n';
import { files, mediaResources } from '@platform/tauri/client';
import videoCardPlaceholder from '@/assets/placeholder-video-card.jpg';
import { getNotebookVideoPreview } from './video-preview-cache';

type MediaKind = 'image' | 'video';

function filenameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

function MediaUnavailable({ filePath }: { filePath: string }) {
  const { t } = useI18n();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-sm text-[var(--muted-foreground)]">
      <span>{t('document.file.unavailable')}</span>
      <span className="max-w-full truncate text-xs" title={filePath}>{filenameFromPath(filePath)}</span>
    </div>
  );
}

function ImageResourcePreview({ filePath, notebookPath }: { filePath: string; notebookPath: string }) {
  const { t } = useI18n();
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setSrc(null);
    void files.readImage(filePath, notebookPath).then((dataUrl) => {
      if (cancelled) return;
      setSrc(dataUrl);
      setFailed(!dataUrl);
      setLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setFailed(true);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath, notebookPath]);

  if (loading) {
    return <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">{t('document.file.loading')}</div>;
  }
  if (failed || !src) return <MediaUnavailable filePath={filePath} />;

  return (
    <div className="flex h-full w-full items-center justify-center overflow-auto bg-[var(--agent-bg,var(--document-bg))] p-6">
      <img
        src={src}
        alt={filenameFromPath(filePath)}
        className="block max-h-full max-w-full rounded-lg object-contain"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

function VideoResourcePreview({ filePath, notebookPath }: { filePath: string; notebookPath: string }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [poster, setPoster] = useState(videoCardPlaceholder);
  const src = useMemo(() => files.toAssetUrl(filePath), [filePath]);

  // The media command establishes the notebook-scoped security access before
  // the native asset URL is mounted. It does not create a document session.
  useEffect(() => {
    let cancelled = false;
    const requestId = crypto.randomUUID();
    setAuthorized(false);
    setFailed(false);
    setPoster(videoCardPlaceholder);
    void mediaResources.get(filePath, notebookPath).then(() => {
      if (cancelled) return;
      setAuthorized(true);
      void getNotebookVideoPreview(
        filePath,
        notebookPath,
        requestId,
      ).then((preview) => {
        if (!cancelled && preview) setPoster(preview);
      });
    }).catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
      void mediaResources.cancelThumbnail(requestId).catch(() => undefined);
    };
  }, [filePath, notebookPath, src]);

  if (failed) return <MediaUnavailable filePath={filePath} />;
  if (!authorized) {
    return <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">{t('document.file.loading')}</div>;
  }

  return (
    <div className="flex h-full w-full items-center justify-center overflow-auto bg-[var(--agent-bg,var(--document-bg))] p-6">
      <video
        src={src}
        poster={poster}
        controls
        preload="metadata"
        playsInline
        className="media-resource-video block h-auto max-h-full max-w-full rounded-lg object-contain"
        aria-label={filenameFromPath(filePath)}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

export function MediaResourceView({
  filePath,
  notebookPath,
  resourceKind,
}: {
  filePath: string;
  notebookPath: string | null;
  resourceKind: MediaKind;
}) {
  const preview = notebookPath ? (
    resourceKind === 'image'
      ? <ImageResourcePreview filePath={filePath} notebookPath={notebookPath} />
      : <VideoResourcePreview filePath={filePath} notebookPath={notebookPath} />
  ) : (
    <MediaUnavailable filePath={filePath} />
  );

  return (
    <div className="flex h-full min-w-0 flex-col bg-[var(--agent-bg,var(--document-bg))]">
      <div className="relative flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">{preview}</div>
      </div>
    </div>
  );
}
