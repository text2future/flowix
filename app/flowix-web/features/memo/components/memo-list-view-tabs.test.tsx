import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoListViewTabs } from './memo-list-view-tabs';
import { ListColumnContent } from '@features/shell/components/list-column-content';

vi.mock('@shared/ui/tooltip', () => ({
  // 触发元素原样返回，content 渲染到 data 属性供断言。
  Tooltip: ({ content, children }: { content?: React.ReactNode; children: React.ReactNode }) => (
    <>
      {children}
      <span data-tooltip-content>{content}</span>
    </>
  ),
}));

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  // 树里还有 import { translate, DEFAULT_APP_LANGUAGE } 的模块（如错误边界），
  // 只 mock useI18n 会让这些模块在加载期就失败。
  translate: (_language: string, key: string) => key,
  DEFAULT_APP_LANGUAGE: 'zh-CN',
}));

describe('MemoListViewTabs', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('commits a pointer tab intent before the later click phase', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(<MemoListViewTabs activeTab="cards" onChange={onChange} />);
    });

    const button = host.querySelector<HTMLButtonElement>(
      '[data-memo-list-view-tab="folders"]',
    );
    expect(button).not.toBeNull();

    await act(async () => {
      button!.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
      }));
      button!.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        button: 0,
        detail: 1,
      }));
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('folders');
  });

  it('keeps keyboard activation on the click path', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(<MemoListViewTabs activeTab="cards" onChange={onChange} />);
    });

    const button = host.querySelector<HTMLButtonElement>(
      '[data-memo-list-view-tab="folders"]',
    );
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        detail: 0,
      }));
    });

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith('folders');
  });
  it('only shows the file tree and notes tabs as icon-only items with hover tooltips', async () => {
    await act(async () => {
      root.render(<MemoListViewTabs activeTab="folders" onChange={vi.fn()} />);
    });
    expect(Array.from(host.querySelectorAll('[role="tab"]')).map((tab) =>
      tab.getAttribute('data-memo-list-view-tab'))).toEqual(['folders', 'cards']);
    // tab 内不含文案，完整文案只作为无障碍标签（i18n mock 原样返回 key）。
    expect(host.querySelector('[data-memo-list-view-tab="folders"]')?.getAttribute('aria-label')).toBe('memo.list.viewFolders');
    expect(host.querySelector('[data-memo-list-view-tab="cards"]')?.getAttribute('aria-label')).toBe('memo.list.viewCards');
    // hover tooltip 展示短文案（空间 / 笔记）。
    const tooltipContents = Array.from(host.querySelectorAll('[data-tooltip-content]')).map((node) => node.textContent);
    expect(tooltipContents).toEqual(['memo.list.viewFoldersShort', 'memo.list.viewCardsShort']);
  });

  it('keeps file-tree navigation selected while showing the conversation content page', async () => {
    const onViewChange = vi.fn();
    await act(async () => {
      root.render(
        <ListColumnContent activeView="conversations" onViewChange={onViewChange}
          conversationList={<div data-conversation-drawer />}>
          <div data-conversation-page />
        </ListColumnContent>,
      );
    });
    expect(host.querySelector('[data-memo-list-view-tab="folders"]')?.getAttribute('aria-selected')).toBe('true');
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(host.querySelector('[data-conversation-page]')).not.toBeNull();
    expect(host.querySelector('[data-conversation-page]')?.parentElement?.hasAttribute('inert')).toBe(true);
    const drawer = host.querySelector('[data-conversation-drawer]');
    expect(drawer?.parentElement?.getAttribute('data-page-active')).toBe('true');
    expect(drawer?.closest('[data-sidebar-list-drawer-viewport]')).not.toBeNull();
    expect(host.querySelector('[role="tablist"]')?.closest('[data-sidebar-list-drawer-viewport]')).toBeNull();
    expect(host.querySelector('[data-memo-list-view-back]')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-memo-list-view-tab="cards"]')!.click());
    expect(onViewChange).toHaveBeenCalledWith('cards');
  });

  it('animates both entries and the return while keeping the drawer mounted', async () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
    const cancel = vi.fn();
    const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({ playState: 'finished', cancel, onfinish: null }));
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    const renderPage = async (activeView: 'folders' | 'conversations') => {
      await act(async () => root.render(
        <ListColumnContent activeView={activeView} onViewChange={vi.fn()}
          conversationList={<div data-cached-conversations />}>
          <div />
        </ListColumnContent>,
      ));
    };
    try {
      await renderPage('folders');
      expect(animate).not.toHaveBeenCalled();
      await renderPage('conversations');
      const cached = host.querySelector('[data-cached-conversations]');
      await renderPage('folders');
      await renderPage('conversations');
      expect(animate).toHaveBeenCalledTimes(3);
      expect(animate.mock.calls[0]).toEqual(animate.mock.calls[2]);
      expect(host.querySelector('[data-cached-conversations]')).toBe(cached);
      expect(cancel).toHaveBeenCalledTimes(2);
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'animate', original);
      else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    }
  });

});
