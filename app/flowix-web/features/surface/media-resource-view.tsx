'use client';

import { useEffect, useMemo, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';

import { useI18n } from '@/lib/i18n';
import { files, mediaResources } from '@platform/tauri/client';
import { MediaPropertiesPanel } from './media-properties-panel';

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
  const src = useMemo(() => files.toAssetUrl(filePath), [filePath]);

  // The media command establishes the notebook-scoped security access before
  // the native asset URL is mounted. It does not create a document session.
  useEffect(() => {
    let cancelled = false;
    setAuthorized(false);
    setFailed(false);
    void mediaResources.get(filePath, notebookPath).catch(() => {
      if (!cancelled) setFailed(true);
    }).then((response) => {
      if (!cancelled && response) setAuthorized(true);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath, notebookPath]);

  if (failed) return <MediaUnavailable filePath={filePath} />;
  if (!authorized) {
    return <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">{t('document.file.loading')}</div>;
  }

  return (
    <div className="flex h-full w-full items-center justify-center overflow-auto bg-[var(--agent-bg,var(--document-bg))] p-6">
      <video
        src={src}
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
  propertiesVisibleByDefault = true,
}: {
  filePath: string;
  notebookPath: string | null;
  resourceKind: MediaKind;
  propertiesVisibleByDefault?: boolean;
}) {
  const { t } = useI18n();
  const [propertiesVisible, setPropertiesVisible] = useState(propertiesVisibleByDefault);
  useEffect(() => {
    setPropertiesVisible(propertiesVisibleByDefault);
  }, [filePath, notebookPath, propertiesVisibleByDefault]);

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
        {notebookPath && propertiesVisible && (
          <MediaPropertiesPanel
            filePath={filePath}
            notebookPath={notebookPath}
            onClose={() => setPropertiesVisible(false)}
          />
        )}
        {notebookPath && !propertiesVisible && (
          <button
            type="button"
            onClick={() => setPropertiesVisible(true)}
            title={t('media.properties.open')}
            aria-label={t('media.properties.open')}
            className="absolute right-3 top-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border-popup)] bg-[var(--card)] text-xs text-[var(--foreground)] hover:bg-[var(--muted)]"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
