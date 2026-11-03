import type { Editor } from '@tiptap/core';
import { AllSelection, NodeSelection, TextSelection } from '@tiptap/pm/state';
import {
  attachSessionViewCapture,
  type useSessionViewChannel,
} from '@features/workspace/public/session-view-state-api';

type SessionViewChannel = ReturnType<typeof useSessionViewChannel>;

export interface EditorViewRecovery {
  /** 记下当前选区/滚动位置（内部节流, 可频繁调用）。 */
  schedule: () => void;
  dispose: () => void;
}

/**
 * 编辑器实例创建后的「视图状态续接」：把上一个会话残留的选区与滚动位置应用上去,
 * 之后持续回写。属于适配层逻辑（DOM + ProseMirror selection）, 与组件渲染无关,
 * 因此独立成模块, 让 markdown-editor 只保留一行挂载/一行清理。
 */
export function attachEditorViewRecovery(
  editor: Editor,
  channel: SessionViewChannel,
  scrollEl: HTMLElement | null,
): EditorViewRecovery {
  const saved = channel?.read();
  if (saved?.kind === 'editor') {
    const max = editor.state.doc.content.size;
    const anchor = Math.min(saved.anchor, max);
    const node = editor.state.doc.nodeAt(anchor);
    const selection = saved.selectionType === 'all' ? new AllSelection(editor.state.doc)
      : saved.selectionType === 'node' && node && NodeSelection.isSelectable(node) ? NodeSelection.create(editor.state.doc, anchor)
      : TextSelection.between(editor.state.doc.resolve(anchor), editor.state.doc.resolve(Math.min(saved.head, max)));
    editor.view.dispatch(editor.state.tr.setSelection(selection).setMeta('addToHistory', false));
  }

  const restoreScroll = () => {
    if (scrollEl && saved?.kind === 'editor') {
      scrollEl.scrollTop = saved.scrollTop;
      scrollEl.scrollLeft = saved.scrollLeft;
    }
  };
  restoreScroll();
  // 首屏布局可能尚未完成, 下一帧再贴一次。
  const restoreFrame = requestAnimationFrame(restoreScroll);

  const capture = attachSessionViewCapture(channel, () => ({ kind: 'editor',
    anchor: editor.state.selection.anchor, head: editor.state.selection.head,
    selectionType: editor.state.selection instanceof AllSelection ? 'all' : editor.state.selection instanceof NodeSelection ? 'node' : 'text',
    scrollTop: scrollEl?.scrollTop ?? 0, scrollLeft: scrollEl?.scrollLeft ?? 0 }));
  editor.on('selectionUpdate', capture.schedule);

  return {
    schedule: capture.schedule,
    dispose: () => {
      cancelAnimationFrame(restoreFrame);
      editor.off('selectionUpdate', capture.schedule);
      capture.dispose();
    },
  };
}
