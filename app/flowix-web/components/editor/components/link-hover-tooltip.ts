import { openUrl } from '@tauri-apps/plugin-opener';
import type { Editor } from '@tiptap/core';
import { normalizePlainLinkHref } from '../extensions/markdown-link';
import { openLinkBubbleMenu } from './link-bubble-menu';

interface LinkRange {
  from: number;
  to: number;
  text: string;
}

const HIDE_DELAY_MS = 120;
const VIEWPORT_PADDING = 8;
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
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelHide = () => {
    if (!hideTimer) return;
    clearTimeout(hideTimer);
    hideTimer = null;
  };

  const hide = () => {
    cancelHide();
    activeLink = null;
    tooltipEl?.remove();
    tooltipEl = null;
  };

  const scheduleHide = () => {
    cancelHide();
    hideTimer = setTimeout(hide, HIDE_DELAY_MS);
  };

  const getLinkRange = (link: HTMLAnchorElement): LinkRange | null => {
    const from = editor.view.posAtDOM(link, 0);
    const to = editor.view.posAtDOM(link, link.childNodes.length);

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
    if (!activeLink) return;

    const href = normalizePlainLinkHref(activeLink.getAttribute('href'));
    const range = getLinkRange(activeLink);
    if (!range) return;

    hide();
    editor.chain().focus().setTextSelection({ from: range.from, to: range.to }).run();
    openLinkBubbleMenu(editor, () => undefined, {
      from: range.from,
      to: range.to,
      selectedText: range.text,
      href,
    });
  };

  const removeActiveLink = () => {
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
    if (tooltipEl) return tooltipEl;

    tooltipEl = document.createElement('div');
    tooltipEl.className = 'editor-link-hover-tooltip';
    tooltipEl.addEventListener('mouseenter', cancelHide);
    tooltipEl.addEventListener('mouseleave', scheduleHide);
    document.body.appendChild(tooltipEl);
    return tooltipEl;
  };

  const positionTooltip = (link: HTMLAnchorElement) => {
    if (!tooltipEl) return;

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
    tooltip.innerHTML = '';

    const text = document.createElement('span');
    text.className = 'editor-link-hover-tooltip-text';
    text.textContent = href;

    const actions = document.createElement('span');
    actions.className = 'editor-link-hover-tooltip-actions';
    actions.append(
      createIconButton('编辑链接', EDIT_ICON, (event) => {
        event.preventDefault();
        event.stopPropagation();
        editActiveLink();
      }),
      createIconButton('移除链接', REMOVE_ICON, (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeActiveLink();
      }),
    );

    tooltip.append(text, actions);
    tooltip.style.opacity = '0';
  };

  const show = (link: HTMLAnchorElement, href: string) => {
    if (!href) return;

    activeLink = link;
    renderTooltip(href);
    positionTooltip(link);

    requestAnimationFrame(() => {
      if (activeLink !== link || !tooltipEl) return;
      positionTooltip(link);
      tooltipEl.style.opacity = '1';
    });
  };

  const updatePosition = () => {
    if (!activeLink) return;
    positionTooltip(activeLink);
  };

  const handleEvent = (event: Event) => {
    const target = event.target as HTMLElement | null;
    const link = target?.closest('a') as HTMLAnchorElement | null;
    if (!link) return;

    const href = normalizePlainLinkHref(link.getAttribute('href'));

    if (event.type === 'click' && href) {
      event.preventDefault();
      void openUrl(href).catch((error) => {
        console.error('Failed to open external link:', error);
      });
      return;
    }

    if (event.type === 'mouseover') {
      cancelHide();
      link.setAttribute('data-link-tooltip', href);
      show(link, href);
      return;
    }

    if (event.type === 'mousemove') {
      updatePosition();
      return;
    }

    if (event.type === 'mouseout') {
      const relatedTarget = (event as MouseEvent).relatedTarget as Node | null;
      if (!relatedTarget || (!link.contains(relatedTarget) && !tooltipEl?.contains(relatedTarget))) {
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
    hide();
  };
}
