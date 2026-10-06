'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { basicSetup } from 'codemirror';
import { redo, undo } from '@codemirror/commands';
import {
  Compartment,
  EditorState,
  StateEffect,
  StateField,
} from '@codemirror/state';
import {
  LanguageDescription,
  syntaxHighlighting,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tagHighlighter, tags } from '@lezer/highlight';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  lineNumberWidgetMarker,
  gutterWidgetClass,
} from '@codemirror/view';
import {
  closeSearchPanel,
  openSearchPanel,
  searchPanelOpen,
} from '@codemirror/search';

import { cn } from '@/lib/utils';

import { isMarkdownFilePath } from '@features/editor/code-file';
import { shikiHighlighting, shikiLanguageIdForPath } from '@features/editor/code-editor-shiki';
import { pushHandler, useShortcutScope } from '@features/shortcuts';
import type { ClipboardSnapshot } from '@features/editor/extensions/paste-rules/clipboard';

export interface CodeEditorHandle {
  flushPendingChanges: () => string | null;
  focusStart?: () => void;
  moveTitleToBody?: (trailingContent: string) => void;
  pasteToBody?: (snapshot: ClipboardSnapshot) => void;
}

interface CodeEditorProps {
  filePath: string;
  content: string;
  editable?: boolean;
  onChange: (content: string) => void;
  className?: string;
  autoFocus?: boolean;
  searchPanelOpen?: boolean;
  onSearchPanelOpenChange?: (open: boolean) => void;
  onEditorScroll?: (scrollTop: number) => void;
  onEditingFinished?: () => void;
  /** Optional control rendered in the source memo's title gutter. */
  onToggleEditorMode?: () => void;
  sourceModeToggleLabel?: string;
  /** React content mounted inside CodeMirror's actual scroll surface. */
  scrollHeader?: ReactNode;
}

function getSourceBodyStart(content: string): number {
  const frontmatter = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(content);
  return frontmatter?.[0].length ?? 0;
}

type SourceHeaderMountHandler = (dom: HTMLDivElement, mounted: boolean) => void;

/**
 * The source title is a CodeMirror block widget instead of a sibling of
 * `.cm-content`. This keeps its height in CodeMirror's height map, which is
 * required for virtual viewport updates and scroll anchoring to remain valid.
 */
class SourceHeaderWidget extends WidgetType {
  constructor(private readonly onMount: SourceHeaderMountHandler) {
    super();
  }

  eq(other: SourceHeaderWidget): boolean {
    return other.onMount === this.onMount;
  }

  toDOM(): HTMLDivElement {
    const dom = document.createElement('div');
    dom.className = 'cm-source-header';
    this.onMount(dom, true);
    return dom;
  }

  destroy(dom: HTMLElement): void {
    if (dom instanceof HTMLDivElement) this.onMount(dom, false);
  }

  ignoreEvent(): boolean {
    return true;
  }

  // This is only used before the widget has been measured. The ResizeObserver
  // below replaces it with the exact height once the title is in the DOM.
  get estimatedHeight(): number {
    return 54;
  }
}

// Give the line-number gutter a block for the title widget as well. Without
// one, an empty document can initially paint its sole line number before the
// portal-mounted title has been measured. A text edit happens to rebuild the
// gutter, which is why the number then moves to the expected position.
class SourceHeaderGutterMarker extends GutterMarker {
  toDOM(): HTMLElement {
    const dom = document.createElement('span');
    dom.className = 'cm-source-header-gutter-marker';
    return dom;
  }
}

const sourceHeaderGutterMarker = new SourceHeaderGutterMarker();

class SourceHeaderGutterClass extends GutterMarker {
  elementClass = 'cm-source-header-gutter-element';
}

const sourceHeaderGutterClass = new SourceHeaderGutterClass();

const setSourceHeaderDecoration = StateEffect.define<DecorationSet>();

const sourceHeaderField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setSourceHeaderDecoration)) return effect.value;
    }
    return value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

function sourceHeaderDecoration(onMount: SourceHeaderMountHandler): DecorationSet {
  const widget = new SourceHeaderWidget(onMount);
  return Decoration.set([
    Decoration.widget({ widget, side: -1, block: true }).range(0),
  ]);
}

