import { terminalInlineAtomCaretPosition } from './shared/terminal-inline-atom-caret';
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

type StableCaretScope = 'document' | 'composer';

function activeClassFor(scope: StableCaretScope): string {
  return scope === 'composer' ? 'has-composer-stable-caret' : 'has-document-stable-caret';
}

function elementAtPosition(view: EditorView, position: number): HTMLElement {
  const { node } = view.domAtPos(position, -1);
  if (node instanceof HTMLElement) return node;
  return node.parentElement ?? view.dom;
}

function caretHeightAt(view: EditorView, position: number): number {
  const element = elementAtPosition(view, position);
  const fontSize = Number.parseFloat(getComputedStyle(element).fontSize);
  const resolvedFontSize = Number.isFinite(fontSize) ? fontSize : 16;

  // Native carets expand to the line box in editable pre-wrap content. Keep
  // the visual caret tied to glyph size instead, independently of line-height.
  return Math.max(12, resolvedFontSize * 1.15);
}

function caretWidthAt(element: HTMLElement, scope: StableCaretScope = scopeAt(element)): number {
  const property = scope === 'composer' ? '--agent-composer-caret-width' : '--editor-caret-width';
  const width = Number.parseFloat(getComputedStyle(element).getPropertyValue(property));
  return Number.isFinite(width) && width > 0 ? width : 2;
}

function scopeAt(element: HTMLElement): StableCaretScope {
  return element.closest('.agent-composer__input-content') ? 'composer' : 'document';
}

interface CaretRect {
  left: number;
  top: number;
  bottom: number;
}

/** Resolve both sides from the logical selection and the visible chip, never
 * from the browser's caret inside a non-editable NodeView. The shared caret
 * is two pixels wide; its nearest edge stays one pixel away from the border. */
export function getInlineAtomBoundaryCaretRect(
  view: Pick<EditorView, 'state' | 'nodeDOM'>,
  position: number,
): CaretRect | null {
  const $pos = view.state.doc.resolve(position);
  const candidates = [
    { node: $pos.nodeBefore, pos: position - ($pos.nodeBefore?.nodeSize ?? 0), side: 'after' },
    { node: $pos.nodeAfter, pos: position, side: 'before' },
  ] as const;
  for (const { node, pos, side } of candidates) {
    if (!node?.isInline || !node.isAtom || node.isText) continue;
    const wrapper = view.nodeDOM(pos);
    if (!(wrapper instanceof HTMLElement)
      || wrapper.getAttribute('data-inline-atom-caret') !== 'single-line') continue;
    const card = wrapper.querySelector<HTMLElement>('[data-inline-atom-card]');
    if (!card) continue;
    const rect = card.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const scope = scopeAt(wrapper);
    const gapProperty = scope === 'composer' ? '--agent-composer-caret-gap' : '--inline-atom-caret-gap';
    const gapValue = Number.parseFloat(getComputedStyle(wrapper).getPropertyValue(gapProperty));
    const gap = Number.isFinite(gapValue) && gapValue >= 0 ? gapValue : 1;
    const width = caretWidthAt(wrapper, scope);
    const rtl = getComputedStyle(card).direction === 'rtl';
    const leftEdge = (side === 'before') !== rtl;
    const result = {
      left: leftEdge ? rect.left - width - gap : rect.right + gap,
      top: rect.top,
      bottom: rect.bottom,
    };
    if (isUsableCaretRect(result)) return result;
  }
  return null;
}

interface TerminalInlineAtomCaretResolution {
  found: boolean;
  rect: CaretRect | null;
}

function isUsableCaretRect(rect: CaretRect): boolean {
  return Number.isFinite(rect.left)
    && Number.isFinite(rect.top)
    && Number.isFinite(rect.bottom)
    && rect.bottom >= rect.top;
}

