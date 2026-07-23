import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';

const PAGE_SIZE = 20;
const MENU_MAX_HEIGHT = 288;
const MENU_GAP = 6;
const VIEWPORT_PADDING = 8;
const MENU_MIN_HEIGHT = 96;
const MENU_FLIP_BELOW_THRESHOLD = 10 * 16;

export interface SuggestionMenuRenderProps<TItem> {
  items: TItem[];
  selectedIndex: number;
  scrollSelectedItem: boolean;
  hasMore: boolean;
  loading: boolean;
  onSelect: (item: TItem) => void;
  onHover: (index: number) => void;
  onLoadMore: () => void;
}

export interface SuggestionMenuSelectContext<TItem> {
  editor: Editor;
  view: EditorView;
  item: TItem;
  triggerFrom: number;
  trigger: string;
  /** 删除从 trigger 位置到当前光标之间的文本 (含 trigger 字符)。
   *  选择已有项时通常需要先删掉触发符再插入完整内容;
   *  选择"新建"类项时跳过此步, 让编辑器里已存在的查询文本保留。 */
  deleteTriggerText: () => boolean;
}

export interface SuggestionMenuConfig<TItem> {
  /** 触发字符, 如 `@` / `#` */
  trigger: string;
  /** 弹窗宽度 (px) */
  width: number;
  /** 校验触发位置, 返回 false 表示不开弹窗 (例: `#` 需行首/空白后) */
  isValidTriggerPosition?: (view: EditorView, from: number) => boolean;
  /** 解析当前查询; 返回 null 表示关闭弹窗 */
  parseQuery: (view: EditorView, triggerFrom: number, trigger: string) => string | null;
  /** 异步获取候选项 */
  fetchItems: (query: string) => Promise<TItem[]>;
  /** 渲染下拉 UI */
  render: (props: SuggestionMenuRenderProps<TItem>) => ReactNode;
  /** 选中回调 */
  onSelect: (ctx: SuggestionMenuSelectContext<TItem>) => void;
  /** 异步查询失败的回调 */
  onError?: (err: unknown) => void;
}

interface MenuState {
  triggerFrom: number;
  trigger: string;
  query: string;
  requestId: number;
}

interface MenuInstance<TItem> {
  selectedIndex: number;
  scrollSelectedItem: boolean;
  allItems: TItem[];
  visibleCount: number;
  loading: boolean;
}

// ─── 模块级单例: 同一时刻只允许一个 suggestion 弹窗 ──────────────────────
// Mention 扩展共享同一容器 / 位置 / IME 状态,
// 开新弹窗时主动 close 旧的, 避免两者并存。
let menuState: MenuState | null = null;
let menuInstance: MenuInstance<unknown> | null = null;
let menuContainer: HTMLDivElement | null = null;
let menuRoot: Root | null = null;
let activeEditor: Editor | null = null;
let activeView: EditorView | null = null;
let activeConfig: SuggestionMenuConfig<unknown> | null = null;
let composing = false;
let menuPlacement: 'above' | 'below' | null = null;
let positionFrame = 0;
let menuOpenId = 0;

function disposeMenuRoot(root: Root, container: HTMLDivElement) {
  window.setTimeout(() => {
    root.unmount();
    container.remove();
  }, 0);
}

function isComposing(view: EditorView): boolean {
  return composing || Boolean((view as EditorView & { composing?: boolean }).composing);
}

function closeMenu() {
  menuOpenId += 1;
  document.removeEventListener('mousedown', handlePointerDownOutside, true);
  window.removeEventListener('resize', handleWindowResize);
  window.removeEventListener('scroll', handleScrollOutside, true);
  if (positionFrame) {
    window.cancelAnimationFrame(positionFrame);
    positionFrame = 0;
  }

  const root = menuRoot;
  const container = menuContainer;
  menuRoot = null;
  menuContainer = null;

  menuState = null;
  menuInstance = null;
  activeEditor = null;
  activeView = null;
  activeConfig = null;
  composing = false;
  menuPlacement = null;

  if (root && container) {
    disposeMenuRoot(root, container);
  } else {
    container?.remove();
  }
}

function isCurrentMenuView(view: EditorView, openId = menuOpenId): boolean {
  return (
    openId === menuOpenId &&
    activeView === view &&
    !view.isDestroyed &&
    Boolean(menuRoot && menuContainer && menuState && menuInstance && activeConfig)
  );
}

