import type { Editor } from '@tiptap/core';
import { isEmptyMarkdownPlaceholderOnly } from './markdown-normalization';

/**
 * 编辑器文档层面的就地修正。这些操作只读写 ProseMirror 文档/插件状态，
 * 不持有 React 状态，也不参与 MarkdownEditor 的渲染 —— 从
 * `markdown-editor.tsx` 抽出即可让主文件回到冻结阈值内。
 */

/** 清掉任务项里仅剩占位符的段落内容（例如导入后残留的空 `<p>`）。 */
export function normalizeTaskItemPlaceholders(editor: Editor): void {
  const { state, view } = editor;
  const deletions: Array<{ from: number; to: number }> = [];

  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'taskItem') return true;

    const firstChild = node.firstChild;
    if (!firstChild || firstChild.type.name !== 'paragraph') return false;
    if (!isEmptyMarkdownPlaceholderOnly(firstChild.textContent)) return false;

    const paragraphPos = pos + 1;
    const from = paragraphPos + 1;
    const to = paragraphPos + firstChild.nodeSize - 1;
    if (from < to) {
      deletions.push({ from, to });
    }

    return false;
  });

  if (deletions.length > 0) {
    // All positions refer to the original document. Applying the ranges from
    // right to left keeps an earlier deletion from shifting a later range.
    const tr = state.tr;
    deletions
      .sort((a, b) => b.from - a.from)
      .forEach(({ from, to }) => tr.delete(from, to));
    tr.setMeta('addToHistory', false);
    view.dispatch(tr);
  }
}

/**
 * An authoritative external document replacement starts a new undo domain.
 * Reusing the existing history plugin would leave steps from the previous
 * document mapped against the replacement. Remove and re-register the same
 * plugin instance so its state is initialized empty without rebuilding the
 * editor view or its NodeViews.
 */
export function resetEditorHistory(editor: Editor): void {
  const historyPlugin = editor.state.plugins.find((plugin) => {
    const key = (plugin as unknown as { key?: string }).key;
    return key?.startsWith('history$') === true;
  });
  if (!historyPlugin) return;

  editor.unregisterPlugin('history');
  editor.registerPlugin(historyPlugin);
}
