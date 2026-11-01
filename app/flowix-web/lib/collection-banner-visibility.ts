'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * 集合头图显隐的**跨组件树**桥。
 *
 * 头图的真实状态在集合外壳里（`CollectionShell` 持有 `.index.yaml` 的 summary 与
 * 写属性的能力），而 Work 列顶部 header 的「···」菜单在另一棵树上，读不到那份
 * state。两者靠这个小注册表通信：
 *   - 外壳挂载时登记 `{ visible, toggle }`，卸载即摘除（返回的 cleanup 按对象身份
 *     删除，不会误删别的实例）：
 *   - header 只读**最后一个**登记项 ── 同一个集合可能同时开在 Work 列与右栏，
 *     谁最后挂载谁的写入口生效，读到的状态也就跟着它；
 *   - 任何登记 / 摘除都广播一个事件，header 据此重渲染（`visible` 变了要换图标）。
 *
 * 「显示标题」不需要这层桥：它是一条全局偏好（见 `collection-title-visibility`）。
 * 头图是集合自己的属性，只有持有 summary 的外壳知道它当前是不是被隐藏。
 */
export interface CollectionBannerControl {
  visible: boolean;
  toggle: () => void;
}

const BANNER_CONTROL_EVENT = 'flowix:collection-banner-control-changed';

/** key = 集合体地址（`.index.yaml`），每个 key 是一条按挂载顺序排列的栈。 */
const controls = new Map<string, CollectionBannerControl[]>();

function emit(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(BANNER_CONTROL_EVENT));
}

/** 外壳调用：登记自己作为该集合的写入口，返回摘除函数。 */
export function registerCollectionBannerControl(
  indexPath: string,
  control: CollectionBannerControl,
): () => void {
  const stack = controls.get(indexPath) ?? [];
  stack.push(control);
  controls.set(indexPath, stack);
  emit();
  return () => {
    const current = controls.get(indexPath);
    if (!current) return;
    const index = current.lastIndexOf(control);
    if (index >= 0) current.splice(index, 1);
    if (current.length === 0) controls.delete(indexPath);
    emit();
  };
}

/**
 * header 调用：读当前集合的头图开关。
 * `available=false`（该地址没有外壳登记）时菜单不显示「显示头图」这一项。
 */
export function useCollectionBannerControl(indexPath: string | null): {
  available: boolean;
  visible: boolean;
  toggle: () => void;
} {
  const read = useCallback(
    () => {
      const stack = indexPath ? controls.get(indexPath) : null;
      return stack && stack.length > 0 ? stack[stack.length - 1] : null;
    },
    [indexPath],
  );
  const [control, setControl] = useState(() => read());
  useEffect(() => {
    const sync = () => setControl(read());
    sync();
    window.addEventListener(BANNER_CONTROL_EVENT, sync);
    return () => window.removeEventListener(BANNER_CONTROL_EVENT, sync);
  }, [read]);
  const toggle = useCallback(() => { read()?.toggle(); }, [read]);
  return { available: control !== null, visible: control?.visible ?? false, toggle };
}
