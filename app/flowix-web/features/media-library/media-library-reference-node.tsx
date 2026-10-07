import { reuseCollectionValue } from '@features/collection/content-equality';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Node as TiptapNode, mergeAttributes, type Editor, type MarkdownToken } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorView, NodeView as ProseMirrorNodeView } from '@tiptap/pm/view';
import { createRoot, type Root } from 'react-dom/client';
import { ChevronDown, X } from 'lucide-react';
import { ArrowUpRightIcon, ArrowsLeftRightIcon, FunnelIcon, PlusIcon } from '@phosphor-icons/react';
import { attachments, dialogs, externalDocuments, files, collections, mediaResources, type MediaResource, type NotebookFolderOption } from '@platform/tauri/client';
import { resourceKindFromPath } from '@features/editor/public/code-file';
import { useNoteStore } from '@features/memo/store/note-store';
import { openCollectionTarget, replaceExternalDocumentPath } from '@features/workspace/use-cases/workspace-navigation';
import { canonicalDirectoryPath, canonicalPath, joinNotebookMemoPath } from '@/lib/path';
import { displayTitleFromFilename, mediaLibraryExtension } from '@/lib/utils';
import { useCollectionReference } from '@features/collection/use-collection-reference';
import { toast } from '@/lib/toast';
import { Button } from '@shared/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import { useI18n } from '@/lib/i18n';
import { ResourceFolderIcon } from '@features/surface/resource-file-icon';
import { NotebookTreeResourceIcon } from '@features/memo/components/file-type-icon';
import { openMediaLibraryReferencePicker } from './media-library-reference-picker';
import { renameMediaLibraryFile } from './rename-media-library';
import { MediaLibraryPhotoWall } from './media-library-photo-wall';
import { PHOTO_WALL_CANDIDATE_LIMIT } from './photo-wall-layout';
import { createMediaLibraryRecord, hasMediaLibraryDatasetCondition, matchesMediaLibraryDataset, normalizeMediaLibraryFileCondition, parseMediaLibrary, serializeMediaLibrary, type MediaLibraryDocument, type MediaLibraryKind, type MediaLibraryRecord } from './model';

const MEDIA_LIBRARY_REFERENCE_MARKER = 'flowix:media-library-reference';
const MEDIA_LIBRARY_REFERENCE_VERSION = 1;
const EMBED_RESOURCE_LIMIT = PHOTO_WALL_CANDIDATE_LIMIT;

export interface MediaLibraryReferenceAttrs {
  notebookId: string | null;
  relativePath: string | null;
  collectionId: string | null;
}

function normalizeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeAttrs(value: unknown): MediaLibraryReferenceAttrs {
  const attrs = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    notebookId: normalizeText(attrs.notebookId),
    relativePath: normalizeText(attrs.relativePath)?.replace(/\\/g, '/').replace(/^\/+/, '') ?? null,
    collectionId: normalizeText(attrs.collectionId),
  };
}

