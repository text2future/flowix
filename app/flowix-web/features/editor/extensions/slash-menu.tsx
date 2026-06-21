import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { createRoot, type Root } from 'react-dom/client';
import {
  SLASH_MENU_ITEMS,
  SlashMenuDropdown,
  type SlashMenuItem,
} from '@features/editor/components/slash-menu-dropdown';

export const slashMenuPluginKey = new PluginKey('slashMenu');

interface SlashMenuState {
  triggerFrom: number;
  query: string;
}

interface MenuInstance {
  selectedIndex: number;
  items: SlashMenuItem[];
}

let menuState: SlashMenuState | null = null;
let menuRoot: Root | null = null;
let menuContainer: HTMLDivElement | null = null;
let activeEditor: Editor | null = null;
let menuInstance: MenuInstance | null = null;

function filterItems(query: string): SlashMenuItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return SLASH_MENU_ITEMS;

  return SLASH_MENU_ITEMS.filter((item) => {
    const haystack = [
      item.id,
      item.label,
      item.description,
      ...item.keywords,
    ].join(' ').toLowerCase();

    return haystack.includes(normalizedQuery);
  });
}

function closeMenu() {
  document.removeEventListener('mousedown', handlePointerDownOutside, true);
  window.removeEventListener('resize', closeMenu);
  window.removeEventListener('scroll', handleScrollOutside, true);

  if (menuRoot) {
    menuRoot.unmount();
    menuRoot = null;
  }

  if (menuContainer) {
    menuContainer.remove();
    menuContainer = null;
  }

  menuState = null;
  activeEditor = null;
  menuInstance = null;
}

function handlePointerDownOutside(event: MouseEvent) {
  const target = event.target;
  if (target instanceof Node && menuContainer?.contains(target)) return;
  closeMenu();
}

// 滚动关闭 ── 与 mention (suggestion-menu.tsx) 同源: 只在滚动发生在
// menuContainer 外时才关闭。弹窗自身 overflow-y:auto, 用户在弹窗内
// 滚轮 / 触摸滚动时 scroll 事件会冒泡到 window (capture 阶段也会捕到),
// 不过滤就会把刚打开的弹窗立刻关掉。
function handleScrollOutside(event: Event) {
  const target = event.target;
  if (target instanceof Node && menuContainer?.contains(target)) return;
  closeMenu();
}

function isBlockStart(view: EditorView, pos: number): boolean {
  const $pos = view.state.doc.resolve(pos);
  return $pos.parent.isTextblock && $pos.parentOffset === 0;
}

function getSlashBlockRange(editor: Editor): { from: number; to: number } | null {
  if (!menuState) return null;

  const $trigger = editor.state.doc.resolve(menuState.triggerFrom);
  if ($trigger.depth < 1 || !$trigger.parent.isTextblock) return null;

  return {
    from: $trigger.before($trigger.depth),
    to: $trigger.after($trigger.depth),
  };
}

function getEmptyBlockRangeAfterSlashDelete(
  range: { from: number; to: number } | null
): { from: number; to: number } | undefined {
  if (!range) return undefined;
  return { from: range.from, to: range.from + 2 };
}

function getQuery(view: EditorView, triggerFrom: number): string | null {
  const { selection } = view.state;
  if (!selection.empty || selection.from < triggerFrom + 1) return null;

  const $trigger = view.state.doc.resolve(triggerFrom);
  const $cursor = view.state.doc.resolve(selection.from);
  if ($trigger.sameParent($cursor) === false) return null;

  const query = view.state.doc.textBetween(triggerFrom + 1, selection.from, '\n', '\n');
  if (/[\s/]/.test(query)) return null;

  return query;
}

const SLASH_MENU_MAX_HEIGHT_REM = 20;
const SLASH_MENU_MIN_HEIGHT_REM = 10;
const SLASH_MENU_MAX_HEIGHT_PX = SLASH_MENU_MAX_HEIGHT_REM * 16;
const SLASH_MENU_MIN_HEIGHT_PX = SLASH_MENU_MIN_HEIGHT_REM * 16;

function estimateMenuHeight(items: SlashMenuItem[]): number {
  // header per section (~28px) + items (min 42px + 2px gap each) + wrapper padding (8px)
  const sectionCount = new Set(items.map((item) => item.section)).size;
  const headers = 28 * sectionCount;
  const perItem = 44;
  const wrapper = 8;
  // wrapper 实际被 CSS max-height 截断; 估算也用同一条上限, 否则
  // menuHeight 会超过真实渲染高度, placeAbove 误判翻转。
  const estimated = headers + items.length * perItem + wrapper;
  return Math.min(estimated, SLASH_MENU_MAX_HEIGHT_PX);
}

