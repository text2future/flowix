import { useCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Node as TiptapNode, mergeAttributes, type Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorView, NodeView as ProseMirrorNodeView } from '@tiptap/pm/view';
import { X } from 'lucide-react';
import { ArrowUpRightIcon, ArrowsLeftRightIcon } from '@phosphor-icons/react';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { useNoteStore } from '@features/memo/store/note-store';
import { useAppLanguage } from '@features/preferences/public/runtime-api';
import { I18nProvider } from '@/lib/i18n/provider';
import { useI18n } from '@/lib/i18n';
import { canonicalDirectoryPath, canonicalPath } from '@/lib/path';
import { useCollectionReference } from '@features/collection/use-collection-reference';
import { toast } from '@/lib/toast';
import { Button } from '@shared/ui/button';
import { NotebookTreeResourceIcon } from '@features/memo/components/file-type-icon';
import { TableDocumentView } from './table-document-view';
import { openTableReferencePicker } from './table-reference-picker';
import {
  TABLE_REFERENCE_MARKER,
  TABLE_REFERENCE_VERSION,
  normalizeTableReferenceAttrs,
  tableReferenceMarkdownSpec,
  type TableReferenceAttrs,
} from './table-reference-markdown';

const EDITOR_EDITABILITY_CHANGE_EVENT = 'flowix:editor-editability-change';

class TableReferenceNodeView implements ProseMirrorNodeView {
  readonly dom: HTMLElement;
  private readonly root: Root;
  private node: ProseMirrorNode;
  private destroyed = false;
  private editorPane: HTMLElement | null = null;
  private layoutObserver: ResizeObserver | null = null;
  private layoutFrame: number | null = null;
  private readonly handleEditabilityChange = () => this.render();
  private readonly scheduleEditorLayoutSync = () => {
    if (this.destroyed || this.layoutFrame !== null) return;
    this.layoutFrame = window.requestAnimationFrame(() => {
      this.layoutFrame = null;
      this.syncEditorLayout();
    });
  };

  constructor(
    node: ProseMirrorNode,
    private readonly editor: Editor,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.node = node;
    this.dom = document.createElement('div');
    this.dom.className = 'table-reference-node';
    this.dom.dataset.type = 'table-reference';
    this.dom.contentEditable = 'false';
    this.view.dom.addEventListener(EDITOR_EDITABILITY_CHANGE_EVENT, this.handleEditabilityChange);
    this.root = createRoot(this.dom);
    this.render();
    this.observeEditorLayout();
  }

  private observeEditorLayout() {
    const pane = this.view.dom.closest<HTMLElement>('.editor-content');
    if (!pane || this.view.dom.closest('.agent-conversation-surface') || typeof ResizeObserver === 'undefined') return;
    this.editorPane = pane;
    this.layoutObserver = new ResizeObserver(this.scheduleEditorLayoutSync);
    this.layoutObserver.observe(this.dom);
    this.layoutObserver.observe(this.view.dom);
    this.layoutObserver.observe(pane);
    pane.addEventListener('scroll', this.scheduleEditorLayoutSync, { passive: true });
    window.addEventListener('resize', this.scheduleEditorLayoutSync);
    this.scheduleEditorLayoutSync();
  }

  private syncEditorLayout() {
    const pane = this.view.dom.closest<HTMLElement>('.editor-content');
    if (!pane || this.view.dom.closest('.agent-conversation-surface')) {
      this.clearEditorLayout();
      return;
    }

    const paneRect = pane.getBoundingClientRect();
    const nodeRect = this.dom.getBoundingClientRect();
    const scale = pane.offsetWidth > 0 ? paneRect.width / pane.offsetWidth : 1;
    if (pane.clientWidth <= 0 || nodeRect.width <= 0) return;
    if (this.dom.parentElement === this.view.dom) {
      const leadingSpace = Math.max(0, (nodeRect.left - paneRect.left) / (scale || 1) - pane.clientLeft);
      this.dom.dataset.tableReferenceBreakout = 'true';
      this.dom.style.setProperty('--multidimensional-table-editor-pane-width', `${pane.clientWidth}px`);
      this.dom.style.setProperty('--multidimensional-table-editor-leading-space', `${leadingSpace}px`);
    } else {
      this.clearBreakout();
    }
    this.syncEmbeddedTableHeader(pane);
  }

