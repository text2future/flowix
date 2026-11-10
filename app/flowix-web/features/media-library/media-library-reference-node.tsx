import { friendlyErrorMessage } from '@/lib/friendly-error-message';
import { resolveCollectionLocationScope, pathInCollectionScope } from '@features/collection/public/folder-api';
import { resolveDatasetFilterForLocation } from '@features/collection/dataset-filter-location';
import { reuseCollectionValue } from '@features/collection/content-equality';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Node as TiptapNode, mergeAttributes, type Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorView, NodeView as ProseMirrorNodeView } from '@tiptap/pm/view';
import { createRoot, type Root } from 'react-dom/client';
import { ChevronRight, X } from 'lucide-react';
import { ArrowUpRightIcon, ArrowsLeftRightIcon, FunnelIcon, PlusIcon } from '@phosphor-icons/react';
import { dialogs, externalDocuments, files, collections, mediaResources, type MediaResource, type NotebookFolderOption } from '@platform/tauri/client';
import { resourceKindFromPath } from '@features/editor/public/code-file';
import { useNoteStore } from '@features/memo/store/note-store';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { canonicalDirectoryPath, canonicalPath, joinNotebookMemoPath, notebookRelativeDirectoryPath } from '@/lib/path';
import { displayTitleFromFilename } from '@/lib/utils';
import { useCollectionReference } from '@features/collection/use-collection-reference';
import { collectionDisplayName } from '@features/collection/model';
import { toast } from '@/lib/toast';
import { Button } from '@shared/ui/button';
import { useTitleEditCaret } from '@shared/hooks/use-title-edit-caret';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { useI18n } from '@/lib/i18n';
import { NotebookTreeResourceIcon } from '@features/memo/components/file-type-icon';
import { openMediaLibraryReferencePicker } from './media-library-reference-picker';
import { importMediaLibraryFiles } from './media-import';
import { renameMediaLibrary } from './rename-media-library';
import { MediaLibraryPhotoWall } from './media-library-photo-wall';
import { PHOTO_WALL_CANDIDATE_LIMIT } from './photo-wall-layout';
import { MediaLibraryFilterPanel } from './media-library-filter-panel';
import {
  MEDIA_LIBRARY_REFERENCE_MARKER,
  MEDIA_LIBRARY_REFERENCE_VERSION,
  mediaLibraryReferenceMarkdownSpec,
  normalizeMediaLibraryReferenceAttrs,
  type MediaLibraryReferenceAttrs,
} from './media-library-reference-markdown';
import { canEditMediaLibraryFilter, hasMediaDatasetFilter, mediaCollectionFilterForSave, mediaLibraryFileCondition, matchesMediaCollectionFilter, normalizeMediaLibraryFileCondition, parseMediaLibrary, serializeMediaLibrary, type MediaLibraryDocument, type MediaLibraryKind, type MediaLibraryRecord } from './model';
import { collectionSourceDomain, collectionWriteContent } from '@features/collection/public/hybrid-api';
import { publishCollectionContent } from '@features/collection/public/content-events-api';

const EMBED_RESOURCE_LIMIT = PHOTO_WALL_CANDIDATE_LIMIT;

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
      attrs={normalizeMediaLibraryReferenceAttrs(this.node.attrs)}
      currentNotebookId={this.editor.storage.attachmentLink?.getNotebookId?.() ?? null}
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
    // 同 table-reference-node：EditorView 重建期间的同步 destroy 可能撞上
    // React 渲染期，unmount 推迟到宏任务。
    const { root } = this;
    window.setTimeout(() => root.unmount(), 0);
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
      const filePath = joinNotebookMemoPath(notebookPath, record.relative_path);
      if (!filePath) return null;
      try {
        return (await mediaResources.get(filePath, notebookPath)).resource;
      } catch { return null; }
    }));
    linked.push(...resolved.filter((resource): resource is MediaResource => resource !== null));
  }
  return linked;
}

