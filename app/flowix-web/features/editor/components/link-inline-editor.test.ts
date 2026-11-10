import type { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { editorLinkInputValue } from '@features/editor/editor-link-resolution';
import {
  closeLinkInlineEditor,
  isLinkInlineEditorOpen,
  openLinkInlineEditor,
} from './link-inline-editor';

interface EditorSpy {
  editor: Editor;
  calls: Array<{ name: string; arg?: unknown }>;
  focus: ReturnType<typeof vi.fn>;
  emit: (event: string) => void;
}

/** 只要把命令链调用顺序记下来即可: 这里验的是「链接编辑器下了什么命令」。 */
function createEditor(): EditorSpy {
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

  const dom = document.createElement('div');
  document.body.append(dom);

  const focus = vi.fn();
  const listeners = new Map<string, Set<() => void>>();
  const editor = {
    view: { dom, isDestroyed: false, dispatch: vi.fn() },
    state: { tr: { setMeta: () => ({}) } },
    chain: () => chain,
    commands: { focus },
    on: (event: string, handler: () => void) => {
      const handlers = listeners.get(event) ?? new Set();
      handlers.add(handler);
      listeners.set(event, handlers);
    },
    off: (event: string, handler: () => void) => {
      listeners.get(event)?.delete(handler);
    },
  } as unknown as Editor;

  const emit = (event: string) => {
    for (const handler of [...(listeners.get(event) ?? [])]) handler();
  };

  return { editor, calls, focus, emit };
}

const anchorRect = () => new DOMRect(100, 100, 80, 20);

function openEditor(
  options: {
    from?: number;
    to?: number;
    initialHref?: string;
    mode?: 'create' | 'edit';
    onClose?: (result: string) => void;
  } = {},
): EditorSpy {
  const spy = createEditor();
  openLinkInlineEditor({
    editor: spy.editor,
    range: { from: options.from ?? 2, to: options.to ?? 8 },
    initialHref: options.initialHref ?? 'https://old.example',
    mode: options.mode ?? 'edit',
    getAnchorRect: anchorRect,
    onClose: options.onClose,
  });
  return spy;
}

function input(): HTMLInputElement {
  const element = document.querySelector<HTMLInputElement>('.editor-link-hover-tooltip-input');
  if (!element) throw new Error('inline link editor input missing');
  return element;
}

function pressEnter(): void {
  input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

afterEach(() => {
  closeLinkInlineEditor('canceled');
  document.body.innerHTML = '';
});

describe('inline link editor', () => {
  it('shows the authored destination in the input', () => {
    openEditor({ initialHref: 'https://old.example' });

    expect(isLinkInlineEditorOpen()).toBe(true);
    expect(input().value).toBe('https://old.example');
    expect(document.querySelector('[data-link-action="save"]')?.textContent).toBe('保存');
    // 只有保存: 放弃编辑走 Esc / 点气泡外。
    expect(document.querySelector('[data-link-action="cancel"]')).toBeNull();
  });

  it('retargets the existing link mark when saved', () => {
    const onClose = vi.fn();
    const { calls } = openEditor({ onClose });

    input().value = 'https://new.example';
    pressEnter();

    expect(calls).toEqual([
      { name: 'setTextSelection', arg: { from: 2, to: 8 } },
      { name: 'extendMarkRange', arg: 'link' },
      { name: 'setLink', arg: { href: 'https://new.example' } },
      { name: 'setTextSelection', arg: 8 },
      { name: 'run' },
    ]);
    expect(isLinkInlineEditorOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledWith('saved');
  });

  it('keeps a path-shaped destination exactly as authored', () => {
    const { calls } = openEditor();

    input().value = 'skills/RESOLVER.md';
    pressEnter();

    expect(calls).toContainEqual({ name: 'setLink', arg: { href: 'skills/RESOLVER.md' } });
  });

  it('inserts a new link when the target range is collapsed', () => {
    const { calls } = openEditor({ from: 3, to: 3, initialHref: '', mode: 'create' });

    input().value = 'example.com';
    pressEnter();

    expect(calls).toEqual([
      {
        name: 'insertContent',
        arg: {
          type: 'text',
          marks: [{ type: 'link', attrs: { href: 'http://example.com' } }],
          text: 'http://example.com',
        },
      },
      { name: 'run' },
    ]);
  });

  it('refuses to save an empty destination', () => {
    const onClose = vi.fn();
    const { calls } = openEditor({ onClose });

    input().value = '   ';
    pressEnter();

    expect(calls).toEqual([]);
    expect(isLinkInlineEditorOpen()).toBe(true);
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes itself when the editor is destroyed', () => {
    const { emit } = openEditor();
    expect(isLinkInlineEditorOpen()).toBe(true);

    emit('destroy');

    expect(isLinkInlineEditorOpen()).toBe(false);
    expect(document.querySelector('.editor-link-inline-editor')).toBeNull();
  });

  it('cancels without touching the document', () => {
    const onClose = vi.fn();
    const { calls } = openEditor({ onClose });

    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(calls).toEqual([]);
    expect(isLinkInlineEditorOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledWith('canceled');
  });

  it('closes when the pointer goes down outside the bubble', () => {
    const onClose = vi.fn();
    openEditor({ onClose });

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

    expect(isLinkInlineEditorOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledWith('canceled');
  });

  it('decodes path destinations but normalizes web hosts for the input', () => {
    expect(editorLinkInputValue('skills/a.md')).toBe('skills/a.md');
    expect(editorLinkInputValue('example.com')).toBe('http://example.com');
    expect(editorLinkInputValue('/tmp/a%20b.md')).toBe('/tmp/a b.md');
    expect(editorLinkInputValue('https://example.com/a%20b')).toBe('https://example.com/a%20b');
  });
});

describe('inline link editor placement', () => {
  // jsdom 不跑布局: 量不到尺寸 computeOverlayFrame 会返回 null 走兜底, 这里给
  // 菜单一个固定实测尺寸 (弹窗 min-width 236 / 估算高度 110)。
  const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

  function stubMenuSize(): void {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 236 });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 110 });
  }

  function restoreMenuSize(): void {
    if (offsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth);
    if (offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight);
  }

  function openBelow(anchor: DOMRect): void {
    stubMenuSize();
    const { editor } = createEditor();
    openLinkInlineEditor({
      editor,
      range: { from: 2, to: 8 },
      initialHref: '',
      mode: 'create',
      placement: 'below',
      getAnchorRect: () => anchor,
    });
  }

  afterEach(() => {
    restoreMenuSize();
  });

  it('stays hidden instead of guessing a position before it can be measured', () => {
    // jsdom 量不到尺寸: 这时不能把 0 宽当成气泡宽度去算居中 (会右移半个宽度),
    // 也不能先显示在 (0,0)。
    const { editor } = createEditor();
    openLinkInlineEditor({
      editor,
      range: { from: 2, to: 8 },
      initialHref: '',
      mode: 'create',
      placement: 'below',
      getAnchorRect: () => new DOMRect(120, 300, 100, 20),
    });

    const bubble = document.querySelector<HTMLElement>('.editor-link-inline-editor');
    expect(bubble?.style.visibility).toBe('hidden');
    expect(bubble?.style.left).toBe('');
    expect(bubble?.style.top).toBe('');
  });

  it('sits below the selection and centers on it', () => {
    // 选区 (120,300)-(220,320): 下方 320 + 8 = 328; 水平居中 120 + 50 - 118 = 52。
    openBelow(new DOMRect(120, 300, 100, 20));

    const bubble = document.querySelector<HTMLElement>('.editor-link-inline-editor');
    expect(bubble?.style.top).toBe('328px');
    expect(bubble?.style.left).toBe('52px');
  });

  it('sits above the link when the entry point asks for above', () => {
    stubMenuSize();
    const { editor } = createEditor();
    openLinkInlineEditor({
      editor,
      range: { from: 2, to: 8 },
      initialHref: 'https://example.com',
      mode: 'edit',
      getAnchorRect: () => new DOMRect(120, 300, 100, 20),
    });

    const bubble = document.querySelector<HTMLElement>('.editor-link-inline-editor');
    // 上方: 300 - 8(间距) - 110(高度) = 182; 水平居中 120 + 50 - 118 = 52。
    expect(bubble?.style.top).toBe('182px');
    expect(bubble?.style.left).toBe('52px');
  });

  it('moves above the selection when there is no room below', () => {
    // 选区贴到面板底部: 下方放不下 110px 的输入气泡, 整体上移。
    openBelow(new DOMRect(400, 680, 100, 20));

    const bubble = document.querySelector<HTMLElement>('.editor-link-inline-editor');
    // 上方: 680 - 8(间距) - 110(高度) = 562。
    expect(bubble?.style.top).toBe('562px');
    // 水平居中: 400 + 50 - 118 = 332。
    expect(bubble?.style.left).toBe('332px');
  });
});
