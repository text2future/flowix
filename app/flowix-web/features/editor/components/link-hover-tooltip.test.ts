import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openerMocks = vi.hoisted(() => ({
  openUrl: vi.fn(async () => undefined),
}));
const toastMocks = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock('@platform/tauri/opener', () => openerMocks);
vi.mock('@/lib/toast', () => ({ toast: toastMocks }));

import { closeLinkInlineEditor } from './link-inline-editor';
import { attachLinkHoverTooltip } from './link-hover-tooltip';
import { setSelectionBubbleMenuVisible } from './selection-bubble-menu-state';

interface FixtureOptions {
  documentPath?: string;
  openLocalPath?: (target: { path: string }) => void;
}

function createEditorFixture(href: string, options: FixtureOptions = {}) {
  const scroller = document.createElement('div');
  scroller.className = 'editor-content';
  const mount = document.createElement('div');
  const editorDom = document.createElement('div');
  editorDom.className = 'ProseMirror';
  editorDom.innerHTML = `
    <p><a href="${href}">link</a></p>
    <h2>基础 Slide 外壳</h2>
  `;
  mount.append(editorDom);
  scroller.append(mount);
  document.body.append(scroller);

  const calls: Array<{ name: string; arg?: unknown }> = [];
  const chain: Record<string, unknown> = { focus: () => chain };
  for (const name of ['setTextSelection', 'extendMarkRange', 'setLink', 'insertContent']) {
    chain[name] = (arg: unknown) => {
      calls.push({ name, arg });
      return chain;
    };
  }
  chain.run = () => {
    calls.push({ name: 'run' });
    return true;
  };

  const editor = {
    view: {
      dom: editorDom,
      isDestroyed: false,
      // 链接只有一段文字: 起点 1, 终点 2。
      posAtDOM: (_node: Node, offset: number) => (offset === 0 ? 1 : 2),
      dispatch: vi.fn(),
    },
    state: {
      tr: { setMeta: () => ({}) },
      doc: { textBetween: () => 'link' },
    },
    chain: () => chain,
    commands: { focus: vi.fn() },
    // 链接输入气泡会订阅 destroy 事件, 假编辑器给出同样的最小接口。
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Editor;
  const context = options.documentPath
    ? { documentPath: options.documentPath, openLocalPath: options.openLocalPath }
    : undefined;
  const detach = attachLinkHoverTooltip(editor, mount, () => context);

  return {
    anchor: editorDom.querySelector('a') as HTMLAnchorElement,
    calls,
    detach,
    scroller,
  };
}

describe('link hover tooltip navigation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    openerMocks.openUrl.mockClear();
    toastMocks.error.mockClear();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });
  });

  afterEach(() => {
    // 内联链接编辑器是单例, 用例之间必须收干净。
    closeLinkInlineEditor('canceled');
    document.body.innerHTML = '';
    // 模块级共享状态: 每个用例结束时把选区气泡的可见性复位。
    setSelectionBubbleMenuVisible(false);
  });

  it('handles a heading fragment inside the current editor instead of opening it externally', () => {
    const { anchor, detach, scroller } = createEditorFixture('#基础-slide-外壳');
    scroller.scrollTo = vi.fn();

    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(scroller.scrollTo).toHaveBeenCalledOnce();
    expect(openerMocks.openUrl).not.toHaveBeenCalled();
    detach();
  });

  it('opens a video source without adding the ordinary link hover tooltip', () => {
    const href = 'https://www.bilibili.com/video/BV1TGnP6VE2f';
    const { anchor, detach } = createEditorFixture(href);
    anchor.parentElement!.setAttribute('data-video-embed', '');
    anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(anchor.hasAttribute('data-link-tooltip')).toBe(false);
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(openerMocks.openUrl).toHaveBeenCalledWith(href);
    detach();
  });

  it('copies the destination shown in the hover tooltip', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const { anchor, detach } = createEditorFixture('https://example.com');

    anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 150));

    const tooltip = document.querySelector('.editor-link-hover-tooltip');
    expect(tooltip).not.toBeNull();
    // Layout: [remove] link text [copy] [edit] — the unlink button leads the
    // bubble, the copy and text edit buttons follow the address.
    const buttons = tooltip!.querySelectorAll<HTMLElement>('.editor-link-hover-tooltip-button');
    expect(Array.from(buttons, (button) => button.dataset.linkAction)).toEqual([
      'remove',
      'copy',
      'edit',
    ]);
    expect(tooltip!.firstElementChild?.getAttribute('data-link-action')).toBe('remove');
    // 编辑是文字按钮 (无图标), 复制 / 移除链接是图标按钮。
    const editButton = tooltip!.querySelector<HTMLElement>('[data-link-action="edit"]')!;
    expect(editButton.querySelector('svg')).toBeNull();
    expect(editButton.textContent?.trim()).not.toBe('');
    expect(tooltip!.querySelector('[data-link-action="remove"] svg')).not.toBeNull();

    const copyButton = tooltip!.querySelector<HTMLElement>('[data-link-action="copy"]')!;
    copyButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writeText).toHaveBeenCalledWith('https://example.com');
    expect(copyButton.classList.contains('is-copied')).toBe(true);
    // 成功态换成 Lucide 勾选 (描边), 与 copy / unlink 同一视觉语言。
    const copiedIcon = copyButton.querySelector('svg');
    expect(copiedIcon?.getAttribute('fill')).toBe('none');
    expect(copiedIcon?.getAttribute('stroke')).toBe('currentColor');
    expect(toastMocks.error).not.toHaveBeenCalled();
    detach();
  });

  it('turns the bubble into an inline link editor when edit is clicked', async () => {
    const { anchor, detach } = createEditorFixture('https://example.com');
    anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 150));

    const editButton = document.querySelector<HTMLElement>('[data-link-action="edit"]');
    expect(editButton).not.toBeNull();
    editButton!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    // hover 态收起 (地址文案 / 复制按钮都没了), 同一位置换成
    // 「地址输入框 + 取消 / 保存」; 两者共用同一套气泡外观。
    expect(document.querySelector('.editor-link-hover-tooltip-text')).toBeNull();
    expect(document.querySelector('[data-link-action="copy"]')).toBeNull();
    const input = document.querySelector<HTMLInputElement>(
      '.editor-link-inline-editor .editor-link-hover-tooltip-input',
    );
    expect(input?.value).toBe('https://example.com');
    expect(document.querySelector('[data-link-action="save"]')).not.toBeNull();
    expect(document.querySelector('[data-link-action="cancel"]')).toBeNull();
    detach();
  });

  it('defers to the selection bubble when both could show at once', async () => {
    const { anchor, detach } = createEditorFixture('https://example.com');
    setSelectionBubbleMenuVisible(true);

    anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(document.querySelector('.editor-link-hover-tooltip')).toBeNull();
    detach();
  });

  it('steps aside as soon as the selection bubble appears', async () => {
    const { anchor, detach } = createEditorFixture('https://example.com');

    anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(document.querySelector('.editor-link-hover-tooltip')).not.toBeNull();

    setSelectionBubbleMenuVisible(true);

    expect(document.querySelector('.editor-link-hover-tooltip')).toBeNull();
    detach();
  });

  it('keeps using the system opener for a regular external link', () => {
    const { anchor, detach } = createEditorFixture('https://example.com');

    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(openerMocks.openUrl).toHaveBeenCalledWith('https://example.com');
    detach();
  });

  it('opens a sibling path through the document layer instead of a browser', () => {
    const openLocalPath = vi.fn();
    const { anchor, detach } = createEditorFixture('skills/RESOLVER.md', {
      documentPath: '/Users/rop/kb/README.md',
      openLocalPath,
    });

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(openLocalPath).toHaveBeenCalledWith(expect.objectContaining({
      path: '/Users/rop/kb/skills/RESOLVER.md',
    }));
    expect(openerMocks.openUrl).not.toHaveBeenCalled();
    expect(toastMocks.error).not.toHaveBeenCalled();
    detach();
  });

  it('never invents a web host for a sibling path without a document base', () => {
    const { anchor, detach } = createEditorFixture('skills/RESOLVER.md');

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(openerMocks.openUrl).not.toHaveBeenCalled();
    expect(toastMocks.error).toHaveBeenCalledOnce();
    detach();
  });
});
