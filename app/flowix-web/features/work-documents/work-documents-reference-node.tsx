import { createRoot, type Root } from 'react-dom/client';
import { lazy, Suspense, useMemo, useState } from 'react';
import { Node as TiptapNode, mergeAttributes, type Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorView, NodeView as ProseMirrorNodeView } from '@tiptap/pm/view';
import { useNotebookById } from '@features/memo/public/notebook-api';
import { useAppLanguage } from '@features/preferences/public/runtime-api';
import { I18nProvider } from '@/lib/i18n/provider';
import { useI18n } from '@/lib/i18n';
import { useCollectionReference } from '@features/collection/public/collection-reference-api';
import { useCollectionNameEdit, CollectionTitle } from '@features/collection/public/title-api';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { toast } from '@/lib/toast';
import { Button } from '@shared/ui/button';
import { CollectionActionsSlot } from '@shared/ui/collection-actions';
import { ArrowUpRightIcon, ArrowsLeftRightIcon } from '@phosphor-icons/react';
import { X } from 'lucide-react';
import { openWorkDocumentsReferencePicker } from './work-documents-reference-picker';
import {
  normalizeWorkDocumentsReferenceAttrs,
  workDocumentsReferenceMarkdownSpec,
  WORK_DOCUMENTS_REFERENCE_MARKER,
  WORK_DOCUMENTS_REFERENCE_VERSION,
  type WorkDocumentsReferenceAttrs,
} from './work-documents-reference-markdown';

const WorkDocumentsCollectionView = lazy(() => import('@features/surface/public/collection-view-api').then((module) => ({ default: module.WorkDocumentsCollectionView })));
const WORK_DOCUMENTS_REFERENCE_PAGE_SIZE = 6;

class WorkDocumentsReferenceNodeView implements ProseMirrorNodeView {
  readonly dom: HTMLElement;
  private readonly root: Root;
  private node: ProseMirrorNode;
  private destroyed = false;
  private readonly handleEditabilityChange = () => this.render();

  constructor(node: ProseMirrorNode, private readonly editor: Editor, private readonly view: EditorView, private readonly getPos: () => number | undefined) {
    this.node = node;
    this.dom = document.createElement('div');
    this.dom.className = 'work-documents-reference-node';
    this.dom.dataset.type = 'work-documents-reference';
    this.dom.contentEditable = 'false';
    this.view.dom.addEventListener('flowix:editor-editability-change', this.handleEditabilityChange);
    this.root = createRoot(this.dom);
    this.render();
  }

  private render() {
    if (this.destroyed) return;
    this.root.render(<WorkDocumentsReferenceSurface
      attrs={normalizeWorkDocumentsReferenceAttrs(this.node.attrs)}
      currentNotebookId={this.editor.storage.attachmentLink?.getNotebookId?.() ?? null}
      editable={this.editor.isEditable}
      onRemove={() => this.removeNode()}
      onReplace={(anchor) => this.replaceNode(anchor)}
    />);
  }

  private removeNode() {
    if (this.destroyed || this.view.isDestroyed || !this.editor.isEditable) return;
    const pos = this.getPos();
    if (pos === undefined) return;
    const current = this.view.state.doc.nodeAt(pos);
    if (!current || current.type.name !== 'workDocumentsReference') return;
    this.view.dispatch(this.view.state.tr.delete(pos, pos + current.nodeSize).scrollIntoView());
  }

  private replaceNode(anchor: HTMLElement) {
    if (this.destroyed || this.view.isDestroyed || !this.editor.isEditable) return;
    const pos = this.getPos();
    if (pos === undefined) return;
    const current = this.view.state.doc.nodeAt(pos);
    if (!current || current.type.name !== 'workDocumentsReference') return;
    openWorkDocumentsReferencePicker(this.editor, { from: pos, to: pos + current.nodeSize }, { kind: 'button', element: anchor, align: 'right' });
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type.name !== 'workDocumentsReference') return false;
    this.node = node;
    this.render();
    return true;
  }

  stopEvent(): boolean { return true; }
  ignoreMutation(): boolean { return true; }

  destroy() {
    this.destroyed = true;
    this.view.dom.removeEventListener('flowix:editor-editability-change', this.handleEditabilityChange);
    const { root } = this;
    window.setTimeout(() => root.unmount(), 0);
  }
}

function WorkDocumentsReferenceSurface({ attrs, currentNotebookId, editable, onRemove, onReplace }: {
  attrs: WorkDocumentsReferenceAttrs;
  currentNotebookId: string | null;
  editable: boolean;
  onRemove: () => void;
  onReplace: (anchor: HTMLElement) => void;
}) {
  const language = useAppLanguage();
  return <I18nProvider language={language}><WorkDocumentsReferenceContent
    attrs={attrs}
    currentNotebookId={currentNotebookId}
    editable={editable}
    onRemove={onRemove}
    onReplace={onReplace}
  /></I18nProvider>;
}