  private syncEmbeddedTableHeader(pane: HTMLElement) {
    const header = this.dom.querySelector<HTMLElement>('.table-reference-node__content .multidimensional-table thead');
    const table = header?.closest('table');
    if (!header || !table) return;

    // The horizontal overlay scroller is thead's nearest scroll container, so
    // native sticky cannot follow the editor's vertical scroll. Keep it aligned
    // with the editor viewport and stop at the table's lower edge.
    const paneRect = pane.getBoundingClientRect();
    const scale = pane.offsetWidth > 0 ? paneRect.width / pane.offsetWidth : 1;
    const layoutScale = scale || 1;
    const paneTop = paneRect.top + pane.clientTop * layoutScale;
    const headerRect = header.getBoundingClientRect();
    const tableBottom = table.getBoundingClientRect().bottom;
    const stickyOffset = Math.min(
      Math.max(0, (paneTop - headerRect.top) / layoutScale),
      (tableBottom - paneTop - headerRect.height) / layoutScale,
    );
    header.style.transform = Math.abs(stickyOffset) < 0.5 ? '' : `translateY(${stickyOffset}px)`;
  }

  private clearBreakout() {
    delete this.dom.dataset.tableReferenceBreakout;
    this.dom.style.removeProperty('--multidimensional-table-editor-pane-width');
    this.dom.style.removeProperty('--multidimensional-table-editor-leading-space');
  }

  private clearEditorLayout() {
    this.clearBreakout();
    this.dom.querySelector<HTMLElement>('.table-reference-node__content .multidimensional-table thead')?.style.removeProperty('transform');
  }

  private render() {
    if (this.destroyed) return;
    const attrs = normalizeTableReferenceAttrs(this.node.attrs);
    this.root.render(<TableReferenceSurface
      attrs={attrs}
      currentNotebookId={this.editor.storage.attachmentLink?.getNotebookId?.() ?? null}
      editable={this.editor.isEditable}
      onViewChange={(viewId) => this.updateAttrs({ viewId })}
      onRelativePathChange={(relativePath) => this.updateAttrs({ relativePath })}
      onReplace={(anchor) => this.replaceNode(anchor)}
      onRemove={() => this.removeNode()}
    />);
  }

  private updateAttrs(patch: Partial<TableReferenceAttrs>) {
    if (this.destroyed || this.view.isDestroyed || !this.editor.isEditable) return;
    const pos = this.getPos();
    if (pos === undefined) return;
    const current = this.view.state.doc.nodeAt(pos);
    if (!current || current.type.name !== 'tableReference') return;
    const attrs = { ...current.attrs, ...patch };
    if (Object.entries(patch).every(([key, value]) => (current.attrs as Record<string, unknown>)[key] === value)) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, attrs));
  }

  private removeNode() {
    if (this.destroyed || this.view.isDestroyed || !this.editor.isEditable) return;
    const pos = this.getPos();
    if (pos === undefined) return;
    const node = this.view.state.doc.nodeAt(pos);
    if (!node || node.type.name !== 'tableReference') return;
    this.view.dispatch(this.view.state.tr.delete(pos, pos + node.nodeSize).scrollIntoView());
  }

  private replaceNode(anchor: HTMLElement) {
    if (this.destroyed || this.view.isDestroyed || !this.editor.isEditable) return;
    const pos = this.getPos();
    if (pos === undefined) return;
    const node = this.view.state.doc.nodeAt(pos);
    if (!node || node.type.name !== 'tableReference') return;
    openTableReferencePicker(this.editor, { from: pos, to: pos + node.nodeSize }, { kind: 'button', element: anchor, align: 'right' });
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type.name !== 'tableReference') return false;
    this.node = node;
    this.render();
    this.scheduleEditorLayoutSync();
    return true;
  }

  stopEvent(): boolean {
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy() {
    this.destroyed = true;
    this.view.dom.removeEventListener(EDITOR_EDITABILITY_CHANGE_EVENT, this.handleEditabilityChange);
    this.layoutObserver?.disconnect();
    this.layoutObserver = null;
    this.editorPane?.removeEventListener('scroll', this.scheduleEditorLayoutSync);
    this.editorPane = null;
    window.removeEventListener('resize', this.scheduleEditorLayoutSync);
    if (this.layoutFrame !== null) window.cancelAnimationFrame(this.layoutFrame);
    this.layoutFrame = null;
    this.clearEditorLayout();
    // 编辑器重建时本 destroy 会被 EditorView 的 updateState 同步调用，可能
    // 正处于 React 渲染/提交期间；同步 unmount 会触发 "Attempted to
    // synchronously unmount a root while React was already rendering" 竞态。
    // 推迟到宏任务与当前渲染周期解耦（node view 的 dom 已脱离文档，残留无碍）。
    const { root } = this;
    window.setTimeout(() => root.unmount(), 0);
  }
}