function MediaLibraryDatasetPopover({ document, notebook, filePath, editable, busy = false, onSaved, open, onOpenChange: setOpen }: {
  document: MediaLibraryDocument | null;
  notebook: { id: string; path: string } | undefined;
  filePath: string | null;
  editable: boolean;
  busy?: boolean;
  onSaved: (document: MediaLibraryDocument) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const condition = document ? mediaLibraryFileCondition(document) : {};
  const fixedFolderPath = document?.collection.placement === 'folder' && notebook && filePath
    ? notebookRelativeDirectoryPath(notebook.path, canonicalDirectoryPath(filePath.replace(/[\\/][^\\/]*$/, ''))) ?? ''
    : undefined;
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [fileName, setFileName] = useState('');
  const [fileTypes, setFileTypes] = useState<string[]>([]);
  const [path, setPath] = useState('');
  const [pathIsAll, setPathIsAll] = useState(false);
  const [folderOptions, setFolderOptions] = useState<NotebookFolderOption[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setFilterMenuOpen(false);
      setFolderPickerOpen(false);
      return;
    }
    setFileName(condition.file_name_contains ?? '');
    setFileTypes(condition.file_types ?? (condition.file_type ? [condition.file_type] : []));
    setPath(condition.path_contains ?? '');
    setPathIsAll(condition.path_scope === 'all');
  }, [open, condition.file_name_contains, condition.file_type, condition.file_types, condition.path_contains, condition.path_scope]);

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

  const save = useCallback(async (pathOverride?: string | null, closeOnSave = true): Promise<boolean> => {
    if (!document || !notebook || !filePath || saving) return false;
    if (!canEditMediaLibraryFilter(document)) {
      toast.error('当前媒体库包含编辑器不支持的筛选，未保存以保留原条件');
      return false;
    }
    const nextCondition = normalizeMediaLibraryFileCondition({
      file_name_contains: fileName.trim(),
      file_types: fileTypes.length && fileTypes.length < 2 ? fileTypes as MediaLibraryKind[] : undefined,
      path_contains: pathOverride === null ? undefined : (pathOverride ?? path).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
      path_scope: pathOverride === null || (pathOverride === undefined && pathIsAll) ? 'all' : undefined,
    });
    setSaving(true);
    try {
      let source = await externalDocuments.read(filePath, notebook.path);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const current = parseMediaLibrary(source);
        if (current.collection.id !== document.collection.id) throw new Error('媒体库身份已变化，请重新插入引用');
        if (!canEditMediaLibraryFilter(current)) throw new Error('当前媒体库包含编辑器不支持的筛选，已取消保存');
        const next: MediaLibraryDocument = {
          ...current,
          collection: { ...current.collection, revision: current.collection.revision + 1, updated_at: new Date().toISOString() },
          dataset: { ...current.dataset, filter: mediaCollectionFilterForSave(current, nextCondition, filePath, notebook.path) },
          views: { ...current.views, items: current.views.items.map((view) => view.id === current.views.default_id
            ? { ...view, filter: { all: [], any: [] } } : view) },
        };
        const writeDomain = collectionSourceDomain(source, 'media_library');
        const result = await externalDocuments.write({ filePath,
          content: collectionWriteContent({ source, domain: writeDomain, document: next, serialize: serializeMediaLibrary }),
          expectedContent: source, scopePath: notebook.path });
        if (result.status === 'saved') {
          onSaved(next);
          // 编辑器里的筛选面板也改了媒体库文件：广播落盘内容，媒体面板与外壳 tab 立刻跟上。
          publishCollectionContent({ indexPath: filePath, notebookPath: notebook.path, content: result.content });
          if (closeOnSave) setOpen(false);
          return true;
        }
        if (result.status === 'conflict' && attempt === 0) {
          source = result.diskContent;
          continue;
        }
        throw new Error(result.status === 'error' ? result.message : '无法保存数据集条件');
      }
    } catch (error) {
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.tableViewSave'));
      return false;
    } finally {
      setSaving(false);
    }
    return false;
  }, [document, fileName, filePath, fileTypes, notebook, onSaved, path, pathIsAll, saving]);

  const activeCount = Number(Boolean(condition.file_name_contains)) + Number(Boolean(condition.file_type || condition.file_types?.length)) + Number(Boolean(condition.path_contains) || condition.path_scope === 'all');
  return <Popover open={open} onOpenChange={(next) => {
    setOpen(next);
    if (!next) {
      setFilterMenuOpen(false);
      setFolderPickerOpen(false);
    }
  }}>
    <PopoverTrigger asChild>
      <Button type="button" variant="ghost" size="sm" className={'h-7 w-7 rounded-lg p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]' + (open || activeCount ? ' bg-[var(--muted)] text-[var(--foreground)]' : '')} aria-label="数据集合" title="数据集合" disabled={!editable || busy || !document || !notebook || !filePath}>
        <FunnelIcon size={14} weight="bold" aria-hidden="true" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" side="bottom" sideOffset={0} fitViewport style={{ zIndex: 150 }} ignorePopoverOutside={filterMenuOpen || folderPickerOpen} className="w-[220px] max-w-[calc(100vw-16px)] rounded-xl p-1.5 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
      <div className="space-y-0.5">
        <MediaLibraryFilterPanel
          fileName={fileName}
          fileTypes={fileTypes}
          path={path}
          pathIsAll={pathIsAll}
          folderPickerOpen={folderPickerOpen}
          folderOptions={folderOptions}
          folderOptionsLoading={loadingFolders}
          notebookAvailable={Boolean(notebook)}
          busy={saving || busy}
          fixedFolderPath={fixedFolderPath}
          locationOnly
          showLocationMenu={false}
          onFileNameChange={setFileName}
          onFileTypesChange={setFileTypes}
          onPathChange={setPath}
          onPathSelected={async (selectedPath) => {
            const saved = await save(selectedPath, false);
            if (saved) {
              setPath(selectedPath ?? '');
              setPathIsAll(selectedPath === null);
            }
            return saved;
          }}
          onFolderPickerOpenChange={setFolderPickerOpen}
          onReset={() => {}}
          onApply={() => {}}
        />
        <Popover open={filterMenuOpen} onOpenChange={setFilterMenuOpen}>
          <div className={`rounded-lg transition-colors ${filterMenuOpen ? 'bg-[var(--hover-bg)]' : 'hover:bg-[var(--hover-bg)]'}`}>
            <PopoverTrigger asChild>
              <button type="button" className="flex h-8 w-full items-center justify-between rounded-lg px-1.5 text-left text-sm hover:text-[var(--foreground)] data-[state=open]:text-[var(--foreground)]">
                <span>资料筛选</span>
                <span className="flex items-center gap-1 text-xs text-[var(--muted-foreground)]">
                  {fileName.trim() || fileTypes.length ? '已设置' : '未设置'}
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
              </button>
            </PopoverTrigger>
          </div>
          <PopoverContent side="left" align="start" sideOffset={0} fitViewport style={{ zIndex: 160 }} ignorePopoverOutside={folderPickerOpen} className="max-h-[min(70vh,420px)] w-[320px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl p-1.5 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
            <div className="space-y-1">
              <MediaLibraryFilterPanel
                fileName={fileName}
                fileTypes={fileTypes}
                path={path}
                pathIsAll={pathIsAll}
                folderPickerOpen={folderPickerOpen}
                folderOptions={folderOptions}
                folderOptionsLoading={loadingFolders}
                notebookAvailable={Boolean(notebook)}
                busy={saving || busy}
                applying={saving}
                showLocationMenu={false}
                onFileNameChange={setFileName}
                onFileTypesChange={setFileTypes}
                onPathChange={setPath}
                onFolderPickerOpenChange={setFolderPickerOpen}
                onReset={() => { setFileName(''); setFileTypes([]); }}
                onApply={() => { void save(); }}
              />
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </PopoverContent>
  </Popover>;
}