/**
 * Keep the active-line affordance separate from a real text selection. The
 * built-in `highlightActiveLine` extension intentionally marks the line at
 * every selection head, including non-empty ranges. That is useful for a
 * generic code editor, but in the source memo it makes a selected range look
 * like two simultaneous selection states. Expose the range state as a DOM
 * attribute so the compiled CSS can suppress only the visual active-line
 * layer without changing CodeMirror's selection or history state.
 */
const rangeSelectionState = ViewPlugin.fromClass(class {
  constructor(view: EditorView) {
    this.sync(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet) this.sync(update.view);
  }

  sync(view: EditorView) {
    view.dom.toggleAttribute(
      'data-has-range-selection',
      view.state.selection.ranges.some((range) => !range.empty),
    );
  }
});

const codeEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--document-foreground, var(--foreground, #1f2937))',
    backgroundColor: 'transparent',
    fontSize: 'var(--code-editor-font-size, 13px)',
    // Source text must show the characters users typed. In particular, do
    // not render ASCII operators such as `-->` as typographic ligatures.
    fontVariantLigatures: 'none',
    fontFeatureSettings: '"liga" 0, "clig" 0, "calt" 0',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'var(--code-editor-font-family, var(--code-font-family, ui-monospace, monospace))',
    lineHeight: 'var(--code-editor-line-height, 1.65)',
    fontVariantLigatures: 'none',
    fontFeatureSettings: '"liga" 0, "clig" 0, "calt" 0',
  },
  '.cm-content': {
    minHeight: '100%',
    padding: 'var(--code-editor-content-padding-top, 14px) 0 var(--code-editor-content-padding-bottom, 28px)',
    // Keep the document text color on the actual content layer. Relying on
    // inheritance from `.cm-editor` makes text disappear in WebKit when a
    // theme variable is unavailable during the production-app startup.
    color: 'var(--document-foreground, var(--foreground, #1f2937))',
    caretColor: 'var(--foreground)',
  },
  '.cm-line': {
    padding: '0 var(--code-editor-line-padding-right, 20px) 0 var(--code-editor-line-padding-left, 10px)',
    color: 'var(--document-foreground, var(--foreground, #1f2937))',
  },
  '.cm-gutters': {
    border: 'none',
    color: 'var(--muted-foreground)',
    backgroundColor: 'var(--document-bg)',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    color: 'color-mix(in oklch, var(--muted-foreground) 40%, transparent)',
  },
  '.cm-foldGutter .cm-gutterElement > span': {
    opacity: 0,
    transition: 'opacity 120ms ease',
  },
  '.cm-gutters:hover .cm-foldGutter .cm-gutterElement > span': {
    opacity: 0.5,
  },
  '.cm-foldGutter .cm-gutterElement > span[title="Fold line"]': {
    display: 'inline-block',
    position: 'relative',
    top: '-3px',
  },
  '.cm-activeLine, .cm-activeLineGutter': {
    backgroundColor: 'var(--code-editor-active-surface-bg, color-mix(in oklch, var(--muted) 58%, transparent))',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in oklch, var(--brand, var(--primary)) 26%, transparent)',
    color: 'inherit',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'color-mix(in oklch, var(--brand, var(--primary)) 26%, transparent)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--foreground)',
  },
  '.cm-panels': {
    color: 'var(--foreground)',
    backgroundColor: 'var(--card)',
  },
  '.cm-panels.cm-panels-top': {
    borderBottom: '1px solid var(--border)',
  },
  '.cm-search': {
    padding: '6px 10px',
  },
  '.cm-textfield': {
    height: '26px',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    color: 'var(--foreground)',
    backgroundColor: 'var(--background)',
  },
  '.cm-button': {
    border: '1px solid var(--border)',
    borderRadius: '6px',
    color: 'var(--foreground)',
    backgroundImage: 'none',
    backgroundColor: 'var(--muted)',
  },
  '.cm-tooltip': {
    border: '1px solid var(--border)',
    color: 'var(--foreground)',
    backgroundColor: 'var(--popover)',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    color: 'var(--foreground)',
    backgroundColor: 'var(--muted)',
  },
});

