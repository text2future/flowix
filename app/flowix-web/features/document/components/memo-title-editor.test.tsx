import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const titleSession = vi.hoisted(() => ({
  snapshot: {
    filename: 'Original.md',
    draft: 'Original',
    saving: false,
    error: null as string | null,
  },
  setDraft: vi.fn(),
  commit: vi.fn(() => Promise.resolve(true)),
  cancel: vi.fn(),
}));
const renameTitle = vi.fn(() => Promise.resolve('Original.md'));

vi.mock('./memo-title-session', () => ({
  useMemoTitleSession: () => titleSession,
}));

import { MemoTitleEditor, type MemoTitleBodyNavigation, type MemoTitleEditorHandle } from './memo-title-editor';

function setTextareaValue(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  setter?.call(element, value);
}

function dispatchKey(
  element: HTMLTextAreaElement,
  key: string,
  keyCode?: number,
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  if (keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: keyCode });
  element.dispatchEvent(event);
  return event;
}

/** Minimal DOMRect stand-in for stubbing layout in jsdom. */
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function dispatchPaste(element: HTMLTextAreaElement, text: string, html = ''): ClipboardEvent {  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  const values: Record<string, string> = {
    'text/plain': text,
    'text/html': html,
  };
  Object.defineProperty(event, 'clipboardData', {
    value: {
      types: Object.keys(values),
      files: [],
      getData(type: string) {
        return values[type] ?? '';
      },
    },
  });
  element.dispatchEvent(event);
  return event;
}