function terminalInlineCaretRect(card: HTMLElement): CaretRect | null {
  // A collapsed range at the end of the content represents the actual visual
  // caret position, including the final line of a wrapped inline element.
  // Unlike getBoundingClientRect(), it does not return the union of all line
  // fragments.
  try {
    const range = document.createRange();
    range.selectNodeContents(card);
    range.collapse(false);
    const rangeRect = range.getBoundingClientRect();
    if (
      rangeRect.width <= 1.5
      && rangeRect.height > 0
      && isUsableCaretRect({
        left: rangeRect.left,
        top: rangeRect.top,
        bottom: rangeRect.bottom,
      })
    ) {
      return {
        left: rangeRect.left,
        top: rangeRect.top,
        bottom: rangeRect.bottom,
      };
    }
  } catch {
    // Fall through to fragment geometry for older or partially implemented
    // browser Range implementations.
  }

  // Inline elements can produce one DOMRect per visual line.  Select the
  // lowest fragment, then the rightmost one for wrapped bidirectional text.
  const fragments = Array.from(card.getClientRects())
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .sort((a, b) => a.bottom - b.bottom || a.right - b.right);
  const lastFragment = fragments[fragments.length - 1];
  if (!lastFragment) return null;

  const direction = getComputedStyle(card).direction;
  const left = direction === 'rtl' ? lastFragment.left : lastFragment.right;
  const fragmentRect = { left, top: lastFragment.top, bottom: lastFragment.bottom };
  return isUsableCaretRect(fragmentRect) ? fragmentRect : null;
}

function findTerminalInlineAtomCaretAnchor(
  view: Pick<EditorView, 'dom'>,
  position: number,
): HTMLElement | null {
  const anchors = view.dom.querySelectorAll<HTMLElement>(
    '.terminal-inline-atom-caret-anchor',
  );
  return Array.from(anchors).find((anchor) => (
    anchor.closest('.ProseMirror') === view.dom
    &&
    terminalInlineAtomCaretPosition(anchor) === position
  )) ?? null;
}

function resolveTerminalInlineAtomCaret(
  view: Pick<EditorView, 'dom'>,
  position: number,
): TerminalInlineAtomCaretResolution {
  const anchor = findTerminalInlineAtomCaretAnchor(view, position);
  if (!anchor) return { found: false, rect: null };

  // The decoration is inserted immediately after the NodeView wrapper.
  // Prefer the visible card's terminal visual fragment. The card may wrap,
  // so its union bounding box is not a valid caret position.
  const atomWrapper = anchor.previousElementSibling as HTMLElement | null;
  const card = atomWrapper?.querySelector<HTMLElement>(
    '.note-reference__card, .editor-file-attachment__card',
  );
  if (card) {
    const cardRect = terminalInlineCaretRect(card);
    if (cardRect) return { found: true, rect: cardRect };
  }

  // If a custom atom has no known card class, its wrapper is still a useful
  // single-fragment fallback.
  const wrapperRect = atomWrapper?.getBoundingClientRect();
  if (wrapperRect && wrapperRect.width > 0 && wrapperRect.height > 0) {
    const fallbackRect = {
      left: wrapperRect.right,
      top: wrapperRect.top,
      bottom: wrapperRect.bottom,
    };
    if (isUsableCaretRect(fallbackRect)) return { found: true, rect: fallbackRect };
  }

  return { found: true, rect: null };
}

interface TextRunEdge {
  text: Text;
  from: number;
  to: number;
}

function trailingTextRun(
  view: Pick<EditorView, 'domAtPos'>,
  position: number,
): TextRunEdge | null {
  let node: Node;
  let offset: number;
  try {
    ({ node, offset } = view.domAtPos(position, -1));
  } catch {
    return null;
  }
  // `nodeType` is used instead of `instanceof Text` so editors mounted in
  // another realm (frame/shadow root) resolve the same way.
  if (!node || node.nodeType !== 3) return null;
  const text = node as Text;
  if (!offset || offset !== text.data.length) return null;
  // Step over the low surrogate of a trailing astral character so the range
  // spans a whole code point instead of half of one.
  let from = offset - 1;
  const unit = text.data.charCodeAt(from);
  if (from > 0 && unit >= 0xdc00 && unit <= 0xdfff) from -= 1;
  return { text, from, to: offset };
}

function lastGlyphRect(edge: TextRunEdge): DOMRect | null {
  try {
    const range = edge.text.ownerDocument.createRange();
    range.setStart(edge.text, edge.from);
    range.setEnd(edge.text, edge.to);
    const rect = range.getBoundingClientRect();
    // A collapsed trailing space, or a node without a layout box, reports an
    // empty rect at the origin. Drawing from it would send the caret to the
    // top-left corner, so keep the browser geometry instead.
    return rect.height > 0 ? rect : null;
  } catch {
    return null;
  }
}