function updatePosition(view: EditorView) {
  if (!menuContainer) return;

  // Anchor to the text block (not the caret line) so the menu is always
  // attached to the block boundary: below the block when expanding down,
  // above the block when flipping up.
  const { $from } = view.state.selection;
  const blockTopCoords = view.coordsAtPos($from.start());
  const blockBottomCoords = view.coordsAtPos($from.end());
  const menuWidth = 220;
  const viewportPadding = 8;
  const menuGap = 6;

  // 自然高度 (offsetHeight) 用于翻转决策 ── 必须用 CSS 硬上限 cap,
  // 否则内容超过 30rem 时 (estimate 已 cap, 但渲染后 overflow 走的是
  // 自然高度) placeAbove 会按真实高度判定, 翻上去后又被 maxHeight
  // 压回, 浪费翻转 / 视觉抖动。
  const naturalHeight =
    menuContainer.offsetHeight ||
    estimateMenuHeight(menuInstance?.items ?? []);
  const heightForFlip = Math.min(
    naturalHeight || SLASH_MENU_MAX_HEIGHT_PX,
    SLASH_MENU_MAX_HEIGHT_PX,
  );

  const spaceBelow = window.innerHeight - blockBottomCoords.bottom - viewportPadding;
  const spaceAbove = blockTopCoords.top - viewportPadding;

  // Flip above the block when below is too tight and above has more room.
  const placeAbove =
    spaceBelow < heightForFlip + menuGap && spaceAbove > spaceBelow;

  // 视口自适应高度 ── 与 mention (suggestion-menu.tsx#updatePosition)
  // 同源: 可用空间 = 视口 - gap - padding, 但不低于 min-height (视口
  // 极端窄时菜单仍按 min-height 渲染, 内部 overflow-y 兜底滚动)。
  // 高度超过 max-height 时内部滚动, 弹窗本身不超出窗口上下边界。
  const availableHeight = placeAbove
    ? Math.max(SLASH_MENU_MIN_HEIGHT_PX, spaceAbove - menuGap)
    : Math.max(SLASH_MENU_MIN_HEIGHT_PX, spaceBelow - menuGap);
  const maxHeight = Math.min(SLASH_MENU_MAX_HEIGHT_PX, availableHeight);

  menuContainer.style.maxHeight = `${maxHeight}px`;

  const top = placeAbove
    ? Math.max(viewportPadding, blockTopCoords.top - maxHeight - menuGap)
    : Math.min(
        blockBottomCoords.bottom + menuGap,
        Math.max(viewportPadding, window.innerHeight - maxHeight - viewportPadding)
      );

  const left = Math.min(
    Math.max(blockTopCoords.left, viewportPadding),
    Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding)
  );

  menuContainer.style.top = `${top}px`;
  menuContainer.style.left = `${left}px`;
}

function renderMenu(view: EditorView) {
  if (!menuRoot || !menuInstance) return;

  menuRoot.render(
    <SlashMenuDropdown
      items={menuInstance.items}
      selectedIndex={menuInstance.selectedIndex}
      onHover={(index) => {
        if (!menuInstance) return;
        menuInstance.selectedIndex = index;
        renderMenu(view);
      }}
      onSelect={handleSelect}
    />
  );

  // Position after render so offsetHeight reflects the actual menu size.
  updatePosition(view);
}

function openMenu(view: EditorView, editor: Editor, triggerFrom: number) {
  closeMenu();

  menuState = { triggerFrom, query: '' };
  activeEditor = editor;
  menuInstance = {
    selectedIndex: 0,
    items: SLASH_MENU_ITEMS,
  };

  menuContainer = document.createElement('div');
  menuContainer.style.position = 'fixed';
  menuContainer.style.zIndex = '2147483647';
  menuContainer.style.width = '220px';
  menuContainer.style.maxWidth = 'calc(100vw - 16px)';
  document.body.appendChild(menuContainer);
  menuRoot = createRoot(menuContainer);

  document.addEventListener('mousedown', handlePointerDownOutside, true);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('scroll', handleScrollOutside, true);

  renderMenu(view);
}

function deleteTriggerText(editor: Editor): boolean {
  if (!menuState) return false;

  const to = editor.state.selection.from;
  editor.chain().focus().deleteRange({
    from: menuState.triggerFrom,
    to,
  }).run();

  return true;
}

