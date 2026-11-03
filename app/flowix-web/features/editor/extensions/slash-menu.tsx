import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { createRoot, type Root } from 'react-dom/client';
import { useNoteStore } from '@features/memo/store/note-store';
import { openNoteMention, invalidateMentionNotes } from '@features/editor/extensions/note-mention';
import {
  SLASH_MENU_ITEMS,
  SlashMenuDropdown,
  getSlashMenuItemLabel,
  type AgentThreadSlashMenuItemId,
  type SlashMenuItem,
} from '@features/editor/components/slash-menu-dropdown';
import {
  getCurrentAppLanguage,
  isAgentTypeEnabled,
  subscribeEditorRuntimePreferences,
} from '@features/preferences/public/runtime-api';
import {
  getAgentRuntimeStatusSnapshot,
  getAvailableAgentTypes,
  refreshAgentRuntimeStatusIfStale,
  subscribeAgentRuntimeStatus,
} from '@features/agent/public/runtime-status-api';
import { windows } from '@platform/tauri/client';
import { translate } from '@/lib/i18n';
import type { AgentTypeKey } from '@/types/agent';
import { applyListType } from './list-transforms';
import { openTableReferencePicker } from '@features/multidimensional-table/table-reference-picker';
import { openMediaLibraryReferencePicker } from '@features/media-library/media-library-reference-picker';
import type { TableViewType } from '@features/multidimensional-table/model';
import { insertTableTemplate } from './table/table-templates';
import { getTableSlashMenuItems } from './table/table-slash-menu';

export const slashMenuPluginKey = new PluginKey('slashMenu');

interface SlashMenuState {
  triggerFrom: number;
  deleteFrom: number;
  query: string;
  cursorPos: number;
}

interface MenuInstance {
  selectedIndex: number;
  scrollSelectedItem: boolean;
  hasNavigated: boolean;
  availableItems: SlashMenuItem[];
  items: SlashMenuItem[];
  submenu: 'table' | null;
}

let menuState: SlashMenuState | null = null;
let menuRoot: Root | null = null;
let menuContainer: HTMLDivElement | null = null;
let activeEditor: Editor | null = null;
let activeView: EditorView | null = null;
let menuInstance: MenuInstance | null = null;
let menuOpenId = 0;
let unsubscribeRuntimeStatus: (() => void) | null = null;
let unsubscribeUserSettings: (() => void) | null = null;
let positionFrame: number | null = null;

function disposeMenuRoot(root: Root, container: HTMLDivElement) {
  window.setTimeout(() => {
    root.unmount();
    container.remove();
  }, 0);
}

const AGENT_THREAD_TYPE_BY_SLASH_ID: Record<AgentThreadSlashMenuItemId, AgentTypeKey> = {
  'agent-thread-pi': 'pi',
  'agent-thread-codex': 'codex',
  'agent-thread-claude': 'claudecode',
  'agent-thread-hermes': 'hermes',
  'agent-thread-opencode': 'opencode',
  'agent-thread-deepseek-harness': 'dsh',
};

const TABLE_VIEW_TYPE_BY_SLASH_ID: Partial<Record<SlashMenuItem['id'], TableViewType>> = {
  'table-reference': 'table',
  'table-kanban-view': 'kanban',
  'table-calendar-view': 'calendar',
  'table-gallery-view': 'gallery',
};

function isAgentThreadSlashMenuItemId(id: SlashMenuItem['id']): id is AgentThreadSlashMenuItemId {
  return id in AGENT_THREAD_TYPE_BY_SLASH_ID;
}

function getAvailableSlashAgentTypes(): Set<AgentTypeKey> {
  const runtime = getAgentRuntimeStatusSnapshot();
  const availableAgents = getAvailableAgentTypes(
    runtime.statusByType,
    runtime.isChecking,
    isAgentTypeEnabled,
  );

  if (availableAgents.length > 0) {
    return new Set(availableAgents.map((type) => type.id));
  }

  // While no successful check exists or a refresh is in flight, keep Pi as
  // the lightweight default until runtime availability is known.
  if ((!runtime.hasChecked || runtime.isChecking) && isAgentTypeEnabled('pi')) {
    return new Set(['pi']);
  }
  return new Set();
}