function metadataFromSource(source: string): Record<string, unknown> | null {
  const match = new RegExp(`^<!--[ \\t]*${MEDIA_LIBRARY_REFERENCE_MARKER}[ \\t]+(\\{[^\\r\\n]*\\})[ \\t]*-->(?:\\r?\\n|$)`).exec(source);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

class MediaLibraryReferenceNodeView implements ProseMirrorNodeView {
  readonly dom: HTMLElement;
  private readonly root: Root;
  private node: ProseMirrorNode;
  private destroyed = false;
  private readonly handleEditabilityChange = () => this.render();
  private readonly handleRelativePathChange = (relativePath: string) => this.updateAttrs({ relativePath });

  constructor(node: ProseMirrorNode, private readonly editor: Editor, private readonly view: EditorView, private readonly getPos: () => number | undefined) {
    this.node = node;
    this.dom = document.createElement('div');
    this.dom.className = 'media-library-reference-node';
    this.dom.dataset.type = 'media-library-reference';
    this.dom.contentEditable = 'false';
    this.view.dom.addEventListener('flowix:editor-editability-change', this.handleEditabilityChange);
    this.root = createRoot(this.dom);
    this.render();
  }

  private render() {
    if (this.destroyed) return;
    this.root.render(<MediaLibraryReferenceSurface
      key={`${this.node.attrs.notebookId}:${this.node.attrs.collectionId}`}
      attrs={normalizeAttrs(this.node.attrs)}
      editable={this.editor.isEditable}
      onRemove={() => this.removeNode()}
      onReplace={(anchor) => this.replaceNode(anchor)}
      onRelativePathChange={this.handleRelativePathChange}
    />);
  }

  private updateAttrs(patch: Partial<MediaLibraryReferenceAttrs>) {
    if (this.destroyed || this.view.isDestroyed || !this.editor.isEditable) return;
    const pos = this.getPos();
    if (pos === undefined) return;
    const current = this.view.state.doc.nodeAt(pos);
    if (!current || current.type.name !== 'mediaLibraryReference') return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, ...patch }));
  }

  private removeNode() {
    if (this.destroyed || this.view.isDestroyed || !this.editor.isEditable) return;
    const pos = this.getPos();
    if (pos === undefined) return;
    const current = this.view.state.doc.nodeAt(pos);
    if (!current || current.type.name !== 'mediaLibraryReference') return;
    this.view.dispatch(this.view.state.tr.delete(pos, pos + current.nodeSize).scrollIntoView());
  }

  private replaceNode(anchor: HTMLElement) {
    if (this.destroyed || this.view.isDestroyed || !this.editor.isEditable) return;
    const pos = this.getPos();
    if (pos === undefined) return;
    const current = this.view.state.doc.nodeAt(pos);
    if (!current || current.type.name !== 'mediaLibraryReference') return;
    openMediaLibraryReferencePicker(this.editor, { from: pos, to: pos + current.nodeSize }, { kind: 'button', element: anchor });
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type.name !== 'mediaLibraryReference') return false;
    this.node = node;
    this.render();
    return true;
  }

  stopEvent(): boolean { return true; }
  ignoreMutation(): boolean { return true; }

  destroy() {
    this.destroyed = true;
    this.view.dom.removeEventListener('flowix:editor-editability-change', this.handleEditabilityChange);
    this.root.unmount();
  }
}

async function resolveMediaLibraryPath(notebook: { id: string; path: string }, collectionId: string) {
  const item = await collections.resolve(notebook.id, collectionId);
  if (item.identityConflict || item.parseState !== 'valid' || item.collectionType !== 'media_library') throw new Error('无法唯一定位媒体库');
  const filePath = joinNotebookMemoPath(notebook.path, item.relativePath);
  if (!filePath) throw new Error('媒体库路径无效');
  const document = parseMediaLibrary(await externalDocuments.read(filePath, notebook.path));
  if (document.collection.id !== collectionId) throw new Error('媒体库身份已变化');
  return { filePath, relativePath: item.relativePath, document };
}

async function loadLinkedMediaResources(
  records: MediaLibraryRecord[],
  notebookPath: string,
  limit: number,
  isActive: () => boolean,
): Promise<MediaResource[]> {
  const linked: MediaResource[] = [];
  for (let offset = 0; offset < records.length && linked.length <= limit && isActive(); offset += 8) {
    const batch = records.slice(offset, offset + 8);
    const resolved = await Promise.all(batch.map(async (record) => {
      const filePath = joinNotebookMemoPath(notebookPath, record.note_path);
      if (!filePath) return null;
      try {
        return (await mediaResources.get(filePath, notebookPath)).resource;
      } catch { return null; }
    }));
    linked.push(...resolved.filter((resource): resource is MediaResource => resource !== null));
  }
  return linked;
}

