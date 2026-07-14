import { defineAction } from '@features/shortcuts/registry';
import { invokeHandler } from '@features/shortcuts/handler-registry';
import { windows } from '@platform/tauri/client';
import { useSettingsStore } from '@features/shell/store/settings-store';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import { navigateDocumentHistory } from '@/lib/document-navigation';
import { resolveSystemTheme, type ResolvedThemeId, type ThemeId } from '@features/theme';

/**
 * 集中声明所有 action 的地方。
 *
 * 设计原则:
 *  - `run` 应该是纯事件分发 (dispatch CustomEvent / 调 handler-registry),
 *    不持有 React state, 这样 actions.ts 不依赖 React 上下文, 便于单测。
 *  - 实例相关的逻辑 (哪个编辑器、哪个弹窗) 通过 handler-registry 间接引用,
 *    组件 mount 时 push, unmount 时 pop。
 *  - 业务方应当 *优先* 在这里集中声明, 避免散落在各组件的 useEffect 注册
 *    (那样无法静态追溯 action 列表, 命令面板也读不到)。
 *
 * `group` 字段是稳定的英文 id (与 i18n key 后缀一致), 供排序 / 查找使用;
 * 人类可读的展示文案走 `preferences.shortcuts.group.*` i18n key (见
 * shortcut-i18n.ts 的 GROUP_KEY_BY_ID)。
 *
 * 当前 action 清单 (按 group 排序):
 *
 *   editor
 *     editor.find              ⌘F          window  — 打开 / 关闭编辑器搜索替换面板
 *     editor.undo              ⌘Z          editor  — 撤销
 *     editor.redo              ⌘⇧Z         editor  — 重做
 *     editor.setHeading1       ⌘1          editor  — 块元素 → H1
 *     editor.setHeading2       ⌘2          editor  — 块元素 → H2
 *     editor.setHeading3       ⌘3          editor  — 块元素 → H3
 *     editor.setHeading4       ⌘4          editor  — 块元素 → H4
 *     editor.setParagraph      ⌘0          editor  — 块元素 → 正文
 *     editor.toggleBulletList   ⌘⌥8         editor  — 块元素 → 无序列表
 *     editor.toggleOrderedList  ⌘⌥7         editor  — 块元素 → 有序列表
 *     editor.toggleTaskList     ⌘⌥9         editor  — 块元素 → 待办列表
 *
 *   navigation
 *     palette.search  ⌘K          no-input — 打开/关闭命令面板 (toggle)
 *     menu.open       ⌘P / Ctrl+P window — 打开偏好设置窗口
 *
 *   memo
 *     memo.create            ⌘N          no-input — 新建 Memo
 *     notebook.create        ⌘⌥N         no-input — 新建笔记本
 *     notebook.switcher.toggle ⌘⇧N       no-input — 打开/关闭笔记本下拉面板 (toggle)
 *
 *   view
 *     theme.toggle         ⌘⌥T         window   — 循环切换主题 (编辑器内也生效)
 *     panel.memoList.toggle ⌘L / Ctrl+L window — 显示/隐藏 memo 列表 (左栏)
 *
 *   system
 *     dialog.cancel   Esc         dialog   — 关闭弹窗
 *     dialog.confirm  Enter       dialog   — 确认弹窗
 */

// ── 模块常量 ──────────────────────────────────────────────

/** theme.toggle 的循环顺序 — 与 lib/theme/options.ts 的 THEME_OPTIONS 同序。 */
const THEME_CYCLE: readonly ThemeId[] = ['system', 'light', 'dark', 'rock', 'mist', 'ember'];

function resolveThemeId(theme: ThemeId, prefersDark: boolean): ResolvedThemeId {
  return theme === 'system' ? resolveSystemTheme(prefersDark) : theme;
}

function nextVisibleTheme(current: ThemeId, prefersDark: boolean): ThemeId {
  const currentResolved = resolveThemeId(current, prefersDark);
  const startIndex = THEME_CYCLE.indexOf(current);
  const start = startIndex < 0 ? 0 : startIndex;

  for (let offset = 1; offset <= THEME_CYCLE.length; offset += 1) {
    const candidate = THEME_CYCLE[(start + offset) % THEME_CYCLE.length];
    if (resolveThemeId(candidate, prefersDark) !== currentResolved) {
      return candidate;
    }
  }

  return current;
}

// ── 编辑 ─────────────────────────────────────────────────