function getAvailableSlashMenuItems(): SlashMenuItem[] {
  const availableAgentTypes = getAvailableSlashAgentTypes();

  return SLASH_MENU_ITEMS.filter((item) => {
    if (!isAgentThreadSlashMenuItemId(item.id)) return true;
    return availableAgentTypes.has(AGENT_THREAD_TYPE_BY_SLASH_ID[item.id]);
  });
}

function filterItems(query: string, availableItems = getAvailableSlashMenuItems()): SlashMenuItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return availableItems;

  const language = getCurrentAppLanguage();

  return availableItems.filter((item) => {
    if (item.id === 'table' && getTableSlashMenuItems(query, language).length > 0) return true;
    const labelText = getSlashMenuItemLabel(item, language);
    const haystack = [
      item.id,
      labelText,
      item.description,
      ...item.keywords,
    ].join(' ').toLowerCase();

    return haystack.includes(normalizedQuery);
  });
}

function closeMenu(ownerView?: EditorView) {
  if (ownerView && activeView !== ownerView) return;

  menuOpenId += 1;
  if (positionFrame !== null) {
    window.cancelAnimationFrame(positionFrame);
    positionFrame = null;
  }
  document.removeEventListener('mousedown', handlePointerDownOutside, true);
  window.removeEventListener('resize', handleWindowResize);
  window.removeEventListener('scroll', handleScrollOutside, true);
  unsubscribeRuntimeStatus?.();
  unsubscribeRuntimeStatus = null;
  unsubscribeUserSettings?.();
  unsubscribeUserSettings = null;

  const root = menuRoot;
  const container = menuContainer;
  menuRoot = null;
  menuContainer = null;

  menuState = null;
  activeEditor = null;
  activeView = null;
  menuInstance = null;

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
    Boolean(menuRoot && menuContainer && menuState && menuInstance)
  );
}

/** Let host-level navigation defer to this view's active command menu. */
export function isSlashMenuOpen(view: EditorView): boolean {
  return isCurrentMenuView(view);
}

function handlePointerDownOutside(event: MouseEvent) {
  const target = event.target;
  if (target instanceof Node && menuContainer?.contains(target)) return;
  closeMenu();
}

function handleWindowResize() {
  closeMenu();
}

// 滚动关闭 ── 与 mention (suggestion-menu.tsx) 同源: 只在滚动发生在
// menuContainer 外时才关闭。弹窗自身 overflow-y:auto, 用户在弹窗内
// 滚轮 / 触摸滚动时 scroll 事件会冒泡到 window (capture 阶段也会捕到),
// 不过滤就会把刚打开的弹窗立刻关掉。
function handleScrollOutside(event: Event) {
  const target = event.target;
  if (target instanceof Node && menuContainer?.contains(target)) return;
  const view = activeView;
  if (!view || view.isDestroyed) {
    closeMenu();
    return;
  }

  if (positionFrame !== null) return;
  const openId = menuOpenId;
  positionFrame = window.requestAnimationFrame(() => {
    positionFrame = null;
    if (!isCurrentMenuView(view, openId)) return;
    try {
      updatePosition(view);
    } catch {
      closeMenu(view);
    }
  });
}

function getSlashTriggerDeleteFrom(view: EditorView, pos: number): number | null {
  const $pos = view.state.doc.resolve(pos);
  if (!$pos.parent.isTextblock) return null;
  if ($pos.parentOffset === 0) return pos;

  const previousChar = view.state.doc.textBetween(pos - 1, pos, '\n', '\n');
  return /\s/.test(previousChar) ? pos - 1 : null;
}

