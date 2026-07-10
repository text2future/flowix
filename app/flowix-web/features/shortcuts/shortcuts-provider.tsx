'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { chordMatches, isInEditableField, scopeAllows } from '@features/shortcuts/matcher';
import { getPlatform } from '@features/shortcuts';
import { listActions, resolveBinding } from '@features/shortcuts/registry';
import type { ActionContext, Scope, ShortcutOverrides } from '@features/shortcuts';

/**
 * <ShortcutsProvider> — 顶层组件, 维护:
 *  1. scope 栈 (ref — 修改不触发 re-render, 避免每次 keydown 抖动整树)
 *  2. overrides 镜像 (ref + state 双写 — UI 重渲染用 state, keydown 读取用 ref)
 *  3. 单 keydown 监听 (挂在 window, 一次 mount 一次 unmount)
 *
 * 匹配流程:
 *   keydown → 算 activeScope & editable → listActions() 顺序遍历
 *     → 跳过 scope 不匹配的
 *     → resolveBinding + chordMatches
 *     → 第一个命中: preventDefault + 调 action.run
 *     → 后续 action 不再参与 (first match wins)
 *
 * first match wins 的理由: listActions 顺序由 defineAction 调用顺序决定, 自然
 * 表达"后注册的覆盖先注册的"。如果两个 action 撞 binding, 后定义的赢,
 * 另一个彻底拿不到这个键 (而不是随机触发, 那是 bug 温床)。
 */

export interface ShortcutsContextValue {
  /**
   * Push scope 到栈顶, 返回 pop 函数。
   * Provider 的 keydown handler 总是检查栈顶第一个 'editor' 是否存在 (后面有算法)。
   */
  pushScope: (scope: Scope) => () => void;
  /** 当前 overrides 镜像 — 暴露给偏好 UI 用。 */
  overrides: ShortcutOverrides;
}

const ShortcutsContext = createContext<ShortcutsContextValue | null>(null);

export function useShortcutsContext(): ShortcutsContextValue {
  const ctx = useContext(ShortcutsContext);
  if (!ctx) {
    throw new Error('useShortcutsContext must be used inside <ShortcutsProvider>');
  }
  return ctx;
}

export interface ShortcutsProviderProps {
  /** 用户覆盖层, 来自 UserSettings.shortcuts。 */
  overrides: ShortcutOverrides;
  children: React.ReactNode;
}

export function ShortcutsProvider({ overrides, children }: ShortcutsProviderProps) {
  // scope 栈: ref 不触发 re-render — push/pop 是热路径, 不能抖动整树
  const scopeStackRef = useRef<Scope[]>(['window']);
  // overrides 镜像: ref 给 keydown handler 用, 永远读到最新值 (避免闭包过期)
  const overridesRef = useRef<ShortcutOverrides>(overrides);
  useEffect(() => {
    overridesRef.current = overrides;
  }, [overrides]);

  const pushScope = useCallback((scope: Scope) => {
    scopeStackRef.current.push(scope);
    let popped = false;
    return () => {
      if (popped) return;
      popped = true;
      const stack = scopeStackRef.current;
      const idx = stack.lastIndexOf(scope);
      if (idx >= 0) stack.splice(idx, 1);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((window as unknown as { __flowixShortcutRecorderOpen?: boolean }).__flowixShortcutRecorderOpen) {
        return;
      }

      const platform = getPlatform();
      const scopeStack = scopeStackRef.current;
      const editable = isInEditableField(e.target);
      const inEditor = scopeStack.includes('editor');
      // 派发用 scope — 'editor' 类 action 在栈里有就标 editor, 其余用 'window'。
      // 'no-input' 也用 'window' 派发 (scope 字段另算, 不影响 ctx.scope 语义)。
      const activeScope: Scope = inEditor ? 'editor' : 'window';

      const actions = listActions();
      for (const action of actions) {
        if (!scopeAllows(action.scope, scopeStack, editable)) continue;
        const { chord } = resolveBinding(action.id, overridesRef.current);
        if (!chord) continue;
        if (
          !chordMatches(e, chord, {
            platform,
          })
        ) {
          continue;
        }
        if (
          action.when &&
          !action.when({
            activeScope,
            focusedTag:
              e.target instanceof HTMLElement ? e.target.tagName.toLowerCase() : null,
            platform,
          })
        ) {
          continue;
        }
        // 调用 run — 返回值决定是否 claim 这个按键。
        // 必须在 preventDefault 之前问, 否则无法撤销 prevent。
        const ctx: ActionContext = { scope: action.scope, source: 'key', platform };
        let result: ReturnType<typeof action.run>;
        try {
          result = action.run(ctx);
        } catch (err) {
          console.error(`[shortcuts] action "${action.id}" threw:`, err);
          result = false;
        }
        if (result instanceof Promise) {
          // 异步 action 视作已处理 (preventDefault + stopPropagation 立即执行),
          // 失败用 .catch 兜底。Provider 不等 Promise 解决 — 同步键盘响应优先。
          result.catch(err => {
            console.error(`[shortcuts] action "${action.id}" rejected:`, err);
          });
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (result === false) {
          // run 显式拒绝 (e.g. handler 栈空, 或 handler 自己判断不应该 claim)
          // 不 preventDefault, 继续找下一个同 chord 的 action; 找不到则落到浏览器默认。
          continue;
        }
        // 命中 — 阻止默认 + 阻止冒泡
        e.preventDefault();
        e.stopPropagation();
        return; // first successful match wins
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  const value = useMemo<ShortcutsContextValue>(
    () => ({ pushScope, overrides }),
    [pushScope, overrides],
  );

  return <ShortcutsContext.Provider value={value}>{children}</ShortcutsContext.Provider>;
}