/**
 * Tiptap 编辑器 — 打开搜索替换面板。
 *
 * scope: 'window' — 与原 markdown-editor.tsx:307-313 行为一致, 任何地方
 * 按 ⌘F 都能打开面板 (无编辑器挂载时, run 返回 false, 落到浏览器默认)。
 *
 * handler 由 MarkdownEditor 组件 mount 时 push, 内部读 onSearchPanelOpenChangeRef。
 */
defineAction({
  id: 'editor.find',
  titleKey: 'preferences.shortcuts.action.editor.find.title',
  descriptionKey: 'preferences.shortcuts.action.editor.find.description',
  group: 'editor',
  scope: 'window',
  defaultBinding: {
    mac: 'Mod+F',
    windows: 'Mod+F',
    linux: 'Mod+F',
  },
  run: () => {
    invokeHandler('editor.find');
    return true;
  },
});

/**
 * Tiptap 编辑器 — 撤销 (undo)。
 *
 * scope: 'editor' — 仅当编辑器获得焦点时生效, 与 useShortcutScope('editor')
 * 配合; 弹窗/列表里按 ⌘Z 不会触发此 action, 走浏览器默认 (或 no-op)。
 */
defineAction({
  id: 'editor.undo',
  titleKey: 'preferences.shortcuts.action.editor.undo.title',
  descriptionKey: 'preferences.shortcuts.action.editor.undo.description',
  group: 'editor',
  scope: 'editor',
  defaultBinding: {
    mac: 'Mod+Z',
    windows: 'Mod+Z',
    linux: 'Mod+Z',
  },
  run: () => invokeHandler('editor.undo'),
});

/**
 * Tiptap 编辑器 — 重做 (redo)。
 *
 * Mac / Windows 主流约定都是 ⌘⇧Z (主键), ⌘Y 作为 Windows 习惯 (Word, IDE) 兜底。
 * 当前实现只绑 ⌘⇧Z, 用户在偏好里可自行加 ⌘Y 重绑。
 */
defineAction({
  id: 'editor.redo',
  titleKey: 'preferences.shortcuts.action.editor.redo.title',
  descriptionKey: 'preferences.shortcuts.action.editor.redo.description',
  group: 'editor',
  scope: 'editor',
  defaultBinding: {
    mac: 'Mod+Shift+Z',
    windows: 'Mod+Shift+Z',
    linux: 'Mod+Shift+Z',
  },
  run: () => invokeHandler('editor.redo'),
});

/**
 * 编辑器内块元素切换 — 8 个 action, 快捷键与 drag-context-menu 菜单项一致。
 *
 * scope: 'editor' — 与 editor.undo/redo 同款, 仅当编辑器获得焦点 (markdown-editor
 * 调 useShortcutScope('editor')) 时生效。 handler 通过 pushHandler 间接引用
 * 当前 mounted 的 editor 实例 (在 markdown-editor.tsx 里 push), 卸载时 pop。
 *
 * 全部走 `editor.chain().focus().toggleXxx()` — focus 保证即便焦点飘到
 * 标题输入框等也能切回编辑器应用命令。toggle 语义: 已是目标类型则还原成 paragraph,
 * 不是则切换。 与拖拽菜单 `applyMenuItem` 走的是同一组 Tiptap 命令。
 */

// ── 标题 1-4 ──
defineAction({
  id: 'editor.setHeading1',
  titleKey: 'preferences.shortcuts.action.editor.setHeading1.title',
  descriptionKey: 'preferences.shortcuts.action.editor.setHeading1.description',
  group: 'editor',
  scope: 'editor',
  defaultBinding: { mac: 'Mod+1', windows: 'Mod+1', linux: 'Mod+1' },
  run: () => invokeHandler('editor.setHeading1'),
});

defineAction({
  id: 'editor.setHeading2',
  titleKey: 'preferences.shortcuts.action.editor.setHeading2.title',
  descriptionKey: 'preferences.shortcuts.action.editor.setHeading2.description',
  group: 'editor',
  scope: 'editor',
  defaultBinding: { mac: 'Mod+2', windows: 'Mod+2', linux: 'Mod+2' },
  run: () => invokeHandler('editor.setHeading2'),
});

defineAction({
  id: 'editor.setHeading3',
  titleKey: 'preferences.shortcuts.action.editor.setHeading3.title',
  descriptionKey: 'preferences.shortcuts.action.editor.setHeading3.description',
  group: 'editor',
  scope: 'editor',
  defaultBinding: { mac: 'Mod+3', windows: 'Mod+3', linux: 'Mod+3' },
  run: () => invokeHandler('editor.setHeading3'),
});