function isBlockStartTrigger(editor: Editor): boolean {
  if (!menuState) return false;
  const $trigger = editor.state.doc.resolve(menuState.triggerFrom);
  return $trigger.parent.isTextblock && $trigger.parentOffset === 0;
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

function prepareSlashBlockTarget(editor: Editor): { from: number; to: number } | undefined {
  if (!menuState) return undefined;
  if (isBlockStartTrigger(editor)) {
    const range = getSlashBlockRange(editor);
    deleteTriggerText(editor);
    return getEmptyBlockRangeAfterSlashDelete(range);
  }

  const { state, view } = editor;
  const paragraphType = state.schema.nodes.paragraph;
  if (!paragraphType) {
    deleteTriggerText(editor);
    return undefined;
  }

  const $trigger = state.doc.resolve(menuState.triggerFrom);
  if ($trigger.depth < 1 || !$trigger.parent.isTextblock) {
    deleteTriggerText(editor);
    return undefined;
  }

  const blockEnd = $trigger.after($trigger.depth);
  const to = state.selection.from;
  let tr = state.tr.delete(menuState.deleteFrom, to);
  const insertPos = tr.mapping.map(blockEnd, -1);
  tr = tr.insert(insertPos, paragraphType.create());
  const selectionPos = insertPos + 1;
  tr = tr.setSelection(TextSelection.create(tr.doc, selectionPos));
  view.dispatch(tr.scrollIntoView());

  return { from: insertPos, to: insertPos + 2 };
}

function insertHorizontalRuleAtRange(
  editor: Editor,
  range: { from: number; to: number } | undefined
): boolean {
  const horizontalRuleType = editor.state.schema.nodes.horizontalRule;
  const paragraphType = editor.state.schema.nodes.paragraph;
  if (!horizontalRuleType || !paragraphType || !range) {
    return editor.chain().focus().setHorizontalRule().run();
  }

  const { state, view } = editor;
  const from = Math.max(0, Math.min(range.from, state.doc.content.size));
  const to = Math.max(from, Math.min(range.to, state.doc.content.size));
  const horizontalRule = horizontalRuleType.create();
  const paragraph = paragraphType.create();
  const tr = state.tr.replaceWith(from, to, [horizontalRule, paragraph]);
  const selectionPos = Math.min(from + horizontalRule.nodeSize + 1, tr.doc.content.size);
  tr.setSelection(TextSelection.create(tr.doc, selectionPos));
  view.dispatch(tr.scrollIntoView());
  return true;
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
  const sectionKey = (item: SlashMenuItem) => item.sectionKey ?? item.section ?? '';
  const sectionCount = new Set(items.map(sectionKey)).size;
  const headers = 28 * sectionCount;
  const perItem = 44;
  const wrapper = 8;
  // wrapper 实际被 CSS max-height 截断; 估算也用同一条上限, 否则
  // menuHeight 会超过真实渲染高度, placeAbove 误判翻转。
  const estimated = headers + items.length * perItem + wrapper;
  return Math.min(estimated, SLASH_MENU_MAX_HEIGHT_PX);
}

function updatePosition(view: EditorView) {
  if (!menuContainer || !menuState) return;

  // Keep slash menu positioning consistent with mention menus: horizontal
  // anchor follows the trigger character, vertical placement follows the
  // active cursor line while the query changes.
  const cursorCoords = view.coordsAtPos(view.state.selection.from);
  const slashCoords = view.coordsAtPos(menuState.triggerFrom);
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

  const spaceBelow = window.innerHeight - cursorCoords.bottom - viewportPadding;
  const spaceAbove = cursorCoords.top - viewportPadding;

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
    ? Math.max(viewportPadding, cursorCoords.top - maxHeight - menuGap)
    : Math.min(
        cursorCoords.bottom + menuGap,
        Math.max(viewportPadding, window.innerHeight - maxHeight - viewportPadding)
      );

  const left = Math.min(
    Math.max(slashCoords.left, viewportPadding),
    Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding)
  );

  menuContainer.style.top = `${top}px`;
  menuContainer.style.left = `${left}px`;
}