function MediaLibraryDatasetPopover({ document, notebook, filePath, editable, busy = false, onSaved }: {
  document: MediaLibraryDocument | null;
  notebook: { id: string; path: string } | undefined;
  filePath: string | null;
  editable: boolean;
  busy?: boolean;
  onSaved: (document: MediaLibraryDocument) => void;
}) {
  const { t } = useI18n();
  const condition = document?.view.condition.file_condition ?? {};
  const [open, setOpen] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [fileName, setFileName] = useState('');
  const [fileType, setFileType] = useState<'any' | MediaLibraryKind>('any');
  const [path, setPath] = useState('');
  const [folderOptions, setFolderOptions] = useState<NotebookFolderOption[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFileName(condition.file_name_contains ?? '');
    setFileType(condition.file_type ?? 'any');
    setPath(condition.path_contains ?? '');
  }, [open, condition.file_name_contains, condition.file_type, condition.path_contains]);

  useEffect(() => {
    if (!folderPickerOpen || !notebook) return;
    let active = true;
    setLoadingFolders(true);
    void files.getNotebookFolderOptions(notebook.path).then((options) => {
      if (active) setFolderOptions(options);
    }).catch(() => {
      if (active) setFolderOptions([]);
    }).finally(() => { if (active) setLoadingFolders(false); });
    return () => { active = false; };
  }, [folderPickerOpen, notebook]);

  const save = useCallback(async () => {
    if (!document || !notebook || !filePath || saving) return;
    const nextCondition = normalizeMediaLibraryFileCondition({
      file_name_contains: fileName.trim(),
      file_type: fileType === 'any' ? undefined : fileType,
      path_contains: path.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
    });
    setSaving(true);
    try {
      let source = await externalDocuments.read(filePath, notebook.path);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const current = parseMediaLibrary(source);
        if (current.collection.id !== document.collection.id) throw new Error('媒体库身份已变化，请重新插入引用');
        const next: MediaLibraryDocument = {
          ...current,
          collection: { ...current.collection, revision: current.collection.revision + 1, updated_at: new Date().toISOString() },
          view: { ...current.view, condition: Object.keys(nextCondition).length ? { file_condition: nextCondition } : {} },
        };
        const result = await externalDocuments.write({ filePath, content: serializeMediaLibrary(next), expectedContent: source, scopePath: notebook.path });
        if (result.status === 'saved') {
          onSaved(next);
          setOpen(false);
          return;
        }
        if (result.status === 'conflict' && attempt === 0) {
          source = result.diskContent;
          continue;
        }
        throw new Error(result.status === 'error' ? result.message : '无法保存数据集条件');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法保存数据集条件');
    } finally {
      setSaving(false);
    }
  }, [document, fileName, filePath, fileType, notebook, onSaved, path, saving]);

  const activeCount = Number(Boolean(condition.file_name_contains)) + Number(Boolean(condition.file_type)) + Number(Boolean(condition.path_contains));
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button type="button" variant="ghost" size="sm" className={'h-7 w-7 rounded-lg p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]' + (open || activeCount ? ' bg-[var(--muted)] text-[var(--foreground)]' : '')} aria-label="数据集" title="数据集" disabled={!editable || busy || !document || !notebook || !filePath}>
        <FunnelIcon size={14} weight="bold" aria-hidden="true" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" side="bottom" sideOffset={0} fitViewport style={{ zIndex: 150 }} ignorePopoverOutside={folderPickerOpen} className="max-h-[min(70vh,420px)] w-[320px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl px-1 py-2 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <p className="agent-thread-card__codex-settings-title px-2">数据集</p>
          {(fileName.trim() || fileType !== 'any' || path.trim()) && <button type="button" className="mx-2 rounded-lg px-2 py-1 text-xs text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]" onClick={() => { setFileName(''); setFileType('any'); setPath(''); }}>{t('mediaLibrary.clearFilters')}</button>}
        </div>
        <label className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-center gap-2 px-2">
          <span className="px-0.5 text-sm text-[var(--foreground)]">{t('mediaLibrary.filterFileName')}</span>
          <input value={fileName} onChange={(event) => setFileName(event.currentTarget.value)} placeholder={t('mediaLibrary.filterFileNamePlaceholder')} aria-label={t('mediaLibrary.filterFileName')} className="h-8 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none focus:border-[var(--brand)]" />
        </label>
        <div className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-center gap-2 px-2">
          <span className="px-0.5 text-sm text-[var(--foreground)]">{t('mediaLibrary.filterType')}</span>
          <Select value={fileType} onValueChange={(value) => setFileType(value as 'any' | MediaLibraryKind)}>
            <SelectTrigger className="h-8 min-w-0 w-full rounded-lg bg-transparent px-2 text-left text-sm"><SelectValue>{fileType === 'image' ? t('mediaLibrary.images') : fileType === 'video' ? t('mediaLibrary.videos') : t('mediaLibrary.all')}</SelectValue></SelectTrigger>
            <SelectContent align="start" fitViewport style={{ zIndex: 170 }} className="flowix-preferences-select-content">
              <SelectItem value="any">{t('mediaLibrary.all')}</SelectItem><SelectItem value="image">{t('mediaLibrary.images')}</SelectItem><SelectItem value="video">{t('mediaLibrary.videos')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-center gap-2 px-2">
          <span className="px-0.5 text-sm text-[var(--foreground)]">{t('mediaLibrary.filterPath')}</span>
          <Popover open={folderPickerOpen} onOpenChange={setFolderPickerOpen}>
            <PopoverTrigger asChild><button type="button" disabled={!notebook} className="flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-transparent px-2 text-left text-sm disabled:opacity-50"><span className="min-w-0 truncate">{path || t('mediaLibrary.chooseFolder')}</span><ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" /></button></PopoverTrigger>
            <PopoverContent side="bottom" align="start" sideOffset={4} style={{ zIndex: 170 }} className="max-h-[min(60vh,280px)] w-[260px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
              {loadingFolders ? <p className="px-2 py-2 text-xs text-[var(--muted-foreground)]">{t('mediaLibrary.loadingFolders')}</p> : <div className="space-y-0.5">
                <button type="button" aria-pressed={!path} onClick={() => { setPath(''); setFolderPickerOpen(false); }} className={'flex h-8 w-full items-center gap-2 rounded-lg pr-2 text-left text-sm hover:bg-[var(--muted)]' + (!path ? ' bg-[var(--muted)]' : '')}><span className="flex min-w-0 flex-1 items-center gap-2 pl-2"><ResourceFolderIcon expanded={false} className="h-[18px] w-[18px] shrink-0" /><span className="min-w-0 truncate">{t('mediaLibrary.anyFolder')}</span></span></button>
                {folderOptions.length === 0 ? <p className="px-2 py-2 text-xs text-[var(--muted-foreground)]">{t('mediaLibrary.noFolders')}</p> : folderOptions.map((option) => {
                  const folderName = option.relativePath.split('/').filter(Boolean).pop() ?? option.relativePath;
                  const selected = path === option.relativePath;
                  return <button key={option.relativePath} type="button" title={option.relativePath} aria-pressed={selected} onClick={() => { setPath(option.relativePath); setFolderPickerOpen(false); }} className={'flex h-8 w-full items-center gap-2 rounded-lg pr-2 text-left text-sm hover:bg-[var(--muted)]' + (selected ? ' bg-[var(--muted)]' : '')} style={{ paddingLeft: 8 + option.depth * 16 }}><ResourceFolderIcon expanded={false} className="h-[18px] w-[18px] shrink-0" /><span className="min-w-0 truncate">{folderName}</span></button>;
                })}
              </div>}
            </PopoverContent>
          </Popover>
        </div>
      </div>
      <div className="mx-2 mt-2"><button type="button" disabled={saving || busy} className="flex h-8 w-full items-center justify-center rounded-lg border border-[var(--border)] bg-white text-sm text-gray-900 hover:bg-gray-100 disabled:opacity-50" onClick={() => void save()}>{saving ? '保存中…' : t('mediaLibrary.apply')}</button></div>
    </PopoverContent>
  </Popover>;
}

function MediaLibraryReferenceSurface({ attrs, editable, onRemove, onReplace, onRelativePathChange }: {
  attrs: MediaLibraryReferenceAttrs;
  editable: boolean;
  onRemove: () => void;
  onReplace: (anchor: HTMLElement) => void;
  onRelativePathChange: (relativePath: string) => void;
}) {
  const { t } = useI18n();
  const notebooks = useNoteStore((state) => state.notebooks);
  const notebook = notebooks.find((item) => item.id === attrs.notebookId);
  const [nearViewport, setNearViewport] = useState(false);
  const reference = useCollectionReference(notebook, attrs.collectionId, 'media_library', null, nearViewport);
  const filePath = reference.fileIdentity?.path ?? null;
  const sectionRef = useRef<HTMLElement>(null);
  const [document, setDocument] = useState<MediaLibraryDocument | null>(null);
  const [resources, setResources] = useState<MediaResource[]>([]);
  const [resourceRevision, setResourceRevision] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const loadingLibrary = !reference.content && !reference.error;
  const [loadingResources, setLoadingResources] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [addingMedia, setAddingMedia] = useState(false);
  const addMediaInFlightRef = useRef(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const element = sectionRef.current;
    if (!element || typeof IntersectionObserver === 'undefined') { setNearViewport(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setNearViewport(true);
      observer.disconnect();
    }, { rootMargin: '600px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!reference.content) return;
    const next = parseMediaLibrary(reference.content);
    setDocument((current) => current ? { ...next,
      view: reuseCollectionValue(current.view, next.view),
      records: reuseCollectionValue(current.records, next.records),
    } : next);
    setError(null);
  }, [reference.content]);

  const condition = document?.view.condition.file_condition;
  const fileType = condition?.file_type;
  const hasDatasetCondition = hasMediaLibraryDatasetCondition(condition);
  const hasDocument = document !== null;
  const mediaLibraryRecords = document?.records.data ?? [];
  useEffect(() => {
    if (!nearViewport || !notebook || !hasDocument) return;
    if (!hasDatasetCondition && mediaLibraryRecords.length === 0) {
      setResources([]);
      setHasMore(false);
      setLoadingResources(false);
      setError(null);
      return;
    }
    let active = true;
    setLoadingResources(true);
    void (async () => {
      const [linked, matches, hasMoreMatches] = await Promise.all([
        loadLinkedMediaResources(mediaLibraryRecords, notebook.path, EMBED_RESOURCE_LIMIT, () => active),
        (async () => {
          if (!hasDatasetCondition) return [[], false] as const;
          const kinds: MediaLibraryKind[] = fileType ? [fileType] : ['image', 'video'];
          const matching: MediaResource[] = [];
          let cursor: string | null = null;
          let hasMoreResources = true;
          while (active && matching.length <= EMBED_RESOURCE_LIMIT && hasMoreResources) {
            const page = await mediaResources.listPage(notebook.path, kinds, cursor, 120);
            matching.push(...page.resources.filter((resource) => matchesMediaLibraryDataset(resource, condition)));
            hasMoreResources = page.hasMore;
            cursor = page.nextCursor;
            if (hasMoreResources && !cursor) break;
          }
          return [matching, matching.length > EMBED_RESOURCE_LIMIT] as const;
        })(),
      ]).then(([linkedResources, [matchingResources, moreMatches]]) => [linkedResources, matchingResources, moreMatches] as const);
      if (!active) return;
      const unique = new Map<string, MediaResource>();
      for (const resource of [...linked, ...matches]) {
        const fullPath = joinNotebookMemoPath(notebook.path, resource.relativePath) ?? resource.relativePath;
        const key = canonicalPath(fullPath).toLocaleLowerCase();
        if (!unique.has(key)) unique.set(key, resource);
      }
      const merged = [...unique.values()];
      setResources(merged.slice(0, EMBED_RESOURCE_LIMIT));
      setHasMore(merged.length > EMBED_RESOURCE_LIMIT || hasMoreMatches);
    })().catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (active) setLoadingResources(false); });
    return () => { active = false; };
  }, [condition, fileType, hasDatasetCondition, hasDocument, mediaLibraryRecords, nearViewport, notebook?.id, notebook?.path, resourceRevision]);

  const openLibrary = useCallback(async () => {
    if (!filePath || !notebook || !attrs.collectionId) return;
    try {
      const resolved = await resolveMediaLibraryPath(notebook, attrs.collectionId!);
      if (resolved.relativePath !== attrs.relativePath) onRelativePathChange(resolved.relativePath);
      await openCollectionTarget({ notebookId: notebook.id, collectionId: attrs.collectionId });
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : '无法打开媒体库');
    }
  }, [attrs.collectionId, attrs.relativePath, filePath, notebook, onRelativePathChange]);
  const addMedia = useCallback(async () => {
    if (!editable || !notebook || !filePath || !attrs.collectionId || !document
      || addingMedia || renaming || editingName || addMediaInFlightRef.current) return;
    addMediaInFlightRef.current = true;
    setAddingMedia(true);
    try {
      const selectedPaths = await dialogs.selectFiles({ accept: 'image/*', multiple: true });
      if (!selectedPaths?.length) return;

      const validPaths = selectedPaths.filter((path) => resourceKindFromPath(path) === 'image');
      if (!validPaths.length) {
        toast.error(t('mediaLibrary.addMediaNoSupported'));
        return;
      }

      const resolved = await resolveMediaLibraryPath(notebook, attrs.collectionId);
      if (resolved.relativePath !== attrs.relativePath) onRelativePathChange(resolved.relativePath);
      const sourceContent = await externalDocuments.read(resolved.filePath, notebook.path);
      if (!sourceContent) throw new Error('无法读取媒体库文件');
      const latestDocument = parseMediaLibrary(sourceContent);
      if (latestDocument.collection.id !== attrs.collectionId) throw new Error('媒体库身份已变化，请重新插入引用');

      const pathFilter = latestDocument.view.condition.file_condition?.path_contains?.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const root = canonicalDirectoryPath(notebook.path);
      const recordsToAppend = [] as ReturnType<typeof createMediaLibraryRecord>[];
      const completed: string[] = [];
      let failed = 0;
      for (const sourcePath of validPaths) {
        let importedPath: string | null = null;
        const targetDirectory = pathFilter ? joinNotebookMemoPath(notebook.path, pathFilter) : null;
        if (pathFilter && targetDirectory) {
          try {
            importedPath = await files.importFile(sourcePath, targetDirectory, notebook.path);
          } catch {
            importedPath = null;
          }
        }
        if (!importedPath) {
          try {
            const savedPath = await attachments.saveFromPath(sourcePath, notebook.id);
            if (!savedPath) throw new Error('媒体附件保存失败');
            const saved = canonicalPath(savedPath);
            if (!saved.startsWith(`${root}/attachments/`)) throw new Error('附件保存路径不在当前笔记本');
            recordsToAppend.push(createMediaLibraryRecord(saved.slice(root.length + 1).replace(/\\/g, '/')));
            importedPath = savedPath;
          } catch (reason) {
            console.error('[MediaLibraryReference] Failed to import image:', reason);
            failed += 1;
            continue;
          }
        }
        completed.push(importedPath);
        await mediaResources.get(importedPath, notebook.path).catch(() => undefined);
      }

      let savedDocument = latestDocument;
      if (recordsToAppend.length) {
        let expectedContent = sourceContent;
        let baseline = latestDocument;
        let saved = false;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const linked = new Set(baseline.records.data.map((record) => canonicalPath(record.note_path).toLocaleLowerCase()));
          const additions = recordsToAppend.filter((record) => {
            const key = canonicalPath(record.note_path).toLocaleLowerCase();
            if (linked.has(key)) return false;
            linked.add(key);
            return true;
          });
          const next = {
            ...baseline,
            collection: { ...baseline.collection, revision: baseline.collection.revision + 1, updated_at: new Date().toISOString() },
            records: { data: [...baseline.records.data, ...additions] },
          };
          const result = await externalDocuments.write({
            filePath: resolved.filePath,
            content: serializeMediaLibrary(next),
            expectedContent,
            scopePath: notebook.path,
          });
          if (result.status === 'saved') {
            savedDocument = next;
            saved = true;
            break;
          }
          if (result.status === 'conflict' && attempt === 0) {
            expectedContent = result.diskContent;
            baseline = parseMediaLibrary(result.diskContent);
            if (baseline.collection.id !== attrs.collectionId) throw new Error('媒体库身份已变化，请重新插入引用');
            continue;
          }
          if (result.status === 'conflict') {
            savedDocument = parseMediaLibrary(result.diskContent);
            toast.error('媒体库配置再次发生变化，已载入最新版本，请重试');
            break;
          }
          throw new Error(result.status === 'error' ? result.message : '媒体库文件已不存在');
        }
        if (!saved) toast.error(t('mediaLibrary.addMediaRecordFailed'));
      }
      setDocument(savedDocument);
      if (completed.length) setResourceRevision((revision) => revision + 1);
      if (selectedPaths.length > validPaths.length) {
        toast.error(t('mediaLibrary.addMediaSkipped', { count: selectedPaths.length - validPaths.length }));
      }
      if (failed) toast.error(t('mediaLibrary.addMediaImportFailed', { count: failed }));
      if (completed.length) toast.success(t('mediaLibrary.addMediaSuccess', { count: completed.length }));
      if (!completed.length && !failed) toast.error(t('mediaLibrary.addMediaFailed'));
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : t('mediaLibrary.addMediaFailed'));
    } finally {
      addMediaInFlightRef.current = false;
      setAddingMedia(false);
    }
  }, [addingMedia, attrs.collectionId, attrs.relativePath, document, editable, editingName, filePath, notebook, onRelativePathChange, renaming, t]);
  const beginRename = useCallback(() => {
    if (!editable || renaming || addingMedia || !filePath) return;
    setNameDraft(document?.collection.name ?? reference.item?.name ?? '');
    setEditingName(true);
    requestAnimationFrame(() => nameInputRef.current?.select());
  }, [addingMedia, document?.collection.name, reference.item?.name, editable, filePath, renaming]);
  const renameLibrary = useCallback(async (rawTitle: string) => {
    const title = rawTitle.trim();
    const currentTitle = document?.collection.name ?? reference.item?.name ?? '';
    if (renaming) return;
    if (!editable || !notebook || !filePath || !title || title === currentTitle) {
      setEditingName(false);
      setNameDraft(currentTitle);
      return;
    }
    if (/[\\/]/.test(title)) {
      toast.error('文件名不能包含路径分隔符');
      setEditingName(false);
      setNameDraft(currentTitle);
      return;
    }
    const extension = mediaLibraryExtension(filePath);
    if (!extension) {
      toast.error('无法识别媒体库文件后缀');
      setEditingName(false);
      setNameDraft(currentTitle);
      return;
    }
    setRenaming(true);
    try {
      if (!attrs.collectionId) return;
      const resolved = await resolveMediaLibraryPath(notebook, attrs.collectionId);
      const result = await renameMediaLibraryFile({
        filePath: resolved.filePath, notebookPath: notebook.path, notebookId: notebook.id, collectionId: attrs.collectionId, title,
        onRenamed: (nextPath) => {
          const identity = reference.fileIdentity;
          if (!identity) return;
          replaceExternalDocumentPath(identity.displayId, resolved.filePath, nextPath);
          const root = canonicalDirectoryPath(notebook.path);
          if (nextPath.startsWith(`${root}/`)) onRelativePathChange(nextPath.slice(root.length + 1));
        },
      });
      setDocument((current) => current ? { ...result.document,
        view: reuseCollectionValue(current.view, result.document.view),
        records: reuseCollectionValue(current.records, result.document.records),
      } : result.document);
      if (result.metadataError) toast.error(`文件已重命名，配置名称未能保存：${result.metadataError}`);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : '重命名媒体库失败');
    } finally {
      setRenaming(false);
      setEditingName(false);
    }
  }, [attrs.collectionId, attrs.relativePath, document?.collection.name, reference.item?.name, reference.fileIdentity, editable, filePath, notebook, onRelativePathChange, renaming]);
  const displayName = document?.collection.name ?? attrs.relativePath?.split('/').pop()?.replace(/\.lib\.ya?ml$/i, '') ?? '媒体库';

  return <section ref={sectionRef} className="my-3 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--editor-block-bg)] px-3 pb-3 pt-1.5" contentEditable={false} aria-label={`媒体库：${displayName}`}>
    <div className="mb-1.5 flex items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 pr-2" title={displayName} onDoubleClick={editingName ? undefined : beginRename}>
        <NotebookTreeResourceIcon path={filePath ?? 'media-library.lib.yaml'} className="h-5 w-5 shrink-0" />
        {editingName ? <input
          ref={nameInputRef}
          aria-label="媒体库文件名"
          value={nameDraft}
          disabled={renaming}
          onChange={(event) => setNameDraft(event.currentTarget.value)}
          onBlur={(event) => void renameLibrary(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
            else if (event.key === 'Escape') { event.preventDefault(); setEditingName(false); setNameDraft(document?.collection.name ?? reference.item?.name ?? ''); }
          }}
          className="h-7 min-w-0 w-full flex-1 border-0 bg-transparent px-0 text-sm font-medium text-[var(--foreground)] outline-none"
        /> : <button
          type="button"
          aria-label={`重命名媒体库：${displayTitleFromFilename(filePath)}`}
          title={`双击重命名：${displayTitleFromFilename(filePath)}`}
          disabled={!editable || renaming || addingMedia || !filePath}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); beginRename(); } }}
          className="min-w-0 flex-1 truncate p-0 text-left text-sm font-medium text-[var(--foreground)] disabled:opacity-100"
        >{reference.item?.name ?? displayName}</button>}
      </div>
      <div className="flex shrink-0 items-center gap-0">
        <MediaLibraryDatasetPopover document={document} notebook={notebook} filePath={filePath} editable={editable} busy={addingMedia || renaming || editingName} onSaved={setDocument} />
        {editable && <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t('mediaLibrary.addMedia')}
          title={t('mediaLibrary.addMedia')}
          disabled={!document || !notebook || !filePath || addingMedia || renaming || editingName}
          onClick={() => void addMedia()}
          className="h-7 w-7 rounded-lg p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
        ><PlusIcon size={14} weight="bold" aria-hidden="true" /></Button>}
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 rounded-lg p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]" aria-label="打开媒体库" title="打开" disabled={!filePath || !notebook || !attrs.collectionId} onClick={openLibrary}>
          <ArrowUpRightIcon size={14} weight="bold" aria-hidden="true" />
        </Button>
        {editable && <Button type="button" variant="ghost" size="sm" title="更换" aria-label="更换媒体库" onClick={(event) => onReplace(event.currentTarget)} className="h-7 w-7 rounded-lg p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"><ArrowsLeftRightIcon size={14} weight="bold" aria-hidden="true" /></Button>}
        {editable && <button type="button" title="移除引用" aria-label="移除媒体库引用" onClick={onRemove} className="rounded-md p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--muted)]"><X className="h-4 w-4" aria-hidden="true" /></button>}
      </div>
    </div>
    {!attrs.notebookId || !attrs.collectionId
      ? <div className="py-8 text-center text-sm text-[var(--muted-foreground)]">媒体库引用信息不完整。</div>
      : !notebook || reference.error
        ? <div className="py-8 text-center text-sm text-[var(--muted-foreground)]">{reference.error ?? '找不到媒体库所属的笔记本。'}</div>
        : !nearViewport || loadingLibrary || loadingResources
          ? <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{Array.from({ length: 6 }, (_, index) => <div key={index} className="aspect-video animate-pulse rounded-md bg-[var(--muted)]" />)}</div>
          : error
            ? <div className="py-8 text-center text-sm text-[var(--muted-foreground)]">{error}</div>
            : resources.length === 0
            ? <div className="py-8 text-center text-sm text-[var(--muted-foreground)]">{hasDatasetCondition ? '媒体库暂无匹配资源' : '请先设置数据集条件'}</div>
              : <>
                <MediaLibraryPhotoWall resources={resources} notebookId={notebook.id} notebookPath={notebook.path} hasMore={hasMore} onOpenLibrary={openLibrary} />
              </>}
  </section>;
}