function handlePointerDownOutside(event: MouseEvent) {
  const target = event.target;
  if (target instanceof Node && menuContainer?.contains(target)) return;
  closeMenu();
}

function handleScrollOutside(event: Event) {
  const target = event.target;
  if (target instanceof Node && menuContainer?.contains(target)) return;
  if (!activeView || !activeConfig || activeView.isDestroyed) {
    closeMenu();
    return;
  }

  try {
    refreshMenuFromEditor(activeView);
  } catch {
    closeMenu();
  }
}

function handleWindowResize() {
  if (activeView && activeConfig) updatePosition(activeView, activeConfig.width);
}

function deleteTriggerText(): boolean {
  if (!menuState || !activeEditor) return false;
  activeEditor.chain().focus().deleteRange({
    from: menuState.triggerFrom,
    to: activeEditor.state.selection.from,
  }).run();
  return true;
}

function updatePosition(view: EditorView, width: number) {
  if (!menuContainer || !menuInstance || !menuState) return;

  const cursorCoords = view.coordsAtPos(view.state.selection.from);
  const anchorCoords = view.coordsAtPos(menuState.triggerFrom + menuState.trigger.length);
  const spaceAbove = cursorCoords.top - VIEWPORT_PADDING;
  const spaceBelow = window.innerHeight - cursorCoords.bottom - VIEWPORT_PADDING;
  const shouldPlaceAbove = spaceBelow < MENU_FLIP_BELOW_THRESHOLD && spaceAbove > spaceBelow;
  const shouldPlaceBelow = spaceBelow >= MENU_FLIP_BELOW_THRESHOLD || spaceBelow >= spaceAbove;

  if (!menuPlacement) {
    menuPlacement = shouldPlaceAbove ? 'above' : 'below';
  } else if (menuPlacement === 'below' && shouldPlaceAbove) {
    menuPlacement = 'above';
  } else if (menuPlacement === 'above' && shouldPlaceBelow) {
    menuPlacement = 'below';
  }

  const availableHeight = menuPlacement === 'above'
    ? Math.max(MENU_MIN_HEIGHT, spaceAbove - MENU_GAP)
    : Math.max(MENU_MIN_HEIGHT, spaceBelow - MENU_GAP);
  const left = Math.min(
    Math.max(anchorCoords.left, VIEWPORT_PADDING),
    Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING),
  );

  menuContainer.style.setProperty(
    '--mention-note-max-height',
    `${Math.min(MENU_MAX_HEIGHT, availableHeight)}px`,
  );
  if (menuPlacement === 'above') {
    menuContainer.style.top = '';
    menuContainer.style.bottom = `${Math.max(
      VIEWPORT_PADDING,
      window.innerHeight - cursorCoords.top + MENU_GAP,
    )}px`;
  } else {
    menuContainer.style.top = `${Math.min(
      cursorCoords.bottom + MENU_GAP,
      window.innerHeight - VIEWPORT_PADDING - MENU_MIN_HEIGHT,
    )}px`;
    menuContainer.style.bottom = '';
  }
  menuContainer.style.left = `${left}px`;
}

function scheduleUpdatePosition(view: EditorView, width: number) {
  if (positionFrame) window.cancelAnimationFrame(positionFrame);
  positionFrame = window.requestAnimationFrame(() => {
    positionFrame = 0;
    updatePosition(view, width);
  });
}

function renderMenu(view: EditorView) {
  if (!isCurrentMenuView(view)) return;
  const root = menuRoot;
  const instance = menuInstance;
  const config = activeConfig;
  if (!root || !instance || !config) return;
  const visibleItems = instance.allItems.slice(0, instance.visibleCount);

  root.render(config.render({
    items: visibleItems as never,
    selectedIndex: instance.selectedIndex,
    scrollSelectedItem: instance.scrollSelectedItem,
    hasMore: instance.visibleCount < instance.allItems.length,
    loading: instance.loading,
    onSelect: (item) => {
      if (!activeEditor || !menuState || !activeConfig) return;
      activeConfig.onSelect({
        editor: activeEditor,
        view,
        item,
        triggerFrom: menuState.triggerFrom,
        trigger: menuState.trigger,
        deleteTriggerText,
      });
    },
    onHover: (index) => {
      if (!menuInstance) return;
      menuInstance.selectedIndex = index;
      menuInstance.scrollSelectedItem = false;
      renderMenu(view);
    },
    onLoadMore: () => {
      if (!menuInstance) return;
      menuInstance.visibleCount = Math.min(
        menuInstance.visibleCount + PAGE_SIZE,
        menuInstance.allItems.length,
      );
      renderMenu(view);
    },
  }));

  scheduleUpdatePosition(view, config.width);
}

