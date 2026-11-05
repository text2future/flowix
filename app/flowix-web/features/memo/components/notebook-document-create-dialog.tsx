import { useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { createTableDocumentFile, type TableViewType } from '@features/multidimensional-table/public/create-api';
import { createMediaLibraryFile } from '@features/media-library/model';
import { createWorkDocumentsCollectionFile } from '@features/work-documents/model';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Button } from '@shared/ui/button';

export interface NotebookDocumentCreateRequest {
  kind: 'table' | 'media-library' | 'work-documents';
  notebook: { id: string; path: string };
  viewType?: TableViewType;
  parentFolder: () => Promise<string | null | undefined> | string | null | undefined;
  onTableCreated?: (selection: { relativePath: string; collectionId: string; viewId: string }) => void | Promise<void>;
  refresh?: () => Promise<void>;
}

/** Each mounted dialog owns one creation request and its transient form state. */
export function NotebookDocumentCreateDialog({ request, onClose }: {
  request: NotebookDocumentCreateRequest;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const type = request.viewType ?? 'table';
  const defaults = {
    table: ['memo.create.tableDefaultName', 'memo.create.tableDialogTitle'],
    gallery: ['memo.create.galleryDefaultName', 'memo.create.galleryDialogTitle'],
    kanban: ['memo.create.kanbanDefaultName', 'memo.create.kanbanDialogTitle'],
    calendar: ['memo.create.calendarDefaultName', 'memo.create.calendarDialogTitle'],
  } as const;
  const [defaultName, title, description] = request.kind === 'table'
    ? [t(defaults[type][0]), t(defaults[type][1]), t('memo.create.tableDescription')]
    : request.kind === 'media-library'
      ? [t('memo.create.mediaLibraryDefaultName'), t('memo.create.mediaLibraryTitle'), t('memo.create.mediaLibraryDescription')]
      : [t('memo.create.workDocuments'), t('memo.create.workDocumentsTitle'), t('memo.create.workDocumentsDescription')];
  const [name, setName] = useState(defaultName);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const submit = async () => {
    if (savingRef.current || !name.trim()) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const { notebook } = request;
      const parent = await request.parentFolder();
      let filePath: string;
      if (request.kind === 'table') {
        const created = await createTableDocumentFile(notebook.path, parent, name, type);
        filePath = created.filePath;
        if (request.onTableCreated) {
          const view = created.table.views.items[0];
          if (!view) throw new Error('新建多维表格没有可用视图');
          await request.onTableCreated({ relativePath: created.relativePath, collectionId: created.table.collection.id, viewId: view.id });
        }
      } else if (request.kind === 'media-library') {
        const created = await createMediaLibraryFile(notebook.path, parent, name);
        filePath = created.filePath;
      } else {
        filePath = (await createWorkDocumentsCollectionFile(notebook.path, parent, name)).filePath;
      }
      onClose();
      await request.refresh?.();
      await openWorkspaceSurface({
        index: 0,
        target: { kind: 'external', path: filePath, scopePath: notebook.path, transitionId: null },
        options: { notebookId: notebook.id },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('memo.fileTree.createFailed'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <input autoFocus value={name} disabled={saving} onChange={(event) => setName(event.target.value)} placeholder={defaultName} className="h-9 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none focus:border-[var(--brand)]" />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" className="rounded-lg" disabled={saving} onClick={onClose}>{t('dialog.cancel')}</Button>
            <Button type="submit" size="sm" className="rounded-lg" disabled={!name.trim() || saving}>{saving ? t('memo.create.creating') : t('memo.create.confirm')}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
