'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SectionHeader } from '@features/preferences/sections/primitives';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { errorMessage } from '@/lib/error-message';
import { notes, type PathArchiveSummary, type PathVersionMeta } from '@platform/tauri/client';
import { Button } from '@shared/ui/button';
import { useDocumentStore } from '@features/document/store/document-store';
import { documentIdentityFromFile } from '@features/document/store/document-identity';
import { applyLoadedDocumentContent, flushDocumentPath } from '@features/document/store/document-session-service';

export function HistorySection() {
  const { t } = useI18n();
  const [archives, setArchives] = useState<PathArchiveSummary[]>([]);
  const [selected, setSelected] = useState<PathArchiveSummary | null>(null);
  const [versions, setVersions] = useState<PathVersionMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const requestSequence = useRef(0);

  const loadArchives = useCallback(async () => {
    try { setArchives(await notes.listArchives()); }
    catch (error) { toast.error(errorMessage(error)); }
  }, []);
  useEffect(() => { void loadArchives(); }, [loadArchives]);

  const openArchive = async (archive: PathArchiveSummary) => {
    const request = ++requestSequence.current;
    setSelected(archive);
    setVersions([]);
    setBusy(true);
    try {
      const items = await notes.listVersions(archive.notebookId, archive.relativePath);
      if (request === requestSequence.current) setVersions(items);
    } catch (error) { if (request === requestSequence.current) toast.error(errorMessage(error)); }
    finally { if (request === requestSequence.current) setBusy(false); }
  };

  const restore = async (version: PathVersionMeta) => {
    if (!selected || !window.confirm(t('preferences.history.restoreConfirm'))) return;
    const archive = selected;
    setBusy(true);
    try {
      const session = useDocumentStore.getState().activeExternalSession;
      const active = session?.notebookId === archive.notebookId
        && session.relativePath === archive.relativePath ? session : null;
      if (active) {
        const identity = documentIdentityFromFile(active.fileIdentity);
        if (!await flushDocumentPath(identity, active.fileIdentity.path, active.scopePath)) {
          toast.error(t('document.version.saveCurrentFailed'));
          return;
        }
      }
      await notes.restoreArchivedVersion(archive.notebookId, archive.relativePath, version.id);
      if (active && useDocumentStore.getState().activeExternalSession?.fileIdentity.path === active.fileIdentity.path) {
        const content = await notes.readDocument(active.fileIdentity.path);
        if (content !== null) {
          applyLoadedDocumentContent(documentIdentityFromFile(active.fileIdentity), active.fileIdentity.path, content, { preservePending: false });
        }
      }
      toast.success(t('preferences.history.restored'));
      setVersions(await notes.listVersions(archive.notebookId, archive.relativePath));
      await loadArchives();
    } catch (error) { toast.error(errorMessage(error)); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <SectionHeader title={t('preferences.history.title')} />
      <p className="text-xs text-[var(--muted-foreground)]">{t('preferences.history.description')}</p>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void loadArchives()}>{t('preferences.history.refresh')}</Button>
      {archives.length === 0 && <p className="py-8 text-center text-sm text-[var(--muted-foreground)]">{t('preferences.history.empty')}</p>}
      <div className="space-y-2">
        {archives.map((archive) => (
          <button key={`${archive.notebookId}:${archive.relativePath}`} type="button"
            disabled={busy}
            onClick={() => void openArchive(archive)}
            className="w-full rounded-lg border border-[var(--border)] p-3 text-left text-sm hover:bg-[var(--muted)] disabled:opacity-60">
            <span className="block font-medium break-all">{archive.relativePath}</span>
            <span className="text-xs text-[var(--muted-foreground)]">{archive.notebookName} · {archive.versionCount} · {new Date(archive.latestAt).toLocaleString()}</span>
          </button>
        ))}
      </div>
      {selected && <div className="space-y-2 rounded-xl border border-[var(--border)] p-3">
        <div className="break-all text-sm font-medium">{selected.relativePath}</div>
        {versions.map((version) => <div key={version.id} className="flex items-center justify-between gap-2 text-xs">
          <span>{new Date(version.createdAt).toLocaleString()} · {t(version.source === 'cloud_conflict' ? 'document.version.source.cloudConflict' : version.source === 'restore_backup' ? 'document.version.source.restoreBackup' : version.source === 'manual' ? 'document.version.source.manual' : 'document.version.source.auto')}</span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void restore(version)}>{t('preferences.history.restore')}</Button>
        </div>)}
      </div>}
    </div>
  );
}
