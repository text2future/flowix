'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowDownToLine, FolderOpen, LoaderCircle } from 'lucide-react';
import { files, product } from '@platform/tauri/client';
import { Button } from '@shared/ui/button';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import './docx-preview.css';

type PreviewState = 'loading' | 'ready' | 'failed';
type ConversionState = 'idle' | 'converting' | 'success' | 'failed';
type DocxMarkdownImage = { marker: string; contentType: string; contentBase64: string };

function decodeBase64(value: string): Uint8Array {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function userFacingError(
  error: unknown,
  fallback: string,
  t: ReturnType<typeof useI18n>['t'],
): string {
  const message = errorText(error);
  if (message.includes('DOCX_TOO_LARGE')) return t('docx.tooLarge');
  if (message.includes('DOCX_IMAGE_TOO_LARGE')) return t('docx.imagesTooLarge');
  if (message.includes('DOCX_IMAGE_UNSUPPORTED')) return t('docx.imageUnsupported');
  if (message.includes('DOCX_FORBIDDEN')) return t('docx.forbidden');
  if (message.includes('DOCX_NAME_CONFLICT')) return t('docx.nameConflict');
  return `${fallback}: ${message.replace(/^DOCX_[A-Z_]+:\s*/, '')}`;
}

export function DocxPreview({ filePath, scopePath }: { filePath: string; scopePath: string | null }) {
  const { t } = useI18n();
  const bodyRef = useRef<HTMLDivElement>(null);
  const stylesRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  const bytesRef = useRef<Uint8Array | null>(null);
  const [previewState, setPreviewState] = useState<PreviewState>('loading');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [conversionState, setConversionState] = useState<ConversionState>('idle');
  const [conversionError, setConversionError] = useState<string | null>(null);
  const [warningCount, setWarningCount] = useState(0);
  const [generatedName, setGeneratedName] = useState<string | null>(null);

  useEffect(() => {
    const requestId = ++requestRef.current;
    let cancelled = false;
    bytesRef.current = null;
    setPreviewState('loading');
    setPreviewError(null);
    setConversionState('idle');
    setConversionError(null);
    setWarningCount(0);
    setGeneratedName(null);
    bodyRef.current?.replaceChildren();
    stylesRef.current?.replaceChildren();

    void (async () => {
      try {
        const encoded = await files.readDocxFile(filePath, scopePath ?? undefined);
        if (cancelled || requestRef.current !== requestId) return;
        const bytes = decodeBase64(encoded);
        bytesRef.current = bytes;
        const { renderAsync } = await import('docx-preview');
        if (cancelled || requestRef.current !== requestId) return;
        const body = bodyRef.current;
        const styles = stylesRef.current;
        if (!body || !styles) return;
        await renderAsync(bytes, body, styles, {
          className: 'flowix-docx',
          inWrapper: true,
          experimental: true,
          useBase64URL: true,
        });
        if (cancelled || requestRef.current !== requestId) return;
        setPreviewState('ready');
      } catch (error) {
        if (cancelled || requestRef.current !== requestId) return;
        setPreviewError(userFacingError(error, t('docx.previewFailed'), t));
        setPreviewState('failed');
      }
    })();

    return () => {
      cancelled = true;
      if (requestRef.current === requestId) requestRef.current += 1;
      bytesRef.current = null;
      bodyRef.current?.replaceChildren();
      stylesRef.current?.replaceChildren();
    };
  }, [filePath, scopePath, t]);

  const convertToMarkdown = useCallback(async () => {
    const bytes = bytesRef.current;
    if (!bytes || !scopePath || conversionState === 'converting') return;
    const requestId = requestRef.current;
    setConversionState('converting');
    setConversionError(null);
    setWarningCount(0);
    setGeneratedName(null);
    try {
      const [mammothModule, turndownModule] = await Promise.all([
        import('mammoth'),
        import('turndown'),
      ]);
      if (requestRef.current !== requestId) return;
      const images: DocxMarkdownImage[] = [];
      let imageSequence = 0;
      const converted = await mammothModule.default.convertToHtml(
        { arrayBuffer: toArrayBuffer(bytes) },
        {
          convertImage: mammothModule.default.images.imgElement(async (image) => {
            const index = imageSequence++;
            const marker = `flowix-docx-image-${crypto.randomUUID()}-${index}`;
            images[index] = {
              marker,
              contentType: image.contentType,
              contentBase64: await image.readAsBase64String(),
            };
            return { src: marker };
          }),
        },
      );
      const conversionErrors = converted.messages.filter((message) => message.type === 'error');
      if (conversionErrors.length) throw new Error(conversionErrors[0].message);
      const markdown = new turndownModule.default({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
      }).turndown(converted.value).trim();
      if (!markdown) throw new Error('DOCX_EMPTY');
      if (requestRef.current !== requestId) return;
      const outputPath = await files.createDocxMarkdown(filePath, scopePath, `${markdown}\n`, images);
      if (requestRef.current !== requestId) return;
      setGeneratedName(fileName(outputPath));
      setWarningCount(converted.messages.filter((message) => message.type === 'warning').length);
      setConversionState('success');
    } catch (error) {
      if (requestRef.current !== requestId) return;
      const message = errorText(error);
      setConversionError(message.includes('DOCX_EMPTY')
        ? t('docx.emptyResult')
        : userFacingError(error, t('docx.conversionFailed'), t));
      setConversionState('failed');
    }
  }, [conversionState, filePath, scopePath, t]);

  return (
    <section className="flowix-docx-preview relative flex h-full min-h-0 flex-col">
      <header className="absolute left-0 right-0 top-0 z-20 flex h-10 items-center justify-between gap-3 border-b border-[color-mix(in_oklch,var(--border)_70%,transparent)] bg-[color-mix(in_oklch,var(--card)_78%,transparent)] px-3 backdrop-blur-md">
        <div className="min-w-0">
          <h2 className="flex min-w-0 items-center gap-2 text-sm font-medium" title={filePath}>
            <span className="truncate">{fileName(filePath)}</span>
            <span className="shrink-0 rounded-md border border-[color-mix(in_oklch,var(--border)_70%,transparent)] px-1.5 py-0.5 text-[10px] font-normal leading-none text-[var(--muted-foreground)]">
              {t('docx.previewTitle')}
            </span>
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 w-7 rounded-lg p-0"
            aria-label={t('document.file.openContainingFolder')}
            title={t('document.file.openContainingFolder')}
            onClick={() => {
              void product.revealInFileManager(filePath).catch(() => {
                toast.error(t('memo.fileTree.openFailed'));
              });
            }}
          >
            <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void convertToMarkdown()}
            disabled={previewState !== 'ready' || conversionState === 'converting' || !scopePath}
            className="h-7 gap-1.5 rounded-lg px-2 text-xs"
          >
            {conversionState === 'converting'
              ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              : <ArrowDownToLine className="h-3.5 w-3.5" aria-hidden="true" />}
            {conversionState === 'converting' ? t('docx.converting') : t('docx.convert')}
          </Button>
        </div>
      </header>

      {previewState === 'loading' && (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-[var(--muted-foreground)]" role="status">
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('docx.loading')}
        </div>
      )}
      {previewState === 'failed' && (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="max-w-lg text-center text-sm text-[var(--destructive)]" role="alert">
            <AlertCircle className="mx-auto mb-2 h-5 w-5" aria-hidden="true" />
            {previewError}
          </div>
        </div>
      )}
      {conversionState === 'success' && generatedName && (
        <p className="shrink-0 border-b border-[var(--border)] px-4 py-2 text-xs text-[var(--muted-foreground)]" role="status">
          {t('docx.generated', { name: generatedName })}
          {warningCount > 0 && ` · ${t('docx.warnings', { count: warningCount })}`}
        </p>
      )}
      {conversionState === 'failed' && conversionError && (
        <p className="shrink-0 border-b border-[var(--border)] px-4 py-2 text-xs text-[var(--destructive)]" role="alert">
          {conversionError}
        </p>
      )}
      <div className="flowix-docx-scroll min-h-0 flex-1" style={{ display: previewState === 'ready' ? undefined : 'none' }}>
        <div ref={stylesRef} className="flowix-docx-style-host" aria-hidden="true" />
        <div ref={bodyRef} className="flowix-docx-body" />
      </div>
    </section>
  );
}