function renderMenu(view: EditorView, reposition = true) {
  if (!isCurrentMenuView(view)) return;
  const openId = menuOpenId;
  const root = menuRoot;
  const instance = menuInstance;
  if (!root || !instance) return;

  root.render(
    <SlashMenuDropdown
      language={getCurrentAppLanguage()}
      items={instance.items}
      selectedIndex={instance.selectedIndex}
      scrollSelectedItem={instance.scrollSelectedItem}
      onHover={(index) => {
        if (!isCurrentMenuView(view, openId)) return;
        if (!menuInstance) return;
        if (menuInstance.selectedIndex === index && !menuInstance.scrollSelectedItem) return;
        menuInstance.hasNavigated = true;
        menuInstance.selectedIndex = index;
        menuInstance.scrollSelectedItem = false;
        renderMenu(view, false);
      }}
      onScroll={() => {
        if (isCurrentMenuView(view, openId) && menuInstance) {
          menuInstance.hasNavigated = true;
        }
      }}
      onSelect={(item) => {
        if (isCurrentMenuView(view, openId)) handleSelect(item);
      }}
      onBack={instance.submenu ? () => {
        if (isCurrentMenuView(view, openId)) closeTableSubmenu(view);
      } : undefined}
      onAddAgent={instance.submenu ? undefined : () => {
        if (isCurrentMenuView(view, openId)) void handleAddAgentClick(view, openId);
      }}
    />
  );

  // Position after render so offsetHeight reflects the actual menu size.
  if (reposition) updatePosition(view);
}

async function handleAddAgentClick(view: EditorView, openId: number): Promise<void> {
  if (!isCurrentMenuView(view, openId)) return;
  closeMenu(view);
  try {
    await windows.openPreferences('agents');
  } catch (err) {
    console.error('[SlashMenu] open preferences failed:', err);
  }
}

function openMenu(view: EditorView, editor: Editor, triggerFrom: number, deleteFrom: number) {
  closeMenu();

  const openId = menuOpenId;
  const availableItems = getAvailableSlashMenuItems();
  menuState = { triggerFrom, deleteFrom, query: '', cursorPos: view.state.selection.from };
  activeEditor = editor;
  activeView = view;
  menuInstance = {
    selectedIndex: 0,
    scrollSelectedItem: true,
    hasNavigated: false,
    availableItems,
    items: availableItems,
    submenu: null,
  };

  menuContainer = document.createElement('div');
  menuContainer.style.position = 'fixed';
  menuContainer.style.zIndex = '2147483647';
  menuContainer.style.width = '220px';
  menuContainer.style.maxWidth = 'calc(100vw - 16px)';
  document.body.appendChild(menuContainer);
  menuRoot = createRoot(menuContainer);

  document.addEventListener('mousedown', handlePointerDownOutside, true);
  window.addEventListener('resize', handleWindowResize);
  window.addEventListener('scroll', handleScrollOutside, true);

  // Runtime detection may finish after the menu opens. Update the idle menu,
  // then freeze its row order once the user begins navigating it.
  unsubscribeRuntimeStatus = subscribeAgentRuntimeStatus(() => {
    if (!isCurrentMenuView(view, openId) || activeEditor !== editor) return;
    if (!menuInstance || menuInstance.hasNavigated) return;
    refreshAvailableAgentItems(view);
  });
  unsubscribeUserSettings = subscribeEditorRuntimePreferences(() => {
    if (!isCurrentMenuView(view, openId) || activeEditor !== editor) return;
    if (menuInstance) menuInstance.availableItems = getAvailableSlashMenuItems();
    refreshMenuFromEditor(view, true);
  });

  renderMenu(view);
  void refreshAgentRuntimeStatusIfStale();
}

function deleteTriggerText(editor: Editor): boolean {
  if (!menuState) return false;

  const to = editor.state.selection.from;
  editor.chain().focus().deleteRange({
    from: menuState.deleteFrom,
    to,
  }).run();

  return true;
}

function memoTitleFromFilename(filename: string): string {
  const stripped = filename.replace(/\.md$/i, '').trim();
  if (stripped) return stripped;
  // 同步命名兜底走当前语言的 memo.untitled (zh-CN "未命名的笔记" / en-US "Untitled memo")。
  const language = getCurrentAppLanguage();
  return translate(language, 'memo.untitled');
}