describe('MemoTitleEditor IME handling', () => {
  let container: HTMLDivElement;
  let root: Root;
  let textarea: HTMLTextAreaElement;
  let onMoveToBody: ReturnType<typeof vi.fn<(request: MemoTitleBodyNavigation) => void>>;

  beforeEach(() => {
    vi.clearAllMocks();
    titleSession.commit.mockImplementation(() => Promise.resolve(true));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onMoveToBody = vi.fn();
    act(() => {
      root.render(createElement(MemoTitleEditor, {
        displayId: 'display:title-test',
        filename: 'Original.md',
        renameTitle,
        editable: true,
        onMoveToBody,
      }));
    });
    textarea = container.querySelector('textarea')!;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps intermediate composition text local until compositionend', () => {
    act(() => {
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      setTextareaValue(textarea, 'ni');
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'ni' }));
    });

    expect(textarea.value).toBe('ni');
    expect(titleSession.setDraft).not.toHaveBeenCalled();

    act(() => {
      setTextareaValue(textarea, '你');
      textarea.dispatchEvent(new CompositionEvent('compositionend', {
        bubbles: true,
        data: '你',
      }));
    });

    expect(titleSession.setDraft).toHaveBeenCalledTimes(1);
    expect(titleSession.setDraft).toHaveBeenCalledWith('你');

    act(() => {
      setTextareaValue(textarea, '你');
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: '你' }));
    });

    expect(titleSession.setDraft).toHaveBeenCalledTimes(1);
  });

  it('does not move to the body when Enter confirms an active composition', () => {
    act(() => {
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      dispatchKey(textarea, 'Enter', 13);
    });

    expect(titleSession.commit).not.toHaveBeenCalled();
    expect(onMoveToBody).not.toHaveBeenCalled();
  });

  it('does not move to the body for WebKit process-key 229', () => {
    act(() => {
      dispatchKey(textarea, 'Enter', 229);
    });

    expect(titleSession.commit).not.toHaveBeenCalled();
    expect(onMoveToBody).not.toHaveBeenCalled();
  });

  it('moves to the body for an ordinary Enter after composition', async () => {
    setTextareaValue(textarea, 'Title tail');
    textarea.setSelectionRange(5, 5);

    await act(async () => {
      const event = dispatchKey(textarea, 'Enter', 13);
      expect(event.defaultPrevented).toBe(true);
      await Promise.resolve();
    });

    expect(titleSession.setDraft).toHaveBeenCalledWith('Title');
    expect(titleSession.commit).toHaveBeenCalledTimes(1);
    expect(onMoveToBody).toHaveBeenCalledWith({
      trailingContent: ' tail',
      insertEmptyLine: true,
    });
  });

  it('moves to the body before the title rename finishes', () => {
    titleSession.commit.mockImplementation(() => new Promise(() => {}));
    setTextareaValue(textarea, 'Title tail');
    textarea.setSelectionRange(5, 5);

    act(() => dispatchKey(textarea, 'Enter', 13));

    expect(titleSession.commit).toHaveBeenCalledTimes(1);
    expect(onMoveToBody).toHaveBeenCalledWith({
      trailingContent: ' tail',
      insertEmptyLine: true,
    });
  });

  it.each([true, false])('waits for the rename result (%s) before accepting a body-to-title merge', async (saved) => {
    let finish!: (saved: boolean) => void;
    titleSession.commit.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const editorRef = createRef<MemoTitleEditorHandle>();
    act(() => {
      root.render(createElement(MemoTitleEditor, {
        ref: editorRef,
        displayId: 'display:title-test',
        filename: 'Original.md',
        renameTitle,
        editable: true,
        onMoveToBody,
      }));
    });

    let accepted: boolean | undefined;
    let merging!: Promise<boolean>;
    act(() => {
      merging = editorRef.current!.appendBodyLine('First line');
      void merging.then(value => { accepted = value; });
    });
    expect(accepted).toBeUndefined();
    expect(titleSession.setDraft).toHaveBeenCalledWith('OriginalFirst line');
    expect(titleSession.commit).toHaveBeenCalledTimes(1);
    await act(async () => { finish(saved); await merging; });
    expect(accepted).toBe(saved);
  });

  it('coalesces repeated body-to-title merges while the rename is pending', async () => {
    let finish!: (saved: boolean) => void;
    titleSession.commit.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const editorRef = createRef<MemoTitleEditorHandle>();
    act(() => {
      root.render(createElement(MemoTitleEditor, {
        ref: editorRef,
        displayId: 'display:title-test',
        filename: 'Original.md',
        renameTitle,
        editable: true,
        onMoveToBody,
      }));
    });

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = editorRef.current!.appendBodyLine('First line');
      second = editorRef.current!.appendBodyLine('First line');
    });

    expect(titleSession.setDraft).toHaveBeenCalledTimes(1);
    expect(titleSession.setDraft).toHaveBeenCalledWith('OriginalFirst line');
    expect(titleSession.commit).toHaveBeenCalledTimes(1);
    await act(async () => { finish(true); await Promise.all([first, second]); });
    expect(await first).toBe(true);
    expect(await second).toBe(true);
  });

  it('keeps title-to-body navigation available when read-only', async () => {
    await act(async () => {
      root.render(createElement(MemoTitleEditor, {
        displayId: 'display:title-test',
        filename: 'Original.md',
        renameTitle,
        editable: false,
        allowReadOnlyBoundaryNavigation: true,
        onMoveToBody,
      }));
    });

    const readOnlyTextarea = container.querySelector('textarea')!;
    readOnlyTextarea.setSelectionRange(readOnlyTextarea.value.length, readOnlyTextarea.value.length);
    const event = dispatchKey(readOnlyTextarea, 'ArrowDown');

    expect(event.defaultPrevented).toBe(true);
    expect(titleSession.commit).not.toHaveBeenCalled();
    expect(onMoveToBody).toHaveBeenCalledWith({ insertEmptyLine: false });
  });

  it('does not enable read-only boundary navigation without the mode opt-in', async () => {
    await act(async () => {
      root.render(createElement(MemoTitleEditor, {
        displayId: 'display:title-test',
        filename: 'Original.md',
        renameTitle,
        editable: false,
        onMoveToBody,
      }));
    });

    const readOnlyTextarea = container.querySelector('textarea')!;
    readOnlyTextarea.setSelectionRange(readOnlyTextarea.value.length, readOnlyTextarea.value.length);
    const event = dispatchKey(readOnlyTextarea, 'ArrowDown');

    expect(event.defaultPrevented).toBe(false);
    expect(onMoveToBody).not.toHaveBeenCalled();
  });

  it('does not cancel title editing when Escape belongs to the IME', () => {
    act(() => {
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      dispatchKey(textarea, 'Escape', 229);
    });

    expect(titleSession.cancel).not.toHaveBeenCalled();
  });

  it('uses a document-selection surface in source mode', async () => {
    await act(async () => {
      root.render(createElement(MemoTitleEditor, {
        displayId: 'display:title-test',
        filename: 'Original.md',
        renameTitle,
        editable: true,
        useDocumentSelection: true,
        onMoveToBody,
      }));
    });

    const title = container.querySelector<HTMLElement>('.memo-title-editor--document-selection');
    expect(title?.tagName).toBe('DIV');
    expect(title?.getAttribute('contenteditable')).toBe('plaintext-only');
    expect(container.querySelector('textarea')).toBeNull();
  });
});

