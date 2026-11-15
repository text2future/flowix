import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Editor } from '@tiptap/core';

export interface CollectionReferenceInsertRange {
  from: number;
  to: number;
}

export type CollectionReferencePickerAnchor =
  | { kind: 'editor-column'; element: HTMLElement }
  | { kind: 'button'; element: HTMLElement; align?: 'left' | 'right' };

export interface CollectionReferenceCandidate {
  notebookId: string;
  notebookName: string;
  notebookPath: string;
  relativePath: string;
  collectionId: string;
  name: string;
}

type PickerKind = 'table' | 'media-library' | 'work-documents';
type PickerContent = (generation: number, onClose: () => void) => ReactNode;

let pickerRoot: Root | null = null;
let pickerHost: HTMLDivElement | null = null;
let pickerAnchorActions: HTMLElement | null = null;
let pickerGeneration = 0;
const PICKER_WIDTH = 272;
const VIEWPORT_PADDING = 8;

export function normalizeCollectionPickerQuery(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function filterCollectionCandidates<T extends CollectionReferenceCandidate>(items: T[], query: string): T[] {
  const normalized = normalizeCollectionPickerQuery(query);
  if (!normalized) return items;
  return items.filter((item) => normalizeCollectionPickerQuery(
    `${item.name} ${item.notebookName} ${item.relativePath}`,
  ).includes(normalized));
}

export function collectionCandidateFolderLabel(candidate: CollectionReferenceCandidate): string {
  const folder = candidate.relativePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  return folder ? `${folder}/` : `${candidate.notebookName}/`;
}

export function isCollectionReferencePickerCurrent(generation: number): boolean {
  return pickerGeneration === generation && pickerRoot !== null;
}

export function closeCollectionReferencePicker(generation?: number) {
  if (generation !== undefined && generation !== pickerGeneration) return;
  pickerGeneration += 1;
  const root = pickerRoot;
  const host = pickerHost;
  pickerAnchorActions?.removeAttribute('data-reference-picker-open');
  pickerAnchorActions = null;
  pickerRoot = null;
  pickerHost = null;
  root?.unmount();
  host?.remove();
}

function updatePickerPosition(editor: Editor, position: number, anchor: CollectionReferencePickerAnchor) {
  const host = pickerHost;
  if (!host || editor.isDestroyed) return;
  try {
    const anchorElement = anchor.element.isConnected ? anchor.element : null;
    const rect = anchorElement?.getBoundingClientRect()
      ?? editor.view.coordsAtPos(position);
    const isEditorColumn = anchor.kind === 'editor-column' && anchorElement !== null;
    const columnInset = isEditorColumn ? VIEWPORT_PADDING * 2 : 0;
    const width = Math.max(0, Math.min(
      PICKER_WIDTH,
      window.innerWidth - VIEWPORT_PADDING * 2,
      isEditorColumn ? rect.right - rect.left - columnInset * 2 : PICKER_WIDTH,
    ));
    const columnTop = isEditorColumn
      ? Math.max(rect.top + VIEWPORT_PADDING, VIEWPORT_PADDING)
      : VIEWPORT_PADDING;
    const columnBottom = isEditorColumn
      ? Math.min(rect.bottom - VIEWPORT_PADDING, window.innerHeight - VIEWPORT_PADDING)
      : window.innerHeight - VIEWPORT_PADDING;
    const viewportMaxHeight = Math.max(0, Math.min(320, columnBottom - columnTop));
    const picker = host.firstElementChild instanceof HTMLElement ? host.firstElementChild : null;
    host.style.width = `${width}px`;
    if (isEditorColumn && picker && picker.style.width !== `${width}px`) {
      picker.style.width = `${width}px`;
    }
    if (picker && picker.style.maxHeight !== `${viewportMaxHeight}px`) {
      picker.style.maxHeight = `${viewportMaxHeight}px`;
    }
    const height = Math.min(picker?.offsetHeight || viewportMaxHeight, viewportMaxHeight);

    let top: number;

    if (isEditorColumn) {
      host.style.transformOrigin = 'bottom right';
      top = columnBottom - height;
    } else {
      host.style.transformOrigin = anchor.kind === 'button' && anchor.align === 'right' ? 'top right' : 'top left';
      top = Math.min(
        Math.max(rect.bottom, VIEWPORT_PADDING),
        Math.max(VIEWPORT_PADDING, window.innerHeight - height - VIEWPORT_PADDING),
      );
    }

    host.style.top = `${top}px`;
    const requestedLeft = isEditorColumn
      ? rect.right - width - columnInset
      : anchor.kind === 'button' && anchor.align === 'right' ? rect.right - width : rect.left;
    host.style.left = `${Math.min(Math.max(requestedLeft, VIEWPORT_PADDING), Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING))}px`;
  } catch {
    closeCollectionReferencePicker();
  }
}

function ReferencePickerFrame({ editor, replaceRange, anchor, onClose, children }: {
  editor: Editor;
  replaceRange: CollectionReferenceInsertRange;
  anchor: CollectionReferencePickerAnchor;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && !pickerHost?.contains(event.target)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    const reposition = () => updatePickerPosition(editor, replaceRange.from, anchor);
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    let repositionFrame = 0;
    const scheduleReposition = () => {
      if (repositionFrame) return;
      repositionFrame = window.requestAnimationFrame(() => {
        repositionFrame = 0;
        reposition();
      });
    };
    const observer = pickerHost && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(scheduleReposition)
      : null;
    if (observer && pickerHost) observer.observe(pickerHost);
    if (observer && anchor.kind === 'editor-column') observer.observe(anchor.element);
    return () => {
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      if (repositionFrame) window.cancelAnimationFrame(repositionFrame);
      observer?.disconnect();
    };
  }, [anchor, editor, onClose, replaceRange.from]);

  useLayoutEffect(() => {
    updatePickerPosition(editor, replaceRange.from, anchor);
  });

  return <>{children}</>;
}