function WorkDocumentsReferenceContent({ attrs, currentNotebookId, editable, onRemove, onReplace }: {
  attrs: WorkDocumentsReferenceAttrs;
  currentNotebookId: string | null;
  editable: boolean;
  onRemove: () => void;
  onReplace: (anchor: HTMLElement) => void;
}) {
  const { t } = useI18n();
  const [actionsTarget, setActionsTarget] = useState<HTMLDivElement | null>(null);
  const actionsHost = useMemo(() => ({ target: actionsTarget }), [actionsTarget]);
  const notebook = useNotebookById(attrs.notebookId);
  const external = !currentNotebookId || currentNotebookId !== attrs.notebookId;
  const reference = useCollectionReference(external ? undefined : notebook, attrs.collectionId, 'work_documents');
  const filePath = reference.fileIdentity?.path ?? null;
  const displayName = reference.item?.name ?? attrs.relativePath?.split('/').pop()?.replace(/\.index\.ya?ml$/i, '') ?? '列表';
  const titleEdit = useCollectionNameEdit({
    filePath: filePath ?? '',
    notebookPath: notebook?.path ?? null,
    notebookId: notebook?.id ?? null,
    expectedCollectionId: attrs.collectionId,
    currentName: displayName,
    editable: editable && !external && Boolean(filePath),
  });

  const openOriginal = async () => {
    if (!notebook || !attrs.collectionId) return;
    try {
      await openWorkspaceSurface({
        index: 0,
        target: { kind: 'collection-reference', notebookId: notebook.id, collectionId: attrs.collectionId, viewId: null, collectionKind: 'work_documents' },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法打开资料列表');
    }
  };

  return <section className="my-3 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--editor-block-bg)] px-3 pb-3 pt-1.5" contentEditable={false} aria-label={`资料列表：${displayName}`}>
      <div className="mb-1.5 flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 pr-2" title={displayName}>
          <CollectionTitle
            kind="work_documents"
            title={displayName}
            inputLabel={t('workDocuments.titleLabel')}
            renameLabel={t('workDocuments.renameLabel')}
            renameHint={t('workDocuments.renameHint')}
            edit={titleEdit}
          />
        </div>
        <div className="flex shrink-0 items-center gap-0">
          <CollectionActionsSlot onTargetChange={setActionsTarget} />
          <Button type="button" variant="ghost" size="sm" className="h-7 w-7 rounded-lg p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]" aria-label="打开资料列表" title="打开" disabled={!filePath || external} onClick={() => void openOriginal()}>
            <ArrowUpRightIcon size={14} weight="bold" aria-hidden="true" />
          </Button>
          {editable && <Button type="button" variant="ghost" size="sm" title="更换" aria-label="更换资料列表" onClick={(event) => onReplace(event.currentTarget)} className="h-7 w-7 rounded-lg p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"><ArrowsLeftRightIcon size={14} weight="bold" aria-hidden="true" /></Button>}
          {editable && <button type="button" title="移除引用" aria-label="移除资料列表引用" onClick={onRemove} className="rounded-md p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--muted)]"><X className="h-4 w-4" /></button>}
        </div>
      </div>
      {!attrs.notebookId || !attrs.collectionId
        ? <div className="py-8 text-center text-sm text-[var(--muted-foreground)]">资料列表引用信息不完整</div>
        : external
          ? <div className="py-8 text-center text-sm text-[var(--muted-foreground)]">此资料列表不属于当前笔记本</div>
          : !notebook
            ? <div className="py-8 text-center text-sm text-[var(--muted-foreground)]">找不到引用所在的笔记本</div>
            : !filePath
              ? <div className="py-8 text-center text-sm text-[var(--muted-foreground)]">{reference.error ?? '正在定位资料列表…'}</div>
              : <Suspense fallback={<div className="py-8 text-center text-sm text-[var(--muted-foreground)]">正在打开资料列表…</div>}>
                <WorkDocumentsCollectionView
                  key={attrs.collectionId}
                  filePath={filePath}
                  fileIdentity={reference.fileIdentity}
                  notebookPath={notebook.path}
                  notebookId={notebook.id}
                  expectedCollectionId={attrs.collectionId}
                  editable={editable}
                  actionsHost={actionsHost}
                  pageScroll
                  workDocumentsPageSize={WORK_DOCUMENTS_REFERENCE_PAGE_SIZE}
                  showLoadMoreButton
                />
              </Suspense>}
    </section>;
}

export const WorkDocumentsReference = TiptapNode.create({
  name: 'workDocumentsReference',
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
  parseHTML() { return [{ tag: 'div[data-flowix-work-documents-reference]' }]; },
  renderHTML({ node, HTMLAttributes }) {
    const attrs = normalizeWorkDocumentsReferenceAttrs(node.attrs);
    return ['div', mergeAttributes(HTMLAttributes, {
      'data-flowix-work-documents-reference': 'true',
      'data-notebook-id': attrs.notebookId ?? '',
      'data-relative-path': attrs.relativePath ?? '',
      'data-collection-id': attrs.collectionId ?? '',
      contenteditable: 'false',
      class: 'work-documents-reference-node',
    })];
  },
  addNodeView() {
    return ({ node, editor, view, getPos }) => new WorkDocumentsReferenceNodeView(node, editor, view, typeof getPos === 'function' ? getPos : () => undefined);
  },
  ...workDocumentsReferenceMarkdownSpec,
  renderMarkdown(node) {
    return `<!-- ${WORK_DOCUMENTS_REFERENCE_MARKER} ${JSON.stringify({ version: WORK_DOCUMENTS_REFERENCE_VERSION, ...normalizeWorkDocumentsReferenceAttrs(node.attrs) })} -->\n`;
  },
});