describe('MemoTitleEditor title paste splitting', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('uses the first line as the title and routes the rest to the body', () => {
    const onPasteToBody = vi.fn();
    act(() => {
      root.render(createElement(MemoTitleEditor, {
        displayId: 'display:title-test',
        filename: 'Original.md',
        renameTitle,
        editable: true,
        onMoveToBody: vi.fn(),
        onPasteToBody,
      }));
    });

    const textarea = container.querySelector('textarea')!;
    textarea.select();
    const event = dispatchPaste(textarea, 'Pasted title\nFirst body line\nSecond body line');

    expect(event.defaultPrevented).toBe(true);
    expect(titleSession.setDraft).toHaveBeenCalledWith('Pasted title');
    expect(onPasteToBody).toHaveBeenCalledWith(expect.objectContaining({
      text: 'First body line\nSecond body line',
    }));
  });
});

describe('MemoTitleEditor property submenu', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(createElement(MemoTitleEditor, {
        displayId: 'display:title-test',
        filename: 'Original.md',
        renameTitle,
        editable: true,
        onMoveToBody: vi.fn(),
      }));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  /** The menu is portaled to document.body, so query from there. */
  const menuItems = () =>
    Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));

  const openPropertiesMenu = () => {
    act(() => {
      container.querySelector<HTMLButtonElement>('.memo-title-properties-toggle')?.click();
    });
  };

  // Labels are resolved through i18n, so match the rendered zh-CN copy.
  const findAddPropertyRow = () =>
    menuItems().find((item) => item.textContent === '添加属性');

  /**
   * Reveal the preset panel the way the UI does: hovering the row. A click is
   * deliberately not used here because it performs the row's own action
   * (add a blank property) and closes the menu.
   */
  const hoverAddPropertyRow = () => {
    const row = findAddPropertyRow()!;
    act(() => {
      const event = new MouseEvent('mousemove', { bubbles: true });
      // The menu ignores zero-movement events, which is what jsdom reports.
      Object.defineProperty(event, 'movementX', { value: 3 });
      Object.defineProperty(event, 'movementY', { value: 3 });
      row.dispatchEvent(event);
    });
    return row;
  };

  const submenuPanel = () => document.body.querySelectorAll<HTMLElement>('[role="menu"]')[1];

  /** Capture `flowix:add-property` payloads for the duration of `run`. */
  const withAddPropertyRequests = (
    run: (requests: Array<{ propertyTargetId?: string; presetKey?: string }>) => void,
  ) => {
    const requests: Array<{ propertyTargetId?: string; presetKey?: string }> = [];
    const listener = (event: Event) => {
      requests.push((event as CustomEvent<{ propertyTargetId?: string; presetKey?: string }>).detail);
    };
    window.addEventListener('flowix:add-property', listener);
    try {
      run(requests);
    } finally {
      window.removeEventListener('flowix:add-property', listener);
    }
  };

  it('reveals label-only preset children under a 预设 group heading', () => {
    withAddPropertyRequests(() => {
      openPropertiesMenu();

      const addPropertyRow = findAddPropertyRow();
      expect(addPropertyRow).not.toBeUndefined();
      expect(addPropertyRow?.getAttribute('aria-haspopup')).toBe('menu');
      expect(addPropertyRow?.getAttribute('aria-expanded')).toBe('false');

      // The panel is not mounted at all until the row is hovered.
      expect(document.body.querySelectorAll('[role="menu"]')).toHaveLength(1);

      hoverAddPropertyRow();

      expect(findAddPropertyRow()?.getAttribute('aria-expanded')).toBe('true');
      // Scope to the submenu panel: the parent menu's own leaves are still mounted.
      const submenu = submenuPanel();
      expect(submenu).not.toBeUndefined();
      // The 预设 heading labels the group without being an actionable item.
      expect(submenu.textContent).toContain('预设');
      const submenuItems = Array.from(submenu.querySelectorAll('[role="menuitem"]'));
      expect(submenuItems.map((item) => item.textContent))
        .toEqual(['名称', '描述', '标签', '颜色', '图标']);
      // Rows are label-only: no leading icon slot is rendered inside the submenu.
      expect(submenuItems.every((item) => item.querySelector('svg') === null)).toBe(true);
    });
  });

  it('anchors the submenu flush to the hovered item top-right corner', () => {
    withAddPropertyRequests(() => {
      openPropertiesMenu();
      // jsdom lays out nothing, so give the hovered row real geometry before
      // the submenu measures it. The row is inset by the menu's padding: the
      // menu spans x=100..280 while the row spans x=104..276.
      findAddPropertyRow()!.getBoundingClientRect = () => rect(104, 128, 172, 28);

      hoverAddPropertyRow();

      const submenu = submenuPanel();
      expect(submenu).not.toBeUndefined();

      // Flush against the row's own right edge (276), not the menu's (280).
      expect(Number.parseFloat(submenu.style.left)).toBeCloseTo(276, 0);
      // Top aligns to the hovered row, compensating the panel's own padding so
      // the first submenu row sits level with it (128 - padding).
      const padding = Number.parseFloat(getComputedStyle(submenu).paddingTop) || 0;
      expect(Number.parseFloat(submenu.style.top)).toBeCloseTo(128 - padding, 0);
    });
  });

  it('adds a blank property when the 添加属性 row itself is activated', () => {
    withAddPropertyRequests((requests) => {
      openPropertiesMenu();
      act(() => { findAddPropertyRow()?.click(); });

      // Clicking the row must still perform its own action, not only expand.
      expect(requests).toEqual([{ propertyTargetId: 'file:display:title-test' }]);
      // The blank-property path is the menu's default action, so the menu closes.
      expect(document.body.querySelector('[role="menu"]')).toBeNull();
    });
  });

  it('adds a blank property when Enter activates the 添加属性 row', () => {
    withAddPropertyRequests((requests) => {
      openPropertiesMenu();
      const menu = document.body.querySelector<HTMLElement>('[role="menu"]')!;

      // ArrowDown moves the selection onto 添加属性 (the second row); the menu
      // owns that key handling, so drive it before Enter.
      act(() => {
        menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      });
      act(() => {
        menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });

      expect(requests).toEqual([{ propertyTargetId: 'file:display:title-test' }]);
    });
  });

  it('dispatches a preset-scoped add-property request when a preset is picked', () => {
    withAddPropertyRequests((requests) => {
      openPropertiesMenu();
      hoverAddPropertyRow();

      act(() => {
        menuItems().find((item) => item.textContent === '标签')?.click();
      });

      // Only the preset request, never a bare blank-property add.
      expect(requests).toEqual([{
        propertyTargetId: 'file:display:title-test',
        presetKey: 'tags',
      }]);
      // Selecting a leaf closes the menu rather than leaving it open.
      expect(document.body.querySelector('[role="menu"]')).toBeNull();
    });
  });

  /**
   * Stand in for the frontmatter node view: answer the occupied-keys query with
   * the supplied keys, the way the editor does synchronously on dispatch.
   */
  const withOccupiedKeys = (keys: string[], run: () => void) => {
    const responder = (event: Event) => {
      const detail = (event as CustomEvent<{ keys?: string[] }>).detail;
      detail?.keys?.push(...keys);
    };
    window.addEventListener('flowix:query-occupied-property-keys', responder);
    try {
      run();
    } finally {
      window.removeEventListener('flowix:query-occupied-property-keys', responder);
    }
  };

  it('disables presets that are already present in the frontmatter', () => {
    withAddPropertyRequests(() => {
      withOccupiedKeys(['tags', 'flowix_colors'], () => {
        openPropertiesMenu();
        hoverAddPropertyRow();
      });

      const submenuItems = Array.from(submenuPanel().querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
      const byLabel = new Map(submenuItems.map((item) => [item.textContent, item]));

      // Taken presets are inert and explain why.
      expect(byLabel.get('标签')?.disabled).toBe(true);
      expect(byLabel.get('标签')?.title).toBe('该属性已存在');
      expect(byLabel.get('颜色')?.disabled).toBe(true);
      // Untaken presets stay actionable.
      expect(byLabel.get('名称')?.disabled).toBe(false);
      expect(byLabel.get('描述')?.disabled).toBe(false);
      expect(byLabel.get('图标')?.disabled).toBe(false);
    });
  });

  it('does not dispatch a request when a disabled preset is clicked', () => {
    withAddPropertyRequests((requests) => {
      withOccupiedKeys(['tags'], () => {
        openPropertiesMenu();
        hoverAddPropertyRow();
      });

      act(() => {
        menuItems().find((item) => item.textContent === '标签')?.click();
      });

      // A disabled leaf must not queue a duplicate add.
      expect(requests).toEqual([]);
    });
  });

  it('keeps every preset enabled when the frontmatter has no properties yet', () => {
    withAddPropertyRequests(() => {
      // No responder installed: nothing is occupied.
      openPropertiesMenu();
      hoverAddPropertyRow();

      const submenuItems = Array.from(submenuPanel().querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
      expect(submenuItems.every((item) => !item.disabled)).toBe(true);
    });
  });
});
