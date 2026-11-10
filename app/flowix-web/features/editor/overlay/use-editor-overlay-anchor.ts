'use client';

import type { Editor } from '@tiptap/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OverlayFrame } from './compute-overlay-frame';

/**
 * 编辑器漂浮层的锚点调度器 —— 选区气泡工具条与表格气泡工具条共用这一套。
 *
 * 存在的唯一理由: 编辑器的滚动发生在内层 `.editor-content`(OverlayScrollbar 的
 * scroller), 不冒泡到 window, 所以任何只监听 window 的漂浮元素都不会跟随滚动。
 *
 * 契约:
 * - 漂浮层 portal 到 **document.body**, 用 `position: fixed` + 视口坐标定位。
 *   不能挂在编辑器根 `.markdown-editor` 里: 它是 `overflow: hidden` 的裁剪盒
 *   (absolute 会被裁掉), 又带 `isolation: isolate` —— 自带叠层上下文, 于是横向
 *   溢出到相邻列时会被后绘制的列表列盖住。body + fixed 同时解决裁剪和层级;
 * - 滚动/尺寸变化只触发「重算」, 绝不触发卸载重挂;
 * - 订阅源固定为编辑器事件 + 捕获阶段 document scroll + 根 ResizeObserver。
 */

export type EditorOverlayFrameComputer = (root: HTMLElement) => OverlayFrame | null;

export interface EditorOverlayAnchor {
  /** 编辑器根 (只用于几何计算与「是否就绪」判定); 漂浮层的 portal 目标是 body。 */
  root: HTMLElement | null;
  /** 当前定位 (视口坐标); null 表示此刻不该显示。 */
  frame: OverlayFrame | null;
  /**
   * 立即(或下一帧)重算。菜单内容变化导致尺寸变化后调用;
   * `immediate` 为真时同步 flush, 供 layout effect 在绘制前校正。
   */
  requestUpdate: (immediate?: boolean) => void;
}

function sameFrame(left: OverlayFrame | null, right: OverlayFrame | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.left === right.left && left.top === right.top;
}

export function useEditorOverlayAnchor(
  editor: Editor,
  compute: EditorOverlayFrameComputer,
): EditorOverlayAnchor {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [frame, setFrame] = useState<OverlayFrame | null>(null);

  const rootRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef<OverlayFrame | null>(null);
  const frameIdRef = useRef<number | null>(null);
  const pendingRef = useRef(false);
  const computeRef = useRef(compute);
  computeRef.current = compute;

  const flush = useCallback(() => {
    frameIdRef.current = null;
    pendingRef.current = false;
    const currentRoot = rootRef.current;
    if (!currentRoot) return;
    const next = computeRef.current(currentRoot);
    if (sameFrame(frameRef.current, next)) return;
    frameRef.current = next;
    setFrame(next);
  }, []);

  const requestUpdate = useCallback((immediate = false) => {
    if (immediate) {
      if (frameIdRef.current !== null) {
        window.cancelAnimationFrame(frameIdRef.current);
        frameIdRef.current = null;
      }
      flush();
      return;
    }
    if (pendingRef.current) return;
    // 用独立的 pending 标记而不是「frameId 非空」判断: rAF 在某些环境
    // (含单测的同步 stub) 会在赋值前就回调, 用 id 判断会永久卡住。
    pendingRef.current = true;
    frameIdRef.current = window.requestAnimationFrame(flush);
  }, [flush]);

  useEffect(() => {
    // 编辑器可能在 effect 排队时已被销毁 (切文档/切语言的卸载路径),
    // 此时 view.dom 已 detach — 直接 closest 会触发 view-not-available 警告。
    if (editor.isDestroyed) return;
    const dom = editor.view.dom as HTMLElement | null;
    const resolved = dom?.closest('.markdown-editor');
    const nextRoot = resolved instanceof HTMLElement ? resolved : null;
    rootRef.current = nextRoot;
    setRoot(nextRoot);
    return () => {
      rootRef.current = null;
    };
  }, [editor]);

  useEffect(() => {
    if (!root || editor.isDestroyed) return;

    let disposed = false;
    const request = () => {
      if (!disposed) requestUpdate();
    };

    editor.on('selectionUpdate', request);
    editor.on('transaction', request);
    editor.on('focus', request);
    editor.on('blur', request);
    window.addEventListener('resize', request);
    // 捕获阶段: 编辑器滚动发生在内层 .editor-content, 不冒泡到 window。
    document.addEventListener('scroll', request, true);

    const observer = new ResizeObserver(request);
    observer.observe(root);

    // 首帧立即对齐, 避免出现一帧的错位。
    requestUpdate(true);

    return () => {
      disposed = true;
      if (frameIdRef.current !== null) {
        window.cancelAnimationFrame(frameIdRef.current);
        frameIdRef.current = null;
      }
      pendingRef.current = false;
      editor.off('selectionUpdate', request);
      editor.off('transaction', request);
      editor.off('focus', request);
      editor.off('blur', request);
      window.removeEventListener('resize', request);
      document.removeEventListener('scroll', request, true);
      observer.disconnect();
    };
  }, [editor, root, requestUpdate]);

  return { root, frame, requestUpdate };
}
