'use client';

import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { MemoList } from '@features/memo/components/memo-list';

const OPEN_DELAY_MS = 600;
const CLOSE_DELAY_MS = 150;
const LEAVE_ANIM_MS = 160;

interface MemoListHoverPreviewTriggerProps {
  onMouseEnter?: (event: ReactMouseEvent<HTMLElement>) => void;
  onMouseLeave?: (event: ReactMouseEvent<HTMLElement>) => void;
}

interface MemoListHoverPreviewProps {
  trigger: ReactElement<MemoListHoverPreviewTriggerProps>;
}

/**
 * 侧栏折叠时, hover 编辑器顶部的「展开侧栏」按钮 1s 后弹出的笔记列表浮层。
 *
 * 设计要点:
 *   - 复用 MemoList 作为内容渲染源 ── 同样的过滤 / 排序 / 选中态 /
 *     滚动分页逻辑, 保证浮层与中间列 100% 一致。
 *   - 不用 Radix HoverCard 的 Popper 定位: Popper wrapper 上的 transform
 *     会让 fixed 子元素退化成相对 wrapper 定位, 无法贴 viewport 边缘。
 *     这里用 `createPortal(..., document.body)` + fixed 定位。
 *   - 触发按钮 / 浮层组成一个 hover region: 任一方 mouseleave 立即启动
 *     CLOSE_DELAY_MS 倒计时, 任一方 mouseenter 立即取消 ── 与 Radix
 *     HoverCard 的语义一致。
 *   - 进场 / 出场动画完全交给 CSS (`flowix-hover-preview-enter` /
 *     `-leave` keyframes)。组件用 isOpen 控制是否应该显示; 关闭后等
 *     LEAVE_ANIM_MS 让动画播完再卸载 DOM。
 *   - 双挂载时的副作用去重在 memo-list.tsx 内部用模块级
 *     `memoListGlobalListenerCount` refcount 控制。
 */
export function MemoListHoverPreview({ trigger }: MemoListHoverPreviewProps) {
  const [isOpen, setIsOpen] = useState(false);
  // isOpen 同时驱动 `shouldRender`: isOpen=true → 立即挂载; isOpen=false
  // → 延迟 LEAVE_ANIM_MS 再卸载, 让 CSS 出场动画播完。
  const [shouldRender, setShouldRender] = useState(false);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const unmountTimerRef = useRef<number | null>(null);

  // 卸载时清掉所有 timer。
  useEffect(() => {
    return () => {
      if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
      if (unmountTimerRef.current !== null) window.clearTimeout(unmountTimerRef.current);
    };
  }, []);

  // isOpen 变化时同步 shouldRender: 开则立即挂, 关则延迟卸载。
  useEffect(() => {
    if (isOpen) {
      if (unmountTimerRef.current !== null) {
        window.clearTimeout(unmountTimerRef.current);
        unmountTimerRef.current = null;
      }
      setShouldRender(true);
      return;
    }
    if (!shouldRender) return;
    unmountTimerRef.current = window.setTimeout(() => {
      unmountTimerRef.current = null;
      setShouldRender(false);
    }, LEAVE_ANIM_MS);
    return () => {
      if (unmountTimerRef.current !== null) window.clearTimeout(unmountTimerRef.current);
    };
  }, [isOpen, shouldRender]);

  const requestOpen = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (openTimerRef.current !== null || isOpen) return;
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      setIsOpen(true);
    }, OPEN_DELAY_MS);
  };
  const requestClose = () => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null || !isOpen) return;
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setIsOpen(false);
    }, CLOSE_DELAY_MS);
  };

  const handleTriggerEnter = useCallback(() => requestOpen(), [isOpen]);
  const handleTriggerLeave = useCallback(() => requestClose(), [isOpen]);
  const handlePopupEnter = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);
  const handlePopupLeave = useCallback(() => requestClose(), [isOpen]);

  const triggerWithHandlers = useMemo(() => {
    if (!isValidElement(trigger)) return trigger;
    return cloneElement(trigger, {
      onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => {
        const original = trigger.props.onMouseEnter;
        if (typeof original === 'function') original(event);
        if (!event.defaultPrevented) handleTriggerEnter();
      },
      onMouseLeave: (event: ReactMouseEvent<HTMLElement>) => {
        const original = trigger.props.onMouseLeave;
        if (typeof original === 'function') original(event);
        if (!event.defaultPrevented) handleTriggerLeave();
      },
    });
  }, [trigger, handleTriggerEnter, handleTriggerLeave]);

  return (
    <>
      {triggerWithHandlers as ReactNode}
      {shouldRender && typeof document !== 'undefined'
        ? createPortal(
            <div
              data-memo-list-hover-preview
              data-preview-state={isOpen ? 'open' : 'closing'}
              onMouseEnter={handlePopupEnter}
              onMouseLeave={handlePopupLeave}
              className={
                'fixed left-1 top-[10vh] z-[1700] flex h-[80vh] w-[280px] flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] ' +
                // y 偏移改 0; x 偏移 = 原 y 偏移 (20 / 8) 的 1.5 倍 = 30 / 12 px。
                // 用单层 shadow ── Tailwind 3.x 任意值不支持逗号分隔的多层。
                'shadow-[12px_0_25px_-5px_rgb(0_0_0/_0.1)] ' +
                (isOpen ? 'flowix-hover-preview-enter' : 'flowix-hover-preview-leave')
              }
            >
              <MemoList hideHeader />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