async function createChildNoteReference(editor: Editor): Promise<void> {
  const store = useNoteStore.getState();
  const notebook = store.selectedNotebook;
  if (!notebook || !editor.schema.nodes.noteReference) return;

  deleteTriggerText(editor);
  const insertAt = editor.state.selection.from;
  closeMenu();

  try {
    const created = await store.createNote(undefined, notebook.id);
    invalidateMentionNotes();
    editor
      .chain()
      .focus()
      .setTextSelection(Math.min(insertAt, editor.state.doc.content.size))
      .insertContent({
        type: 'noteReference',
        attrs: {
          notebookId: notebook.id,
          notebookName: notebook.name,
          title: memoTitleFromFilename(created.relativePath.split('/').pop() ?? created.relativePath),
          originalPath: created.path,
          relativePath: created.relativePath,
          stale: false,
        },
      })
      .run();
  } catch (err) {
    console.error('[SlashMenu] create child note failed:', err);
  }
}

function getSlashReferencePickerContext(editor: Editor, blockRange: { from: number; to: number } | null) {
  const slashMenuRect = menuContainer?.getBoundingClientRect();
  const cursorCoords = editor.view.coordsAtPos(editor.state.selection.from);
  const anchor = {
    kind: 'slash' as const,
    rect: slashMenuRect ?? {
      left: cursorCoords.left,
      right: cursorCoords.left,
      top: cursorCoords.bottom + 6,
      bottom: cursorCoords.bottom + 6,
    },
  };
  const replaceRange = isBlockStartTrigger(editor)
    ? blockRange ?? undefined
    : prepareSlashBlockTarget(editor);
  return { anchor, replaceRange };
}

function openTableSubmenu(view: EditorView): void {
  if (!isCurrentMenuView(view) || !menuInstance || !menuState || !activeEditor) return;
  if (!activeEditor.isEditable || activeEditor.isActive('table')) {
    closeMenu(view);
    return;
  }
  menuInstance.submenu = 'table';
  menuInstance.items = getTableSlashMenuItems(menuState.query, getCurrentAppLanguage());
  menuInstance.selectedIndex = 0;
  menuInstance.scrollSelectedItem = true;
  menuInstance.hasNavigated = true;
  renderMenu(view);
}

function closeTableSubmenu(view: EditorView): void {
  if (!isCurrentMenuView(view) || !menuInstance || !menuState) return;
  menuInstance.submenu = null;
  menuInstance.items = filterItems(menuState.query, menuInstance.availableItems);
  menuInstance.selectedIndex = Math.max(menuInstance.items.findIndex(item => item.id === 'table'), 0);
  menuInstance.scrollSelectedItem = true;
  renderMenu(view);
}

