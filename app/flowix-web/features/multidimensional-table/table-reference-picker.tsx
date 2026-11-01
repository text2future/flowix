import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { Plus, Table2 } from 'lucide-react';
import { files, externalDocuments } from '@platform/tauri/client';
import { useNoteStore } from '@features/memo/store/note-store';
import { joinNotebookMemoPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import { createTableDocumentFile } from './create-table-file';
import { parseTableDocumentAsync } from './parse-table-document';
import { addCalendarDateView, addKanbanView, addTableView, serializeTableDocument, type TableViewType } from './model';
import {
  closeCollectionReferencePicker,
  collectionCandidateFolderLabel,
  filterCollectionCandidates,
  isCollectionReferencePickerCurrent,
  openCollectionReferencePicker,
  useCollectionPickerListNavigation,
  type CollectionReferenceCandidate,
  type CollectionReferenceInsertRange,
  type CollectionReferencePickerAnchor,
} from '@features/collection/reference-picker';
import { collectionSourceDomain, collectionWriteContent } from '@features/collection/public/hybrid-api';

function TableReferencePicker({ editor, replaceRange, generation, preferredViewType, ownerNotebookId }: {
  editor: Editor;
  replaceRange: CollectionReferenceInsertRange;
  generation: number;
  preferredViewType?: TableViewType;
  ownerNotebookId: string | null;
}) {
  const ownerNotebook = useNoteStore((state) => state.notebooks.find((notebook) => notebook.id === ownerNotebookId && !notebook.missing));
  const notebooks = useMemo(() => ownerNotebook ? [ownerNotebook] : [], [ownerNotebook]);
  const [candidates, setCandidates] = useState<CollectionReferenceCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [creatingTable, setCreatingTable] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const searchRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

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
            collectionId: document.collectionId,
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

  const filteredCandidates = useMemo(() => filterCollectionCandidates(candidates, query), [candidates, query]);
  const navigation = useCollectionPickerListNavigation(filteredCandidates.length, query);

  useLayoutEffect(() => {
    const textarea = searchRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(textarea.scrollHeight + 2, window.innerHeight * 0.5)}px`;
  }, [query]);

  const attachReference = (candidate: CollectionReferenceCandidate, collectionId: string, viewId: string | null) => {
    if (!isCollectionReferencePickerCurrent(generation)) return;
    if (candidate.notebookId !== editor.storage.attachmentLink?.getNotebookId?.()) {
      toast.warning('只能插入当前笔记本中的多维表格');
      setOpeningPath(null);
      return;
    }
    if (editor.isDestroyed || !editor.isEditable) {
      closeCollectionReferencePicker(generation);
      if (!editor.isDestroyed) toast.error('当前笔记为只读，无法插入多维表格引用');
      return;
    }
    const inserted = editor.chain().focus().insertContentAt(replaceRange, {
      type: 'tableReference',
      attrs: {
        notebookId: candidate.notebookId,
        relativePath: candidate.relativePath,
        collectionId,
        viewId,
      },
    }).run();
    if (!inserted) throw new Error('无法在当前位置插入多维表格引用');
    closeCollectionReferencePicker(generation);
  };

  const openCandidate = async (candidate: CollectionReferenceCandidate) => {
    if (openingPath || !isCollectionReferencePickerCurrent(generation)) return;
    setOpeningPath(candidate.relativePath);
    try {
      const filePath = joinNotebookMemoPath(candidate.notebookPath, candidate.relativePath);
      if (!filePath) throw new Error('多维表格路径无效');
      const source = await externalDocuments.read(filePath, candidate.notebookPath);
      if (!isCollectionReferencePickerCurrent(generation)) return;
      if (candidate.notebookId !== editor.storage.attachmentLink?.getNotebookId?.()) {
        setOpeningPath(null);
        return;
      }
      const document = await parseTableDocumentAsync(source);
      if (document.collection.id !== candidate.collectionId) {
        throw new Error('表格文件已更新，请重新打开选择器后选择');
      }
      let targetDocument = document;
      let view = preferredViewType
        ? targetDocument.views.items.find((entry) => entry.layout === preferredViewType)
        : targetDocument.views.items.find((entry) => entry.id === targetDocument.views.default_id) ?? targetDocument.views.items[0];
      if (preferredViewType && !view) {
        if (preferredViewType === 'kanban') {
          const addedView = addKanbanView(targetDocument);
          targetDocument = addedView.document;
          view = addedView.view;
        } else if (preferredViewType === 'calendar') {
          const addedView = addCalendarDateView(targetDocument);
          targetDocument = addedView.document;
          view = addedView.view;
        } else {
          const addedView = addTableView(targetDocument, preferredViewType);
          targetDocument = addedView.document;
          view = addedView.view;
        }
        const writeDomain = collectionSourceDomain(source, 'table');
        const result = await externalDocuments.write({
          filePath,
          content: collectionWriteContent({ source, domain: writeDomain, document: targetDocument, serialize: serializeTableDocument }),
          expectedContent: source,
          scopePath: candidate.notebookPath,
        });
        if (result.status !== 'saved') throw new Error(result.status === 'conflict' ? '多维表格已被其他操作修改，请重新选择' : '多维表格文件已不存在');
      }
      if (!view) throw new Error('多维表格没有可用视图');
      attachReference(candidate, document.collection.id, view.id);
    } catch (error) {
      if (!isCollectionReferencePickerCurrent(generation)) return;
      toast.error(error instanceof Error ? error.message : '读取多维表格失败');
      setOpeningPath(null);
    }
  };

  const createTable = async () => {
    const name = query.trim();
    if (!name || creatingTable || !isCollectionReferencePickerCurrent(generation)) return;
    if (!ownerNotebook || ownerNotebook.id !== editor.storage.attachmentLink?.getNotebookId?.()) {
      toast.error('无法确定当前笔记本');
      return;
    }
    if (editor.isDestroyed || !editor.isEditable) {
      closeCollectionReferencePicker(generation);
      if (!editor.isDestroyed) toast.error('当前笔记为只读，无法插入多维表格引用');
      return;
    }

    setCreatingTable(true);
    try {
      const preferences = await files.getNotebookViewPreferences(ownerNotebook.path);
      const created = await createTableDocumentFile(
        ownerNotebook.path,
        preferences.defaultCreateFolder,
        name,
        preferredViewType ?? 'table',
      );
      if (!isCollectionReferencePickerCurrent(generation)) return;
      if (editor.storage.attachmentLink?.getNotebookId?.() !== ownerNotebook.id) {
        toast.warning('当前笔记本已切换，请在当前笔记本中重新插入多维表格');
        setCreatingTable(false);
        return;
      }
      attachReference({
        notebookId: ownerNotebook.id,
        notebookName: ownerNotebook.name,
        notebookPath: ownerNotebook.path,
        relativePath: created.relativePath,
        collectionId: created.table.collection.id,
        name: created.name,
      }, created.table.collection.id, created.table.views.items[0]?.id ?? null);
    } catch (error) {
      if (!isCollectionReferencePickerCurrent(generation)) return;
      toast.error(error instanceof Error ? error.message : '创建多维表格失败');
      setCreatingTable(false);
    }
  };

  const viewTypeLabel = preferredViewType === 'kanban' ? '看板' : preferredViewType === 'calendar' ? '日历' : preferredViewType === 'gallery' ? '画廊' : '表格';

  return <div className={`slash-menu-dropdown table-reference-picker${navigation.keyboardNavigation ? ' is-keyboard-navigation' : ''}`} role="dialog" aria-label="选择或新建多维表格">
    <div className="table-reference-picker__search flex shrink-0 items-start gap-1">
      <textarea
        ref={searchRef}
        rows={1}
        value={query}
        onChange={(event) => {
          setQuery(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          navigation.onInputKeyDown(event);
          if (event.key === 'Enter' && !event.nativeEvent.isComposing && !event.shiftKey) {
            event.preventDefault();
            const candidate = filteredCandidates[navigation.activeIndex];
            if (candidate) {
              void openCandidate(candidate);
            } else void createTable();
          }
        }}
        placeholder="输入名称搜索 或 新建"
        className="min-h-8 max-h-[50vh] min-w-0 flex-1 shrink-0 resize-none overflow-y-auto border-0 bg-transparent px-2 py-2 text-sm leading-5 shadow-none focus-visible:border-0 focus-visible:ring-0"
      />
      {query.trim() && <button
        type="button"
        aria-label={preferredViewType === 'kanban' ? '新建多维表格、状态属性和看板' : `新建多维表格和${viewTypeLabel}视图`}
        title={preferredViewType === 'kanban' ? '同时新建状态属性' : `新建${viewTypeLabel}视图`}
        disabled={creatingTable}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void createTable()}
        className="flex h-8 w-10 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-50"
      ><Plus className="h-4 w-4" aria-hidden="true" /></button>}
    </div>
    {preferredViewType === 'kanban' && query.trim() && <div className="px-2 pb-1 text-xs text-[var(--muted-foreground)]">点击 + 创建表格时，会同时新增共享的“状态”单选属性。</div>}
    <div className="slash-menu-items-frame">
      <div className="slash-menu-items" role="listbox" aria-label="多维表格列表">
        <div className="slash-menu-header" role="presentation"><span>选择已创建集合插入</span></div>
        {loading ? <div className="slash-menu-empty">正在读取多维表格…</div>
          : loadError ? <div className="slash-menu-empty text-[var(--destructive)]">{loadError}</div>
            : filteredCandidates.length === 0 ? <div className="slash-menu-empty">{candidates.length ? '没有匹配的多维表格' : '当前没有多维表格'}</div>
              : filteredCandidates.map((candidate, index) => <button
                key={`${candidate.notebookId}:${candidate.relativePath}`}
                ref={(element) => { navigation.optionRefs.current[index] = element; }}
                type="button"
                role="option"
                aria-selected={navigation.isSelected(index)}
                className={`slash-menu-item disabled:opacity-50${navigation.isSelected(index) ? ' is-selected' : ''}`}
                disabled={openingPath !== null || creatingTable}
                onMouseMove={() => navigation.onOptionMouseMove(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void openCandidate(candidate)}
              >
                <Table2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="slash-menu-item-label min-w-0 flex-1">{candidate.name}</span>
                <span className="slash-menu-item-description max-w-[42%]">{collectionCandidateFolderLabel(candidate)}</span>
                {openingPath === candidate.relativePath && <span className="text-xs text-[var(--muted-foreground)]">读取中</span>}
              </button>)}
      </div>
    </div>
  </div>;
}

export function openTableReferencePicker(editor: Editor, replaceRange: CollectionReferenceInsertRange, anchor: CollectionReferencePickerAnchor, preferredViewType?: TableViewType) {
  const ownerNotebookId = editor.storage.attachmentLink?.getNotebookId?.() ?? null;
  openCollectionReferencePicker(editor, replaceRange, anchor, 'table', (generation) => <TableReferencePicker
    editor={editor}
    replaceRange={replaceRange}
    generation={generation}
    preferredViewType={preferredViewType}
    ownerNotebookId={ownerNotebookId}
  />);
}
