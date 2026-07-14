import { useEffect } from 'react';
import { useShortcutsContext } from '@features/shortcuts/shortcuts-provider';
import type { Scope } from '@features/shortcuts';

/**
 * 声明当前组件子树需要某个 scope — mount 时 push 到 Provider 的栈, unmount 时 pop。
 *
 * 用法 (编辑器 mount 时):
 *
 *   function TiptapEditor() {
 *     useShortcutScope('editor');
 *     return <EditorContent ... />;
 *   }
 *
 * 多次调用会得到多个 scope 同进栈, 弹栈顺序与 push 严格对应 (LIFO)。
 * 这样嵌套的编辑器也能正确表达 "我在 editor 上下文里"。
 */
export function useShortcutScope(scope: Scope): void {
  const ctx = useShortcutsContext();
  useEffect(() => {
    const pop = ctx.pushScope(scope);
    return pop;
  }, [ctx, scope]);
}