function TableReferenceSurface({ attrs, currentNotebookId, editable, onViewChange, onRelativePathChange, onReplace, onRemove }: {
  attrs: TableReferenceAttrs;
  currentNotebookId: string | null;
  editable: boolean;
  onViewChange: (viewId: string) => void;
  onRelativePathChange: (relativePath: string) => void;
  onReplace: (anchor: HTMLElement) => void;
  onRemove: () => void;
}) {
  const language = useAppLanguage();
  const notebook = useNoteStore((state) => state.notebooks.find((item) => item.id === attrs.notebookId));
  const external = !currentNotebookId || currentNotebookId !== attrs.notebookId;
  const reference = useCollectionReference(external ? undefined : notebook, attrs.collectionId, 'table');
  const fileIdentity = reference.fileIdentity;
  const filePath = fileIdentity?.path ?? null;
  const displayName = reference.item?.name ?? attrs.relativePath?.split('/').pop()?.replace(/\.(?:table|index)\.ya?ml$/i, '') ?? '多维表格';
  const unavailable = external || (!filePath && Boolean(reference.error));

  const handleFilePathChange = useCallback((nextFilePath: string) => {
    const rootPath = notebook ? canonicalDirectoryPath(notebook.path) : '';
    const normalizedNextPath = canonicalPath(nextFilePath);
    if (rootPath && normalizedNextPath.startsWith(`${rootPath}/`)) {
      onRelativePathChange(normalizedNextPath.slice(rootPath.length + 1));
      return;
    }
  }, [notebook, onRelativePathChange]);

  const openOriginal = useCallback(async () => {
    if (!notebook || !attrs.collectionId) return;
    try {
      await openWorkspaceSurface({
        index: 0,
        target: { kind: 'collection-reference', notebookId: notebook.id, collectionId: attrs.collectionId, viewId: attrs.viewId, collectionKind: 'table' },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法打开多维表格');
    }
  }, [attrs.collectionId, attrs.viewId, notebook]);

  return <I18nProvider language={language}>
    <section
      className={unavailable ? 'table-reference-node__surface table-reference-node__surface--unavailable my-3 overflow-hidden rounded-xl border border-[var(--border)] px-3 pb-3 pt-1.5' : 'table-reference-node__surface'}
      contentEditable={false}
      aria-label={`多维表格：${displayName}`}
    >
      {!attrs.notebookId || !attrs.collectionId
        ? <div className="table-reference-node__message">此多维表格引用信息不完整。</div>
        : external
            ? <>
              <div className="mb-1.5 flex items-center gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-1.5 pr-2" title={displayName}>
                  <NotebookTreeResourceIcon path={attrs.relativePath ?? 'table.yaml'} collectionType="table" className="h-5 w-5 shrink-0" />
                  <span className="min-w-0 truncate px-0.5 py-1 text-sm font-medium leading-none text-[var(--foreground)]">{displayName}</span>
                </div>
                <div className="flex shrink-0 items-center gap-0">
                  <Button type="button" variant="ghost" size="sm" className="h-7 w-7 rounded-lg p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]" aria-label="打开多维表格" title="打开" disabled>
                    <ArrowUpRightIcon size={14} weight="bold" aria-hidden="true" />
                  </Button>
                  {editable && <Button type="button" variant="ghost" size="sm" title="更换" aria-label="更换多维表格" onClick={(event) => onReplace(event.currentTarget)} className="h-7 w-7 rounded-lg p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"><ArrowsLeftRightIcon size={14} weight="bold" aria-hidden="true" /></Button>}
                  {editable && <button type="button" className="table-reference-node__remove" aria-label="移除多维表格引用" title="移除引用" onClick={onRemove}><X className="h-4 w-4" aria-hidden="true" /></button>}
                </div>
              </div>
              <div className="py-8 text-center text-sm text-[var(--muted-foreground)]"><TableReferenceErrorMessage error="" external /></div>
            </>
          : !notebook
            ? <div className="table-reference-node__message">找不到引用所在的笔记本。</div>
            : !filePath
            ? <>
              {reference.error && <div className="mb-1.5 flex items-center gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-1.5 pr-2" title={displayName}>
                  <NotebookTreeResourceIcon path={attrs.relativePath ?? 'table.yaml'} collectionType="table" className="h-5 w-5 shrink-0" />
                  <span className="min-w-0 truncate px-0.5 py-1 text-sm font-medium leading-none text-[var(--foreground)]">{displayName}</span>
                </div>
                <div className="flex shrink-0 items-center gap-0">
                  <Button type="button" variant="ghost" size="sm" className="h-7 w-7 rounded-lg p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]" aria-label="打开多维表格" title="打开" disabled>
                    <ArrowUpRightIcon size={14} weight="bold" aria-hidden="true" />
                  </Button>
                  {editable && <Button type="button" variant="ghost" size="sm" title="更换" aria-label="更换多维表格" onClick={(event) => onReplace(event.currentTarget)} className="h-7 w-7 rounded-lg p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"><ArrowsLeftRightIcon size={14} weight="bold" aria-hidden="true" /></Button>}
                  {editable && <button type="button" className="table-reference-node__remove" aria-label="移除多维表格引用" title="移除引用" onClick={onRemove}><X className="h-4 w-4" aria-hidden="true" /></button>}
                </div>
              </div>}
              <div className={reference.error ? 'py-8 text-center text-sm text-[var(--muted-foreground)]' : 'table-reference-node__message'}>{reference.error ? <TableReferenceErrorMessage error={reference.error} /> : '正在定位多维表格…'}</div>
            </>
            : <div className="table-reference-node__content">
              <TableDocumentView
                key={attrs.collectionId}
                filePath={filePath}
                fileIdentity={fileIdentity}
                notebookPath={notebook.path}
                notebookId={notebook.id}
                embeddedInEditor
                expectedCollectionId={attrs.collectionId}
                initialViewId={attrs.viewId}
                editable={editable}
                onRemoveReference={onRemove}
                canCreateFields
                canCreateRecords={false}
                showAssociateNoteAction
                onActiveViewChange={onViewChange}
                onFilePathChange={handleFilePathChange}
                trailingActions={(datasetAction) =>
                  <div className="multidimensional-table__view-nav-actions">
                    {datasetAction}
                    <span role="separator" aria-orientation="vertical" className="multidimensional-table__view-nav-actions-separator" />
                    <Button type="button" variant="ghost" size="sm" className="h-7 w-7 rounded-lg p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]" aria-label="打开多维表格" title="打开" disabled={!filePath || !notebook} onClick={openOriginal}>
                      <ArrowUpRightIcon size={14} weight="bold" aria-hidden="true" />
                    </Button>
                    <Button type="button" variant="ghost" size="sm" className="h-7 w-7 rounded-lg p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]" aria-label="更换多维表格" title="更换" disabled={!editable} onClick={(event) => onReplace(event.currentTarget)}>
                      <ArrowsLeftRightIcon size={14} weight="bold" aria-hidden="true" />
                    </Button>
                    <button type="button" className="table-reference-node__remove" aria-label="移除多维表格引用" title="移除引用" disabled={!editable} onClick={onRemove}>
                      <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                }
              />
            </div>}
    </section>
  </I18nProvider>;
}

function TableReferenceErrorMessage({ error, external = false }: { error: string; external?: boolean }) {
  const { t } = useI18n();
  return <>{external ? t('collection.notInCurrentNotebook') : error === 'COLLECTION_NOT_FOUND' ? t('multidimensionalTable.collectionNotFound') : error}</>;
}

export const TableReference = TiptapNode.create({
  name: 'tableReference',
  group: 'block',
  atom: true,
  selectable: false,
  draggable: false,

  addAttributes() {
    return {
      notebookId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-notebook-id'),
        renderHTML: (attrs) => ({ 'data-notebook-id': attrs.notebookId ?? '' }),
      },
      relativePath: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-relative-path'),
        renderHTML: (attrs) => ({ 'data-relative-path': attrs.relativePath ?? '' }),
      },
      collectionId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-collection-id'),
        renderHTML: (attrs) => ({ 'data-collection-id': attrs.collectionId ?? '' }),
      },
      viewId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-view-id'),
        renderHTML: (attrs) => ({ 'data-view-id': attrs.viewId ?? '' }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-flowix-table-reference]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const attrs = normalizeTableReferenceAttrs(node.attrs);
    return ['div', mergeAttributes(HTMLAttributes, {
      'data-flowix-table-reference': 'true',
      'data-notebook-id': attrs.notebookId ?? '',
      'data-relative-path': attrs.relativePath ?? '',
      'data-collection-id': attrs.collectionId ?? '',
      'data-view-id': attrs.viewId ?? '',
      contenteditable: 'false',
      class: 'table-reference-node',
    })];
  },

  addNodeView() {
    return ({ node, editor, view, getPos }) => new TableReferenceNodeView(
      node,
      editor,
      view,
      typeof getPos === 'function' ? getPos : () => undefined,
    );
  },

  ...tableReferenceMarkdownSpec,

  renderMarkdown(node) {
    const attrs = normalizeTableReferenceAttrs(node.attrs);
    return `<!-- ${TABLE_REFERENCE_MARKER} ${JSON.stringify({ version: TABLE_REFERENCE_VERSION, ...attrs })} -->\n`;
  },
});
