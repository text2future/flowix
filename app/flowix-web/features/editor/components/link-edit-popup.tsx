import { Editor, posToDOMRect } from '@tiptap/core';
import { createRoot, type Root } from 'react-dom/client';
import { linkSelectionHighlightPluginKey, normalizePlainLinkHref } from '@features/editor/extensions/markdown-link';
import { useI18n } from '@features/i18n';

interface SavedLinkSelection {
  from: number;
  to: number;
  selectedText: string;
}

type LinkEditMode = 'create' | 'edit';

interface LinkEditPopupState {
  editor: Editor;
  onClose: () => void;
  selection: SavedLinkSelection;
  initialHref: string;
  mode: LinkEditMode;
}

interface OpenLinkEditPopupOptions {
  from?: number;
  to?: number;
  selectedText?: string;
  href?: string;
  mode?: LinkEditMode;
}

let popupContainer: HTMLDivElement | null = null;
let popupRoot: Root | null = null;
let popupState: LinkEditPopupState | null = null;
let clickOutsideHandler: ((e: MouseEvent) => void) | null = null;
let clickOutsideTimer: ReturnType<typeof setTimeout> | null = null;
let repositionHandler: (() => void) | null = null;
let repositionFrame: number | null = null;
let revealFrame: number | null = null;

function disposePopupRoot(root: Root, container: HTMLDivElement) {
  window.setTimeout(() => {
    root.unmount();
    container.remove();
  }, 0);
}

function clearSelectionHighlight(editor: Editor) {
  editor.view.dispatch(editor.state.tr.setMeta(linkSelectionHighlightPluginKey, { clear: true }));
}

function showSelectionHighlight(editor: Editor, from: number, to: number) {
  if (from >= to) return;
  editor.view.dispatch(editor.state.tr.setMeta(linkSelectionHighlightPluginKey, { from, to }));
}

function updatePopupPosition(editor: Editor, selection: SavedLinkSelection) {
  if (!popupContainer) return;
  if (editor.view.isDestroyed) {
    closePopup();
    return;
  }

  const docSize = editor.state.doc.content.size;
  const from = Math.min(selection.from, docSize);
  const to = Math.min(Math.max(selection.to, from), docSize);
  const rect = posToDOMRect(editor.view, from, to);
  const popupWidth = popupContainer.offsetWidth || 236;
  const popupHeight = popupContainer.offsetHeight || 110;
  const viewportPadding = 8;
  const left = Math.min(
    Math.max(rect.left + window.scrollX, window.scrollX + viewportPadding),
    window.scrollX + window.innerWidth - popupWidth - viewportPadding,
  );
  const below = rect.bottom + window.scrollY + 6;
  const above = rect.top + window.scrollY - popupHeight - 6;
  const viewportBottom = window.scrollY + window.innerHeight - popupHeight - viewportPadding;
  const top = below <= viewportBottom
    ? below
    : Math.max(window.scrollY + viewportPadding, above);

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
      (popupContainer?.querySelector('.link-edit-href') as HTMLInputElement | null)?.focus();
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

  if (clickOutsideTimer !== null) {
    clearTimeout(clickOutsideTimer);
    clickOutsideTimer = null;
  }

  if (clickOutsideHandler) {
    document.removeEventListener('click', clickOutsideHandler);
    clickOutsideHandler = null;
  }

  const root = popupRoot;
  const container = popupContainer;
  popupRoot = null;
  popupContainer = null;
  popupState = null;

  if (root && container) {
    disposePopupRoot(root, container);
  } else {
    container?.remove();
  }
}