defineAction({
  id: 'editor.setHeading4',
  titleKey: 'preferences.shortcuts.action.editor.setHeading4.title',
  descriptionKey: 'preferences.shortcuts.action.editor.setHeading4.description',
  group: 'editor',
  scope: 'editor',
  defaultBinding: { mac: 'Mod+4', windows: 'Mod+4', linux: 'Mod+4' },
  run: () => invokeHandler('editor.setHeading4'),
});

/** 块元素 → 正文 (paragraph)。 命名沿用 Tiptap `setParagraph` 命令。 */
defineAction({
  id: 'editor.setParagraph',
  titleKey: 'preferences.shortcuts.action.editor.setParagraph.title',
  descriptionKey: 'preferences.shortcuts.action.editor.setParagraph.description',
  group: 'editor',
  scope: 'editor',
  defaultBinding: { mac: 'Mod+0', windows: 'Mod+0', linux: 'Mod+0' },
  run: () => invokeHandler('editor.setParagraph'),
});

/**
 * 块元素 → 各类列表 — 与 drag-context-menu 的 listMenuItems 同序。
 *
 * 用 `Mod+Alt+7/8/9` 而非 Notion/Obsidian/Tiptap 默认的 `Mod+Shift+7/8/9`,
 * 后者会**双 toggle 互相抵消**: Tiptap StarterKit 的 bullet-list / ordered-list
 * / task-list 扩展内置了 Mod-Shift-7/8/9 的 keymap, 跑在 contenteditable
 * 目标阶段; 我的 ShortcutsProvider 跑在 window bubble 阶段, 晚于 Tiptap。
 * 同一按键被两处各 toggle 一次, 净结果 0, 看上去"没生效"。
 *
 * `Mod+Alt+7/8/9` 不在 Tiptap 内置 keymap 里 (它只用 Mod+Shift), 也少有
 * 主流 app 占这个 chord, Mac/Win/Linux 几乎零冲突。 数字 7/8/9 与之前的
 * 设定一致, 用户只需把"按 Shift"换成"按 Alt", 肌肉记忆保留。
 */
defineAction({
  id: 'editor.toggleBulletList',
  titleKey: 'preferences.shortcuts.action.editor.toggleBulletList.title',
  descriptionKey: 'preferences.shortcuts.action.editor.toggleBulletList.description',
  group: 'editor',
  scope: 'editor',
  defaultBinding: { mac: 'Mod+Alt+8', windows: 'Mod+Alt+8', linux: 'Mod+Alt+8' },
  run: () => invokeHandler('editor.toggleBulletList'),
});

defineAction({
  id: 'editor.toggleOrderedList',
  titleKey: 'preferences.shortcuts.action.editor.toggleOrderedList.title',
  descriptionKey: 'preferences.shortcuts.action.editor.toggleOrderedList.description',
  group: 'editor',
  scope: 'editor',
  defaultBinding: { mac: 'Mod+Alt+7', windows: 'Mod+Alt+7', linux: 'Mod+Alt+7' },
  run: () => invokeHandler('editor.toggleOrderedList'),
});

defineAction({
  id: 'editor.toggleTaskList',
  titleKey: 'preferences.shortcuts.action.editor.toggleTaskList.title',
  descriptionKey: 'preferences.shortcuts.action.editor.toggleTaskList.description',
  group: 'editor',
  scope: 'editor',
  defaultBinding: { mac: 'Mod+Alt+9', windows: 'Mod+Alt+9', linux: 'Mod+Alt+9' },
  run: () => invokeHandler('editor.toggleTaskList'),
});

// ── 导航 ─────────────────────────────────────────────────

/**
 * 打开/关闭全局搜索 / 命令面板 (GlobalSearchCommand) — toggle 语义。
 *
 * 实现: dispatch `flowix:toggle-palette` 事件, memo-list.tsx 监听后
 * `setSearchCommandOpen(prev => !prev)`。沿用仓库里 `flowix:open-create-notebook` /
 * `flowix:request-delete-memo` 的 CustomEvent 解耦模式 — 命令面板的
 * 状态留在 memo-list 内部, 任何位置都能触发。
 *
 * scope: 'window' — 应用级命令, 编辑器或输入框聚焦时也可触发。
 */
defineAction({
  id: 'palette.search',
  titleKey: 'preferences.shortcuts.action.palette.search.title',
  descriptionKey: 'preferences.shortcuts.action.palette.search.description',
  group: 'navigation',
  scope: 'window',
  defaultBinding: {
    mac: 'Mod+K',
    windows: 'Mod+K',
    linux: 'Mod+K',
  },
  run: () => {
    window.dispatchEvent(new CustomEvent('flowix:toggle-palette'));
  },
});

