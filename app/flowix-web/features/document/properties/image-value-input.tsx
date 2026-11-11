import { ImagePlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { canonicalDirectoryPath, canonicalPath, joinNotebookMemoPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import { dialogs, files, notebookAssets } from '@platform/tauri/client';

export function propertyImagePaths(value: unknown): string[] {
  if (typeof value === 'string' && value) return [value];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item))
    : [];
}

export async function selectPropertyImage(
  notebook: { id: string; path: string },
  t: (key: I18nKey) => string,
): Promise<string | null> {
  try {
    const paths = await dialogs.selectFiles({ accept: 'image/*', multiple: false });
    const sourcePath = paths?.[0];
    if (!sourcePath) return null;
    if (!/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|tif|tiff|heic|heif)$/i.test(sourcePath)) {
      toast.error(t('document.properties.imageOnly'));
      return null;
    }
    const attachment = await notebookAssets.saveFromPath(sourcePath, { notebookId: notebook.id });
    if (!attachment?.path) throw new Error('Attachment save returned no path');
    const prefix = `${canonicalDirectoryPath(notebook.path)}/`;
    const savedPath = canonicalPath(attachment.path);
    if (!savedPath.startsWith(prefix)) throw new Error('Saved image is outside the notebook');
    const relativePath = savedPath.slice(prefix.length);
    if (!relativePath.startsWith('attachments/')) throw new Error('Saved image is outside attachments');
    return relativePath;
  } catch (error) {
    console.error('[PropertyImage] Failed to save image:', error);
    toast.error(t('document.properties.imageUploadFailed'));
    return null;
  }
}

interface ImageValueInputProps {
  path?: string;
  src?: string | null;
  disabled?: boolean;
  uploading?: boolean;
  emptyLabel?: string;
  onSelect: () => void;
}

export function ImageValueInput({ path, src, disabled, uploading, emptyLabel, onSelect }: ImageValueInputProps) {
  const { t } = useI18n();
  const selectImageLabel = emptyLabel ?? t('document.properties.selectImage');
  return <div className="flex h-10 w-full min-w-0 items-center gap-1 overflow-hidden px-0">
    {path ? <button
      type="button"
      disabled={disabled || uploading}
      onClick={onSelect}
      className="group relative h-8 w-8 shrink-0 cursor-pointer overflow-hidden rounded-md border border-[var(--border)] bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-50"
      title={t('document.properties.selectImage')}
      aria-label={t('document.properties.selectImage')}
    >
      {src
        ? <img src={src} alt="" draggable={false} className="h-full w-full object-cover" />
        : <ImagePlus className="m-auto h-4 w-4 text-[var(--muted-foreground)]" aria-hidden="true" />}
      <span className="absolute inset-0 flex items-center justify-center bg-black/35 text-white opacity-0 transition-opacity group-hover:opacity-100">
        <ImagePlus className="h-4 w-4" aria-hidden="true" />
      </span>
    </button> : <button
      type="button"
      disabled={disabled || uploading}
      onClick={onSelect}
      className="frontmatter-property__date-picker-trigger flex h-8 min-w-0 flex-1 items-center rounded-lg border-0 bg-transparent px-0 text-left text-sm text-[var(--muted-foreground)] opacity-80 hover:bg-transparent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
    >{uploading ? t('document.properties.selectingImage') : selectImageLabel}</button>}
  </div>;
}

export function NotePropertyImageValue({ value, notebook, disabled, onChange }: {
  value: unknown;
  notebook?: { id: string; path: string };
  disabled: boolean;
  onChange: (path: string) => void;
}) {
  const { t } = useI18n();
  const path = propertyImagePaths(value)[0];
  const notebookPath = notebook?.path;
  const [image, setImage] = useState<{ path: string; src: string | null } | null>(null);
  const [uploading, setUploading] = useState(false);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    if (/^(https?:|data:|blob:)/i.test(path)) {
      setImage({ path, src: path });
      return;
    }
    const absolutePath = notebookPath && !/^(\/|[a-z]:[\\/])/i.test(path)
      ? joinNotebookMemoPath(notebookPath, path) ?? path
      : path;
    void files.readImage(absolutePath, notebookPath).catch(() => null).then((src) => {
      if (!cancelled) setImage({ path, src });
    });
    return () => { cancelled = true; };
  }, [path, notebookPath]);

  const chooseImage = async () => {
    if (disabled || uploading) return;
    if (!notebook) {
      toast.error(t('document.properties.imageUploadFailed'));
      return;
    }
    setUploading(true);
    try {
      const selected = await selectPropertyImage(notebook, t);
      if (selected) onChange(selected);
    } finally {
      setUploading(false);
    }
  };
  return <ImageValueInput
    path={path}
    src={image?.path === path ? image?.src : null}
    disabled={disabled}
    uploading={uploading}
    onSelect={() => void chooseImage()}
  />;
}
