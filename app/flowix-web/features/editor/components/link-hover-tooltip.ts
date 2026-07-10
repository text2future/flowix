import { openUrl } from '@tauri-apps/plugin-opener';
import type { Editor } from '@tiptap/core';
import { normalizePlainLinkHref } from '@features/editor/extensions/markdown-link';
import { isLinkEditPopupOpen, openLinkEditPopup } from '@features/editor/components/link-edit-popup';
import { translate } from '@features/i18n';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';

interface LinkRange {
  from: number;
  to: number;
  text: string;
}

const SHOW_DELAY_MS = 80;
const HIDE_DELAY_MS = 140;
const HIDE_ANIMATION_MS = 120;
const VIEWPORT_PADDING = 8;
const IGNORE_LINK_TOOLTIP_SELECTOR = '.agent-thread-card';
const EDIT_ICON = '<svg viewBox="0 0 256 256" aria-hidden="true"><path d="M227.31,73.37,182.63,28.68a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.31,96A16,16,0,0,0,227.31,73.37ZM92.69,208H48V163.31l88-88L180.69,120ZM192,108.68,147.31,64l24-24L216,84.68Z"/></svg>';
const REMOVE_ICON = '<svg viewBox="0 0 256 256" aria-hidden="true"><path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z"/></svg>';

function createIconButton(label: string, icon: string, onClick: (event: MouseEvent) => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'editor-link-hover-tooltip-button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = icon;
  button.addEventListener('click', onClick);
  return button;
}

