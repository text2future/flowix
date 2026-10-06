import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { Plus, Table2 } from 'lucide-react';
import { files, externalDocuments } from '@platform/tauri/client';
import { useNoteStore } from '@features/memo/store/note-store';
import { joinNotebookMemoPath } from '@/lib/path';
import { Input } from '@shared/ui/input';
import { toast } from '@/lib/toast';
import { createTableDocumentFile } from './create-table-file';
import { parseTableDocumentAsync } from './parse-table-document';
import { type TableViewType } from './model';

interface InsertRange {
  from: number;
  to: number;
}

interface TableCandidate {
  notebookId: string;
  notebookName: string;
  notebookPath: string;
  relativePath: string;
  tableId: string;
  name: string;
}

export type TableReferencePickerAnchor =
  | { kind: 'slash'; rect: Pick<DOMRect, 'left' | 'top' | 'bottom'> }
  | { kind: 'button'; element: HTMLElement };

let pickerRoot: Root | null = null;
let pickerHost: HTMLDivElement | null = null;
let pickerGeneration = 0;
const PICKER_WIDTH = 272;
const VIEWPORT_PADDING = 8;

function isCurrentPicker(generation: number): boolean {
  return pickerGeneration === generation && pickerRoot !== null;
}

function closePicker(generation?: number) {
  if (generation !== undefined && generation !== pickerGeneration) return;
  pickerGeneration += 1;
  const root = pickerRoot;
  const host = pickerHost;
  pickerRoot = null;
  pickerHost = null;
  if (!root || !host) return;
  root.unmount();
  host.remove();
}

function updatePickerPosition(editor: Editor, position: number, anchor: TableReferencePickerAnchor) {
  const host = pickerHost;
  if (!host || editor.isDestroyed) return;
  try {
    const coords = editor.view.coordsAtPos(position);
    const anchorRect = anchor.kind === 'button' && anchor.element.isConnected
      ? anchor.element.getBoundingClientRect()
      : anchor.kind === 'slash'
        ? anchor.rect
        : coords;
    const width = Math.min(PICKER_WIDTH, window.innerWidth - VIEWPORT_PADDING * 2);
    host.style.width = `${width}px`;
    host.style.maxHeight = `${Math.min(320, Math.max(160, window.innerHeight - VIEWPORT_PADDING * 2))}px`;
    const menuHeight = Math.min(host.offsetHeight || 320, window.innerHeight - VIEWPORT_PADDING * 2);
    const requestedTop = anchor.kind === 'button' ? anchorRect.bottom : anchorRect.top;
    const top = Math.min(
      Math.max(requestedTop, VIEWPORT_PADDING),
      Math.max(VIEWPORT_PADDING, window.innerHeight - menuHeight - VIEWPORT_PADDING),
    );
    const left = Math.min(
      Math.max(anchorRect.left, VIEWPORT_PADDING),
      Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING),
    );
    host.style.top = `${top}px`;
    host.style.left = `${left}px`;
  } catch {
    closePicker();
  }
}

