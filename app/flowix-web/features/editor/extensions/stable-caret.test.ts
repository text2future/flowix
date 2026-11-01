import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor, Node as TiptapNode } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { ComposerStableCaret, StableCaret, getInlineAtomBoundaryCaretRect, getTerminalInlineAtomCaretRect } from './stable-caret';
import { createInlineAtomNodeView } from './shared/inline-atom-nodeview';

const chipSchema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    chip: { inline: true, atom: true, group: 'inline' },
  },
});

function setRect(element: HTMLElement, rect: Partial<DOMRect>): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: rect.left ?? 0,
      right: rect.right ?? 0,
      top: rect.top ?? 0,
      bottom: rect.bottom ?? 0,
      width: rect.width ?? 0,
      height: rect.height ?? 0,
    }),
  });
}

describe('getTerminalInlineAtomCaretRect', () => {
  it('anchors the caret to the visible note card instead of the trailing break', () => {
    const editor = document.createElement('div');
    editor.className = 'ProseMirror';
    const wrapper = document.createElement('span');
    const card = document.createElement('span');
    const anchor = document.createElement('span');

    card.className = 'note-reference__card';
    anchor.className = 'terminal-inline-atom-caret-anchor';
    anchor.setAttribute('data-terminal-inline-atom-caret-position', '17');
    Object.defineProperty(card, 'getClientRects', {
      configurable: true,
      value: () => [
        { left: 100, right: 240, top: 80, bottom: 106, width: 140, height: 26 },
        { left: 80, right: 220, top: 107, bottom: 133, width: 140, height: 26 },
      ],
    });

    wrapper.append(card);
    editor.append(wrapper, anchor);

    const result = getTerminalInlineAtomCaretRect(
      { dom: editor } as never,
      17,
    );

    expect(result).toEqual({ left: 220, top: 107, bottom: 133 });
  });

  it('does not use another atom anchor position', () => {
    const editor = document.createElement('div');
    const wrapper = document.createElement('span');
    const card = document.createElement('span');
    const anchor = document.createElement('span');

    card.className = 'note-reference__card';
    anchor.className = 'terminal-inline-atom-caret-anchor';
    anchor.setAttribute('data-terminal-inline-atom-caret-position', '17');
    setRect(card, { left: 100, right: 240, top: 80, bottom: 106, width: 140, height: 26 });
    wrapper.append(card);
    editor.append(wrapper, anchor);

    expect(getTerminalInlineAtomCaretRect({ dom: editor } as never, 18)).toBeNull();
  });

  it('does not use an anchor from a nested ProseMirror editor', () => {
    const editor = document.createElement('div');
    editor.className = 'ProseMirror';
    const nestedEditor = document.createElement('div');
    nestedEditor.className = 'ProseMirror';
    const wrapper = document.createElement('span');
    const card = document.createElement('span');
    const anchor = document.createElement('span');

    card.className = 'note-reference__card';
    anchor.className = 'terminal-inline-atom-caret-anchor';
    anchor.setAttribute('data-terminal-inline-atom-caret-position', '17');
    setRect(card, { left: 100, right: 240, top: 80, bottom: 106, width: 140, height: 26 });
    wrapper.append(card);
    nestedEditor.append(wrapper, anchor);
    editor.append(nestedEditor);

    expect(getTerminalInlineAtomCaretRect({ dom: editor } as never, 17)).toBeNull();
  });
});