/**
 * Returns the caret geometry for a position at the end of a padded inline box
 * (inline code, `==highlight==`), or null to keep the reported geometry.
 *
 * `coordsAtPos` describes such a position with the inline element's border
 * box, so the caret is drawn outside the padding and border instead of right
 * after the last glyph (measured: 58.34px for the box edge against 52.55px for
 * the glyph, i.e. one `0.3rem` padding plus the 1px border). Measuring the
 * last glyph gives the in-box edge. The measurement only wins when the
 * reported edge sits more than a pixel to the right of that glyph — exactly
 * the gap the caret must not cross — so plain text, unpadded marks and
 * positions inside a text run keep the browser geometry. The leading edge
 * needs no such help: the browser already reports the first glyph there.
 *
 * Right-to-left boxes fall back to the reported geometry: the border-box
 * answer is direction-ambiguous there and no editor surface ships RTL inline
 * code.
 */
export function getTrailingGlyphCaretRect(
  view: Pick<EditorView, 'dom' | 'domAtPos'>,
  position: number,
  reported: CaretRect,
): CaretRect | null {
  const edge = trailingTextRun(view, position);
  if (!edge) return null;
  if (getComputedStyle(edge.text.parentElement ?? view.dom).direction === 'rtl') return null;
  const glyph = lastGlyphRect(edge);
  if (!glyph) return null;
  if (glyph.right >= reported.left - 1) return null;
  return { left: glyph.right, top: glyph.top, bottom: glyph.bottom };
}

/**
 * Returns geometry for a selection immediately after a terminal inline atom.
 *
 * ProseMirror's logical position is still the source of truth for the
 * selection, but `coordsAtPos` can describe the line box belonging to the
 * trailing break instead of the atom boundary.  The decoration carries the
 * position back into the DOM, allowing us to use the visible card's box as a
 * stable cross-engine anchor.
 */
export function getTerminalInlineAtomCaretRect(
  view: Pick<EditorView, 'dom'>,
  position: number,
): CaretRect | null {
  return resolveTerminalInlineAtomCaret(view, position).rect;
}

class StableCaretView {
  private readonly caret = document.createElement('span');
  private frame: number | null = null;
  private readonly layer: HTMLSpanElement | null;
  private resizeObserver: ResizeObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  private typographyObserver: MutationObserver | null = null;
  private destroyed = false;
  private readonly observedElements = new Set<Element>();
  private lastGeometry: { left: number; top: number; height: number } | null = null;

  constructor(
    private readonly view: EditorView,
    private readonly scope: StableCaretScope,
  ) {
    this.caret.className = scope === 'composer'
      ? 'agent-composer__stable-caret'
      : 'stable-editor-caret--document';
    this.caret.setAttribute('aria-hidden', 'true');
    this.caret.hidden = true;
    const host = scope === 'composer'
      ? view.dom.closest<HTMLElement>('.agent-composer__input-row')
      : view.dom.closest<HTMLElement>('.markdown-editor');
    this.layer = host ? document.createElement('span') : null;
    if (this.layer && host) {
      this.layer.className = scope === 'composer'
        ? 'agent-composer__caret-layer'
        : 'document-editor-caret-layer';
      this.layer.contentEditable = 'false';
      this.layer.setAttribute('aria-hidden', 'true');
      this.layer.appendChild(this.caret);
      host.appendChild(this.layer);
    } else {
      // Standalone editors without a production host retain viewport positioning.
      document.body.appendChild(this.caret);
      this.caret.style.position = 'fixed';
    }
    if (this.layer) {
      this.resizeObserver = new ResizeObserver(this.schedule);
      this.observeLayout();
      this.mutationObserver = new MutationObserver((records) => {
        // Toggling our native-caret suppression class is a render result,
        // not a layout change. Do not feed it back into another render.
        const layoutChanged = records.some((record) => {
          if (record.target !== view.dom || record.attributeName !== 'class') return true;
          const withoutCaretClass = (value: string | null) => (value ?? '')
            .split(/\s+/).filter((name) => name && name !== activeClassFor(scope)).sort().join(' ');
          return withoutCaretClass(record.oldValue) !== withoutCaretClass(view.dom.className);
        });
        if (!layoutChanged) return;
        if (records.some((record) => record.type === 'childList')) this.observeLayout();
        this.schedule();
      });
      this.mutationObserver.observe(view.dom, {
        subtree: true, childList: true, characterData: true,
        attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style', 'src'],
      });
      if (scope === 'document') {
        // Format preferences live on :root. Changing text-indent can move the
        // insertion point without resizing any element or mutating the editor.
        this.typographyObserver = new MutationObserver(this.schedule);
        this.typographyObserver.observe(document.documentElement, {
          attributes: true, attributeFilter: ['style'],
        });
      }
      document.fonts?.addEventListener('loadingdone', this.schedule);
      view.dom.addEventListener('load', this.schedule, true);
    }

    view.dom.addEventListener('focus', this.schedule, true);
    view.dom.addEventListener('blur', this.schedule, true);
    view.dom.addEventListener('compositionstart', this.handleCompositionStart);
    view.dom.addEventListener('compositionend', this.schedule);
    document.addEventListener('selectionchange', this.schedule);
    window.addEventListener('resize', this.schedule);
    window.addEventListener('scroll', this.schedule, true);
    this.schedule();
  }