function applyQueryItems(view: EditorView, items: unknown[], resetPage: boolean) {
  if (!isCurrentMenuView(view)) return;
  const instance = menuInstance;
  if (!instance) return;
  instance.allItems = items;
  instance.loading = false;
  if (resetPage) {
    instance.visibleCount = PAGE_SIZE;
    instance.selectedIndex = 0;
    instance.scrollSelectedItem = true;
  } else {
    instance.selectedIndex = Math.min(
      instance.selectedIndex,
      Math.max(Math.min(instance.visibleCount, instance.allItems.length) - 1, 0),
    );
    instance.scrollSelectedItem = true;
  }
  renderMenu(view);
}

function requestQuery(view: EditorView, query: string, resetPage: boolean) {
  if (!isCurrentMenuView(view)) return;
  const state = menuState;
  const instance = menuInstance;
  const config = activeConfig;
  const openId = menuOpenId;
  if (!state || !instance || !config) return;
  const requestId = ++state.requestId;
  instance.loading = true;
  if (resetPage) {
    instance.allItems = [];
    instance.visibleCount = PAGE_SIZE;
    instance.selectedIndex = 0;
    instance.scrollSelectedItem = true;
  }
  renderMenu(view);

  config.fetchItems(query).then((items) => {
    if (!isCurrentMenuView(view, openId) || menuState?.requestId !== requestId) return;
    applyQueryItems(view, items, resetPage);
  }).catch((err) => {
    config.onError?.(err);
    if (!isCurrentMenuView(view, openId) || menuState?.requestId !== requestId) return;
    applyQueryItems(view, [], resetPage);
  });
}

function openMenu(
  view: EditorView,
  editor: Editor,
  triggerFrom: number,
  config: SuggestionMenuConfig<unknown>,
) {
  closeMenu();

  const openId = menuOpenId;
  menuState = { triggerFrom, trigger: config.trigger, query: '', requestId: 0 };
  activeEditor = editor;
  activeView = view;
  activeConfig = config;
  menuPlacement = null;
  menuInstance = {
    selectedIndex: 0,
    scrollSelectedItem: true,
    allItems: [],
    visibleCount: PAGE_SIZE,
    loading: true,
  };

  menuContainer = document.createElement('div');
  menuContainer.style.position = 'fixed';
  menuContainer.style.zIndex = '2147483647';
  menuContainer.style.width = `${config.width}px`;
  menuContainer.style.maxHeight = `${MENU_MAX_HEIGHT}px`;
  menuContainer.style.maxWidth = 'calc(100vw - 16px)';
  document.body.appendChild(menuContainer);
  menuRoot = createRoot(menuContainer);

  document.addEventListener('mousedown', handlePointerDownOutside, true);
  window.addEventListener('resize', handleWindowResize);
  window.addEventListener('scroll', handleScrollOutside, true);

  if (isCurrentMenuView(view, openId)) {
    requestQuery(view, '', true);
  }
}

export function openSuggestionMenuFromEditor<TItem>(
  editor: Editor,
  config: SuggestionMenuConfig<TItem>
): boolean {
  if (!editor.isEditable || !editor.state.selection.empty) return false;

  editor.chain().focus().insertContent(config.trigger).run();

  const triggerFrom = editor.state.selection.from - config.trigger.length;
  openMenu(
    editor.view,
    editor,
    triggerFrom,
    config as unknown as SuggestionMenuConfig<unknown>
  );

  return true;
}

function refreshMenuFromEditor(view: EditorView) {
  if (!isCurrentMenuView(view)) return;
  const state = menuState;
  const config = activeConfig;
  if (!state || !config) return;
  if (isComposing(view)) return;

  const query = config.parseQuery(view, state.triggerFrom, state.trigger);
  if (query === null) {
    closeMenu();
    return;
  }

  if (query !== state.query) {
    state.query = query;
    requestQuery(view, query, true);
    return;
  }

  renderMenu(view);
}

/**
 * 工厂: 给定 config 创建一个 Tiptap Extension, 提供统一的弹出/定位/IME/
 * 请求取消基础设施。每个 mention 类型 (Note / Tag / 未来更多) 只需声明
 * 自己的 trigger、width、查询 / 渲染 / 选中逻辑。
 */
