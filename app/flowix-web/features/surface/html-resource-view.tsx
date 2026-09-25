'use client';

import { useMemo, useState, type ComponentProps } from 'react';
import { Code2, Eye } from 'lucide-react';

import { useI18n } from '@/lib/i18n';
import { files } from '@platform/tauri/client';
import { DocumentContainer } from '@features/document/components/document-container';

type DocumentProps = ComponentProps<typeof DocumentContainer>;

export function HtmlResourceView({
  filePath,
  scopePath,
  documentProps,
}: {
  filePath: string;
  scopePath: string | null;
  documentProps: DocumentProps;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const src = useMemo(() => files.toAssetUrl(filePath), [filePath]);

  return (
    <div className="relative h-full min-h-0 min-w-0">
      <div className="absolute right-3 top-3 z-20 inline-flex items-center gap-1 rounded-xl border border-[var(--border-popup)] bg-[var(--card)] p-1 shadow-lg">
        <button
          type="button"
          aria-pressed={mode === 'preview'}
          aria-label={t('htmlResource.preview')}
          title={t('htmlResource.preview')}
          onClick={() => setMode('preview')}
          className={`inline-flex h-7 w-7 items-center justify-center rounded-lg ${mode === 'preview' ? 'bg-[var(--muted)] text-[var(--foreground)]' : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)]'}`}
        >
          <Eye className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-pressed={mode === 'source'}
          aria-label={t('htmlResource.source')}
          title={t('htmlResource.source')}
          onClick={() => setMode('source')}
          className={`inline-flex h-7 w-7 items-center justify-center rounded-lg ${mode === 'source' ? 'bg-[var(--muted)] text-[var(--foreground)]' : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)]'}`}
        >
          <Code2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="absolute inset-0 min-h-0 min-w-0">
        <div
          aria-hidden={mode !== 'source'}
          inert={mode !== 'source'}
          className={`absolute inset-0 ${mode === 'source' ? 'z-10' : 'invisible pointer-events-none'}`}
        >
          <DocumentContainer
            {...documentProps}
            filePath={filePath}
            isExternalDocument
            externalScopePath={scopePath}
            readOnly
          />
        </div>
        {mode === 'preview' && (
          <iframe
            key={src}
            title={filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath}
            src={src}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className="absolute inset-0 h-full w-full border-0 bg-white"
          />
        )}
      </div>
    </div>
  );
}