function MediaLibraryReferenceSurface({ attrs, currentNotebookId, editable, onRemove, onReplace, onRelativePathChange }: {
  attrs: MediaLibraryReferenceAttrs;
  currentNotebookId: string | null;
  editable: boolean;
  onRemove: () => void;
  onReplace: (anchor: HTMLElement) => void;
  onRelativePathChange: (relativePath: string) => void;
}) {
  const { t } = useI18n();
  const notebooks = useNoteStore((state) => state.notebooks);
  const notebook = notebooks.find((item) => item.id === attrs.notebookId);
  const external = !currentNotebookId || currentNotebookId !== attrs.notebookId;
  const [nearViewport, setNearViewport] = useState(false);
  const reference = useCollectionReference(external ? undefined : notebook, attrs.collectionId, 'media_library', null, nearViewport && !external);
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
  const { inputRef: nameInputRef, captureCaret: captureNameCaret } = useTitleEditCaret(editingName);

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
      views: reuseCollectionValue(current.views, next.views),
      dataset: { ...next.dataset, records: reuseCollectionValue(current.dataset.records, next.dataset.records) },
    } : next);
    setError(null);
  }, [reference.content]);

  const condition = document ? mediaLibraryFileCondition(document) : undefined;
  const [datasetMenuOpen, setDatasetMenuOpen] = useState(false);
  useEffect(() => {
    if (!external) return;
    setDatasetMenuOpen(false);
    setDocument(null);
    setResources([]);
    setHasMore(false);
    setLoadingResources(false);
    setError(null);
  }, [external]);
  const fileType = condition?.file_type;
  const hasDatasetCondition = Boolean(document && (hasMediaDatasetFilter(document.dataset.filter) || document.dataset.source.scope !== 'notebook')
    || condition?.path_scope === 'all' || condition?.path_contains || condition?.file_name_contains || condition?.file_type);
  const hasDocument = document !== null;
  const mediaLibraryRecords = document?.dataset.records.include ?? [];
  useEffect(() => {
    if (external || !nearViewport || !notebook || !hasDocument) return;
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
      const scope = document ? resolveCollectionLocationScope(document, filePath, notebook.path) : undefined;
      const inCollectionSource = (path: string) => pathInCollectionScope(path, scope);
      const effectiveFilter = document ? resolveDatasetFilterForLocation(document.dataset.filter, document.collection.placement, filePath, notebook.path) : null;
      const scopedRecords = mediaLibraryRecords.filter((record) => inCollectionSource(record.relative_path));
      const [linked, matches, hasMoreMatches] = await Promise.all([
        loadLinkedMediaResources(scopedRecords, notebook.path, EMBED_RESOURCE_LIMIT, () => active),
        (async () => {
          if (!hasDatasetCondition) return [[], false] as const;
          const kinds: MediaLibraryKind[] = fileType ? [fileType] : ['image', 'video'];
          const matching: MediaResource[] = [];
          let cursor: string | null = null;
          let hasMoreResources = true;
          while (active && matching.length <= EMBED_RESOURCE_LIMIT && hasMoreResources) {
            const page = await mediaResources.listPage(notebook.path, kinds, cursor, 120, scope?.relativePath ?? null, scope?.depth);
            matching.push(...page.resources.filter((resource) => inCollectionSource(resource.relativePath)
              && matchesMediaCollectionFilter(resource.relativePath, resource.kind, effectiveFilter)));
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
      if (active) setError(friendlyErrorMessage(reason, t, 'errors.friendly.mediaLoad'));
    }).finally(() => { if (active) setLoadingResources(false); });
    return () => { active = false; };
  }, [document?.dataset.filter, document?.dataset.source.path, document?.dataset.source.scope, external, filePath, fileType, hasDatasetCondition, hasDocument, mediaLibraryRecords, nearViewport, notebook?.id, notebook?.path, resourceRevision]);

  const openLibrary = useCallback(async () => {
    if (!filePath || !notebook || !attrs.collectionId) return;
    try {
      const resolved = await resolveMediaLibraryPath(notebook, attrs.collectionId!);
      if (resolved.relativePath !== attrs.relativePath) onRelativePathChange(resolved.relativePath);
      await openWorkspaceSurface({
        index: 0,
        target: { kind: 'collection-reference', notebookId: notebook.id, collectionId: attrs.collectionId, collectionKind: 'media_library' },
      });
    } catch (reason) {
      toast.error(friendlyErrorMessage(reason, t, 'errors.friendly.mediaLoad'));
    }
  }, [attrs.collectionId, attrs.relativePath, filePath, notebook, onRelativePathChange]);
  const addMedia = useCallback(async () => {
    if (!editable || !notebook || !filePath || !attrs.collectionId || !document
      || addingMedia || renaming || editingName || addMediaInFlightRef.current) return;
    addMediaInFlightRef.current = true;
    setAddingMedia(true);
    try {
      const selectedPaths = await dialogs.selectFiles({ accept: 'media/*', multiple: true });
      if (!selectedPaths?.length) return;

      const validPaths = selectedPaths.filter((path) => {
        const kind = resourceKindFromPath(path);
        return kind === 'image' || kind === 'video';
      });
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

      let savedDocument = latestDocument;
      const result = await importMediaLibraryFiles({
        paths: validPaths, notebookId: notebook.id, notebookPath: notebook.path,
        filePath: resolved.filePath, document: latestDocument,
        persist: async (mutate) => {
          let expectedContent = sourceContent;
          let baseline = latestDocument;
          const writeDomain = collectionSourceDomain(sourceContent, 'media_library');
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const next = mutate(baseline);
            const write = await externalDocuments.write({
              filePath: resolved.filePath,
              content: collectionWriteContent({ source: expectedContent, domain: writeDomain, document: next, serialize: serializeMediaLibrary }),
              expectedContent, scopePath: notebook.path,
            });
            if (write.status === 'saved') {
              savedDocument = next;
              // 导入媒体同样改写了媒体库文件，写盘方负责广播。
              publishCollectionContent({ indexPath: resolved.filePath, notebookPath: notebook.path, content: write.content });
              return true;
            }
            if (write.status !== 'conflict') {
              throw new Error(write.status === 'error' ? write.message : '媒体库文件已不存在');
            }
            expectedContent = write.diskContent;
            baseline = parseMediaLibrary(write.diskContent);
            savedDocument = baseline;
          }
          return false;
        },
        readLatest: async () => parseMediaLibrary(await externalDocuments.read(resolved.filePath, notebook.path)),
      });
      setDocument(savedDocument);
      if (result.completed.length) setResourceRevision((revision) => revision + 1);
      if (result.recordSaveFailed) toast.error(result.cleanupFailed
        ? t('mediaLibrary.addMediaCleanupFailed', { count: result.cleanupFailed })
        : t('mediaLibrary.addMediaRecordFailed'));
      if (selectedPaths.length > validPaths.length) {
        toast.error(t('mediaLibrary.addMediaSkipped', { count: selectedPaths.length - validPaths.length }));
      }
      if (result.failed) toast.error(t('mediaLibrary.addMediaImportFailed', { count: result.failed }));
      if (result.completed.length) toast.success(t('mediaLibrary.addMediaSuccess', { count: result.completed.length }));
    } catch (reason) {
      toast.error(friendlyErrorMessage(reason, t, 'errors.friendly.mediaAdd'));
    } finally {
      addMediaInFlightRef.current = false;
      setAddingMedia(false);
    }
  }, [addingMedia, attrs.collectionId, attrs.relativePath, document, editable, editingName, filePath, notebook, onRelativePathChange, renaming, t]);
  const beginRename = useCallback(() => {
    if (!editable || renaming || addingMedia || !filePath) return;
    setNameDraft(document ? collectionDisplayName(filePath, document.collection.placement) : reference.item?.name ?? '');
    setEditingName(true);
  }, [addingMedia, document?.collection.placement, reference.item?.name, editable, filePath, renaming]);
  const renameLibrary = useCallback(async (rawTitle: string) => {
    const title = rawTitle.trim();
    const currentTitle = document && filePath
      ? collectionDisplayName(filePath, document.collection.placement)
      : reference.item?.name ?? '';
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
    setRenaming(true);
    try {
      if (!attrs.collectionId) return;
      const result = await renameMediaLibrary({
        notebookPath: notebook.path, notebookId: notebook.id, collectionId: attrs.collectionId, title,
        onRenamed: (nextPath) => {
          const root = canonicalDirectoryPath(notebook.path);
          if (nextPath.startsWith(`${root}/`)) onRelativePathChange(nextPath.slice(root.length + 1));
        },
      });
      setDocument((current) => current ? { ...result.document,
        views: reuseCollectionValue(current.views, result.document.views),
        dataset: { ...result.document.dataset, records: reuseCollectionValue(current.dataset.records, result.document.dataset.records) },
      } : result.document);
      if (result.errorCode) { console.warn('Collection follow-up failed', result.errorCode); toast.error(t('errors.friendly.collectionPartial')); };
    } catch (reason) {
      toast.error(friendlyErrorMessage(reason, t, 'errors.friendly.mediaRename'));
    } finally {
      setRenaming(false);
      setEditingName(false);
    }
  }, [attrs.collectionId, document?.collection.placement, reference.item?.name, editable, filePath, notebook, onRelativePathChange, renaming]);
  const displayName = document && filePath
    ? collectionDisplayName(filePath, document.collection.placement)
    : reference.item?.name ?? attrs.relativePath?.split('/').pop()?.replace(/\.(?:index\.ya?ml|(?:table|lib)\.ya?ml)$/i, '') ?? '媒体库';

  return <section ref={sectionRef} className="my-3 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--editor-block-bg)] px-3 pb-3 pt-1.5" contentEditable={false} aria-label={`媒体库：${displayName}`}>
    <div className="mb-1.5 flex items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 pr-2" title={displayName}>
        <NotebookTreeResourceIcon path={filePath ?? 'media-library.lib.yaml'} collectionType="media_library" className="h-5 w-5 shrink-0" />
        {editingName ? <input
          ref={nameInputRef}
          aria-label="媒体库文件名"
          value={nameDraft}
          disabled={renaming}
          onChange={(event) => setNameDraft(event.currentTarget.value)}
          onBlur={(event) => void renameLibrary(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) return;
            if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
            else if (event.key === 'Escape') { event.preventDefault(); setEditingName(false); setNameDraft(document && filePath ? collectionDisplayName(filePath, document.collection.placement) : reference.item?.name ?? ''); }
          }}
          className="box-border h-[22px] min-w-[2em] max-w-full flex-[0_1_auto] rounded px-0.5 py-1 [field-sizing:content] border-0 bg-[var(--muted)] text-sm font-medium leading-none text-[var(--foreground)] outline-none"
        /> : <button
          type="button"
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            captureNameCaret(event.currentTarget, event.clientX, event.clientY);
            beginRename();
          }}
          aria-label={`重命名媒体库：${displayTitleFromFilename(filePath)}`}
          title={`双击重命名：${displayTitleFromFilename(filePath)}`}
          disabled={!editable || renaming || addingMedia || !filePath}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); beginRename(); } }}
          className="min-w-[2em] flex-[0_1_auto] truncate rounded px-0.5 py-1 text-left text-sm font-medium leading-none text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] disabled:opacity-100"
        >{displayName}</button>}
      </div>
      <div className="flex shrink-0 items-center gap-0">
        <MediaLibraryDatasetPopover document={document} notebook={notebook} filePath={filePath} editable={editable} busy={addingMedia || renaming || editingName} onSaved={setDocument} open={datasetMenuOpen} onOpenChange={setDatasetMenuOpen} />
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
      ? <div className="py-8 text-center text-sm text-[var(--muted-foreground)]">媒体库引用信息不完整</div>
      : external
        ? <div className="py-8 text-center text-sm text-[var(--muted-foreground)]">{t('collection.notInCurrentNotebook')}</div>
      : !notebook || reference.error
        ? <div className="py-8 text-center text-sm text-[var(--muted-foreground)]">{reference.error ? t('errors.friendly.mediaLoad') : '找不到媒体库所属的笔记本'}</div>
        : !nearViewport || loadingLibrary || loadingResources
          ? <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{Array.from({ length: 6 }, (_, index) => <div key={index} className="aspect-video animate-pulse rounded-md bg-[var(--muted)]" />)}</div>
          : error
            ? <div className="py-8 text-center text-sm text-[var(--muted-foreground)]">{error}</div>
            : resources.length === 0
            ? <div className="flex items-center justify-center gap-1 py-8 text-sm text-[var(--muted-foreground)]">
                <span>未添加图片或视频，</span>
                <button type="button" disabled={!editable || !document || !notebook || !filePath || addingMedia || renaming || editingName} onClick={() => setDatasetMenuOpen(true)} className="inline-flex items-center gap-0.5 text-[var(--foreground)] hover:text-[var(--brand)] disabled:opacity-50">
                  选择数据<ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button type="button" disabled={!editable || !document || !notebook || !filePath || addingMedia || renaming || editingName} onClick={() => void addMedia()} className="inline-flex items-center gap-0.5 text-[var(--foreground)] hover:text-[var(--brand)] disabled:opacity-50">
                  添加<ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
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
    const attrs = normalizeMediaLibraryReferenceAttrs(node.attrs);
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

  ...mediaLibraryReferenceMarkdownSpec,

  renderMarkdown(node) {
    return `<!-- ${MEDIA_LIBRARY_REFERENCE_MARKER} ${JSON.stringify({ version: MEDIA_LIBRARY_REFERENCE_VERSION, ...normalizeMediaLibraryReferenceAttrs(node.attrs) })} -->\n`;
  },
});