export function createSuggestionExtension<TItem>(config: SuggestionMenuConfig<TItem>) {
  const trigger = config.trigger;
  const isValidTriggerPosition = config.isValidTriggerPosition;
  const typedConfig = config as unknown as SuggestionMenuConfig<unknown>;
  // 每个扩展实例独立 PluginKey, 避免 Tiptap 在同时注册多个 suggestion 时
  // 报 "Adding different instances of a keyed plugin (suggestionMenu$)"。
  const pluginKey = new PluginKey(`suggestion-${trigger}`);

  return Extension.create({
    name: `suggestion-${trigger}`,

    addProseMirrorPlugins() {
      const editor = this.editor;

      return [
        new Plugin({
          key: pluginKey,

          view(view) {
            const handleCompositionStart = () => {
              if (menuState) composing = true;
            };
            const handleCompositionEnd = () => {
              if (!composing) return;
              composing = false;
              window.setTimeout(() => {
                if (menuState) refreshMenuFromEditor(view);
              }, 0);
            };

            view.dom.addEventListener('compositionstart', handleCompositionStart);
            view.dom.addEventListener('compositionend', handleCompositionEnd);

            return {
              update(updatedView) {
                if (updatedView.isDestroyed) return;
                if (updatedView !== view || !menuState) return;
                refreshMenuFromEditor(updatedView);
              },
              destroy() {
                // view 可能已经被所属 Editor 销毁 (e.g. 语言切换触发重建) —
                // 再读 view.dom 会触发 "editor view is not available"。
                if (!view.isDestroyed) {
                  view.dom.removeEventListener('compositionstart', handleCompositionStart);
                  view.dom.removeEventListener('compositionend', handleCompositionEnd);
                }
                closeMenu();
              },
            };
          },

          props: {
            handleTextInput(view, from, _to, text) {
              if (text !== trigger) return false;
              if (!editor.isEditable || !view.state.selection.empty) {
                closeMenu();
                return false;
              }
              if (isValidTriggerPosition && !isValidTriggerPosition(view, from)) {
                return false;
              }

              openMenu(view, editor, from, typedConfig);
              return false;
            },

            handleKeyDown(view, event) {
              if (!menuState || !menuInstance) return false;
              if (event.isComposing || isComposing(view)) return false;

              const visibleItems = menuInstance.allItems.slice(0, menuInstance.visibleCount);

              if (event.key === 'ArrowUp') {
                event.preventDefault();
                menuInstance.selectedIndex = menuInstance.selectedIndex > 0
                  ? menuInstance.selectedIndex - 1
                  : Math.max(visibleItems.length - 1, 0);
                menuInstance.scrollSelectedItem = true;
                renderMenu(view);
                return true;
              }

              if (event.key === 'ArrowDown') {
                event.preventDefault();
                if (
                  menuInstance.selectedIndex >= visibleItems.length - 1 &&
                  menuInstance.visibleCount < menuInstance.allItems.length
                ) {
                  menuInstance.visibleCount = Math.min(
                    menuInstance.visibleCount + PAGE_SIZE,
                    menuInstance.allItems.length,
                  );
                  menuInstance.selectedIndex += 1;
                } else {
                  menuInstance.selectedIndex = menuInstance.selectedIndex < visibleItems.length - 1
                    ? menuInstance.selectedIndex + 1
                    : 0;
                }
                menuInstance.scrollSelectedItem = true;
                renderMenu(view);
                return true;
              }

              if (event.key === 'Escape') {
                event.preventDefault();
                closeMenu();
                return true;
              }

              if (event.key === 'Enter') {
                event.preventDefault();
                const item = visibleItems[menuInstance.selectedIndex];
                if (item && activeConfig && activeEditor && menuState) {
                  activeConfig.onSelect({
                    editor: activeEditor,
                    view,
                    item,
                    triggerFrom: menuState.triggerFrom,
                    trigger: menuState.trigger,
                    deleteTriggerText,
                  });
                }
                return true;
              }

              if (event.key === 'Tab') {
                event.preventDefault();
                const direction = event.shiftKey ? -1 : 1;
                const count = visibleItems.length;
                if (count > 0) {
                  menuInstance.selectedIndex = (menuInstance.selectedIndex + direction + count) % count;
                  menuInstance.scrollSelectedItem = true;
                  renderMenu(view);
                }
                return true;
              }

              return false;
            },
          },
        }),
      ];
    },
  });
}
