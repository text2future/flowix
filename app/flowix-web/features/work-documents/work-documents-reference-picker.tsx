import { PopupScrollArea } from '@shared/ui/popup-scroll-area';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { Plus } from 'lucide-react';
import { collections, files } from '@platform/tauri/client';
import { useNotebookById } from '@features/memo/public/notebook-api';
import { canonicalPath, joinNotebookMemoPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import { CollectionResourceIcon } from '@features/collection/public/appearance-api';
import { createWorkDocumentsCollectionFile } from '@features/collection/public/work-documents-model-api';
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
} from '@features/collection/public/reference-picker-api';

function WorkDocumentsReferencePicker({ editor, replaceRange, generation, ownerNotebookId }: {
  editor: Editor;
  replaceRange: CollectionReferenceInsertRange;
  generation: number;
  ownerNotebookId: string | null;
}) {
  const ownerNotebook = useNotebookById(ownerNotebookId);
  const notebooks = useMemo(() => ownerNotebook ? [ownerNotebook] : [], [ownerNotebook]);
  const [candidates, setCandidates] = useState<CollectionReferenceCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const searchRef = useRef<HTMLTextAreaElement | null>(null);
  const current = () => isCollectionReferencePickerCurrent(generation);

  useEffect(() => { searchRef.current?.focus(); }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    void Promise.all(notebooks.map(async (notebook) => {
      try {
        const items = await collections.list(notebook.id, 'work_documents');
        return {
          notebook,
          items: items.filter((item) => item.collectionType === 'work_documents' && item.collectionId && !item.identityConflict && item.parseState === 'valid'),
          error: null as string | null,
        };
      } catch (error) {
        return { notebook, items: [], error: error instanceof Error ? error.message : String(error) };
      }
    })).then((results) => {
      if (!active) return;
      const available = results.flatMap(({ notebook, items }) => items.map((item) => ({
        notebookId: notebook.id,
        notebookName: notebook.name,
        notebookPath: notebook.path,
        relativePath: item.relativePath,
        collectionId: item.collectionId!,
        name: item.name,
      })));
      available.sort((left, right) => `${left.notebookName}/${left.relativePath}`.localeCompare(`${right.notebookName}/${right.relativePath}`));
      setCandidates(available);
      const failure = results.find((result) => result.error);
      if (available.length === 0 && failure?.error) setLoadError(`无法读取资料列表（${failure.notebook.name}：${failure.error}）`);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [notebooks]);

  const filtered = useMemo(() => filterCollectionCandidates(candidates, query), [candidates, query]);
  const navigation = useCollectionPickerListNavigation(filtered.length, query);

  useLayoutEffect(() => {
    const textarea = searchRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const contentHeight = textarea.scrollHeight + 2;
    textarea.style.height = `${Math.min(contentHeight, window.innerHeight * 0.5)}px`;
  }, [query]);

  const insert = (candidate: CollectionReferenceCandidate): boolean => {
    if (!current()) return false;
    if (candidate.notebookId !== editor.storage.attachmentLink?.getNotebookId?.()) {
      toast.warning('只能插入当前笔记本中的资料列表');
      return false;
    }
    if (editor.isDestroyed || !editor.isEditable) {
      closeCollectionReferencePicker(generation);
      if (!editor.isDestroyed) toast.error('当前笔记为只读，无法插入资料列表');
      return false;
    }
    const inserted = editor.chain().focus().insertContentAt(replaceRange, {
      type: 'workDocumentsReference',
      attrs: { notebookId: candidate.notebookId, relativePath: candidate.relativePath, collectionId: candidate.collectionId },
    }).run();
    if (!inserted) {
      toast.error('无法在当前位置插入资料列表');
      return false;
    }
    closeCollectionReferencePicker(generation);
    return true;
  };

  const create = async () => {
    const name = query.trim();
    if (!name || loading || creating || !current()) return;
    if (!ownerNotebook || ownerNotebook.id !== editor.storage.attachmentLink?.getNotebookId?.()) {
      toast.error('无法确定当前笔记本');
      return;
    }
    if (editor.isDestroyed || !editor.isEditable) {
      closeCollectionReferencePicker(generation);
      if (!editor.isDestroyed) toast.error('当前笔记为只读，无法插入资料列表');
      return;
    }
    setCreating(true);
    try {
      const preferences = await files.getNotebookViewPreferences(ownerNotebook.path);
      const created = await createWorkDocumentsCollectionFile(ownerNotebook.path, preferences.defaultCreateFolder, name);
      if (!current()) return;
      if (editor.storage.attachmentLink?.getNotebookId?.() !== ownerNotebook.id) {
        toast.warning('当前笔记本已切换，请在当前笔记本中重新插入资料列表');
        setCreating(false);
        return;
      }
      const root = canonicalPath(ownerNotebook.path).replace(/\/+$/, '');
      const canonicalFile = canonicalPath(created.filePath);
      const relativePath = canonicalFile.startsWith(`${root}/`) ? canonicalFile.slice(root.length + 1) : null;
      if (!relativePath) throw new Error('资料列表路径不在当前笔记本内');
      const collectionName = created.relativePath.split('/').pop()?.replace(/\.index\.ya?ml$/i, '') || name;
      const candidate: CollectionReferenceCandidate = {
        notebookId: ownerNotebook.id,
        notebookName: ownerNotebook.name,
        notebookPath: ownerNotebook.path,
        relativePath,
        collectionId: created.document.collection.id,
        name: collectionName,
      };
      if (!insert(candidate)) {
        if (!current()) return;
        setCandidates((existing) => {
          if (existing.some((item) => item.notebookId === candidate.notebookId && item.relativePath === candidate.relativePath)) {
            return existing;
          }
          return [...existing, candidate].sort((left, right) => `${left.notebookName}/${left.relativePath}`.localeCompare(`${right.notebookName}/${right.relativePath}`));
        });
        setCreating(false);
      }
    } catch (error) {
      if (!current()) return;
      toast.error(error instanceof Error ? error.message : '创建资料列表失败');
      setCreating(false);
    }
  };

  return <div className={`slash-menu-dropdown table-reference-picker${navigation.keyboardNavigation ? ' is-keyboard-navigation' : ''}`} role="dialog" aria-label="插入资料数据库">
    <div className="table-reference-picker__title" role="heading" aria-level={2}>插入资料数据库</div>
    <div className="table-reference-picker__search flex shrink-0 items-start gap-1 px-2">
      <textarea ref={searchRef} rows={1} value={query} onChange={(event) => setQuery(event.currentTarget.value)} onKeyDown={(event) => {
        navigation.onInputKeyDown(event);
        if (event.key === 'Enter' && !event.nativeEvent.isComposing && !event.shiftKey) {
          event.preventDefault();
          const candidate = filtered[navigation.activeIndex] ?? filtered[0];
          if (candidate) insert(candidate);
          else void create();
        }
      }} placeholder="输入名称搜索或新建" className="multidimensional-table__primary-title-input min-w-0 flex-1 !py-2" />
      {query.trim() && <button type="button" aria-label="新建资料列表" title="新建资料列表" disabled={loading || creating} onMouseDown={(event) => event.preventDefault()} onClick={() => void create()} className="mt-0.5 flex h-8 w-8 shrink-0 self-start items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-50"><Plus className="h-4 w-4" aria-hidden="true" /></button>}
    </div>
    <PopupScrollArea className="slash-menu-items-frame" scrollerClassName="slash-menu-items" scrollerProps={{ role: 'listbox', 'aria-label': '资料列表' }}>
        <div className="slash-menu-header" role="presentation"><span>关联</span></div>
        {loading ? <div className="slash-menu-empty">正在读取资料列表…</div>
          : loadError ? <div className="slash-menu-empty text-[var(--destructive)]">{loadError}</div>
            : filtered.length === 0 ? <div className="slash-menu-empty">{candidates.length ? '没有匹配的资料列表' : '当前没有资料列表'}</div>
              : filtered.map((candidate, index) => <button key={`${candidate.notebookId}:${candidate.relativePath}`} ref={(element) => { navigation.optionRefs.current[index] = element; }} type="button" role="option" aria-selected={navigation.isSelected(index)} disabled={creating} onMouseMove={() => navigation.onOptionMouseMove(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => insert(candidate)} className={`slash-menu-item disabled:opacity-50${navigation.isSelected(index) ? ' is-selected' : ''}`}>
                <CollectionResourceIcon filePath={joinNotebookMemoPath(candidate.notebookPath, candidate.relativePath) ?? candidate.relativePath} notebookPath={candidate.notebookPath} fallbackType="work_documents" className="h-4 w-4 shrink-0" loadWhenVisible />
                <span className="table-reference-picker__candidate-label min-w-0 flex-1">
                  <span className="slash-menu-item-label">{candidate.name}</span>
                  <span className="table-reference-picker__candidate-folder">{collectionCandidateFolderLabel(candidate)}</span>
                </span>
              </button>)}
    </PopupScrollArea>
  </div>;
}

export function openWorkDocumentsReferencePicker(editor: Editor, replaceRange: CollectionReferenceInsertRange, anchor: CollectionReferencePickerAnchor) {
  const ownerNotebookId = editor.storage.attachmentLink?.getNotebookId?.() ?? null;
  openCollectionReferencePicker(editor, replaceRange, anchor, 'work-documents', (generation) => <WorkDocumentsReferencePicker
    editor={editor}
    replaceRange={replaceRange}
    generation={generation}
    ownerNotebookId={ownerNotebookId}
  />);
}
