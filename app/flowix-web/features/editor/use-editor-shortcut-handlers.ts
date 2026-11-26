import { useEffect, type RefObject } from 'react';
import type { Editor } from '@tiptap/core';
import { pushHandler } from '@/lib/shortcuts';
import { selectEditableDocumentContent } from '@features/editor/extensions/frontmatter';
import { applyListType } from '@features/editor/extensions/list-transforms';

export function useEditorShortcutHandlers(editorRef: RefObject<Editor | null>, handleSearchPanelOpenChange: (open: boolean) => void) {
  // 把 editor.find / editor.undo / editor.redo 以及块级格式 action 的实例级
  // handler 注册到全局 handler-registry。组件卸载时 pop 走 — 命令面板
  // (Phase 3) 仍能从 registry 读到 action 列表, 但 run 落到空栈, 行为退化
  // 为 no-op。编辑器命令附带真实 DOM focus 检查，避免多列同时挂载时把
  // 命令发给最后挂载而非当前活动的编辑器。
  //
  useEffect(() => {
    const editorIsFocused = () => {
      const editor = editorRef.current;
      if (!editor || editor.isDestroyed) return false;
      try {
        return editor.view.hasFocus();
      } catch {
        return false;
      }
    };
    const pops = [
      pushHandler('editor.selectAll', () => {
        const editor = editorRef.current;
        if (!editor) return false;
        return selectEditableDocumentContent(editor);
      }, { isActive: editorIsFocused }),
      pushHandler('editor.find', () => {
        handleSearchPanelOpenChange(true);
      }, { isActive: editorIsFocused }),
      pushHandler('editor.undo', () => {
        return editorRef.current?.commands.undo() ?? false;
      }, { isActive: editorIsFocused }),
      pushHandler('editor.redo', () => {
        return editorRef.current?.commands.redo() ?? false;
      }, { isActive: editorIsFocused }),
      // 块元素切换 (⌘1-4 / ⌘0 / ⌘⇧7-9) — 与 drag-context-menu items.tsx
      // 里的菜单项一一对应, 走同一组 Tiptap chain().focus().toggleXxx() 命令。
      // focus() 先调用是为了: 用户可能从标题输入框等地方按快捷键,
      // focus 保证命令落到编辑器内的当前 block。
      pushHandler('editor.setHeading1', () => {
        editorRef.current?.chain().focus().toggleHeading({ level: 1 }).run();
      }, { isActive: editorIsFocused }),
      pushHandler('editor.setHeading2', () => {
        editorRef.current?.chain().focus().toggleHeading({ level: 2 }).run();
      }, { isActive: editorIsFocused }),
      pushHandler('editor.setHeading3', () => {
        editorRef.current?.chain().focus().toggleHeading({ level: 3 }).run();
      }, { isActive: editorIsFocused }),
      pushHandler('editor.setHeading4', () => {
        editorRef.current?.chain().focus().toggleHeading({ level: 4 }).run();
      }, { isActive: editorIsFocused }),
      pushHandler('editor.setParagraph', () => {
        editorRef.current?.chain().focus().setParagraph().run();
      }, { isActive: editorIsFocused }),
      pushHandler('editor.toggleBulletList', () => {
        if (editorRef.current) applyListType(editorRef.current, 'bulletList');
      }, { isActive: editorIsFocused }),
      pushHandler('editor.toggleOrderedList', () => {
        if (editorRef.current) applyListType(editorRef.current, 'orderedList');
      }, { isActive: editorIsFocused }),
      pushHandler('editor.toggleTaskList', () => {
        if (editorRef.current) applyListType(editorRef.current, 'taskList');
      }, { isActive: editorIsFocused }),
    ];
    return () => {
      for (const pop of pops) pop();
    };
  }, [handleSearchPanelOpenChange]);

}