/**
 * 打开偏好设置。
 *
 * Mac / Windows 通用约定: ⇧⌘, / Ctrl+Shift+, 即 "Preferences / 设置"。当前选择
 * 打开独立的 Tauri 偏好窗口 (`windows.openPreferences`), 不复用 in-window
 * MenuBoard — MenuBoard 现有调用链为零, 偏好窗口已经承担所有 settings tab
 * (见 windows/preferences/sections/), 跨窗口体验更一致。
 */
defineAction({
  id: 'menu.open',
  titleKey: 'preferences.shortcuts.action.menu.open.title',
  descriptionKey: 'preferences.shortcuts.action.menu.open.description',
  group: 'navigation',
  scope: 'window',
  defaultBinding: {
    mac: 'Mod+P',
    windows: 'Mod+P',
    linux: 'Mod+P',
  },
  run: () => {
    void windows.openPreferences();
  },
});

// ── Memo ──────────────────────────────────────────────────

/**
 * 新建 Memo。
 *
 * 实现: dispatch `flowix:create-memo` 事件, memo-list.tsx 监听后调用
 * `handleCreateMemo` (含 `selectedNotebook` 守卫, 无当前 notebook 时静默
 * no-op, 不弹错)。这样:
 *  - 复用 memo-list 已有逻辑, 不复制代码
 *  - 按钮和快捷键走同一条路径
 *  - 命令面板接 listActions() 后也能直接调 run
 */
defineAction({
  id: 'memo.create',
  titleKey: 'preferences.shortcuts.action.memo.create.title',
  descriptionKey: 'preferences.shortcuts.action.memo.create.description',
  group: 'memo',
  scope: 'window',
  defaultBinding: {
    mac: 'Mod+N',
    windows: 'Mod+N',
    linux: 'Mod+N',
  },
  run: () => {
    window.dispatchEvent(new CustomEvent('flowix:create-memo'));
  },
});

/**
 * 新建笔记本。
 *
 * 实现: dispatch `flowix:open-create-notebook` 事件, memo-list.tsx 监听后打开
 * 已有的新建笔记本弹窗。和状态栏下拉里的"新建笔记本"按钮走同一条路径。
 */
defineAction({
  id: 'notebook.create',
  titleKey: 'preferences.shortcuts.action.notebook.create.title',
  descriptionKey: 'preferences.shortcuts.action.notebook.create.description',
  group: 'memo',
  scope: 'window',
  defaultBinding: {
    mac: 'Mod+Alt+N',
    windows: 'Mod+Alt+N',
    linux: 'Mod+Alt+N',
  },
  run: () => {
    window.dispatchEvent(new CustomEvent('flowix:open-create-notebook'));
  },
});

/**
 * 切换笔记本下拉面板 (StatusBar 里的 NotebookSwitcher) — toggle 语义。
 *
 * 实现: dispatch `flowix:toggle-notebook-switcher` 事件, main-layout.tsx
 * 监听后 `setNotebookPopupOpen(prev => !prev)`。沿用 `palette.search` →
 * `flowix:toggle-palette` 的同款 CustomEvent 解耦模式 — 弹层 state 留在
 * main-layout 内部, 任何位置都能触发, actions.ts 不依赖 React。
 *
 * scope: 'window' — 应用级命令, 编辑器或输入框聚焦时也可触发。
 */
defineAction({
  id: 'notebook.switcher.toggle',
  titleKey: 'preferences.shortcuts.action.notebook.switcher.toggle.title',
  descriptionKey: 'preferences.shortcuts.action.notebook.switcher.toggle.description',
  group: 'memo',
  scope: 'window',
  defaultBinding: {
    mac: 'Mod+Shift+N',
    windows: 'Mod+Shift+N',
    linux: 'Mod+Shift+N',
  },
  run: () => {
    window.dispatchEvent(new CustomEvent('flowix:toggle-notebook-switcher'));
  },
});

// ── 视图 ──────────────────────────────────────────────────

/**
 * 循环切换主题: system → light → dark → rock → mist → ember → system。
 *
 * scope: 'window' — 任意位置都生效, 包括 Tiptap 编辑器内部。 这是"切主题"
 * 操作的天然诉求: 用户在编辑 memo 时也想切。`⌘⌥T` / `Ctrl+Alt+T` 是双修饰
 * 组合, 在 input / contenteditable 里误触概率极低, 优先级 > 防误触。
 *
 * 直接调 `useUserSettingsStore.getState()` — zustand store 的 getState() 是
 * 非 React 上下文 API, 适合在 action.run 这种"非组件"位置调用。
 * 写入走 store 自带的 200ms debounce 落盘, 不需要这里 await。
 */