describe('composer inline atom caret boundaries', () => {
  it.each(['slash-token', 'skill-token', 'folder-token', 'note-reference'])('%s keeps both caret edges clear of the border after deleting a separator', (kind) => {
    const wrapper = document.createElement('span');
    wrapper.className = `agent-composer__inline-atom-wrapper ${kind}`;
    wrapper.setAttribute('data-inline-atom-caret', 'single-line');
    const card = document.createElement('span');
    card.setAttribute('data-inline-atom-card', '');
    setRect(card, { left: 100, right: 240, top: 80, bottom: 106, width: 140, height: 26 });
    wrapper.append(card);
    const doc = chipSchema.node('doc', null, [chipSchema.node('paragraph', null, [
      chipSchema.text(' '), chipSchema.node('chip'), chipSchema.text(' '),
    ])]);
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, 2) });
    state = state.apply(state.tr.delete(1, 2));
    const view = { state, nodeDOM: (pos: number) => pos === 1 ? wrapper : null };
    // Simulate the browser returning the next line / card border for native
    // caret coordinates: the resolver uses the visible card for both sides.
    expect(getInlineAtomBoundaryCaretRect(view as never, 1)).toEqual({ left: 97, top: 80, bottom: 106 });
    state = state.apply(state.tr.delete(2, 3));
    view.state = state;
    expect(getInlineAtomBoundaryCaretRect(view as never, 2)).toEqual({ left: 241, top: 80, bottom: 106 });
  });

  it('leaves ordinary text positions to the native caret', () => {
    const doc = chipSchema.node('doc', null, [chipSchema.node('paragraph', null, chipSchema.text('text'))]);
    const view = { state: EditorState.create({ doc }), nodeDOM: () => null };
    expect(getInlineAtomBoundaryCaretRect(view as never, 3)).toBeNull();
  });

  it('does not take over other editor atoms or unmounted cards', () => {
    const doc = chipSchema.node('doc', null, [chipSchema.node('paragraph', null, chipSchema.node('chip'))]);
    const wrapper = document.createElement('span');
    const view = { state: EditorState.create({ doc }), nodeDOM: () => wrapper };
    expect(getInlineAtomBoundaryCaretRect(view as never, 1)).toBeNull();
    wrapper.className = 'agent-composer__inline-atom-wrapper';
    wrapper.setAttribute('data-inline-atom-caret', 'single-line');
    expect(getInlineAtomBoundaryCaretRect(view as never, 2)).toBeNull();
  });

  it('uses the configured caret width and gap for either direction', () => {
    const doc = chipSchema.node('doc', null, [chipSchema.node('paragraph', null, chipSchema.node('chip'))]);
    const wrapper = document.createElement('span');
    wrapper.className = 'agent-composer__inline-atom-wrapper';
    wrapper.setAttribute('data-inline-atom-caret', 'single-line');
    wrapper.style.setProperty('--editor-caret-width', '3px');
    wrapper.style.setProperty('--inline-atom-caret-gap', '2px');
    const card = document.createElement('span');
    card.setAttribute('data-inline-atom-card', '');
    setRect(card, { left: 100, right: 240, top: 80, bottom: 106, width: 140, height: 26 });
    wrapper.append(card);
    document.body.append(wrapper);
    const view = { state: EditorState.create({ doc }), nodeDOM: () => wrapper };
    expect(getInlineAtomBoundaryCaretRect(view as never, 1)?.left).toBe(95);
    expect(getInlineAtomBoundaryCaretRect(view as never, 2)?.left).toBe(242);
    card.style.direction = 'rtl';
    expect(getInlineAtomBoundaryCaretRect(view as never, 1)?.left).toBe(242);
    expect(getInlineAtomBoundaryCaretRect(view as never, 2)?.left).toBe(95);
    wrapper.remove();
  });
});

