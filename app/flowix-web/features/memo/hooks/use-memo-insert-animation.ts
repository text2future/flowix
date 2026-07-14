'use client';

import { useCallback, useRef } from 'react';
import gsap from 'gsap';

const ENTRANCE_DURATION = 0.3;
const ENTRANCE_EASE = 'power2.out';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

interface PendingInsert {
  newId: string;
  attempts: number;
}

/**
 * 入场动画 ── 只在**新建一条** memo 时跑一次。
 *
 * 设计:
 * - 不动整列 (没有 FLIP / 没有列表滚动), 只让新 card 自己从左侧淡入;
 * - 新 card 的容器是普通文档流, 没有 transform 定位, 物理上不可能与
 *   上下邻居重叠;
 * - GSAP 作用在 [data-insert-anim] wrapper 上, wrapper 自己的 transform
 *   (x / scale) 不会外溢到 row 容器;
 * - 只在 prepareForInsert(newId) 之后的下一次 useLayoutEffect 里跑,
 *   其它时候 onListRendered 是 no-op。
 */
export function useMemoInsertAnimation() {
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const pendingRef = useRef<PendingInsert | null>(null);

  const registerCard = useCallback((id: string) => (el: HTMLDivElement | null) => {
    if (el) cardRefs.current.set(id, el);
    else cardRefs.current.delete(id);
  }, []);

  // 删掉了原来的 (newId, index) + data-virt-index + scrollToIndex 三件套:
  // 现在没有虚拟列表, 新 memo 永远渲染在列表最前, index 没有意义, 滚动也
  // 由浏览器原生 overflow-y-auto 自然处理 (新 card 出现在最前, 用户想看
  // 就滚, 我们不替用户做"自动滚到顶部"的决定)。
  const prepareForInsert = useCallback((newId: string) => {
    pendingRef.current = { newId, attempts: 0 };
  }, []);

  const onListRendered = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;

    const newEl = cardRefs.current.get(pending.newId);
    if (!newEl) {
      pending.attempts += 1;
      if (pending.attempts > 2) {
        pendingRef.current = null;
      }
      return;
    }

    pendingRef.current = null;

    // 优先取 row 内部的 [data-insert-anim] wrapper, 让 GSAP 的 transform/x/scale
    // 全部作用在视觉层; 找不到 (旧结构 / 单测 / Storybook) 时退回 row 本身。
    const animEl = (newEl.querySelector('[data-insert-anim]') as HTMLElement | null) ?? newEl;

    if (prefersReducedMotion()) return;

    gsap.killTweensOf(animEl);
    gsap.fromTo(
      animEl,
      { autoAlpha: 0, x: -36, scale: 0.985 },
      {
        autoAlpha: 1,
        x: 0,
        scale: 1,
        duration: ENTRANCE_DURATION,
        ease: ENTRANCE_EASE,
        clearProps: 'opacity,visibility,transform',
      }
    );
  }, []);

  return { registerCard, prepareForInsert, onListRendered };
}