function handleSelect(item: SlashMenuItem): void {
  if (!activeEditor || !menuState) return;

  const editor = activeEditor;
  const slashBlockRange = getSlashBlockRange(editor);

  if (item.id === 'table') {
    openTableSubmenu(editor.view);
    return;
  }

  if (item.id === 'create-child-note') {
    void createChildNoteReference(editor);
    return;
  }

  if (item.id === 'reference-note') {
    deleteTriggerText(editor);
    closeMenu();
    openNoteMention(editor);
    return;
  }

  const tableStyle = item.tableStyle;
  if (tableStyle) {
    if (editor.isDestroyed || !editor.isEditable || editor.isActive('table')) {
      closeMenu();
      return;
    }
    const targetRange = prepareSlashBlockTarget(editor);
    const target = targetRange ? editor.state.doc.nodeAt(targetRange.from) : null;
    // A paragraph-start slash can leave existing text after the cursor.
    const replaceRange = target?.isTextblock && target.content.size === 0 ? targetRange : undefined;
    closeMenu();
    insertTableTemplate(editor, tableStyle, { language: getCurrentAppLanguage(), replaceRange });
    return;
  }

  const preferredViewType = TABLE_VIEW_TYPE_BY_SLASH_ID[item.id];
  if (item.id === 'media-library-reference' || preferredViewType) {
    const { anchor, replaceRange } = getSlashReferencePickerContext(editor, slashBlockRange);
    closeMenu();
    if (!replaceRange) return;
    if (item.id === 'media-library-reference') {
      openMediaLibraryReferencePicker(editor, replaceRange, anchor);
    } else {
      openTableReferencePicker(editor, replaceRange, anchor, preferredViewType);
    }
    return;
  }

  if (item.id === 'math-block') {
    prepareSlashBlockTarget(editor);
    closeMenu();
    editor.chain().focus().insertMathBlock().run();
    return;
  }

  if (item.id === 'web-card') {
    prepareSlashBlockTarget(editor);
    closeMenu();
    editor.chain().focus().insertWebCard().run();
    return;
  }

  if (item.id === 'horizontal-rule') {
    const range = prepareSlashBlockTarget(editor);
    closeMenu();
    insertHorizontalRuleAtRange(editor, range);
    return;
  }

  if (isAgentThreadSlashMenuItemId(item.id)) {
    const agentThreadType = AGENT_THREAD_TYPE_BY_SLASH_ID[item.id];
    if (!getAvailableSlashAgentTypes().has(agentThreadType)) {
      const view = activeView;
      if (view && !view.isDestroyed) refreshAvailableAgentItems(view);
      else closeMenu();
      return;
    }
    const replaceRange = isBlockStartTrigger(editor)
      ? slashBlockRange ?? undefined
      : prepareSlashBlockTarget(editor);
    closeMenu();
    // 不加 .focus() ── 与 handleMouseDown 去掉 view.focus() 同源: focus 把
    // 焦点切到 ProseMirror editable, 浏览器 native selection 会接管卡片内
    // 文字并触发 .ProseMirror-selectednode outline, 形成'插入后卡片被外框
    // 框住 + 内部文本高亮'的副作用。焦点在 deleteTriggerText 里已经抢回
    // 编辑器, 这里不再 .focus() 不会丢焦点。
    editor.chain().insertAgentThreadCard({
      typeKey: agentThreadType,
      replaceRange,
    }).run();
    return;
  }

  // 块级切换 (标题 / 正文 / 引用 / 列表 / 分割线) ── 与 insertTable 同源: 先 deleteRange
  // 抹掉 "/query" 让光标停在空块首, 再 toggle/set 把当前空段落换成目标块。
  // 这样不会出现 "/引用" 这种残留字符, 也避免选中既有段落内容被误改。
  const blockToggleById: Partial<Record<SlashMenuItem['id'], () => void>> = {
    'heading-1': () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
    'heading-2': () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    'heading-3': () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
    'heading-4': () => editor.chain().focus().toggleHeading({ level: 4 }).run(),
    'paragraph': () => editor.chain().focus().setParagraph().run(),
    'blockquote': () => editor.chain().focus().toggleBlockquote().run(),
    'code-block': () => editor.chain().focus().toggleCodeBlock().run(),
    'bullet-list': () => { applyListType(editor, 'bulletList'); },
    'ordered-list': () => { applyListType(editor, 'orderedList'); },
    'task-list': () => { applyListType(editor, 'taskList'); },
  };
  const blockToggle = blockToggleById[item.id];
  if (blockToggle) {
    prepareSlashBlockTarget(editor);
    closeMenu();
    blockToggle();
    return;
  }

  const acceptById: Partial<Record<SlashMenuItem['id'], string>> = {
    image: 'image/*',
    video: 'video/*',
  };

  const replaceRange = prepareSlashBlockTarget(editor);
  closeMenu();

  editor.commands.openFileDialog({
    accept: acceptById[item.id],
    multiple: true,
    replaceRange,
  });
}