export function attachLinkHoverTooltip(editor: Editor, root: HTMLElement): () => void {
  let tooltipEl: HTMLDivElement | null = null;
  let activeLink: HTMLAnchorElement | null = null;
  let showTimer: ReturnType<typeof setTimeout> | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let removeTimer: ReturnType<typeof setTimeout> | null = null;

  const getEventElement = (event: Event): Element | null => {
    const target = event.target;
    if (target instanceof Element) return target;
    if (target instanceof Node) return target.parentElement;
    return null;
  };

  const getEventLink = (event: Event): HTMLAnchorElement | null => {
    const link = getEventElement(event)?.closest('a') as HTMLAnchorElement | null;
    if (!link || link.closest(IGNORE_LINK_TOOLTIP_SELECTOR)) return null;
    return link;
  };

  const cancelShow = () => {
    if (!showTimer) return;
    clearTimeout(showTimer);
    showTimer = null;
  };

  const cancelHide = () => {
    if (!hideTimer) return;
    clearTimeout(hideTimer);
    hideTimer = null;
  };

  const cancelRemove = () => {
    if (!removeTimer) return;
    clearTimeout(removeTimer);
    removeTimer = null;
  };

  const removeTooltip = () => {
    cancelRemove();
    tooltipEl?.remove();
    tooltipEl = null;
  };

  const hide = (immediate = false) => {
    cancelShow();
    cancelHide();
    activeLink = null;

    if (!tooltipEl) return;

    if (immediate) {
      removeTooltip();
      return;
    }

    tooltipEl.classList.add('is-hiding');
    tooltipEl.style.pointerEvents = 'none';
    cancelRemove();
    removeTimer = setTimeout(removeTooltip, HIDE_ANIMATION_MS);
  };

  const scheduleHide = () => {
    cancelShow();
    cancelHide();
    hideTimer = setTimeout(hide, HIDE_DELAY_MS);
  };

  const getLinkRange = (link: HTMLAnchorElement): LinkRange | null => {
    if (editor.view.isDestroyed || !link.isConnected) {
      hide(true);
      return null;
    }

    let from: number;
    let to: number;
    try {
      from = editor.view.posAtDOM(link, 0);
      to = editor.view.posAtDOM(link, link.childNodes.length);
    } catch (error) {
      hide(true);
      console.warn('Failed to resolve link range:', error);
      return null;
    }

    if (from >= to) {
      return null;
    }

    return {
      from,
      to,
      text: editor.state.doc.textBetween(from, to, ' '),
    };
  };

  const editActiveLink = () => {
    if (editor.view.isDestroyed) {
      hide(true);
      return;
    }
    if (!activeLink) return;

    const href = normalizePlainLinkHref(activeLink.getAttribute('href'));
    const range = getLinkRange(activeLink);
    if (!range) return;

    hide();
    editor.chain().focus().setTextSelection({ from: range.from, to: range.to }).run();
    openLinkEditPopup(editor, () => undefined, {
      from: range.from,
      to: range.to,
      selectedText: range.text,
      href,
      mode: 'edit',
    });
  };

  const removeActiveLink = () => {
    if (editor.view.isDestroyed) {
      hide(true);
      return;
    }
    if (!activeLink) return;

    const range = getLinkRange(activeLink);
    if (!range) return;

    hide();
    editor
      .chain()
      .focus()
      .setTextSelection({ from: range.from, to: range.to })
      .unsetLink()
      .setTextSelection(range.to)
      .run();
  };

  const ensureTooltip = () => {
    if (tooltipEl) {
      cancelRemove();
      tooltipEl.classList.remove('is-hiding');
      tooltipEl.style.pointerEvents = 'auto';
      return tooltipEl;
    }

    tooltipEl = document.createElement('div');
    tooltipEl.className = 'editor-link-hover-tooltip';
    tooltipEl.addEventListener('mouseenter', cancelHide);
    tooltipEl.addEventListener('mouseleave', scheduleHide);
    document.body.appendChild(tooltipEl);
    return tooltipEl;
  };

  const positionTooltip = (link: HTMLAnchorElement) => {
    if (!tooltipEl) return;
    if (editor.view.isDestroyed) {
      hide(true);
      return;
    }
    if (!link.isConnected) {
      hide(true);
      return;
    }

    const rect = link.getBoundingClientRect();
    const tooltipWidth = tooltipEl.offsetWidth;
    const tooltipHeight = tooltipEl.offsetHeight;
    const centeredLeft = rect.left + rect.width / 2 - tooltipWidth / 2;
    const left = Math.min(
      Math.max(centeredLeft, VIEWPORT_PADDING),
      window.innerWidth - tooltipWidth - VIEWPORT_PADDING,
    );
    const topAbove = rect.top - tooltipHeight - VIEWPORT_PADDING;
    const top = topAbove >= VIEWPORT_PADDING
      ? topAbove
      : Math.min(rect.bottom + VIEWPORT_PADDING, window.innerHeight - tooltipHeight - VIEWPORT_PADDING);

    tooltipEl.style.left = `${Math.max(VIEWPORT_PADDING, left)}px`;
    tooltipEl.style.top = `${Math.max(VIEWPORT_PADDING, top)}px`;
  };

  const renderTooltip = (href: string) => {
    const tooltip = ensureTooltip();
    if (tooltip.dataset.href === href) return;

    tooltip.dataset.href = href;
    tooltip.innerHTML = '';

    const language = useUserSettingsStore.getState().settings.language;
    const editLabel = translate(language, 'editor.link.edit');
    const removeLabel = translate(language, 'editor.link.remove');

    const text = document.createElement('span');
    text.className = 'editor-link-hover-tooltip-text';
    text.textContent = href;

    const actions = document.createElement('span');
    actions.className = 'editor-link-hover-tooltip-actions';
    actions.append(
      createIconButton(editLabel, EDIT_ICON, (event) => {
        event.preventDefault();
        event.stopPropagation();
        editActiveLink();
      }),
      createIconButton(removeLabel, REMOVE_ICON, (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeActiveLink();
      }),
    );

    tooltip.append(text, actions);
  };

  const showNow = (link: HTMLAnchorElement, href: string) => {
    if (!href) return;
    if (editor.view.isDestroyed) {
      hide(true);
      return;
    }

    cancelShow();
    cancelHide();
    activeLink = link;
    renderTooltip(href);
    positionTooltip(link);

    requestAnimationFrame(() => {
      if (activeLink !== link || !tooltipEl) return;
      positionTooltip(link);
    });
  };

  const scheduleShow = (link: HTMLAnchorElement, href: string) => {
    if (!href) return;
    if (editor.view.isDestroyed) {
      hide(true);
      return;
    }
    if (isLinkEditPopupOpen()) {
      hide(true);
      return;
    }

    cancelHide();

    if (activeLink === link && tooltipEl) {
      showNow(link, href);
      return;
    }

    cancelShow();
    showTimer = setTimeout(() => {
      showTimer = null;
      showNow(link, href);
    }, SHOW_DELAY_MS);
  };

  const updatePosition = () => {
    if (!activeLink) return;
    if (isLinkEditPopupOpen()) {
      hide(true);
      return;
    }
    positionTooltip(activeLink);
  };

  const handleEvent = (event: Event) => {
    if (editor.view.isDestroyed) {
      hide(true);
      return;
    }

    const link = getEventLink(event);

    if (isLinkEditPopupOpen()) {
      if (event.type === 'click' && link) {
        event.preventDefault();
      }
      hide(true);
      return;
    }

    if (!link) return;

    const href = normalizePlainLinkHref(link.getAttribute('href'));

    if (event.type === 'click' && href) {
      event.preventDefault();
      hide();
      void openUrl(href).catch((error) => {
        console.error('Failed to open external link:', error);
      });
      return;
    }

    if (event.type === 'mouseover') {
      link.setAttribute('data-link-tooltip', href);
      scheduleShow(link, href);
      return;
    }

    if (event.type === 'mousemove') {
      if (activeLink === link) updatePosition();
      return;
    }

    if (event.type === 'mouseout') {
      const relatedTarget = (event as MouseEvent).relatedTarget as Node | null;
      const movingInsideLink = relatedTarget ? link.contains(relatedTarget) : false;
      const movingToTooltip = relatedTarget && tooltipEl?.contains(relatedTarget);

      if (!movingInsideLink && !movingToTooltip) {
        scheduleHide();
      }
    }
  };

  root.addEventListener('click', handleEvent);
  root.addEventListener('mouseover', handleEvent);
  root.addEventListener('mousemove', handleEvent);
  root.addEventListener('mouseout', handleEvent);
  document.addEventListener('scroll', updatePosition, true);
  window.addEventListener('resize', updatePosition);

  return () => {
    root.removeEventListener('click', handleEvent);
    root.removeEventListener('mouseover', handleEvent);
    root.removeEventListener('mousemove', handleEvent);
    root.removeEventListener('mouseout', handleEvent);
    document.removeEventListener('scroll', updatePosition, true);
    window.removeEventListener('resize', updatePosition);
    hide(true);
  };
}
