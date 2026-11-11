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
import { positionFloatingBubble } from './floating-bubble-position';
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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 链接在 (100,200) 的 80×20 矩形, 气泡量到 300×32 —— 两者之间正好 8px 留白。 */
const LINK_BOX = { left: 100, right: 180, top: 200, bottom: 220, width: 80, height: 20 };
const BUBBLE_SIZE = { width: 300, height: 32 };

/** jsdom 没有布局: 给气泡尺寸和链接矩形装上可预测的值。 */
function createGapFixture(href = 'https://example.com') {
  const { anchor, detach } = createEditorFixture(href);
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => BUBBLE_SIZE.width,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => BUBBLE_SIZE.height,
  });
  anchor.getBoundingClientRect = () => ({ ...LINK_BOX } as DOMRect);

  return {
    anchor,
    detach: () => {
      detach();
      for (const [key, descriptor] of [['offsetWidth', width], ['offsetHeight', height]] as const) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
        else Reflect.deleteProperty(HTMLElement.prototype, key);
      }
    },
  };
}

async function showGapTooltip(anchor: HTMLAnchorElement) {
  anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await wait(150);
  const tooltip = document.querySelector<HTMLElement>('.editor-link-hover-tooltip');
  expect(tooltip).not.toBeNull();
  return tooltip!;
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
    // Layout: [copy] [remove] link text [edit] — both icon actions are grouped
    // on the left of the address (copy first), the text edit button stays on the right.
    const buttons = tooltip!.querySelectorAll<HTMLElement>('.editor-link-hover-tooltip-button');
    expect(Array.from(buttons, (button) => button.dataset.linkAction)).toEqual([
      'copy',
      'remove',
      'edit',
    ]);
    const leading = tooltip!.firstElementChild as HTMLElement;
    expect(leading.className).toBe('editor-link-hover-tooltip-actions');
    expect(
      Array.from(
        leading.querySelectorAll<HTMLElement>('[data-link-action]'),
        (button) => button.dataset.linkAction,
      ),
    ).toEqual(['copy', 'remove']);
    expect(leading.nextElementSibling?.className).toBe('editor-link-hover-tooltip-text');
    expect(
      tooltip!.lastElementChild?.querySelector('[data-link-action="edit"]'),
    ).not.toBeNull();
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

  // 气泡默认贴在链接上方并留 8px 空隙 (VIEWPORT_PADDING)。指针从链接走向
  // 气泡时必须能在这条空隙里停留, 否则 mouseout 启动的 140ms 倒计时会让
  // 气泡在指针到达按钮之前消失。
  it('reports the bubble frame that defines the 8px gap, also when flipped below', () => {
    const element = document.createElement('div');
    Object.defineProperties(element, {
      offsetWidth: { configurable: true, value: BUBBLE_SIZE.width },
      offsetHeight: { configurable: true, value: BUBBLE_SIZE.height },
    });

    const frame = positionFloatingBubble(element, { ...LINK_BOX } as DOMRect);
    expect(frame).toEqual({ left: 8, top: 160, width: 300, height: 32 });
    expect(LINK_BOX.top - (frame.top + frame.height)).toBe(8);

    // 上方放不下时翻到下方, 留白仍是 8px; 安全区按返回的矩形算, 不依赖
    // 会被进场动画 transform 干扰的 getBoundingClientRect()。
    const flipped = positionFloatingBubble(
      element,
      { ...LINK_BOX, top: 10, bottom: 30 } as DOMRect,
    );
    expect(flipped.top - 30).toBe(8);
  });

  it('keeps an 8px gap between the link and the bubble', async () => {
    const { anchor, detach } = createGapFixture();
    try {
      const tooltip = await showGapTooltip(anchor);
      // 200 (link top) - 32 (bubble height) - 8 (gap) = 160
      expect(tooltip.style.top).toBe('160px');
      expect(LINK_BOX.top - (160 + BUBBLE_SIZE.height)).toBe(8);
    } finally {
      detach();
    }
  });

  it('keeps the bubble while the pointer rests in the gap', async () => {
    const { anchor, detach } = createGapFixture();
    try {
      const tooltip = await showGapTooltip(anchor);
      // 指针停在 (150, 196): 链接顶边 200 与气泡底边 192 之间的 8px 留白。
      // relatedTarget 是编辑器里的普通元素, 既不是链接也不是气泡。
      anchor.dispatchEvent(new MouseEvent('mouseout', {
        bubbles: true,
        relatedTarget: anchor.parentElement,
        clientX: 150,
        clientY: 196,
      }));
      await wait(300); // > HIDE_DELAY_MS + HIDE_ANIMATION_MS

      expect(document.querySelector('.editor-link-hover-tooltip')).toBe(tooltip);
      expect(tooltip.classList.contains('is-hiding')).toBe(false);
    } finally {
      detach();
    }
  });

  it('hides once the pointer leaves the link/gap/bubble corridor', async () => {
    const { anchor, detach } = createGapFixture();
    try {
      await showGapTooltip(anchor);
      anchor.dispatchEvent(new MouseEvent('mouseout', {
        bubbles: true,
        relatedTarget: anchor.parentElement,
        clientX: 600,
        clientY: 260,
      }));
      await wait(300);

      expect(document.querySelector('.editor-link-hover-tooltip')).toBeNull();
    } finally {
      detach();
    }
  });

  it('also keeps the bubble when moving back from the bubble towards the link', async () => {
    const { anchor, detach } = createGapFixture();
    try {
      const tooltip = await showGapTooltip(anchor);
      // mouseleave 不冒泡, 直接派发在气泡上; 指针停在留白里不该触发隐藏。
      tooltip.dispatchEvent(new MouseEvent('mouseleave', {
        clientX: 150,
        clientY: 196,
      }));
      await wait(300);

      expect(document.querySelector('.editor-link-hover-tooltip')).toBe(tooltip);
    } finally {
      detach();
    }
  });

  it('hides when the pointer leaves the window, ignoring stale coordinates', async () => {
    const { anchor, detach } = createGapFixture();
    try {
      await showGapTooltip(anchor);
      // relatedTarget 为 null 时 clientX/Y 可能仍是留在走廊里的旧坐标。
      anchor.dispatchEvent(new MouseEvent('mouseout', {
        bubbles: true,
        clientX: 150,
        clientY: 196,
      }));
      await wait(300);

      expect(document.querySelector('.editor-link-hover-tooltip')).toBeNull();
    } finally {
      detach();
    }
  });
});
