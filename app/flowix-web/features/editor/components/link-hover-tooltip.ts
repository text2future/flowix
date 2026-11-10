import { openUrl } from '@platform/tauri/opener';
import type { Editor } from '@tiptap/core';
import { normalizePlainLinkHref } from '@features/editor/extensions/markdown-link';
import { decodeEditorHref, editorLinkInputValue, isRelativePathHref, resolveEditorLocalHref, type EditorLinkContext, type ResolvedEditorLocalLink } from '@features/editor/editor-link-resolution';
import {
  isLinkInlineEditorOpen,
  openLinkInlineEditor,
} from '@features/editor/components/link-inline-editor';
import { positionFloatingBubble } from '@features/editor/components/floating-bubble-position';
import {
  isSelectionBubbleMenuVisible,
  subscribeSelectionBubbleMenuVisibility,
} from '@features/editor/components/selection-bubble-menu-state';
import { navigateToHeadingAnchor } from '@features/editor/components/heading-anchor-navigation';
import { translate } from '@/lib/i18n';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { toast } from '@/lib/toast';

interface LinkRange {
  from: number;
  to: number;
}

const SHOW_DELAY_MS = 80;
const HIDE_DELAY_MS = 140;
const HIDE_ANIMATION_MS = 120;
const IGNORE_LINK_TOOLTIP_SELECTOR = '.agent-thread-card';
// 复制 / 移除链接 / 复制成功都用 Lucide (描边) 图标: 与项目里其他 copy /
// unlink 入口视觉一致; 描边图标靠 stroke=currentColor 上色, 不使用填充。
const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const UNLINK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"/><path d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"/><line x1="8" x2="8" y1="2" y2="5"/><line x1="2" x2="5" y1="8" y2="8"/><line x1="16" x2="16" y1="19" y2="22"/><line x1="19" x2="22" y1="16" y2="16"/></svg>';
// 复制成功的勾选同样用 Lucide (描边), 与 copy / unlink 保持同一视觉语言。
const COPIED_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const COPY_FEEDBACK_MS = 1200;

type LinkTooltipAction = 'copy' | 'edit' | 'remove';

function createActionButton(
  action: LinkTooltipAction,
  label: string,
  onClick: (event: MouseEvent) => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  // 按钮表面样式来自 editor-bubble-menus.css 的共享气泡声明组 (与选区 /
  // 表格气泡同一套尺寸、圆角与 hover 态), 本类名只用来补图标尺寸和复制状态。
  button.className = 'editor-link-hover-tooltip-button';
  // 稳定的动作标记: 排序调整时测试和样式不依赖译文。
  button.dataset.linkAction = action;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', onClick);
  return button;
}

/**
 * Report a link that resolves to neither a local file nor a web host.
 *
 * Its authored form is a sibling path, so there is no honest URL to hand to the
 * OS opener: an unresolved `skills/a.md` is not the host `skills`. Keep the user
 * in the app and say so instead of opening a made-up page.
 */
function notifyUnresolvedPathLink(): void {
  toast.error(translate(getCurrentAppLanguage(), 'errors.friendly.linkOpen'));
}

/**
 * Copy the tooltip's link destination to the system clipboard.
 *
 * The async clipboard API is unavailable in a few desktop shells, so fall back
 * to a temporary textarea instead of reporting a failure the user cannot act
 * on. Returns whether the text actually reached the clipboard.
 */
async function writeClipboardText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path below.
  }

  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', '');
  textArea.style.position = 'fixed';
  textArea.style.top = '-1000px';
  textArea.style.left = '-1000px';
  textArea.style.opacity = '0';
  document.body.appendChild(textArea);
  textArea.select();

  try {
    return document.execCommand('copy');
  } catch (error) {
    console.error('Failed to copy link:', error);
    return false;
  } finally {
    textArea.remove();
  }
}