function handleSelect(item: SlashMenuItem): void {
  if (!activeEditor || !menuState) return;

  const editor = activeEditor;
  const slashBlockRange = getSlashBlockRange(editor);

  if (item.id === 'table') {
    deleteTriggerText(editor);
    closeMenu();
    editor.chain().focus().insertTable({
      rows: 3,
      cols: 3,
      withHeaderRow: true,
    }).run();
    return;
  }

  if (item.id === 'agent-thread-flowix' || item.id === 'agent-thread-codex') {
    closeMenu();
    // 不加 .focus() ── 与 handleMouseDown 去掉 view.focus() 同源: focus 把
    // 焦点切到 ProseMirror editable, 浏览器 native selection 会接管卡片内
    // 文字并触发 .ProseMirror-selectednode outline, 形成'插入后卡片被外框
    // 框住 + 内部文本高亮'的副作用。焦点在 deleteTriggerText 里已经抢回
    // 编辑器, 这里不再 .focus() 不会丢焦点。
    editor.chain().insertAgentThreadCard({
      roleKey: item.id === 'agent-thread-codex' ? 'codex' : 'flowix',
      replaceRange: slashBlockRange ?? undefined,
    }).run();
    return;
  }

  // 块级切换 (引用 / 列表 / 分割线) ── 与 insertTable 同源: 先 deleteRange
  // 抹掉 "/query" 让光标停在空块首, 再 toggle/set 把当前空段落换成目标块。
  // 这样不会出现 "/引用" 这种残留字符, 也避免选中既有段落内容被误改。
  const blockToggleById: Partial<Record<SlashMenuItem['id'], () => void>> = {
    'blockquote': () => editor.chain().focus().toggleBlockquote().run(),
    'code-block': () => editor.chain().focus().toggleCodeBlock().run(),
    'bullet-list': () => editor.chain().focus().toggleBulletList().run(),
    'ordered-list': () => editor.chain().focus().toggleOrderedList().run(),
    'task-list': () => editor.chain().focus().toggleTaskList().run(),
    'horizontal-rule': () => editor.chain().focus().setHorizontalRule().run(),
  };
  const blockToggle = blockToggleById[item.id];
  if (blockToggle) {
    deleteTriggerText(editor);
    closeMenu();
    blockToggle();
    return;
  }

  const acceptById: Partial<Record<SlashMenuItem['id'], string>> = {
    image: 'image/*',
    video: 'video/*',
  };

  deleteTriggerText(editor);
  closeMenu();

  editor.commands.openFileDialog({
    accept: acceptById[item.id],
    multiple: true,
    replaceRange: getEmptyBlockRangeAfterSlashDelete(slashBlockRange),
  });
}

function refreshMenuFromEditor(view: EditorView) {
  if (!menuState || !menuInstance) return;

  const query = getQuery(view, menuState.triggerFrom);
  if (query === null) {
    closeMenu();
    return;
  }

  menuState.query = query;
  menuInstance.items = filterItems(query);
  menuInstance.selectedIndex = Math.min(
    menuInstance.selectedIndex,
    Math.max(menuInstance.items.length - 1, 0)
  );
  renderMenu(view);
}

export const SlashMenu = Extension.create({
  name: 'slashMenu',

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin({
        key: slashMenuPluginKey,

        view(view) {
          return {
            update(updatedView) {
              if (updatedView !== view || !menuState) return;
              refreshMenuFromEditor(updatedView);
            },
            destroy() {
              closeMenu();
            },
          };
        },

        props: {
          handleTextInput(view, from, _to, text) {
            if (text !== '/') return false;

            if (!editor.isEditable || !isBlockStart(view, from)) {
              closeMenu();
              return false;
            }

            openMenu(view, editor, from);
            return false;
          },

          handleKeyDown(view, event) {
            if (!menuState || !menuInstance) return false;

            if (event.key === 'ArrowUp') {
              event.preventDefault();
              menuInstance.selectedIndex = menuInstance.selectedIndex > 0
                ? menuInstance.selectedIndex - 1
                : Math.max(menuInstance.items.length - 1, 0);
              renderMenu(view);
              return true;
            }

            if (event.key === 'ArrowDown') {
              event.preventDefault();
              menuInstance.selectedIndex = menuInstance.selectedIndex < menuInstance.items.length - 1
                ? menuInstance.selectedIndex + 1
                : 0;
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
              const item = menuInstance.items[menuInstance.selectedIndex];
              if (item) handleSelect(item);
              return true;
            }

            if (event.key === 'Tab') {
              event.preventDefault();
              const direction = event.shiftKey ? -1 : 1;
              const count = menuInstance.items.length;
              if (count > 0) {
                menuInstance.selectedIndex = (menuInstance.selectedIndex + direction + count) % count;
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