function refreshMenuFromEditor(view: EditorView, force = false) {
  if (!isCurrentMenuView(view)) return;
  const state = menuState;
  const instance = menuInstance;
  if (!state || !instance) return;

  const query = getQuery(view, state.triggerFrom);
  if (query === null) {
    closeMenu(view);
    return;
  }

  if (!force && query === state.query) {
    // The slash character is inserted after openMenu renders. Its first
    // editor update keeps the query empty but moves the cursor anchor.
    if (state.cursorPos !== view.state.selection.from) {
      state.cursorPos = view.state.selection.from;
      updatePosition(view);
    }
    return;
  }

  state.query = query;
  state.cursorPos = view.state.selection.from;
  instance.items = instance.submenu
    ? getTableSlashMenuItems(query, getCurrentAppLanguage())
    : filterItems(query, instance.availableItems);
  instance.selectedIndex = Math.min(
    instance.selectedIndex,
    Math.max(instance.items.length - 1, 0)
  );
  instance.scrollSelectedItem = true;
  renderMenu(view);
}

function refreshAvailableAgentItems(view: EditorView) {
  if (!isCurrentMenuView(view) || !menuInstance) return;
  menuInstance.availableItems = getAvailableSlashMenuItems();
  menuInstance.selectedIndex = 0;
  menuInstance.hasNavigated = false;
  refreshMenuFromEditor(view, true);
}

export const SlashMenu = Extension.create({
  name: 'slashMenu',
  // An open menu owns navigation/confirmation ahead of paragraph, list, and
  // Tab handlers. Gap input normalization (1200) still runs before it.
  priority: 1150,

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin({
        key: slashMenuPluginKey,

        view(view) {
          const handleBlur = (event: FocusEvent) => {
            const nextTarget = event.relatedTarget;
            if (nextTarget instanceof Node && menuContainer?.contains(nextTarget)) return;
            closeMenu(view);
          };
          view.dom.addEventListener('blur', handleBlur);

          return {
            update(updatedView) {
              if (updatedView !== view || !menuState) return;
              refreshMenuFromEditor(updatedView);
            },
            destroy() {
              if (!view.isDestroyed) view.dom.removeEventListener('blur', handleBlur);
              closeMenu(view);
            },
          };
        },

        props: {
          handleTextInput(view, from, _to, text) {
            if (text !== '/') return false;

            const deleteFrom = getSlashTriggerDeleteFrom(view, from);
            if (!editor.isEditable || deleteFrom === null) {
              closeMenu(view);
              return false;
            }

            openMenu(view, editor, from, deleteFrom);
            return false;
          },

          handleKeyDown(view, event) {
            if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return false;
            if (!isCurrentMenuView(view) || !menuState || !menuInstance) return false;

            if (event.key === 'ArrowUp') {
              event.preventDefault();
              menuInstance.hasNavigated = true;
              menuInstance.selectedIndex = menuInstance.selectedIndex > 0
                ? menuInstance.selectedIndex - 1
                : Math.max(menuInstance.items.length - 1, 0);
              menuInstance.scrollSelectedItem = true;
              renderMenu(view, false);
              return true;
            }

            if (event.key === 'ArrowDown') {
              event.preventDefault();
              menuInstance.hasNavigated = true;
              menuInstance.selectedIndex = menuInstance.selectedIndex < menuInstance.items.length - 1
                ? menuInstance.selectedIndex + 1
                : 0;
              menuInstance.scrollSelectedItem = true;
              renderMenu(view, false);
              return true;
            }

            if (event.key === 'Escape') {
              event.preventDefault();
              if (menuInstance.submenu) closeTableSubmenu(view);
              else closeMenu(view);
              return true;
            }

            if (event.key === 'ArrowLeft' && menuInstance.submenu) {
              event.preventDefault();
              closeTableSubmenu(view);
              return true;
            }

            if (event.key === 'ArrowRight' && (menuInstance.submenu || menuInstance.items[menuInstance.selectedIndex]?.id === 'table')) {
              event.preventDefault();
              if (!menuInstance.submenu) openTableSubmenu(view);
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
              menuInstance.hasNavigated = true;
              const direction = event.shiftKey ? -1 : 1;
              const count = menuInstance.items.length;
              if (count > 0) {
                menuInstance.selectedIndex = (menuInstance.selectedIndex + direction + count) % count;
                menuInstance.scrollSelectedItem = true;
                renderMenu(view, false);
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