describe('separate StableCaret instances in nested editors', () => {
  const editors: Editor[] = [];
  afterEach(() => {
    editors.splice(0).reverse().forEach((editor) => editor.destroy());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('uses the same caret for text and both card edges, and restores native selection during composition', () => {
    vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    const frames = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextId, callback);
      return nextId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const flush = () => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(0));
    };
    const Chip = TiptapNode.create({
      name: 'chip', inline: true, atom: true, group: 'inline',
      renderHTML: () => ['span'],
      addNodeView: () => () => createInlineAtomNodeView({
        caretGeometry: 'single-line',
        wrapperClassName: 'agent-composer__inline-atom-wrapper', label: '计划模式',
      }),
    });
    const mount = document.createElement('div');
    mount.contentEditable = 'false';
    mount.className = 'agent-composer__input-row';
    const NestedComposer = TiptapNode.create({
      name: 'nestedComposer', group: 'block', atom: true,
      renderHTML: () => ['div'],
      addNodeView: () => () => ({ dom: mount, ignoreMutation: () => true }),
    });
    const parentMount = document.createElement('div');
    document.body.append(parentMount);
    const parent = new Editor({
      element: parentMount, extensions: [StarterKit, NestedComposer, StableCaret],
      content: { type: 'doc', content: [
        { type: 'paragraph', content: [{ type: 'text', text: '正文' }] },
        { type: 'nestedComposer' },
      ] },
      editorProps: { attributes: { style: 'font-size: 16px' } },
    });
    editors.push(parent);
    const parentCaret = document.body.querySelector<HTMLElement>('.stable-editor-caret--document')!;
    setRect(parent.view.dom, { left: 0, right: 500, top: 0, bottom: 100, width: 500, height: 100 });
    vi.spyOn(parent.view, 'coordsAtPos').mockReturnValue({ left: 20, right: 20, top: 20, bottom: 46 });
    // EditorView can report focus in a nested editable as parent focus too.
    vi.spyOn(parent.view, 'hasFocus').mockReturnValue(true);
    const editor = new Editor({
      element: mount,
      extensions: [StarterKit, Chip, ComposerStableCaret],
      editorProps: { attributes: { class: 'agent-composer__input-content', style: 'font-size: 16px' } },
      content: { type: 'doc', content: [{ type: 'paragraph', content: [
        { type: 'text', text: 'x' }, { type: 'chip' }, { type: 'text', text: 'yz' },
      ] }] },
    });
    editors.push(editor);
    setRect(editor.view.dom, { left: 0, right: 500, top: 0, bottom: 100, width: 500, height: 100 });
    const card = editor.view.dom.querySelector<HTMLElement>('[data-inline-atom-card]')!;
    setRect(card, { left: 100, right: 240, top: 20, bottom: 46, width: 140, height: 26 });
    vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ left: 20, right: 20, top: 20, bottom: 46 });
    editor.view.dom.focus();
    editor.commands.setTextSelection(2);
    flush();
    const caret = document.body.querySelector<HTMLElement>('.agent-composer__stable-caret')!;
    expect(caret.hidden).toBe(false);
    expect(caret.style.left).toBe('97px');
    expect(caret.style.width).toBe('2px');
    expect(editor.view.dom.classList.contains('has-composer-stable-caret')).toBe(true);
    expect(parentCaret.hidden).toBe(true);
    expect(parent.view.dom.classList.contains('has-document-stable-caret')).toBe(false);
    editor.commands.setTextSelection(3);
    flush();
    expect(caret.style.left).toBe('241px');
    editor.commands.setTextSelection(4);
    flush();
    expect(caret.style.left).toBe('20px');
    expect(document.body.querySelectorAll('.stable-editor-caret--document:not([hidden])')).toHaveLength(0);
    expect(document.body.querySelectorAll('.agent-composer__stable-caret:not([hidden])')).toHaveLength(1);
    editor.commands.setTextSelection({ from: 1, to: 4 });
    flush();
    expect(caret.hidden).toBe(true);
    editor.commands.setTextSelection(2);
    flush();
    vi.spyOn(editor.view, 'composing', 'get').mockReturnValue(true);
    editor.view.dom.dispatchEvent(new Event('compositionstart'));
    flush();
    expect(caret.hidden).toBe(true);
    expect(editor.view.dom.classList.contains('has-composer-stable-caret')).toBe(false);
    parent.view.dom.focus();
    parent.commands.setTextSelection(1);
    flush();
    expect(parentCaret.hidden).toBe(false);
    expect(parentCaret.style.width).toBe(caret.style.width);
    expect(parentCaret.style.height).toBe(caret.style.height);
    expect(caret.hidden).toBe(true);
    expect(frames.size).toBe(0);
    editor.view.dom.focus();
    flush();
    expect(frames.size).toBe(0);
    editor.view.dom.dispatchEvent(new Event('compositionend'));
    expect(frames.size).toBeGreaterThan(0);
    editor.destroy();
    editors.splice(editors.indexOf(editor), 1);
    expect(frames.size).toBe(0);
  });
});