export const MediaLibraryReference = TiptapNode.create({
  name: 'mediaLibraryReference',
  group: 'block',
  atom: true,
  selectable: false,
  draggable: false,

  addAttributes() {
    return {
      notebookId: { default: null, parseHTML: (element) => element.getAttribute('data-notebook-id'), renderHTML: (attrs) => ({ 'data-notebook-id': attrs.notebookId ?? '' }) },
      relativePath: { default: null, parseHTML: (element) => element.getAttribute('data-relative-path'), renderHTML: (attrs) => ({ 'data-relative-path': attrs.relativePath ?? '' }) },
      collectionId: { default: null, parseHTML: (element) => element.getAttribute('data-collection-id'), renderHTML: (attrs) => ({ 'data-collection-id': attrs.collectionId ?? '' }) },
    };
  },

  parseHTML() { return [{ tag: 'div[data-flowix-media-library-reference]' }]; },

  renderHTML({ node, HTMLAttributes }) {
    const attrs = normalizeAttrs(node.attrs);
    return ['div', mergeAttributes(HTMLAttributes, {
      'data-flowix-media-library-reference': 'true',
      'data-notebook-id': attrs.notebookId ?? '',
      'data-relative-path': attrs.relativePath ?? '',
      'data-collection-id': attrs.collectionId ?? '',
      contenteditable: 'false',
      class: 'media-library-reference-node',
    })];
  },

  addNodeView() {
    return ({ node, editor, view, getPos }) => new MediaLibraryReferenceNodeView(node, editor, view, typeof getPos === 'function' ? getPos : () => undefined);
  },

  markdownTokenizer: {
    name: 'mediaLibraryReference',
    level: 'block' as const,
    start(source: string) {
      const match = new RegExp(`^<!--[ \\t]*${MEDIA_LIBRARY_REFERENCE_MARKER}[ \\t]+\\{`, 'm').exec(source);
      return match?.index ?? -1;
    },
    tokenize(source: string) {
      const metadata = metadataFromSource(source);
      if (!metadata) return undefined;
      const match = new RegExp(`^<!--[ \\t]*${MEDIA_LIBRARY_REFERENCE_MARKER}[ \\t]+\\{[^\\r\\n]*\\}[ \\t]*-->(?:\\r?\\n|$)`).exec(source);
      return match ? { type: 'mediaLibraryReference', raw: match[0], metadata } : undefined;
    },
  },

  parseMarkdown(token: MarkdownToken) {
    const metadata = token.metadata && typeof token.metadata === 'object' ? token.metadata as Record<string, unknown> : metadataFromSource(token.raw ?? '') ?? {};
    const attrs = metadata.version === MEDIA_LIBRARY_REFERENCE_VERSION ? metadata : {};
    return { type: 'mediaLibraryReference', attrs: normalizeAttrs(attrs) };
  },

  renderMarkdown(node) {
    return `<!-- ${MEDIA_LIBRARY_REFERENCE_MARKER} ${JSON.stringify({ version: MEDIA_LIBRARY_REFERENCE_VERSION, ...normalizeAttrs(node.attrs) })} -->\n`;
  },
});
