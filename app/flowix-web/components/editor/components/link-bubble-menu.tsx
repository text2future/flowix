import { Editor, posToDOMRect } from '@tiptap/core';
import { createRoot, type Root } from 'react-dom/client';
import { linkSelectionHighlightPluginKey, normalizePlainLinkHref } from '../extensions/markdown-link';

interface SavedLinkSelection {
  from: number;
  to: number;
  selectedText: string;
}

interface LinkBubbleMenuState {
  editor: Editor;
  onClose: () => void;
}

interface OpenLinkBubbleMenuOptions {
  from?: number;
  to?: number;
  selectedText?: string;
  href?: string;
}

let popupContainer: HTMLDivElement | null = null;
let popupRoot: Root | null = null;
let popupState: LinkBubbleMenuState | null = null;
let clickOutsideHandler: ((e: MouseEvent) => void) | null = null;
let repositionHandler: (() => void) | null = null;
let repositionFrame: number | null = null;
let revealFrame: number | null = null;

function getSavedSelection(): SavedLinkSelection | null {
  return ((window as any).__tiptapLinkSelection as SavedLinkSelection | undefined) ?? null;
}

function setSavedSelection(selection: SavedLinkSelection) {
  (window as any).__tiptapLinkSelection = selection;
}

function clearSelectionHighlight(editor: Editor) {
  editor.view.dispatch(editor.state.tr.setMeta(linkSelectionHighlightPluginKey, { clear: true }));
}

function showSelectionHighlight(editor: Editor, from: number, to: number) {
  if (from >= to) return;
  editor.view.dispatch(editor.state.tr.setMeta(linkSelectionHighlightPluginKey, { from, to }));
}

function updatePopupPosition(editor: Editor, selection: SavedLinkSelection) {
  if (!popupContainer || editor.view.isDestroyed) return;

  const docSize = editor.state.doc.content.size;
  const from = Math.min(selection.from, docSize);
  const to = Math.min(Math.max(selection.to, from), docSize);
  const rect = posToDOMRect(editor.view, from, to);
  const popupWidth = popupContainer.offsetWidth || 236;
  const viewportPadding = 8;
  const left = Math.min(
    Math.max(rect.left + window.scrollX, window.scrollX + viewportPadding),
    window.scrollX + window.innerWidth - popupWidth - viewportPadding,
  );
  const top = rect.bottom + window.scrollY + 6;

  popupContainer.style.position = 'absolute';
  popupContainer.style.left = `${left}px`;
  popupContainer.style.top = `${top}px`;
  popupContainer.style.zIndex = '99999';
}

function revealPopup() {
  if (!popupContainer) return;
  popupContainer.style.visibility = 'visible';
  popupContainer.style.opacity = '1';
  popupContainer.style.pointerEvents = 'auto';
}

function hidePopupUntilPositioned() {
  if (!popupContainer) return;
  popupContainer.style.position = 'absolute';
  popupContainer.style.left = '-10000px';
  popupContainer.style.top = '-10000px';
  popupContainer.style.zIndex = '99999';
  popupContainer.style.visibility = 'hidden';
  popupContainer.style.opacity = '0';
  popupContainer.style.pointerEvents = 'none';
}

function schedulePopupReveal(editor: Editor, selection: SavedLinkSelection) {
  if (revealFrame !== null) {
    cancelAnimationFrame(revealFrame);
    revealFrame = null;
  }

  revealFrame = requestAnimationFrame(() => {
    updatePopupPosition(editor, selection);

    revealFrame = requestAnimationFrame(() => {
      revealFrame = null;
      updatePopupPosition(editor, selection);
      revealPopup();
      (popupContainer?.querySelector('.link-bubble-href') as HTMLInputElement | null)?.focus();
    });
  });
}

function cleanupRepositionListeners() {
  if (repositionFrame !== null) {
    cancelAnimationFrame(repositionFrame);
    repositionFrame = null;
  }

  if (revealFrame !== null) {
    cancelAnimationFrame(revealFrame);
    revealFrame = null;
  }

  if (repositionHandler) {
    document.removeEventListener('scroll', repositionHandler, true);
    window.removeEventListener('resize', repositionHandler);
    repositionHandler = null;
  }
}

function setupRepositionListeners(editor: Editor, selection: SavedLinkSelection) {
  cleanupRepositionListeners();

  repositionHandler = () => {
    if (repositionFrame !== null) return;

    repositionFrame = requestAnimationFrame(() => {
      repositionFrame = null;
      updatePopupPosition(editor, selection);
    });
  };

  document.addEventListener('scroll', repositionHandler, true);
  window.addEventListener('resize', repositionHandler);
}

