'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { TrashSimpleIcon } from '@phosphor-icons/react';
import { CustomComponentIcon } from './custom-component-icon';
import { Button } from '@shared/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { DialogFooter } from '@shared/ui/dialog-footer';
import { files } from '@platform/tauri/client';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import {
  componentPreviewDocument,
  parseNotebookComponent,
  type NotebookCustomComponent,
} from '@features/editor/public/custom-component-api';

interface CustomComponentPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notebookPath: string;
  insertMode?: boolean;
  onInsert?: (component: NotebookCustomComponent) => boolean;
}

interface ComponentFileEntry {
  component: NotebookCustomComponent;
  filePath: string;
}

const initialInlineStyles = new WeakMap<HTMLElement, string | null>();

function restoreInitialInlineStyle(element: HTMLElement) {
  if (!initialInlineStyles.has(element)) {
    initialInlineStyles.set(element, element.getAttribute('style'));
  }
  const style = initialInlineStyles.get(element);
  if (style === null) element.removeAttribute('style');
  else if (style !== undefined) element.setAttribute('style', style);
}

function fitComponentPreview(frame: HTMLIFrameElement) {
  const document = frame.contentDocument;
  const body = document?.body;
  const root = document?.documentElement;
  if (!document || !body || !root || frame.clientWidth === 0 || frame.clientHeight === 0) return;

  restoreInitialInlineStyle(body);
  restoreInitialInlineStyle(root);

  const viewportWidth = frame.clientWidth;
  const viewportHeight = frame.clientHeight;
  const contentWidth = Math.max(viewportWidth, body.scrollWidth, root.scrollWidth);
  const contentHeight = Math.max(viewportHeight, body.scrollHeight, root.scrollHeight);
  const scale = Math.min(1, viewportWidth / contentWidth, viewportHeight / contentHeight);

  root.style.setProperty('overflow', 'hidden', 'important');
  body.style.setProperty('position', 'absolute', 'important');
  body.style.setProperty('left', '50%', 'important');
  body.style.setProperty('top', '50%', 'important');
  body.style.setProperty('box-sizing', 'border-box', 'important');
  body.style.setProperty('width', `${contentWidth}px`, 'important');
  body.style.setProperty('height', `${contentHeight}px`, 'important');
  body.style.setProperty('margin', '0', 'important');
  body.style.setProperty('overflow', 'visible', 'important');
  body.style.setProperty('transform', `translate(-50%, -50%) scale(${scale})`, 'important');
  body.style.setProperty('transform-origin', 'center center', 'important');
}

function ComponentPreviewFrame({ html, title }: { html: string; title: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const fit = () => fitComponentPreview(frame);
    frame.addEventListener('load', fit);
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    resizeObserver?.observe(frame);
    fit();

    return () => {
      frame.removeEventListener('load', fit);
      resizeObserver?.disconnect();
    };
  }, [html]);

  return (
    <iframe
      ref={frameRef}
      className="pointer-events-none absolute inset-0 block h-full w-full border-0 bg-white"
      title={title}
      aria-hidden="true"
      // Scripts remain blocked; same-origin access lets the host measure and fit static HTML.
      sandbox="allow-same-origin"
      tabIndex={-1}
      loading="lazy"
      referrerPolicy="no-referrer"
      srcDoc={componentPreviewDocument(html)}
    />
  );
}