function TableReferencePicker({ editor, replaceRange, anchor, generation, preferredViewType, onClose }: {
  editor: Editor;
  replaceRange: InsertRange;
  anchor: TableReferencePickerAnchor;
  generation: number;
  preferredViewType?: TableViewType;
  onClose: () => void;
}) {
  const notebookItems = useNoteStore((state) => state.notebooks);
  const selectedNotebook = useNoteStore((state) => state.selectedNotebook);
  const notebooks = useMemo(() => notebookItems.filter((notebook) => !notebook.missing), [notebookItems]);
  const [candidates, setCandidates] = useState<TableCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [creatingTable, setCreatingTable] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    searchRef.current?.focus();
    const handleOutsidePointer = (event: MouseEvent) => {
      if (event.target instanceof Node && !pickerHost?.contains(event.target)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    const reposition = () => updatePickerPosition(editor, replaceRange.from, anchor);
    document.addEventListener('mousedown', handleOutsidePointer, true);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('mousedown', handleOutsidePointer, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [anchor, editor, onClose, replaceRange.from]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    void Promise.all(notebooks.map(async (notebook) => {
      try {
        const documents = await files.listTableDocuments(notebook.id);
        return {
          notebookName: notebook.name,
          candidates: documents.map((document) => ({
            notebookId: notebook.id,
            notebookName: notebook.name,
            notebookPath: notebook.path,
            relativePath: document.relativePath,
            tableId: document.tableId,
            name: document.name,
          })),
          readError: null,
        };
      } catch (error) {
        return {
          candidates: [],
          readError: error instanceof Error ? error.message : String(error),
          notebookName: notebook.name,
        };
      }
    })).then((results) => {
      if (!active) return;
      const available = results.flatMap((result) => result.candidates);
      available.sort((left, right) => (
        `${left.notebookName}/${left.relativePath}`.localeCompare(`${right.notebookName}/${right.relativePath}`)
      ));
      setCandidates(available);
      const failedNotebook = results.find((result) => result.readError !== null);
      if (available.length === 0 && failedNotebook?.readError) {
        setLoadError(`无法读取多维表格列表（${failedNotebook.notebookName}：${failedNotebook.readError}）`);
      }
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [notebooks]);

  const filteredCandidates = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return candidates;
    return candidates.filter((candidate) => (
      `${candidate.name} ${candidate.notebookName} ${candidate.relativePath}`.toLocaleLowerCase().includes(normalized)
    ));
  }, [candidates, query]);

  useLayoutEffect(() => {
    updatePickerPosition(editor, replaceRange.from, anchor);
  }, [anchor, editor, replaceRange.from, loading, loadError, filteredCandidates.length]);

  const attachReference = (candidate: TableCandidate, tableId: string, viewId: string | null) => {
    if (!isCurrentPicker(generation)) return;
    if (editor.isDestroyed || !editor.isEditable) {
      closePicker(generation);
      if (!editor.isDestroyed) toast.error('当前笔记为只读，无法插入多维表格引用');
      return;
    }
    const inserted = editor.chain().focus().insertContentAt(replaceRange, {
      type: 'tableReference',
      attrs: {
        notebookId: candidate.notebookId,
        relativePath: candidate.relativePath,
        tableId,
        viewId,
      },
    }).run();
    if (!inserted) throw new Error('无法在当前位置插入多维表格引用');
    closePicker(generation);
  };

  const openCandidate = async (candidate: TableCandidate) => {
    if (openingPath || !isCurrentPicker(generation)) return;
    setOpeningPath(candidate.relativePath);
    try {
      const filePath = joinNotebookMemoPath(candidate.notebookPath, candidate.relativePath);
      if (!filePath) throw new Error('多维表格路径无效');
      const source = await externalDocuments.read(filePath, candidate.notebookPath);
      if (!isCurrentPicker(generation)) return;
      const document = await parseTableDocumentAsync(source);
      if (document.table.id !== candidate.tableId) {
        throw new Error('表格文件已更新，请重新打开选择器后选择');
      }
      const view = document.table.views.find((entry) => entry.type === preferredViewType)
        ?? document.table.views[0];
      if (!view) throw new Error('多维表格没有可用视图');
      attachReference(candidate, document.table.id, view.id);
    } catch (error) {
      if (!isCurrentPicker(generation)) return;
      toast.error(error instanceof Error ? error.message : '读取多维表格失败');
      setOpeningPath(null);
    }
  };

  const createTable = async () => {
    const name = query.trim();
    if (!name || creatingTable || !isCurrentPicker(generation)) return;
    if (!selectedNotebook || selectedNotebook.missing) {
      toast.error('请先选择可用的笔记本');
      return;
    }
    if (editor.isDestroyed || !editor.isEditable) {
      closePicker(generation);
      if (!editor.isDestroyed) toast.error('当前笔记为只读，无法插入多维表格引用');
      return;
    }

    setCreatingTable(true);
    try {
      const preferences = await files.getNotebookViewPreferences(selectedNotebook.path);
      const created = await createTableDocumentFile(
        selectedNotebook.path,
        preferences.defaultCreateFolder,
        name,
        preferredViewType ?? 'table',
      );
      if (!isCurrentPicker(generation)) return;
      attachReference({
        notebookId: selectedNotebook.id,
        notebookName: selectedNotebook.name,
        notebookPath: selectedNotebook.path,
        relativePath: created.relativePath,
        tableId: created.table.table.id,
        name: created.name,
      }, created.table.table.id, created.table.table.views[0]?.id ?? null);
    } catch (error) {
      if (!isCurrentPicker(generation)) return;
      toast.error(error instanceof Error ? error.message : '创建多维表格失败');
      setCreatingTable(false);
    }
  };

  const viewTypeLabel = preferredViewType === 'kanban' ? '看板' : preferredViewType === 'calendar' ? '日历' : preferredViewType === 'gallery' ? '画廊列表' : '数据表';

  return <div className="slash-menu-dropdown table-reference-picker" role="dialog" aria-label="选择或新建多维表格">
    <label className="table-reference-picker__search">
      <Input
        ref={searchRef}
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (preferredViewType !== 'kanban') void createTable();
          }
        }}
        placeholder="输入名称新建 或 下方选择"
        className="h-7 min-w-0 flex-1 border-0 bg-transparent px-2 text-sm shadow-none focus-visible:border-0 focus-visible:ring-0"
      />
      {query.trim() && <button
        type="button"
        aria-label={preferredViewType === 'kanban' ? '新建多维表格、状态属性和看板' : `新建多维表格和${viewTypeLabel}视图`}
        title={preferredViewType === 'kanban' ? '同时新建状态属性' : `新建${viewTypeLabel}视图`}
        disabled={creatingTable}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void createTable()}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-50"
      ><Plus className="h-4 w-4" aria-hidden="true" /></button>}
    </label>
    {preferredViewType === 'kanban' && query.trim() && <div className="px-2 pb-1 text-xs text-[var(--muted-foreground)]">点击 + 创建表格时，会同时新增共享的“状态”单选属性。</div>}
    <div className="slash-menu-items-frame">
      <div className="slash-menu-items" role="listbox" aria-label="多维表格列表">
        {loading ? <div className="slash-menu-empty">正在读取多维表格…</div>
          : loadError ? <div className="slash-menu-empty text-[var(--destructive)]">{loadError}</div>
            : filteredCandidates.length === 0 ? <div className="slash-menu-empty">{candidates.length ? '没有匹配的多维表格' : '当前没有多维表格'}</div>
              : filteredCandidates.map((candidate) => <button
                key={`${candidate.notebookId}:${candidate.relativePath}`}
                type="button"
                role="option"
                aria-selected="false"
                disabled={openingPath !== null || creatingTable}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void openCandidate(candidate)}
                className="slash-menu-item disabled:opacity-50"
              >
                <Table2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="slash-menu-item-label min-w-0 flex-1">
                  <span className="block truncate">{candidate.name}</span>
                  <span className="block truncate text-xs text-[var(--muted-foreground)]">{candidate.notebookName} / {candidate.relativePath.split('/').pop()}</span>
                </span>
                {openingPath === candidate.relativePath && <span className="text-xs text-[var(--muted-foreground)]">读取中</span>}
              </button>)}
      </div>
    </div>
  </div>;
}

export function openTableReferencePicker(editor: Editor, replaceRange: InsertRange, anchor: TableReferencePickerAnchor, preferredViewType?: TableViewType) {
  closePicker();
  const generation = pickerGeneration;
  pickerHost = document.createElement('div');
  pickerHost.dataset.tableReferencePicker = 'true';
  pickerHost.style.position = 'fixed';
  pickerHost.style.zIndex = '2147483647';
  pickerHost.style.width = `${PICKER_WIDTH}px`;
  document.body.appendChild(pickerHost);
  pickerRoot = createRoot(pickerHost);
  pickerRoot.render(<TableReferencePicker
    editor={editor}
    replaceRange={replaceRange}
    anchor={anchor}
    generation={generation}
    preferredViewType={preferredViewType}
    onClose={() => closePicker(generation)}
  />);
  requestAnimationFrame(() => updatePickerPosition(editor, replaceRange.from, anchor));
}