function closePopup() {
  cleanupRepositionListeners();

  if (clickOutsideHandler) {
    document.removeEventListener('click', clickOutsideHandler);
    clickOutsideHandler = null;
  }

  if (popupRoot) {
    popupRoot.unmount();
    popupRoot = null;
  }
  if (popupContainer) {
    popupContainer.remove();
    popupContainer = null;
  }
  popupState = null;
}

function handleSave() {
  if (!popupState) return;

  const { editor, onClose } = popupState;
  const popup = popupContainer;
  if (!popup) return;

  const textInput = popup.querySelector('.link-bubble-text') as HTMLInputElement;
  const hrefInput = popup.querySelector('.link-bubble-href') as HTMLInputElement;

  const text = textInput?.value.trim() ?? '';
  const href = normalizePlainLinkHref(hrefInput?.value);

  if (href) {
    const savedSel = getSavedSelection();
    const from = savedSel?.from ?? editor.state.selection.from;
    const to = savedSel?.to ?? editor.state.selection.to;
    const linkText = text || savedSel?.selectedText || href;

    if (from !== to) {
      editor
        .chain()
        .focus()
        .setTextSelection({ from, to })
        .deleteRange({ from, to })
        .insertContent({
          type: 'text',
          marks: [{ type: 'link', attrs: { href } }],
          text: linkText,
        })
        .run();
    } else {
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'text',
          marks: [{ type: 'link', attrs: { href } }],
          text: linkText,
        })
        .run();
    }
  }

  clearSelectionHighlight(editor);
  delete (window as any).__tiptapLinkSelection;
  closePopup();
  onClose();
}

function handleClose() {
  if (!popupState) return;
  const { editor, onClose } = popupState;
  clearSelectionHighlight(editor);
  delete (window as any).__tiptapLinkSelection;
  closePopup();
  onClose();
}

function openLinkBubbleMenu(editor: Editor, onClose: () => void, options: OpenLinkBubbleMenuOptions = {}) {
  closePopup();

  popupState = { editor, onClose };

  const globalSelection = getSavedSelection();
  const currentFrom = editor.state.selection.from;
  const currentTo = editor.state.selection.to;
  const currentSelectedText = currentFrom === currentTo ? '' : editor.state.doc.textBetween(currentFrom, currentTo, ' ');
  const currentSelection = {
    from: options.from ?? currentFrom,
    to: options.to ?? currentTo,
    selectedText: options.selectedText ?? currentSelectedText,
  };
  const hasOptionRange = typeof options.from === 'number' && typeof options.to === 'number' && options.from !== options.to;
  const saved = hasOptionRange || currentFrom !== currentTo ? currentSelection : globalSelection ?? currentSelection;

  setSavedSelection(saved);
  showSelectionHighlight(editor, saved.from, saved.to);

  const { from, to } = saved;
  const selectedText = saved.selectedText
    ?? (from === to ? '' : editor.state.doc.textBetween(from, to, ' '));

  if (!popupContainer) {
    popupContainer = document.createElement('div');
    popupContainer.className = 'link-bubble-popup';
    hidePopupUntilPositioned();
    document.body.appendChild(popupContainer);
    popupRoot = createRoot(popupContainer);
  }

  hidePopupUntilPositioned();
  updatePopupPosition(editor, saved);
  setupRepositionListeners(editor, saved);

  popupRoot!.render(
    <div
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="link-bubble-row">
        <input
          type="text"
          className="link-bubble-text"
          defaultValue={selectedText}
          placeholder="选择的文案"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              handleSave();
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              handleClose();
            }
          }}
        />
      </div>
      <div className="link-bubble-row">
        <input
          type="text"
          className="link-bubble-href"
          defaultValue={options.href ?? ''}
          placeholder="输入链接地址..."
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              handleSave();
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              handleClose();
            }
          }}
        />
      </div>
      <div className="link-bubble-row link-bubble-row-btn">
        <button className="link-bubble-save" onClick={handleSave}>保存</button>
      </div>
    </div>
  );

  schedulePopupReveal(editor, saved);

  // Handle click outside
  clickOutsideHandler = (e: MouseEvent) => {
    if (popupContainer && !popupContainer.contains(e.target as Node)) {
      handleClose();
    }
  };

  // Delay to avoid popup's own click triggering close
  setTimeout(() => {
    if (clickOutsideHandler) {
      document.addEventListener('click', clickOutsideHandler);
    }
  }, 100);
}

export { openLinkBubbleMenu, closePopup };