export function CustomComponentPickerDialog({
  open,
  onOpenChange,
  notebookPath,
  insertMode = false,
  onInsert,
}: CustomComponentPickerDialogProps) {
  const { t } = useI18n();
  const [components, setComponents] = useState<ComponentFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ComponentFileEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadComponents = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const componentPaths = await files.listEditorComponents(notebookPath);
      const results = await Promise.all(componentPaths.map(async (filePath) => {
        const contents = await files.readEditorComponent(filePath, notebookPath);
        const component = parseNotebookComponent(contents);
        return component ? { component, filePath } : null;
      }));
      setComponents(results.filter((entry): entry is ComponentFileEntry => entry !== null)
        .sort((left, right) => left.component.name.localeCompare(right.component.name)));
    } catch {
      setLoadFailed(true);
      setComponents([]);
    } finally {
      setLoading(false);
    }
  }, [notebookPath]);

  useEffect(() => {
    if (open) void loadComponents();
  }, [loadComponents, open]);

  const insert = (entry: ComponentFileEntry) => {
    if (!insertMode || !onInsert) return;
    const inserted = onInsert(entry.component);
    if (!inserted) {
      toast.error(t('memo.fileTree.componentInsertNoEditor'));
      return;
    }
    toast.success(t('memo.fileTree.componentInserted', { name: entry.component.name }));
    onOpenChange(false);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const deleted = await files.delete(deleteTarget.filePath, notebookPath);
      if (!deleted) throw new Error('component delete failed');
      toast.success(t('memo.fileTree.componentDeleted', { name: deleteTarget.component.name }));
      setDeleteTarget(null);
      await loadComponents();
    } catch {
      toast.error(t('memo.fileTree.componentDeleteFailed'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[86vh] max-w-4xl flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CustomComponentIcon className="h-4 w-4" aria-hidden="true" />
              {t('memo.fileTree.componentLibraryTitle')}
            </DialogTitle>
            <DialogDescription>{t('memo.fileTree.componentLibraryDescription')}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-[var(--muted-foreground)]">
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                {t('memo.fileTree.componentLoading')}
              </div>
            ) : loadFailed ? (
              <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-sm text-[var(--muted-foreground)]">
                <span>{t('memo.fileTree.componentLoadError')}</span>
              </div>
            ) : components.length === 0 ? (
              <div className="flex min-h-40 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-[var(--muted-foreground)]">
                <span>{t('memo.fileTree.componentEmpty')}</span>
                <code className="rounded bg-[var(--muted)] px-2 py-1 text-xs">flowix component</code>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 p-1 sm:grid-cols-2">
                {components.map((entry) => (
                  <div
                    key={entry.filePath}
                    className="group relative w-full overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] transition-colors hover:border-gray-300"
                    style={{ aspectRatio: '16 / 9' }}
                  >
                    <ComponentPreviewFrame html={entry.component.html} title={entry.component.name} />
                    {insertMode && (
                      <button
                        type="button"
                        aria-label={entry.component.name}
                        onClick={() => insert(entry)}
                        className="absolute inset-0 block h-full w-full cursor-pointer border-0 bg-transparent p-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand)]"
                      />
                    )}
                    {insertMode && (
                      <Button
                        type="button"
                        onClick={() => insert(entry)}
                        className="absolute bottom-2 left-2 right-2 z-10 h-8 border border-gray-300 bg-white text-gray-800 opacity-0 shadow-sm transition-opacity hover:bg-gray-50 group-hover:opacity-100 focus-visible:opacity-100"
                      >
                        {t('memo.fileTree.componentInsert')}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('memo.fileTree.componentDeleteLabel', { name: entry.component.name })}
                      title={t('memo.fileTree.componentDeleteLabel', { name: entry.component.name })}
                      onClick={() => setDeleteTarget(entry)}
                      style={{
                        width: 28,
                        height: 28,
                        minWidth: 28,
                        minHeight: 28,
                        maxWidth: 28,
                        maxHeight: 28,
                        boxSizing: 'border-box',
                        padding: 0,
                        backgroundColor: 'color-mix(in srgb, var(--hover-bg) 36%, transparent)',
                      }}
                      className="absolute right-2 top-2 z-10 h-7 w-7 rounded-lg p-0 text-[var(--foreground)] shadow-sm transition-[opacity,color] hover:text-[var(--destructive)] group-hover:opacity-100 group-focus-within:opacity-100 opacity-0"
                    ><TrashSimpleIcon size={14} weight="bold" aria-hidden="true" /></Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !deleting) setDeleteTarget(null);
        }}
      >
        <DialogContent closeDisabled={deleting}>
          <DialogHeader>
            <DialogTitle>{t('memo.fileTree.componentDeleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('memo.fileTree.componentDeleteDescription', { name: deleteTarget?.component.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={deleting} onClick={() => setDeleteTarget(null)}>
              {t('dialog.cancel')}
            </Button>
            <Button type="button" variant="destructive" disabled={deleting} onClick={() => void confirmDelete()}>
              {deleting ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {t('dialog.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
