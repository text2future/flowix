import { useSessionScrollRecovery } from '@features/workspace/public/session-view-state-api';
import { reportWorkspaceHeaderScrolled, clearWorkspaceHeaderScrolled } from '@features/workspace/public/header-api';
import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceSurfaceRenderContext } from './workspace-surface-renderer-contract';

/** Geometry and scroll effects only; collection data and navigation live elsewhere. */
export function useCollectionPageLayout(host: WorkspaceSurfaceRenderContext['host'], tableActive: boolean) {
  /**
   * 当前版式与表格需要的横向宽度（表格上报）。为真时整页滚动轨道撑到表格宽度，
   * 头图与 tab 条才有横向 sticky 的余量；画廊/日历/文件树是流式内容，
   * 不能被撑宽，否则会莫名其妙出现整页横向滚动。
   */
  const [activeLayout, setActiveLayout] = useState<string | null>(null);
  const [trackWidth, setTrackWidth] = useState<number | null>(null);
  const handleActiveLayoutChange = useCallback((layout: string | null, contentWidth: number | null) => {
    setActiveLayout(layout);
    setTrackWidth(contentWidth);
  }, []);
  /** 表格版式：唯一会横向溢出的内容，也只有它需要整页横向滚动条。 */
  const pageScrollsHorizontally = tableActive && activeLayout === 'table';
  /** 滚动容器自身尺寸写回 CSS 变量：头图 / tab 条靠它保持「面板宽」并横向钉住。 */
  const [pageScroller, setPageScroller] = useState<HTMLDivElement | null>(null);
  useSessionScrollRecovery(pageScroller, 'collection-page');
  useEffect(() => {
    if (!pageScroller) return;
    const sync = () => {
      // 宽度给头图与 tab 条（宽表整页横滚时它们保持面板宽并 sticky 钉左）。
      pageScroller.style.setProperty('--collection-viewport-w', `${pageScroller.clientWidth}px`);
      // 高度给自带滚动的面板（图墙 / 列表 / 日历 / 看板）留出确定高度：
      // 可见高度 - Work 标题栏（集合内容上穿标题栏时占掉的部分，无穿透为 0）
      // - tab 条 - 底部悬浮输入框的净空。都是 CSS 变量（见 index.css），
      // 这里只写唯一一个需要实测的数字。
      pageScroller.style.setProperty(
        '--collection-content-h',
        `max(0px, calc(${pageScroller.clientHeight}px - var(--work-titlebar-h, 0px) - var(--collection-tab-bar-h) - var(--collection-composer-clearance)))`,
      );
    };
    sync();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(sync);
    observer.observe(pageScroller);
    return () => observer.disconnect();
  }, [pageScroller]);

  // Both columns overlap the collection banner. The owner token isolates cleanup
  // from a replacement view and the other column's independently mounted shell.
  useEffect(() => {
    if (!pageScroller) return;
    const owner = {};
    const sync = () => reportWorkspaceHeaderScrolled(host, owner, pageScroller.scrollTop > 200);
    sync();
    pageScroller.addEventListener('scroll', sync, { passive: true });
    return () => {
      pageScroller.removeEventListener('scroll', sync);
      clearWorkspaceHeaderScrolled(host, owner);
    };
  }, [host, pageScroller]);

  return {
    pageScroller,
    setPageScroller,
    onActiveLayoutChange: handleActiveLayoutChange,
    horizontalScrollbar: pageScrollsHorizontally,
    trackStyle: pageScrollsHorizontally && trackWidth ? { minWidth: `${trackWidth}px` } : undefined,
  };
}