export function openCollectionReferencePicker(
  editor: Editor,
  replaceRange: CollectionReferenceInsertRange,
  anchor: CollectionReferencePickerAnchor,
  kind: PickerKind,
  renderContent: PickerContent,
) {
  closeCollectionReferencePicker();
  const generation = pickerGeneration;
  pickerAnchorActions = anchor.kind === 'button'
    ? anchor.element.closest<HTMLElement>('.multidimensional-table__view-nav-actions')
    : null;
  pickerAnchorActions?.setAttribute('data-reference-picker-open', 'true');
  pickerHost = document.createElement('div');
  pickerHost.className = 'flowix-popover-enter';
  pickerHost.dataset.collectionReferencePicker = kind;
  pickerHost.style.position = 'fixed';
  pickerHost.style.zIndex = '2147483647';
  pickerHost.style.width = `${PICKER_WIDTH}px`;
  if (anchor.kind === 'editor-column') {
    pickerHost.style.transformOrigin = 'bottom right';
    pickerHost.style.setProperty('--flowix-popover-enter-y', '4px');
  } else {
    pickerHost.style.transformOrigin = anchor.align === 'right' ? 'top right' : 'top left';
  }
  document.body.appendChild(pickerHost);
  pickerRoot = createRoot(pickerHost);
  const onClose = () => closeCollectionReferencePicker(generation);
  pickerRoot.render(
    <ReferencePickerFrame editor={editor} replaceRange={replaceRange} anchor={anchor} onClose={onClose}>
      {renderContent(generation, onClose)}
    </ReferencePickerFrame>,
  );
  requestAnimationFrame(() => updatePickerPosition(editor, replaceRange.from, anchor));
}

function shouldNavigateList(textarea: HTMLTextAreaElement, key: 'ArrowUp' | 'ArrowDown'): boolean {
  if (textarea.selectionStart !== textarea.selectionEnd) return false;
  const style = getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(style.lineHeight) || 20;
  const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
  const border = Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
  const visualLines = Math.max(1, Math.round((textarea.clientHeight - verticalPadding - border) / lineHeight));
  if (visualLines === 1) return true;
  return key === 'ArrowDown'
    ? textarea.selectionEnd === textarea.value.length
    : textarea.selectionStart === 0;
}

export function useCollectionPickerListNavigation(itemCount: number, resetKey: string) {
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [keyboardNavigation, setKeyboardNavigation] = useState(false);

  useEffect(() => {
    setActiveIndex(-1);
    setKeyboardNavigation(false);
  }, [resetKey]);

  useEffect(() => {
    optionRefs.current = optionRefs.current.slice(0, itemCount);
    if (activeIndex >= itemCount) setActiveIndex(itemCount - 1);
  }, [activeIndex, itemCount]);

  const move = (index: number, byKeyboard: boolean) => {
    if (!itemCount) return;
    const next = (index + itemCount) % itemCount;
    setActiveIndex(next);
    setKeyboardNavigation(byKeyboard);
    if (byKeyboard) requestAnimationFrame(() => optionRefs.current[next]?.scrollIntoView({ block: 'nearest' }));
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || !shouldNavigateList(event.currentTarget, event.key)) return;
    if (!itemCount) return;
    event.preventDefault();
    move(event.key === 'ArrowDown' ? activeIndex + 1 : activeIndex < 0 ? itemCount - 1 : activeIndex - 1, true);
  };

  return {
    activeIndex,
    keyboardNavigation,
    optionRefs,
    onInputKeyDown,
    onOptionMouseMove: (index: number) => move(index, false),
    isSelected: (index: number) => index === activeIndex,
  };
}