function handleSave() {
  if (!popupState) return;

  const { editor, onClose, selection } = popupState;
  const popup = popupContainer;
  if (!popup) return;

  const textInput = popup.querySelector('.link-edit-text') as HTMLInputElement;
  const hrefInput = popup.querySelector('.link-edit-href') as HTMLInputElement;

  const text = textInput?.value.trim() ?? '';
  const href = normalizePlainLinkHref(hrefInput?.value);

  if (!href) {
    hrefInput?.focus();
    hrefInput?.setAttribute('aria-invalid', 'true');
    return;
  }

  if (href) {
    const from = selection.from;
    const to = selection.to;
    const originalText = selection.selectedText;
    const linkText = text || originalText || href;
    const textUnchanged = from !== to && linkText === originalText;

    if (textUnchanged) {
      editor
        .chain()
        .focus()
        .setTextSelection({ from, to })
        .extendMarkRange('link')
        .setLink({ href })
        .setTextSelection(to)
        .run();
    } else if (from !== to) {
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
  closePopup();
  onClose();
}

function handleClose() {
  if (!popupState) return;
  const { editor, onClose } = popupState;
  clearSelectionHighlight(editor);
  closePopup();
  onClose();
}

function LinkEditPopupContent({
  mode,
  initialHref,
  selectedText,
}: {
  mode: LinkEditMode;
  initialHref: string;
  selectedText: string;
}) {
  const { t } = useI18n();
  const isUpdate = mode === 'edit' && Boolean(initialHref);

  return (
    <div
      role="dialog"
      aria-label={mode === 'edit' ? t('editor.link.edit') : t('editor.link.add')}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="link-edit-row">
        <input
          type="text"
          className="link-edit-text"
          defaultValue={selectedText}
          aria-label={t('editor.link.textLabel')}
          placeholder={t('editor.link.textPlaceholder')}
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
      <div className="link-edit-row">
        <input
          type="text"
          className="link-edit-href"
          defaultValue={initialHref}
          aria-label={t('editor.link.urlLabel')}
          placeholder={t('editor.link.urlPlaceholder')}
          onInput={(e) => {
            e.currentTarget.removeAttribute('aria-invalid');
          }}
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
      <div className="link-edit-row link-edit-row-btn">
        <button className="link-edit-cancel" onClick={handleClose}>
          {t('editor.link.cancel')}
        </button>
        <button className="link-edit-save" onClick={handleSave}>
          {isUpdate ? t('editor.link.update') : t('editor.link.save')}
        </button>
      </div>
    </div>
  );
}

function openLinkEditPopup(editor: Editor, onClose: () => void, options: OpenLinkEditPopupOptions = {}) {
  closePopup();

  const currentFrom = editor.state.selection.from;
  const currentTo = editor.state.selection.to;
  const currentSelectedText = currentFrom === currentTo ? '' : editor.state.doc.textBetween(currentFrom, currentTo, ' ');
  const currentSelection = {
    from: options.from ?? currentFrom,
    to: options.to ?? currentTo,
    selectedText: options.selectedText ?? currentSelectedText,
  };
  const saved = currentSelection;
  const mode = options.mode ?? (options.href ? 'edit' : 'create');

  popupState = {
    editor,
    onClose,
    selection: saved,
    initialHref: normalizePlainLinkHref(options.href),
    mode,
  };
  showSelectionHighlight(editor, saved.from, saved.to);

  const { from, to } = saved;
  const selectedText = saved.selectedText
    ?? (from === to ? '' : editor.state.doc.textBetween(from, to, ' '));

  if (!popupContainer) {
    popupContainer = document.createElement('div');
    popupContainer.className = 'link-edit-popup';
    hidePopupUntilPositioned();
    document.body.appendChild(popupContainer);
    popupRoot = createRoot(popupContainer);
  }

  hidePopupUntilPositioned();
  updatePopupPosition(editor, saved);
  setupRepositionListeners(editor, saved);

  popupRoot!.render(
    <LinkEditPopupContent
      mode={mode}
      initialHref={popupState.initialHref}
      selectedText={selectedText}
    />
  );

  schedulePopupReveal(editor, saved);

  // Handle click outside
  clickOutsideHandler = (e: MouseEvent) => {
    if (popupContainer && !popupContainer.contains(e.target as Node)) {
      handleClose();
    }
  };

  // Delay to avoid popup's own click triggering close
  clickOutsideTimer = setTimeout(() => {
    clickOutsideTimer = null;
    if (clickOutsideHandler) {
      document.addEventListener('click', clickOutsideHandler);
    }
  }, 100);
}

function isLinkEditPopupOpen() {
  return popupContainer !== null;
}

export { isLinkEditPopupOpen, openLinkEditPopup };