  update(): void {
    this.schedule();
  }

  destroy(): void {
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    this.observedElements.clear();
    this.mutationObserver?.disconnect();
    this.typographyObserver?.disconnect();
    document.fonts?.removeEventListener('loadingdone', this.schedule);
    this.view.dom.removeEventListener('load', this.schedule, true);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    if (this.view.dom.classList.contains(activeClassFor(this.scope))) {
      this.view.dom.classList.remove(activeClassFor(this.scope));
    }
    this.view.dom.removeEventListener('focus', this.schedule, true);
    this.view.dom.removeEventListener('blur', this.schedule, true);
    this.view.dom.removeEventListener('compositionstart', this.handleCompositionStart);
    this.view.dom.removeEventListener('compositionend', this.schedule);
    document.removeEventListener('selectionchange', this.schedule);
    window.removeEventListener('resize', this.schedule);
    window.removeEventListener('scroll', this.schedule, true);
    this.caret.remove();
    this.layer?.remove();
  }

  private readonly handleCompositionStart = (): void => {
    this.hide();
  };

  private observeLayout(): void {
    // Inline tokens and paragraphs can reflow without changing the scroll
    // viewport's dimensions (for example when it has reached max-height).
    const elements = new Set<Element>([this.view.dom, ...this.view.dom.querySelectorAll('*')]);
    for (const element of this.observedElements) {
      if (!elements.has(element)) {
        // jsdom 与部分第三方 ResizeObserver polyfill 只实现 observe/disconnect。
        // 缺 unobserve 时直接调用会让 MutationObserver 回调抛错，并中断整次布局同步；
        // 这里降级为「不解除观察」——元素已脱离 DOM，多留一条观察记录无副作用。
        if (typeof this.resizeObserver?.unobserve === 'function') {
          this.resizeObserver.unobserve(element);
        }
        this.observedElements.delete(element);
      }
    }
    for (const element of elements) {
      if (!this.observedElements.has(element)) {
        this.resizeObserver?.observe(element);
        this.observedElements.add(element);
      }
    }
  }

