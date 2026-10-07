import { useCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Node as TiptapNode, mergeAttributes, type Editor, type MarkdownToken } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorView, NodeView as ProseMirrorNodeView } from '@tiptap/pm/view';
import { X } from 'lucide-react';
import { ArrowUpRightIcon, ArrowsLeftRightIcon } from '@phosphor-icons/react';
import { openCollectionTarget } from '@features/workspace/use-cases/workspace-navigation';
import { useNoteStore } from '@features/memo/store/note-store';
import { useAppLanguage } from '@features/preferences/public/runtime-api';
import { I18nProvider } from '@/lib/i18n/provider';
import { canonicalDirectoryPath, canonicalPath } from '@/lib/path';
import { useCollectionReference } from '@features/collection/use-collection-reference';
import { toast } from '@/lib/toast';
import { Button } from '@shared/ui/button';
import { TableDocumentView } from './table-document-view';
import { openTableReferencePicker } from './table-reference-picker';

const TABLE_REFERENCE_MARKER = 'flowix:table-reference';
const TABLE_REFERENCE_VERSION = 1;
const EDITOR_EDITABILITY_CHANGE_EVENT = 'flowix:editor-editability-change';

export interface TableReferenceAttrs {
  notebookId: string | null;
  relativePath: string | null;
  collectionId: string | null;
  viewId: string | null;
}

function normalizeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeAttrs(value: unknown): TableReferenceAttrs {
  const attrs = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    notebookId: normalizeText(attrs.notebookId),
    relativePath: normalizeText(attrs.relativePath)?.replace(/\\/g, '/').replace(/^\/+/, '') ?? null,
    collectionId: normalizeText(attrs.collectionId),
    viewId: normalizeText(attrs.viewId),
  };
}

function metadataFromSource(source: string): Record<string, unknown> | null {
  const match = new RegExp(`^<!--[ \\t]*${TABLE_REFERENCE_MARKER}[ \\t]+(\\{[^\\r\\n]*\\})[ \\t]*-->(?:\\r?\\n|$)`).exec(source);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

class TableReferenceNodeView implements ProseMirrorNodeView {
  readonly dom: HTMLElement;
  private readonly root: Root;
  private node: ProseMirrorNode;
  private destroyed = false;
  private readonly handleEditabilityChange = () => this.render();

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
  }

  private render() {
    if (this.destroyed) return;
    const attrs = normalizeAttrs(this.node.attrs);
    this.root.render(<TableReferenceSurface
      attrs={attrs}
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
    openTableReferencePicker(this.editor, { from: pos, to: pos + node.nodeSize }, { kind: 'button', element: anchor });
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type.name !== 'tableReference') return false;
    this.node = node;
    this.render();
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
    this.root.unmount();
  }
}

function TableReferenceSurface({ attrs, editable, onViewChange, onRelativePathChange, onReplace, onRemove }: {
  attrs: TableReferenceAttrs;
  editable: boolean;
  onViewChange: (viewId: string) => void;
  onRelativePathChange: (relativePath: string) => void;
  onReplace: (anchor: HTMLElement) => void;
  onRemove: () => void;
}) {
  const language = useAppLanguage();
  const notebook = useNoteStore((state) => state.notebooks.find((item) => item.id === attrs.notebookId));
  const reference = useCollectionReference(notebook, attrs.collectionId, 'table', attrs.viewId);
  const fileIdentity = reference.fileIdentity;
  const filePath = fileIdentity?.path ?? null;
  const displayName = reference.item?.name ?? '多维表格';

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
      await openCollectionTarget({ notebookId: notebook.id, collectionId: attrs.collectionId, viewId: attrs.viewId });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法打开多维表格');
    }
  }, [attrs.collectionId, attrs.viewId, notebook]);

  return <I18nProvider language={language}>
    <section className="table-reference-node__surface" contentEditable={false} aria-label={`多维表格：${displayName}`}>
      {!attrs.notebookId || !attrs.collectionId
        ? <div className="table-reference-node__message">此多维表格引用信息不完整。</div>
        : !notebook
          ? <div className="table-reference-node__message">找不到引用所在的笔记本。</div>
          : !filePath
            ? <div className="table-reference-node__message">{reference.error ?? '正在定位多维表格…'}</div>
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
                canDeleteViews={false}
                onActiveViewChange={onViewChange}
                onFilePathChange={handleFilePathChange}
                trailingActions={(datasetAction) =>
                  <div className="multidimensional-table__view-nav-actions">
                    {datasetAction}
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
    const attrs = normalizeAttrs(node.attrs);
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

  markdownTokenizer: {
    name: 'tableReference',
    level: 'block' as const,
    start(source: string) {
      const match = new RegExp(`^<!--[ \\t]*${TABLE_REFERENCE_MARKER}[ \\t]+\\{`, 'm').exec(source);
      return match?.index ?? -1;
    },
    tokenize(source: string) {
      const metadata = metadataFromSource(source);
      if (!metadata) return undefined;
      const match = new RegExp(`^<!--[ \\t]*${TABLE_REFERENCE_MARKER}[ \\t]+\\{[^\\r\\n]*\\}[ \\t]*-->(?:\\r?\\n|$)`).exec(source);
      if (!match) return undefined;
      return { type: 'tableReference', raw: match[0], metadata };
    },
  },

  parseMarkdown(token: MarkdownToken) {
    const metadata = token.metadata && typeof token.metadata === 'object'
      ? token.metadata as Record<string, unknown>
      : metadataFromSource(token.raw ?? '') ?? {};
    const data = metadata.version === TABLE_REFERENCE_VERSION ? metadata : {};
    return { type: 'tableReference', attrs: normalizeAttrs(data) };
  },

  renderMarkdown(node) {
    const attrs = normalizeAttrs(node.attrs);
    return `<!-- ${TABLE_REFERENCE_MARKER} ${JSON.stringify({ version: TABLE_REFERENCE_VERSION, ...attrs })} -->\n`;
  },
});