describe.each(['composer', 'document'] as const)('%s local caret layer', (scope) => {
  let editor: Editor;
  let layer: HTMLElement;
  let caret: HTMLElement;
  let frames: Map<number, FrameRequestCallback>;
  let resize: (target: Element) => void;
  let disconnect: ReturnType<typeof vi.fn>;

  function flush() {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(0));
  }

  function mount() {
    frames = new Map();
    let nextId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextId, callback);
      return nextId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const targets = new Set<Element>();
    disconnect = vi.fn(() => targets.clear());
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        resize = (target) => {
          if (targets.has(target)) callback([], this as unknown as ResizeObserver);
        };
      }
      observe(target: Element) { targets.add(target); }
      unobserve(target: Element) { targets.delete(target); }
      disconnect = disconnect;
    });
    const host = document.createElement('div');
    host.className = scope === 'composer' ? 'agent-composer__input-row' : 'markdown-editor';
    host.contentEditable = 'false';
    const input = document.createElement('div');
    host.append(input);
    document.body.append(host);
    editor = new Editor({
      element: { mount: input },
      extensions: [StarterKit, scope === 'composer' ? ComposerStableCaret : StableCaret],
      content: '<p>hello</p>',
      editorProps: { attributes: {
        class: scope === 'composer' ? 'agent-composer__input-content' : 'editor-content', style: 'font-size: 16px', tabindex: '0',
      } },
    });
    layer = host.querySelector<HTMLElement>(scope === 'composer'
      ? '.agent-composer__caret-layer' : '.document-editor-caret-layer')!;
    caret = layer.querySelector<HTMLElement>(scope === 'composer'
      ? '.agent-composer__stable-caret' : '.stable-editor-caret--document')!;
    setRect(layer, { left: 40, right: 600, top: 30, bottom: 130, width: 560, height: 100 });
    setRect(input, { left: 60, right: 560, top: 40, bottom: 120, width: 500, height: 80 });
    const coords = vi.spyOn(editor.view, 'coordsAtPos')
      .mockReturnValue({ left: 100, right: 100, top: 50, bottom: 76 });
    input.focus();
    editor.commands.setTextSelection(3);
    flush();
    return { input, coords };
  }

  afterEach(() => {
    if (!editor.isDestroyed) editor.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('uses local coordinates outside the editable DOM and stays idle when its row translates', async () => {
    const { input, coords } = mount();
    expect(layer.parentElement).toBe(input.parentElement);
    expect(input.contains(caret)).toBe(false);
    expect(layer.contentEditable).toBe('false');
    expect(caret.hidden).toBe(false);
    expect(caret.style.left).toBe('60px');
    expect(Number.parseFloat(caret.style.top)).toBeCloseTo(23.8);
    expect(layer.style.clipPath).toBe('inset(10px 40px 10px 20px)');
    await Promise.resolve();
    flush();
    await Promise.resolve();
    expect(frames.size).toBe(0);
    coords.mockClear();
    setRect(layer, { left: 140, right: 700, top: 80, bottom: 180, width: 560, height: 100 });
    setRect(input, { left: 160, right: 660, top: 90, bottom: 170, width: 500, height: 80 });
    coords.mockReturnValue({ left: 200, right: 200, top: 100, bottom: 126 });
    flush();
    expect(coords).not.toHaveBeenCalled();
    expect(caret.style.left).toBe('60px');
    resize(input);
    flush();
    expect(caret.style.left).toBe('60px');
    expect(Number.parseFloat(caret.style.top)).toBeCloseTo(23.8);
  });

  it('coalesces viewport and internal token/paragraph resize notifications', () => {
    const { input, coords } = mount();
    coords.mockClear();
    coords.mockReturnValue({ left: 120, right: 120, top: 80, bottom: 106 });
    resize(input);
    resize(input.querySelector('p')!);
    resize(input);
    expect(frames.size).toBe(1);
    flush();
    expect(coords).toHaveBeenCalledTimes(1);
    expect(caret.style.left).toBe('80px');
    expect(Number.parseFloat(caret.style.top)).toBeCloseTo(53.8);
    expect(frames.size).toBe(0);
  });

  it('tracks new paragraphs and stops observing removed content', async () => {
    const { input, coords } = mount();
    editor.commands.setContent('<p>new</p><p>paragraph</p>');
    await Promise.resolve();
    flush();
    const addedParagraph = input.querySelector('p:last-child')!;
    coords.mockClear();
    resize(addedParagraph);
    flush();
    expect(coords).toHaveBeenCalledTimes(1);
    editor.commands.setContent('<p>remaining</p>');
    await Promise.resolve();
    flush();
    expect(addedParagraph.isConnected).toBe(false);
    coords.mockClear();
    resize(addedParagraph);
    flush();
    expect(coords).not.toHaveBeenCalled();
  });

  it('hides outside the input viewport and restores on internal scroll', () => {
    const { input, coords } = mount();
    coords.mockReturnValue({ left: 100, right: 100, top: 130, bottom: 156 });
    input.dispatchEvent(new Event('scroll'));
    flush();
    expect(caret.hidden).toBe(true);
    coords.mockReturnValue({ left: 100, right: 100, top: 110, bottom: 136 });
    input.dispatchEvent(new Event('scroll'));
    flush();
    expect(caret.hidden).toBe(false);
    expect(layer.style.clipPath).toBe('inset(10px 40px 10px 20px)');
  });

  it('converts scaled viewport coordinates to CSS coordinates', () => {
    const { input, coords } = mount();
    Object.defineProperties(layer, {
      offsetWidth: { configurable: true, value: 280 },
      offsetHeight: { configurable: true, value: 50 },
    });
    coords.mockReturnValue({ left: 100, right: 100, top: 50, bottom: 102 });
    resize(input);
    flush();
    expect(caret.style.left).toBe('30px');
    expect(Number.parseFloat(caret.style.top)).toBeCloseTo(13.8);
    expect(layer.style.clipPath).toBe('inset(5px 20px 5px 10px)');
  });

  it.each([2, 4])('keeps the full %ipx caret visible when text fills the input width', (width) => {
    const { input, coords } = mount();
    input.style.setProperty(scope === 'composer' ? '--agent-composer-caret-width' : '--editor-caret-width', `${width}px`);
    // The layer has no spare space beyond the input, as in production.
    setRect(layer, { left: 60, right: 560, top: 40, bottom: 120, width: 500, height: 80 });
    coords.mockReturnValue({ left: 560, right: 560, top: 50, bottom: 76 });
    resize(input);
    flush();
    expect(caret.hidden).toBe(false);
    expect(caret.style.width).toBe(`${width}px`);
    expect(Number.parseFloat(caret.style.left)).toBe(500 - width);
    expect(layer.style.clipPath).toBe('inset(0px 0px 0px 0px)');
    expect(input.classList.contains(scope === 'composer' ? 'has-composer-stable-caret' : 'has-document-stable-caret')).toBe(true);
  });

  it('keeps the right-edge caret inside a scaled viewport without showing offscreen positions', () => {
    const { input, coords } = mount();
    Object.defineProperties(layer, {
      offsetWidth: { configurable: true, value: 280 },
      offsetHeight: { configurable: true, value: 50 },
    });
    coords.mockReturnValue({ left: 559, right: 559, top: 50, bottom: 76 });
    resize(input);
    flush();
    expect(caret.hidden).toBe(false);
    expect(Number.parseFloat(caret.style.left)).toBe(258);
    coords.mockReturnValue({ left: 562, right: 562, top: 50, bottom: 76 });
    resize(input);
    flush();
    expect(caret.hidden).toBe(true);
  });

  it('updates after internal style changes without observing its own render in a loop', async () => {
    const { input, coords } = mount();
    await Promise.resolve();
    flush();
    coords.mockClear();
    coords.mockReturnValue({ left: 125, right: 125, top: 50, bottom: 76 });
    input.style.fontSize = '20px';
    await Promise.resolve();
    expect(frames.size).toBe(1);
    flush();
    expect(coords).toHaveBeenCalledTimes(1);
    expect(caret.style.left).toBe('85px');
    await Promise.resolve();
    expect(frames.size).toBe(0);
  });

  it('restores the native caret during composition and hides for a range selection', () => {
    const { input } = mount();
    const composing = vi.spyOn(editor.view, 'composing', 'get').mockReturnValue(true);
    input.dispatchEvent(new Event('compositionstart'));
    expect(caret.hidden).toBe(true);
    expect(input.classList.contains(scope === 'composer' ? 'has-composer-stable-caret' : 'has-document-stable-caret')).toBe(false);
    composing.mockReturnValue(false);
    input.dispatchEvent(new Event('compositionend'));
    flush();
    expect(caret.hidden).toBe(false);
    editor.commands.setTextSelection({ from: 1, to: 3 });
    flush();
    expect(caret.hidden).toBe(true);
    expect(frames.size).toBe(0);
  });

  it('keeps the caret inside a padded inline box instead of on its border', () => {
    const { coords } = mount();
    editor.commands.setContent('<p><code>hah</code></p>');
    const glyph = { left: 160, right: 190, top: 50, bottom: 76, width: 30, height: 26 };
    vi.spyOn(document, 'createRange').mockImplementation(() => ({
      setStart: () => {},
      setEnd: () => {},
      getBoundingClientRect: () => glyph,
    }) as unknown as Range);
    // coordsAtPos describes the inline element's border box: one padding+border
    // gap to the right of the last glyph.
    coords.mockReturnValue({ left: 196, right: 196, top: 50, bottom: 76 });
    editor.commands.setTextSelection(4);
    flush();
    expect(caret.style.left).toBe('150px');
  });

  it('keeps the reported geometry when the last glyph has no layout box', () => {
    const { coords } = mount();
    editor.commands.setContent('<p><code>hah </code></p>');
    vi.spyOn(document, 'createRange').mockImplementation(() => ({
      setStart: () => {},
      setEnd: () => {},
      getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }),
    }) as unknown as Range);
    coords.mockReturnValue({ left: 196, right: 196, top: 50, bottom: 76 });
    editor.commands.setTextSelection(5);
    flush();
    expect(caret.style.left).toBe('156px');
  });

  it('keeps the reported geometry inside a text run and at plain glyph edges', () => {
    const { coords } = mount();
    editor.commands.setContent('<p><code>hah</code> tail</p>');
    const glyph = { left: 160, right: 190, top: 50, bottom: 76, width: 30, height: 26 };
    const createRange = vi.spyOn(document, 'createRange').mockImplementation(() => ({
      setStart: () => {},
      setEnd: () => {},
      getBoundingClientRect: () => glyph,
    }) as unknown as Range);
    coords.mockReturnValue({ left: 196, right: 196, top: 50, bottom: 76 });
    // Mid-run: the browser already reports the next glyph.
    editor.commands.setTextSelection(2);
    flush();
    expect(createRange).not.toHaveBeenCalled();
    expect(caret.style.left).toBe('156px');
    // End of the code box with trailing text: the reported edge is the next
    // character, one padding+border gap past the last glyph.
    coords.mockReturnValue({ left: 200, right: 200, top: 50, bottom: 76 });
    editor.commands.setTextSelection(4);
    flush();
    expect(caret.style.left).toBe('150px');
  });

  it('releases observers, pending frames and the layer when destroyed', async () => {
    const { input, coords } = mount();
    resize(input);
    expect(frames.size).toBe(1);
    editor.destroy();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(layer.isConnected).toBe(false);
    expect(frames.size).toBe(0);
    coords.mockClear();
    input.style.fontSize = '20px';
    input.dispatchEvent(new Event('load'));
    resize(input);
    await Promise.resolve();
    flush();
    expect(coords).not.toHaveBeenCalled();
  });
});