  private readonly schedule = (): void => {
    if (this.destroyed || this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.render();
    });
  };

  private render(): void {
    const { selection } = this.view.state;
    // A thread-card composer is a nested contenteditable inside the document
    // editor. EditorView.hasFocus() treats focus in that subtree as focus in
    // the parent view, but the parent stable caret must not hide or compete
    // with the composer's own caret renderer.
    const activeElement = document.activeElement;
    const nestedEditableHasFocus = activeElement instanceof HTMLElement
      && activeElement !== this.view.dom
      && this.view.dom.contains(activeElement)
      && activeElement.closest('[contenteditable="true"]') !== this.view.dom;
    if (
      !this.view.editable
      || !this.view.hasFocus()
      || nestedEditableHasFocus
      || this.view.composing
      || !(selection instanceof TextSelection)
      || !selection.empty
    ) {
      this.hide();
      return;
    }

    try {
      const boundaryRect = getInlineAtomBoundaryCaretRect(this.view, selection.head);
      const terminalAtom = boundaryRect
        ? { found: false, rect: null }
        : resolveTerminalInlineAtomCaret(this.view, selection.head);
      // Never fall back to coordsAtPos for a known terminal atom.  If the
      // NodeView is between mount and layout, showing the native caret is safer
      // than drawing a caret from the trailing-break line box.
      if (terminalAtom.found && !terminalAtom.rect) {
        this.hide();
        return;
      }
      let rect: CaretRect | null = boundaryRect ?? terminalAtom.rect;
      if (!rect) {
        const reported = this.view.coordsAtPos(selection.head);
        rect = getTrailingGlyphCaretRect(this.view, selection.head, reported) ?? reported;
      }
      const clipsOwnContent = /^(auto|scroll|hidden|clip)$/.test(getComputedStyle(this.view.dom).overflowY);
      const scrollViewport = (this.layer && this.scope === 'composer') || clipsOwnContent
        ? this.view.dom
        : this.view.dom.closest('.editor-content');
      const viewportRect = scrollViewport instanceof HTMLElement
        ? scrollViewport.getBoundingClientRect()
        : this.view.dom.getBoundingClientRect();
      const isVisible = (
        rect.bottom >= viewportRect.top
        && rect.top <= viewportRect.bottom
        && rect.left >= viewportRect.left - 1
        && rect.left <= viewportRect.right + 1
      );
      if (!isVisible) {
        this.hide();
        return;
      }

      const height = caretHeightAt(this.view, selection.head);
      const width = caretWidthAt(this.view.dom, this.scope);
      let left = rect.left;
      let top = rect.top;
      let lineHeight = Math.max(0, rect.bottom - rect.top);
      if (this.layer) {
        const layerRect = this.layer.getBoundingClientRect();
        // Convert viewport measurements back to the layer's CSS coordinates,
        // including any axis-aligned scale applied by an ancestor.
        const scaleX = this.layer.offsetWidth > 0 && layerRect.width > 0
          ? layerRect.width / this.layer.offsetWidth : 1;
        const scaleY = this.layer.offsetHeight > 0 && layerRect.height > 0
          ? layerRect.height / this.layer.offsetHeight : 1;
        left = (left - layerRect.left) / scaleX;
        top = (top - layerRect.top) / scaleY;
        lineHeight /= scaleY;
        // Clip the overlay to the editor viewport, including partial lines.
        // Its sibling placement keeps it outside ProseMirror's editable DOM.
        const inputRect = viewportRect;
        // A caret extends rightward from the insertion point. At a full line's
        // right edge, keep its entire width inside the clipped viewport rather
        // than suppressing the native caret and clipping away its replacement.
        const inputLeft = (inputRect.left - layerRect.left) / scaleX;
        const inputRight = (inputRect.right - layerRect.left) / scaleX;
        left = Math.min(left, Math.max(inputLeft, inputRight - width));
        const insets = [
          (inputRect.top - layerRect.top) / scaleY,
          (layerRect.right - inputRect.right) / scaleX,
          (layerRect.bottom - inputRect.bottom) / scaleY,
          (inputRect.left - layerRect.left) / scaleX,
        ].map((value) => `${Math.max(0, value)}px`);
        this.layer.style.clipPath = `inset(${insets.join(' ')})`;
      }
      top += Math.max(0, (lineHeight - height) / 2);
      const geometry = { left, top, height };
      const geometryChanged = (
        this.lastGeometry === null
        || Math.abs(this.lastGeometry.left - geometry.left) > 0.1
        || Math.abs(this.lastGeometry.top - geometry.top) > 0.1
        || Math.abs(this.lastGeometry.height - geometry.height) > 0.1
      );

      this.caret.style.left = `${left}px`;
      this.caret.style.width = `${width}px`;
      this.caret.style.top = `${top}px`;
      this.caret.style.height = `${height}px`;
      this.caret.hidden = false;
      if (!this.view.dom.classList.contains(activeClassFor(this.scope))) {
        this.view.dom.classList.add(activeClassFor(this.scope));
      }
      this.lastGeometry = geometry;

      if (geometryChanged) {
        this.caret.style.animation = 'none';
        void this.caret.offsetWidth;
        this.caret.style.animation = '';
      }
    } catch {
      this.hide();
    }
  }

  private hide(): void {
    this.caret.hidden = true;
    this.lastGeometry = null;
    if (this.view.dom.classList.contains(activeClassFor(this.scope))) {
      this.view.dom.classList.remove(activeClassFor(this.scope));
    }
  }
}

function createStableCaretExtension(scope: 'document' | 'composer') {
  const key = new PluginKey(`stableCaret:${scope}`);
  return Extension.create({
    name: 'stableCaret',

    addProseMirrorPlugins() {
      return [
        new Plugin({
          key,
          view: (view) => new StableCaretView(view, scope),
        }),
      ];
    },
  });
}

export const StableCaret = createStableCaretExtension('document');
export const ComposerStableCaret = createStableCaretExtension('composer');
