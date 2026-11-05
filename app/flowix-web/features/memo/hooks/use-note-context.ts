import { useNoteStore, type Notebook } from '@features/memo/store/note-store';
import { joinNotebookMemoPath } from '@/lib/path';
import type { NoteListItem } from '@/types/note-item';

export interface NoteContext {
  /** 笔记所属笔记本；重命名等笔记本范围的写入需要它。 */
  notebook: Notebook | null;
  /** 笔记自身的绝对路径。文档相对路径（缩略图、附件）以它为基准解析。 */
  documentPath: string | null;
}

/**
 * 按 `memo.notebookId` 定位笔记本，而不是假定「当前选中笔记本」── 置顶区、
 * 搜索结果这类列表会混排其它笔记本的条目，用 selectedNotebook 会拼错路径。
 */
export function useNoteContext(
  memo: Pick<NoteListItem, 'notebookId' | 'relativePath'>,
): NoteContext {
  // 返回 store 里既有的对象引用或 null，不新建对象，避免无谓重渲染。
  const notebook = useNoteStore(
    (state) => state.notebooks.find((item) => item.id === memo.notebookId)
      ?? state.selectedNotebook
      ?? null,
  );
  return {
    notebook,
    documentPath: notebook?.path ? joinNotebookMemoPath(notebook.path, memo.relativePath) : null,
  };
}