// Fixed class names keep syntax colors in the compiled application CSS.
// HighlightStyle.define() emits a runtime <style> sheet with generated class
// names, which can be absent during packaged WebView startup.
const codeHighlighter = tagHighlighter([
  { tag: tags.comment, class: 'cm-code-comment' },
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], class: 'cm-code-keyword' },
  { tag: [tags.string, tags.special(tags.string)], class: 'cm-code-string' },
  { tag: [tags.number, tags.bool, tags.null], class: 'cm-code-constant' },
  { tag: [tags.function(tags.variableName), tags.labelName], class: 'cm-code-function' },
  { tag: [tags.typeName, tags.className, tags.namespace], class: 'cm-code-type' },
  { tag: [tags.regexp, tags.escape], class: 'cm-code-regexp' },
  { tag: tags.invalid, class: 'cm-code-invalid' },
]);

export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor({
  filePath,
  content,
  editable = true,
  onChange,
  className,
  autoFocus = false,
  searchPanelOpen: controlledSearchPanelOpen = false,
  onSearchPanelOpenChange,
  onEditorScroll,
  onEditingFinished,
  onToggleEditorMode,
  sourceModeToggleLabel,
  scrollHeader,
}, ref) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [scrollHeaderMount, setScrollHeaderMount] = useState<HTMLDivElement | null>(null);
  const syncingContentRef = useRef(false);
  const onChangeRef = useRef(onChange);
  const onSearchPanelOpenChangeRef = useRef(onSearchPanelOpenChange);
  const onEditorScrollRef = useRef(onEditorScroll);
  const onEditingFinishedRef = useRef(onEditingFinished);
  const languageCompartment = useMemo(() => new Compartment(), []);
  const editableCompartment = useMemo(() => new Compartment(), []);
  const hasScrollHeader = Boolean(scrollHeader);
  const handleSourceHeaderMount = useCallback<SourceHeaderMountHandler>((dom, mounted) => {
    if (mounted) {
      setScrollHeaderMount(dom);
    } else {
      setScrollHeaderMount((current) => current === dom ? null : current);
    }
  }, []);

  onChangeRef.current = onChange;
  onSearchPanelOpenChangeRef.current = onSearchPanelOpenChange;
  onEditorScrollRef.current = onEditorScroll;
  onEditingFinishedRef.current = onEditingFinished;

  useShortcutScope('editor');

  useImperativeHandle(ref, () => ({
    flushPendingChanges: () => {
      const content = viewRef.current?.state.doc.toString() ?? null;
      return content;
    },
    focusStart: () => {
      const view = viewRef.current;
      if (!view) return;
      const bodyStart = getSourceBodyStart(view.state.doc.toString());
      view.focus();
      view.dispatch({
        selection: { anchor: bodyStart, head: bodyStart },
        effects: EditorView.scrollIntoView(bodyStart, { y: 'nearest' }),
      });
    },
    moveTitleToBody: (trailingContent: string) => {
      const view = viewRef.current;
      if (!view || !editable) return;

      const content = view.state.doc.toString();
      const bodyStart = getSourceBodyStart(content);
      const lineBreak = content.includes('\r\n') ? '\r\n' : '\n';
      const insertion = trailingContent.length > 0
        ? `${trailingContent}${lineBreak}${lineBreak}`
        : lineBreak;

      view.dispatch({
        changes: { from: bodyStart, to: bodyStart, insert: insertion },
        // Keep the caret at the split point, before the title tail that was
        // moved into the first body paragraph.
        selection: { anchor: bodyStart, head: bodyStart },
        effects: EditorView.scrollIntoView(bodyStart, { y: 'nearest' }),
      });
      view.focus();
    },
    pasteToBody: (snapshot: ClipboardSnapshot) => {
      const view = viewRef.current;
      if (!view || !editable || !snapshot.text) return;

      const content = view.state.doc.toString();
      const bodyStart = getSourceBodyStart(content);
      const lineBreak = content.includes('\r\n') ? '\r\n' : '\n';
      const text = snapshot.text.replace(/\r\n?/g, lineBreak);
      const existingBody = content.slice(bodyStart);
      const separator = existingBody.length > 0 && !text.endsWith(lineBreak)
        ? lineBreak
        : '';
      const insertion = `${text}${separator}`;

      view.dispatch({
        changes: { from: bodyStart, to: bodyStart, insert: insertion },
        selection: { anchor: bodyStart + insertion.length, head: bodyStart + insertion.length },
        effects: EditorView.scrollIntoView(bodyStart, { y: 'nearest' }),
      });
    },
  }), [editable]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let lastSearchPanelOpen = false;
    // Files whose extension maps to a preloaded Shiki language are colored by
    // the shared Shiki highlighter (see code-editor-shiki.ts) instead of the
    // Lezer tagHighlighter path. Anything else falls back to the 8-class
    // tagHighlighter. The Lezer language is still loaded below for structure
    // (folding / indentation / bracket matching).
    const shikiLang = shikiLanguageIdForPath(filePath);
    const state = EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        codeEditorTheme,
        // Install the block widget before CodeMirror's first viewport and
        // gutter layout. Adding it after mount can leave the empty document's
        // only line number at the old position until a text edit rebuilds it.
        sourceHeaderField.init(() => hasScrollHeader
          ? sourceHeaderDecoration(handleSourceHeaderMount)
          : Decoration.none),
        lineNumberWidgetMarker.of((_view, widget) =>
          widget instanceof SourceHeaderWidget ? sourceHeaderGutterMarker : null),
        gutterWidgetClass.of((_view, widget) =>
          widget instanceof SourceHeaderWidget ? sourceHeaderGutterClass : null),
        ...(hasScrollHeader ? [rangeSelectionState] : []),
        ...(shikiLang
          ? [shikiHighlighting(shikiLang)]
          : [syntaxHighlighting(codeHighlighter)]),
        EditorView.lineWrapping,
        languageCompartment.of([]),
        editableCompartment.of([
          EditorState.readOnly.of(!editable),
          EditorView.editable.of(editable),
        ]),
        EditorView.contentAttributes.of({
          'aria-label': filePath.split(/[\\/]/).pop() ?? filePath,
          spellcheck: 'false',
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !syncingContentRef.current) {
            onChangeRef.current(update.state.doc.toString());
          }
          const nextSearchPanelOpen = searchPanelOpen(update.state);
          if (nextSearchPanelOpen !== lastSearchPanelOpen) {
            lastSearchPanelOpen = nextSearchPanelOpen;
            onSearchPanelOpenChangeRef.current?.(nextSearchPanelOpen);
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: mount });
    viewRef.current = view;

    const handleScroll = () => onEditorScrollRef.current?.(view.scrollDOM.scrollTop);
    const handleBlur = () => onEditingFinishedRef.current?.();
    view.scrollDOM.addEventListener('scroll', handleScroll, { passive: true });
    view.contentDOM.addEventListener('blur', handleBlur);

    if (autoFocus) requestAnimationFrame(() => view.focus());

    return () => {
      view.scrollDOM.removeEventListener('scroll', handleScroll);
      view.contentDOM.removeEventListener('blur', handleBlur);
      view.destroy();
      viewRef.current = null;
      setScrollHeaderMount(null);
    };
  }, [autoFocus, editableCompartment, filePath, handleSourceHeaderMount, languageCompartment]);

  // Install or remove the title as a CodeMirror-managed block widget. This is
  // a separate effect so changing the header does not recreate the editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    view.dispatch({
      effects: setSourceHeaderDecoration.of(
        hasScrollHeader ? sourceHeaderDecoration(handleSourceHeaderMount) : Decoration.none,
      ),
    });
  }, [handleSourceHeaderMount, hasScrollHeader]);

  useEffect(() => {
    const editorIsFocused = () => viewRef.current?.hasFocus ?? false;
    const popSelectAll = pushHandler('editor.selectAll', () => {
      const view = viewRef.current;
      if (!view || !view.hasFocus) return false;
      view.dispatch({
        selection: { anchor: 0, head: view.state.doc.length },
      });
      return true;
    }, { isActive: editorIsFocused });
    const popUndo = pushHandler('editor.undo', () => {
      const view = viewRef.current;
      if (!view || !view.hasFocus) return false;
      return undo(view);
    }, { isActive: editorIsFocused });
    const popRedo = pushHandler('editor.redo', () => {
      const view = viewRef.current;
      if (!view || !view.hasFocus) return false;
      return redo(view);
    }, { isActive: editorIsFocused });
    return () => {
      popSelectAll();
      popUndo();
      popRedo();
    };
  }, []);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editableCompartment.reconfigure([
        EditorState.readOnly.of(!editable),
        EditorView.editable.of(editable),
      ]),
    });
  }, [editable, editableCompartment]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    const headerMount = scrollHeaderMount;
    const editorMount = mountRef.current;
    if (!view || !headerMount || !hasScrollHeader) return;

    const gutters = editorMount?.querySelector<HTMLElement>('.cm-gutters');
    if (!gutters) return;
    // The title is a block widget in `.cm-content`, while line numbers live
    // in the sibling `.cm-gutters` branch. Keep the bridge as a real DOM
    // layer in the gutter so it cannot be lost behind CodeMirror's gutter
    // background or style-mod generated rules.
    const gutterBackground = document.createElement('div');
    gutterBackground.className = 'cm-source-header-gutter-background';
    gutterBackground.setAttribute('aria-hidden', 'true');
    gutters.appendChild(gutterBackground);

    const syncHeaderHeight = () => {
      const titleRow = headerMount.querySelector<HTMLElement>('.source-document-title-row') ?? headerMount;
      const headerRect = titleRow.getBoundingClientRect();
      const blockRect = headerMount.getBoundingClientRect();
      const gutterRect = gutters.getBoundingClientRect();
      const height = headerRect.height;
      const top = headerRect.top - gutterRect.top;
      if (height > 0 && Number.isFinite(top)) {
        editorMount?.style.setProperty('--code-editor-source-header-top', `${top}px`);
        editorMount?.style.setProperty('--code-editor-source-header-height', `${height}px`);
      } else {
        editorMount?.style.removeProperty('--code-editor-source-header-top');
        editorMount?.style.removeProperty('--code-editor-source-header-height');
      }
      if (blockRect.height > 0) {
        editorMount?.style.setProperty('--code-editor-source-header-block-height', `${blockRect.height}px`);
      } else {
        editorMount?.style.removeProperty('--code-editor-source-header-block-height');
      }
    };

    syncHeaderHeight();
    view.requestMeasure();
    const toggleEditorMode = onToggleEditorMode ?? (() => {});
    const sourceModeToggle = onToggleEditorMode
      ? document.createElement('button')
      : null;
    if (sourceModeToggle) {
      sourceModeToggle.type = 'button';
      sourceModeToggle.className = 'cm-source-mode-toggle';
      const markdownIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      markdownIcon.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      markdownIcon.setAttribute('width', '14');
      markdownIcon.setAttribute('height', '14');
      markdownIcon.setAttribute('fill', 'currentColor');
      markdownIcon.setAttribute('viewBox', '48 96 160 68');
      markdownIcon.setAttribute('aria-hidden', 'true');
      const markdownPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      markdownPath.setAttribute(
        'd',
        'M128,104v48a8,8,0,0,1-16,0V123.31L93.66,141.66a8,8,0,0,1-11.32,0L64,123.31V152a8,8,0,0,1-16,0V104a8,8,0,0,1,13.66-5.66L88,124.69l26.34-26.35A8,8,0,0,1,128,104Zm77.66,18.34a8,8,0,0,1,0,11.32l-24,24a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L168,132.69V104a8,8,0,0,1,16,0v28.69l10.34-10.35A8,8,0,0,1,205.66,122.34Z',
      );
      markdownPath.setAttribute('fill', 'currentColor');
      markdownIcon.appendChild(markdownPath);
      sourceModeToggle.appendChild(markdownIcon);
      sourceModeToggle.title = sourceModeToggleLabel ?? 'Switch to rich text mode';
      sourceModeToggle.setAttribute('aria-label', sourceModeToggle.title);
      sourceModeToggle.addEventListener('click', toggleEditorMode);
      gutters.appendChild(sourceModeToggle);
    }
    if (typeof ResizeObserver === 'undefined') {
      return () => {
        sourceModeToggle?.removeEventListener('click', toggleEditorMode);
        sourceModeToggle?.remove();
        gutterBackground.remove();
        editorMount?.style.removeProperty('--code-editor-source-header-top');
        editorMount?.style.removeProperty('--code-editor-source-header-height');
        editorMount?.style.removeProperty('--code-editor-source-header-block-height');
      };
    }
    const observer = new ResizeObserver(() => {
      syncHeaderHeight();
      view.requestMeasure();
    });
    observer.observe(headerMount);
    return () => {
      observer.disconnect();
      sourceModeToggle?.removeEventListener('click', toggleEditorMode);
      sourceModeToggle?.remove();
      gutterBackground.remove();
      editorMount?.style.removeProperty('--code-editor-source-header-top');
      editorMount?.style.removeProperty('--code-editor-source-header-height');
      editorMount?.style.removeProperty('--code-editor-source-header-block-height');
    };
  }, [hasScrollHeader, onToggleEditorMode, scrollHeaderMount, sourceModeToggleLabel]);

  // The title is a nested editing host inside a CodeMirror widget. Keep its
  // focus state on the CodeMirror wrapper explicitly so title and gutter
  // styling does not depend on a parent `:has()` selector matching through
  // the widget boundary.
  useLayoutEffect(() => {
    const headerMount = scrollHeaderMount;
    const editorMount = mountRef.current;
    if (!headerMount || !editorMount || !hasScrollHeader) return;

    const setHeaderFocused = (focused: boolean) => {
      editorMount.toggleAttribute('data-source-header-focused', focused);
    };
    const handleFocusIn = () => setHeaderFocused(true);
    const handleFocusOut = (event: FocusEvent) => {
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && headerMount.contains(nextTarget)) return;
      setHeaderFocused(false);
    };

    headerMount.addEventListener('focusin', handleFocusIn);
    headerMount.addEventListener('focusout', handleFocusOut);
    setHeaderFocused(headerMount.contains(document.activeElement));

    return () => {
      headerMount.removeEventListener('focusin', handleFocusIn);
      headerMount.removeEventListener('focusout', handleFocusOut);
      editorMount.removeAttribute('data-source-header-focused');
    };
  }, [hasScrollHeader, scrollHeaderMount]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === content) return;
    syncingContentRef.current = true;
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
      });
    } finally {
      syncingContentRef.current = false;
    }
  }, [content]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const isOpen = searchPanelOpen(view.state);
    if (controlledSearchPanelOpen && !isOpen) openSearchPanel(view);
    if (!controlledSearchPanelOpen && isOpen) closeSearchPanel(view);
  }, [controlledSearchPanelOpen]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // Markdown is rendered by Shiki and does not need a Lezer language loaded.
    if (isMarkdownFilePath(filePath)) return;
    let disposed = false;
    const description = LanguageDescription.matchFilename(languages, filePath);
    if (!description) return;
    void description.load().then((support) => {
      if (disposed || viewRef.current !== view) return;
      view.dispatch({ effects: languageCompartment.reconfigure(support) });
    }).catch((error: unknown) => {
      if (disposed) return;
      console.error('[CodeEditor] Failed to load language support', {
        filePath,
        language: description.name,
        error,
      });
    });
    return () => {
      disposed = true;
    };
  }, [filePath, languageCompartment]);

  return (
    <>
      <div
        ref={mountRef}
        className={cn(
          'code-editor h-full w-full min-h-0 min-w-0 overflow-hidden',
          hasScrollHeader && 'code-editor--with-scroll-header',
          className,
        )}
      />
      {hasScrollHeader && scrollHeaderMount && createPortal(scrollHeader, scrollHeaderMount)}
    </>
  );
});
