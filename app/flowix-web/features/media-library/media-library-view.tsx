'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { canonicalPath } from '@/lib/path';
import { externalDocuments, files } from '@platform/tauri/client';
import { useNoteStore } from '@features/memo/store/note-store';
import { DocumentListView } from '@features/surface/document-list-view';
import type { DocumentListSurface } from '@features/surface/types';
import { ensureFileDisplayIdentity, findFileDisplayIdentity, findFileDisplayPath, type FileDisplayIdentity } from '@/lib/file-display-registry';
import { displayTitleFromFilename, mediaLibraryExtension } from '@/lib/utils';
import { replaceExternalDocumentPath } from '@features/workspace/use-cases/workspace-navigation';
import { toast } from '@/lib/toast';
import { parseMediaLibrary, serializeMediaLibrary, type MediaLibraryDocument, type MediaLibraryKind } from './model';

export function MediaLibraryView({ filePath, fileIdentity, notebookPath, notebookId = null }: { filePath: string; fileIdentity?: FileDisplayIdentity; notebookPath: string | null; notebookId?: string | null }) {
  const notebooks = useNoteStore((state) => state.notebooks);
  const notebook = notebooks.find((candidate) => canonicalPath(candidate.path) === canonicalPath(notebookPath ?? ''));
  const [renamedFilePath, setRenamedFilePath] = useState<string | null>(null);
  const [document, setDocument] = useState<MediaLibraryDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const sourceContentRef = useRef<string | null>(null);
  const saveInFlightRef = useRef(false);
  const displayId = fileIdentity?.displayId;
  const currentFilePath = (displayId ? findFileDisplayPath(displayId) : null) ?? renamedFilePath ?? filePath;

  useEffect(() => setRenamedFilePath(null), [filePath]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    if (saveInFlightRef.current) {
      setLoading(false);
      return;
    }
    if (!notebookPath) {
      setError('无法确定媒体库所属的笔记本');
      setLoading(false);
      return;
    }
    sourceContentRef.current = null;
    void files.read(currentFilePath, notebookPath).then((source) => {
      if (cancelled) return;
      if (!source) throw new Error('无法读取媒体库文件');
      const parsed = parseMediaLibrary(source);
      sourceContentRef.current = source;
      setDocument(parsed);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [currentFilePath, notebookPath]);

  const persistMutation = useCallback(async (
    mutate: (current: MediaLibraryDocument) => MediaLibraryDocument,
    targetPath = currentFilePath,
    lockAlreadyHeld = false,
  ): Promise<boolean> => {
    if (!document || !notebookPath || !sourceContentRef.current
      || (saveInFlightRef.current && !lockAlreadyHeld)) return false;
    if (!lockAlreadyHeld) {
      saveInFlightRef.current = true;
      setSaving(true);
    }
    try {
      let baseline = document;
      let expectedContent = sourceContentRef.current;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const next = mutate(baseline);
        const result = await externalDocuments.write({
          filePath: targetPath,
          content: serializeMediaLibrary(next),
          expectedContent,
          scopePath: notebookPath,
        });
        if (result.status === 'saved') {
          sourceContentRef.current = result.content;
          setDocument(next);
          return true;
        }
        if (result.status === 'conflict') {
          const latest = parseMediaLibrary(result.diskContent);
          expectedContent = result.diskContent;
          sourceContentRef.current = result.diskContent;
          if (attempt === 0) {
            baseline = latest;
            continue;
          }
          setDocument(latest);
          toast.error('媒体库配置再次发生变化，已载入最新版本，请重试');
          return false;
        }
        throw new Error(result.status === 'error' ? result.message : '媒体库文件已不存在');
      }
      return false;
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : '保存媒体库配置失败');
      return false;
    } finally {
      if (!lockAlreadyHeld) {
        saveInFlightRef.current = false;
        setSaving(false);
      }
    }
  }, [currentFilePath, document, notebookPath]);

  const updateKinds = useCallback(async (kinds: MediaLibraryKind[]) => {
    if (saving) return;
    await persistMutation((current) => ({
      ...current,
      library: { ...current.library, revision: current.library.revision + 1 },
      view: { ...current.view, kinds },
    }));
  }, [persistMutation, saving]);

  const renameLibraryFile = useCallback(async (rawTitle: string) => {
    const title = rawTitle.trim();
    const previousPath = canonicalPath(displayId ? findFileDisplayPath(displayId) ?? currentFilePath : currentFilePath);
    const currentTitle = displayTitleFromFilename(previousPath);
    const extension = mediaLibraryExtension(previousPath);
    if (!title || title === currentTitle || saving || !notebookPath || saveInFlightRef.current) return;
    if (/[\\/]/.test(title)) {
      toast.error('文件名不能包含路径分隔符');
      return;
    }
    if (!extension) {
      toast.error('无法识别媒体库文件后缀');
      return;
    }

    try {
      const identity = fileIdentity ?? findFileDisplayIdentity(previousPath) ?? ensureFileDisplayIdentity(previousPath);
      saveInFlightRef.current = true;
      setSaving(true);
      const nextPath = canonicalPath(await files.rename(previousPath, `${title}${extension}`, notebookPath));
      replaceExternalDocumentPath(identity.displayId, previousPath, nextPath);
      setRenamedFilePath(nextPath);
      const renameConfig = (current: MediaLibraryDocument): MediaLibraryDocument => ({
        ...current,
        library: { ...current.library, name: title, revision: current.library.revision + 1 },
      });
      const saved = await persistMutation(renameConfig, nextPath, true);
      if (!saved) setDocument((current) => current ? renameConfig(current) : current);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : '重命名媒体库失败');
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }, [currentFilePath, displayId, fileIdentity, notebookPath, persistMutation, saving]);

  const listSurface: DocumentListSurface | null = useMemo(() => {
    const resolvedNotebookId = notebookId ?? notebook?.id;
    if (!resolvedNotebookId || !notebookPath || !document) return null;
    return {
      kind: 'document-list',
      instanceKey: fileIdentity?.displayId ?? document.library.id,
      displayId: fileIdentity?.displayId ?? document.library.id,
      folderPath: notebook?.path ?? notebookPath,
      notebookPath: notebook?.path ?? notebookPath,
      notebookId: resolvedNotebookId,
      filters: { resourceKinds: document.view.kinds },
    };
  }, [document, fileIdentity?.displayId, notebook, notebookId, notebookPath]);

  if (loading) return <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">正在打开媒体库…</div>;
  if (error) return <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--destructive)]">{error}</div>;
  if (!document || !listSurface) return <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">媒体库不可用</div>;

  return <div className="relative h-full min-h-0">
    {saving && <span className="pointer-events-none absolute right-5 top-4 z-10 text-[11px] text-[var(--muted-foreground)]">保存中…</span>}
    <DocumentListView
      key={listSurface.displayId}
      surface={listSurface}
      mediaLibrary
      libraryName={displayTitleFromFilename(currentFilePath) || document.library.name}
      libraryFilePath={currentFilePath}
      selectedKinds={document.view.kinds}
      onKindsChange={(kinds) => { void updateKinds(kinds); }}
      onRenameLibrary={renameLibraryFile}
    />
  </div>;
}