export function attachLinkHoverTooltip(
  editor: Editor,
  root: HTMLElement,
  getLinkContext?: () => EditorLinkContext | undefined,
): () => void {
  let tooltipEl: HTMLDivElement | null = null;
  let activeLink: HTMLAnchorElement | null = null;
  let showTimer: ReturnType<typeof setTimeout> | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let removeTimer: ReturnType<typeof setTimeout> | null = null;
  let copyResetTimer: ReturnType<typeof setTimeout> | null = null;

  /** Local file target for a link, or null when it keeps web semantics. */
  const localTargetFor = (rawHref: string | null): ResolvedEditorLocalLink | null => {
    const context = getLinkContext?.();
    if (!context) return null;
    return resolveEditorLocalHref(rawHref, context.documentPath);
  };

  const getEventElement = (event: Event): Element | null => {
    const target = event.target;
    if (target instanceof Element) return target;
    if (target instanceof Node) return target.parentElement;
    return null;
  };

  const getEventLink = (event: Event): HTMLAnchorElement | null => {
    const link = getEventElement(event)?.closest('a') as HTMLAnchorElement | null;
    if (!link || link.closest(IGNORE_LINK_TOOLTIP_SELECTOR)) return null;
    // Video embeds provide their own hover action; clicks still use the system opener.
    if (event.type !== 'click' && link.closest('[data-video-embed]')) return null;
    return link;
  };

  /** 是否已有链接编辑 UI 占着位置 (hover 编辑 / 选区添加链接共用同一个组件)。 */
  const isLinkOverlayOpen = () => isLinkInlineEditorOpen();

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
    if (copyResetTimer) {
      clearTimeout(copyResetTimer);
      copyResetTimer = null;
    }
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

    return { from, to };
  };

  /**
   * Copy the destination shown in the tooltip.
   *
   * The bubble shows exactly what a click would follow (a normalized web URL or
   * the stored relative path), so copying that same text keeps the clipboard and
   * the visible tooltip in agreement.
   */
  const copyHref = async (button: HTMLButtonElement, href: string) => {
    const copied = await writeClipboardText(href);
    if (!copied) {
      toast.error(translate(getCurrentAppLanguage(), 'editor.link.copyFailed'));
      return;
    }

    button.innerHTML = COPIED_ICON;
    button.classList.add('is-copied');
    if (copyResetTimer) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      copyResetTimer = null;
      button.innerHTML = COPY_ICON;
      button.classList.remove('is-copied');
    }, COPY_FEEDBACK_MS);
  };

  /**
   * 编辑当前链接: 气泡原地换成「无外框地址输入框 + 保存」。
   *
   * 与选区气泡里的链接按钮共用同一个内联编辑器 (link-inline-editor), 落点也从
   * 链接的包围盒算起, 所以视觉上就是同一个气泡切换了状态。
   */
  const editActiveLink = () => {
    if (editor.view.isDestroyed) {
      hide(true);
      return;
    }
    const link = activeLink;
    if (!link) return;

    const range = getLinkRange(link);
    if (!range) return;

    const initialHref = editorLinkInputValue(link.getAttribute('href'));
    hide(true);
    openLinkInlineEditor({
      editor,
      range: { from: range.from, to: range.to },
      initialHref,
      mode: 'edit',
      // 链接节点可能在输入过程中被事务重建, 定位时读当前 DOM 的包围盒。
      getAnchorRect: () => (link.isConnected ? link.getBoundingClientRect() : null),
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
    // 气泡底色 / 圆角 / 投影 / 内边距与选区、表格气泡共用同一组 CSS 声明
    // (editor-bubble-menus.css); editor-link-tooltip.css 只覆盖定位与动画。
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

    positionFloatingBubble(tooltipEl, link.getBoundingClientRect());
  };

  const renderTooltip = (href: string) => {
    const tooltip = ensureTooltip();
    if (tooltip.dataset.href === href) return;

    tooltip.dataset.href = href;
    tooltip.innerHTML = '';
    if (copyResetTimer) {
      clearTimeout(copyResetTimer);
      copyResetTimer = null;
    }

    const language = getCurrentAppLanguage();
    const editLabel = translate(language, 'editor.link.actionEdit');
    const removeLabel = translate(language, 'editor.link.remove');
    const copyLabel = translate(language, 'editor.link.copy');

    const text = document.createElement('span');
    text.className = 'editor-link-hover-tooltip-text';
    text.textContent = href;

    // 排版: [unlink] 链接地址 [复制] [编辑]
    // - unlink 前置到地址左侧: 读作「断开这条链接」的入口, 也顺带当链接标记
    // - 复制 / 编辑跟在地址后面, 是对这条链接本身的常规操作
    // - 复制 / unlink 用图标 (Lucide copy / unlink); 编辑用文字: 铅笔图标在
    //   这几个描边图标里辨识度最差, 直接写「编辑」更直白
    const copyButton = createActionButton('copy', copyLabel, (event) => {
      event.preventDefault();
      event.stopPropagation();
      void copyHref(copyButton, href);
    });
    copyButton.innerHTML = COPY_ICON;

    const editButton = createActionButton('edit', editLabel, (event) => {
      event.preventDefault();
      event.stopPropagation();
      editActiveLink();
    });
    editButton.textContent = editLabel;
    editButton.classList.add('editor-link-hover-tooltip-text-button');
    // 文案已经在气泡上, 再去掉原生 title 浮层, 避免悬停时又多一层重复提示。
    editButton.removeAttribute('title');

    const removeButton = createActionButton('remove', removeLabel, (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeActiveLink();
    });
    removeButton.innerHTML = UNLINK_ICON;

    const actions = document.createElement('span');
    actions.className = 'editor-link-hover-tooltip-actions';
    actions.append(copyButton, editButton);

    tooltip.append(removeButton, text, actions);
  };

  const showNow = (link: HTMLAnchorElement, href: string) => {
    if (!href) return;
    if (editor.view.isDestroyed) {
      hide(true);
      return;
    }
    // 选区气泡优先: 拖动/选中文字时指针可能仍压在链接上, 这时不顶出链接气泡。
    if (isSelectionBubbleMenuVisible()) {
      hide(true);
      return;
    }
    // 链接输入气泡已经占着位置 (例如 hover 计时器还没触发就点了选区里的链接
    // 按钮) 时, 不再补一个 hover 气泡出来。
    if (isLinkOverlayOpen()) {
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
    if (isLinkOverlayOpen() || isSelectionBubbleMenuVisible()) {
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
    if (isLinkOverlayOpen()) {
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

    if (isLinkOverlayOpen()) {
      // 链接输入气泡开着时, hover 气泡不再抢镜; 链接点击照旧拦下,
      // 避免编辑途中被链接跳转带走。
      if (event.type === 'click' && link) {
        event.preventDefault();
      }
      hide(true);
      return;
    }

    if (!link) return;

    const rawHref = link.getAttribute('href');
    const resolvedPath = localTargetFor(rawHref);
    // A sibling-path href is never a web URL, even when it fails to resolve:
    // `skills/RESOLVER.md` addresses a file, not the host `skills`.
    const pathShaped = isRelativePathHref(rawHref);
    const href = resolvedPath || pathShaped
      ? decodeEditorHref(rawHref ?? '')
      : normalizePlainLinkHref(rawHref);

    if (event.type === 'click' && href.startsWith('#')) {
      event.preventDefault();
      hide();
      navigateToHeadingAnchor(editor.view.dom, href);
      return;
    }

    if (event.type === 'click' && href) {
      event.preventDefault();
      hide();
      if (resolvedPath) {
        const context = getLinkContext?.();
        if (context?.openLocalPath) {
          void Promise.resolve(context.openLocalPath(resolvedPath)).catch((error) => {
            console.error('Failed to open local document link:', error);
          });
          return;
        }
        // No navigation callback wired: keep the historic web-opener
        // semantics instead of turning the click into a dead end — but a path
        // still has no web form to open.
        if (pathShaped) {
          notifyUnresolvedPathLink();
          return;
        }
        void openUrl(normalizePlainLinkHref(rawHref)).catch((error) => {
          console.error('Failed to open external link:', error);
        });
        return;
      }
      if (pathShaped) {
        notifyUnresolvedPathLink();
        return;
      }
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
  // 选区气泡一旦出现, 正在显示的链接气泡立刻让位 (优先次序: 选区 > 链接)。
  const unsubscribeSelectionBubble = subscribeSelectionBubbleMenuVisibility((visible) => {
    if (visible) hide(true);
  });

  return () => {
    root.removeEventListener('click', handleEvent);
    root.removeEventListener('mouseover', handleEvent);
    root.removeEventListener('mousemove', handleEvent);
    root.removeEventListener('mouseout', handleEvent);
    document.removeEventListener('scroll', updatePosition, true);
    window.removeEventListener('resize', updatePosition);
    unsubscribeSelectionBubble();
    hide(true);
  };
}