defineAction({
  id: 'history.back',
  titleKey: 'preferences.shortcuts.action.history.back.title',
  descriptionKey: 'preferences.shortcuts.action.history.back.description',
  group: 'navigation',
  scope: 'window',
  defaultBinding: {
    mac: 'Alt+ArrowLeft',
    windows: 'Alt+ArrowLeft',
    linux: 'Alt+ArrowLeft',
  },
  run: () => {
    void navigateDocumentHistory('back');
  },
});

defineAction({
  id: 'history.forward',
  titleKey: 'preferences.shortcuts.action.history.forward.title',
  descriptionKey: 'preferences.shortcuts.action.history.forward.description',
  group: 'navigation',
  scope: 'window',
  defaultBinding: {
    mac: 'Alt+ArrowRight',
    windows: 'Alt+ArrowRight',
    linux: 'Alt+ArrowRight',
  },
  run: () => {
    void navigateDocumentHistory('forward');
  },
});

defineAction({
  id: 'theme.toggle',
  titleKey: 'preferences.shortcuts.action.theme.toggle.title',
  descriptionKey: 'preferences.shortcuts.action.theme.toggle.description',
  group: 'view',
  scope: 'window',
  defaultBinding: {
    mac: 'Mod+Alt+T',
    windows: 'Mod+Alt+T',
    linux: 'Mod+Alt+T',
  },
  run: () => {
    const state = useUserSettingsStore.getState();
    const current = state.settings.theme;
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const next = nextVisibleTheme(current, prefersDark);
    void state.updateSettings({ theme: next });
  },
});

/**
 * 切换 memo 列表 (左栏) 的显示与隐藏。
 *
 * scope: 'window' — 应用级视图切换, 编辑器或输入框聚焦时也可触发。
 *
 * 实现: 调 useSettingsStore.toggleMemoListVisible()。 状态在 lib/store/settings-store.ts,
 * zustand persist 到 localStorage (key: 'flowix-settings') — 关闭重开仍记住选择。
 * `main-layout.tsx:600, 619` 观察这个字段并控制左栏挂载/卸载。
 */
defineAction({
  id: 'panel.memoList.toggle',
  titleKey: 'preferences.shortcuts.action.panel.memoList.toggle.title',
  descriptionKey: 'preferences.shortcuts.action.panel.memoList.toggle.description',
  group: 'view',
  scope: 'window',
  defaultBinding: {
    mac: 'Mod+L',
    windows: 'Mod+L',
    linux: 'Mod+L',
  },
  run: () => {
    useSettingsStore.getState().toggleMemoListVisible();
  },
});

// ── 系统 (弹窗) ──────────────────────────────────────────

/**
 * 模态弹窗 — 取消 (Escape)。
 *
 * scope: 'dialog' — 仅当有模态弹窗处于打开状态时 (useShortcutScope('dialog')
 * 在弹窗 mount 时 push) 才生效。多个弹窗嵌套时, 栈顶弹窗的 cancel handler
 * 优先 (pushHandler 是 LIFO 栈)。
 */
defineAction({
  id: 'dialog.cancel',
  titleKey: 'preferences.shortcuts.action.dialog.cancel.title',
  descriptionKey: 'preferences.shortcuts.action.dialog.cancel.description',
  group: 'system',
  scope: 'dialog',
  defaultBinding: {
    mac: 'Escape',
    windows: 'Escape',
    linux: 'Escape',
  },
  run: () => invokeHandler('dialog.cancel'),
});

/**
 * 模态弹窗 — 确认 (Enter)。
 *
 * 与 dialog.cancel 同 scope; 注意 Enter 单独可成 chord (parser 的 STANDALONE_KEYS
 * 包含 'enter')。handler 内部要自己防御: 焦点在 input/textarea/contenteditable
 * 时不应触发 (避免吃掉用户的换行/提交)。
 */
defineAction({
  id: 'dialog.confirm',
  titleKey: 'preferences.shortcuts.action.dialog.confirm.title',
  descriptionKey: 'preferences.shortcuts.action.dialog.confirm.description',
  group: 'system',
  scope: 'dialog',
  defaultBinding: {
    mac: 'Enter',
    windows: 'Enter',
    linux: 'Enter',
  },
  run: () => invokeHandler('dialog.confirm'),
});
