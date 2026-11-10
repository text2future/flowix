'use client';

import { posToDOMRect, type Editor } from '@tiptap/core';
import {
  CaretDownIcon,
  CheckSquareIcon,
  CodeIcon,
  ListBulletsIcon,
  ListNumbersIcon,
  QuotesIcon,
  TextBIcon,
  TextHOneIcon,
  TextHTwoIcon,
  TextHThreeIcon,
  TextHFourIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  TextTIcon,
  TextUnderlineIcon,
} from '@phosphor-icons/react';
import { Code, Link } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { openLinkInlineEditor } from '@features/editor/components/link-inline-editor';
import { editorLinkInputValue } from '@features/editor/editor-link-resolution';
import { FlowixHighlightPalette } from '@features/editor/components/flowix-highlight-palette';
import {
  createSelectionBubbleReference,
  textRangeRect,
  EMPTY_SELECTION_BUBBLE_MENU_SNAPSHOT,
  getSelectionBubbleMenuSnapshot,
  hasFormattableTextSelection,
  sameSelectionBubbleMenuSnapshot,
  setSelectionBubbleMenuVisible,
  type BubbleHeadingLevel,
  type SelectionBubbleMenuSnapshot,
} from '@features/editor/components/selection-bubble-menu-state';
import { computeOverlayFrame } from '@features/editor/overlay/compute-overlay-frame';
import { useEditorOverlayAnchor } from '@features/editor/overlay/use-editor-overlay-anchor';
import { applyListType } from '@features/editor/extensions/list-transforms';
import type { ListTypeName } from '@features/editor/extensions/list-structure';
import { flowixHighlightBackground } from '@features/editor/extensions/flowix-text-colors';
import { Kbd } from '@shared/ui/shortcut-kbd';
import { useI18n } from '@/lib/i18n';
import { Tooltip } from '@shared/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';

interface SelectionBubbleMenuProps {
  editor: Editor;
}

interface FormatButtonProps {
  active: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onRun: () => void;
  /** 需要单独覆盖按压/图标样式时挂的 class (如链接按钮)。 */
  buttonClassName?: string;
}

function FormatButton({
  active,
  disabled = false,
  icon,
  label,
  onRun,
  buttonClassName,
}: FormatButtonProps) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        className={`selection-bubble-button${active ? ' is-active' : ''}${buttonClassName ? ` ${buttonClassName}` : ''}`}
        disabled={disabled}
        aria-label={label}
        aria-pressed={active}
        onMouseDown={(event) => {
          event.preventDefault();
          if (!disabled) onRun();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {icon}
      </button>
    </Tooltip>
  );
}

interface BubbleDropdownItem {
  key: string;
  icon?: ReactNode;
  text?: string;
  active?: boolean;
  /** 右侧快捷键提示 (字面 chord, 参照 drag-context-menu 的 items)。 */
  shortcut?: string;
  onRun?: () => void;
  /** 渲染为分隔线, 其余字段忽略。 */
  divider?: boolean;
}

interface BubbleDropdownProps {
  label: string;
  triggerIcon: ReactNode;
  /** 触发按钮上回显的当前块类型名称 (正文 / 标题 1 / 无序列表 ...)。 */
  triggerLabel: string;
  items: BubbleDropdownItem[];
}

/**
 * bubble 内的块类型下拉: 触发按钮常驻回显当前块状态 (标题/列表/引文/代码块
 * 互斥, 图标 + 名称), 点开弹出选项列表。与高亮面板同一 Popover 通道, mousedown
 * preventDefault 保住编辑器选区。
 *
 * 触发按钮刻意不标 is-active: 非正文块 (H1-H4 / 列表 / 代码块 / 引文) 的状态
 * 已由名称回显, 再叠品牌色底 + 品牌色文字会和 B/I/U 的开关型激活态混淆。
 */
function BubbleDropdown({ label, triggerIcon, triggerLabel, items }: BubbleDropdownProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="selection-bubble-button selection-bubble-dropdown-trigger"
          aria-label={`${label}: ${triggerLabel}`}
          aria-expanded={open}
          onMouseDown={(event) => event.preventDefault()}
        >
          {triggerIcon}
          <span className="selection-bubble-dropdown-trigger-label">{triggerLabel}</span>
          <CaretDownIcon size={10} weight="bold" aria-hidden="true" className="opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={4}
        className="editor-bubble-dropdown w-[200px] rounded-xl shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.12)]"
        aria-label={label}
      >
        <div role="menu">
          {items.map((item) =>
            item.divider ? (
              <span
                key={item.key}
                role="separator"
                className="selection-bubble-dropdown-divider"
              />
            ) : (
              <button
                key={item.key}
                type="button"
                role="menuitemradio"
                aria-checked={item.active}
                className={`selection-bubble-dropdown-item${item.active ? ' is-active' : ''}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen(false);
                  item.onRun?.();
                }}
              >
                {item.icon}
                {item.text && <span className="selection-bubble-dropdown-text">{item.text}</span>}
                {item.shortcut && (
                  <Kbd
                    chord={item.shortcut}
                    className="selection-bubble-dropdown-kbd"
                  />
                )}
              </button>
            ),
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// bubble 内所有 item 的图标统一 16px bold —— 工具条按钮、「转换为」下拉触发按钮、
// 下拉菜单项一致; 与 drag 菜单下拉项 (items.tsx ICON_PROPS) 对齐。
const bubbleIconSize = 16;
const bubbleDropdownIconSize = bubbleIconSize;
// lucide Link 的链环在 16px 下比同排图标显大, 单独收到 15×15 做视觉对齐。
const bubbleLinkIconSize = 15;
// 首帧测量前的估算尺寸; 真值由 layout effect 里的实测校正 (宽度含触发按钮上的块类型名称)。
const BUBBLE_FALLBACK_SIZE = { width: 320, height: 34 };

function dropdownHeadingIcon(level: BubbleHeadingLevel): ReactNode {
  if (level === 1) return <TextHOneIcon size={bubbleDropdownIconSize} weight="bold" aria-hidden="true" />;
  if (level === 2) return <TextHTwoIcon size={bubbleDropdownIconSize} weight="bold" aria-hidden="true" />;
  if (level === 3) return <TextHThreeIcon size={bubbleDropdownIconSize} weight="bold" aria-hidden="true" />;
  return <TextHFourIcon size={bubbleDropdownIconSize} weight="bold" aria-hidden="true" />;
}

function headingIcon(level: BubbleHeadingLevel): ReactNode {
  if (level === 1) return <TextHOneIcon size={bubbleIconSize} weight="bold" aria-hidden="true" />;
  if (level === 2) return <TextHTwoIcon size={bubbleIconSize} weight="bold" aria-hidden="true" />;
  if (level === 3) return <TextHThreeIcon size={bubbleIconSize} weight="bold" aria-hidden="true" />;
  return <TextHFourIcon size={bubbleIconSize} weight="bold" aria-hidden="true" />;
}

/** 标题 1-4 的名称键, 与下拉项用的是同一批文案。 */
const BLOCK_HEADING_LABEL_KEYS = {
  1: 'editor.bubble.heading1',
  2: 'editor.bubble.heading2',
  3: 'editor.bubble.heading3',
  4: 'editor.bubble.heading4',
} as const;

interface BlockTriggerContent {
  icon: ReactNode;
  label: string;
}

/**
 * 块类型互斥 (段落/标题/三种列表/引文/代码块), 触发按钮回显当前块的图标与
 * 名称。图标和名称由同一次判断产出, 不会出现「图标是列表、文字是正文」的错配。
 */
function blockTriggerContent(
  snapshot: SelectionBubbleMenuSnapshot,
  t: ReturnType<typeof useI18n>['t'],
): BlockTriggerContent {
  if (snapshot.heading) {
    return {
      icon: headingIcon(snapshot.heading),
      label: t(BLOCK_HEADING_LABEL_KEYS[snapshot.heading]),
    };
  }
  if (snapshot.bulletList) return { icon: <ListBulletsIcon size={bubbleIconSize} weight="bold" aria-hidden="true" />, label: t('editor.block.bulletList') };
  if (snapshot.orderedList) return { icon: <ListNumbersIcon size={bubbleIconSize} weight="bold" aria-hidden="true" />, label: t('editor.block.orderedList') };
  if (snapshot.taskList) return { icon: <CheckSquareIcon size={bubbleIconSize} weight="bold" aria-hidden="true" />, label: t('editor.block.taskList') };
  if (snapshot.blockquote) return { icon: <QuotesIcon size={bubbleIconSize} weight="bold" aria-hidden="true" />, label: t('editor.slash.label.quote') };
  if (snapshot.codeBlock) return { icon: <CodeIcon size={bubbleIconSize} weight="bold" aria-hidden="true" />, label: t('editor.slash.label.codeBlock') };
  return { icon: <TextTIcon size={bubbleIconSize} weight="bold" aria-hidden="true" />, label: t('editor.toolbar.paragraph') };
}

/**
 * 选区气泡工具条。
 *
 * 元素由这个组件自己持有: portal 到 `document.body`, 用 `position: fixed` +
 * 视口坐标定位 (见 useEditorOverlayAnchor / computeOverlayFrame) —— 与
 * TableBubbleMenu 同一套锚点机制。固定宽度: 面板/窗口再窄也不压缩内容, 放不下就
 * 溢出到面板外, 不让右侧按钮被 overflow: hidden 裁掉。
 *
 * 不要改回 @tiptap/react 的 BubbleMenu —— 它把元素 append 到 document.body 并用
 * position: fixed, 而 Flowix 的滚动发生在内层 .editor-content, tiptap 默认只监听
 * window; 于是菜单既不跟随滚动, 又在「滚动时卸载组件」的旧逻辑下被 React 清空
 * 子节点却留在 body 里, 变成一个 14×8 的空胶囊脏区。
 */
export function SelectionBubbleMenu({ editor }: SelectionBubbleMenuProps) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState(() => getSelectionBubbleMenuSnapshot(editor));
  const [highlightPaletteOpen, setHighlightPaletteOpen] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  // 焦点判定自己做: 高亮/块类型 Popover 弹层挂在 body, 打开时编辑器会 blur,
  // 但菜单必须留着 (否则弹层被连带卸载)。
  const focusedRef = useRef(false);
  const suppressNextBlurRef = useRef(false);

  useEffect(() => {
    const update = () => {
      // 常驻挂载后的热路径: 没有可格式化选区时菜单不可见, 无需重算二十来项
      // 回显状态, 直接落到静态快照。
      if (!hasFormattableTextSelection(editor)) {
        setSnapshot((previous) => (
          previous.hasSelection ? EMPTY_SELECTION_BUBBLE_MENU_SNAPSHOT : previous
        ));
        setHighlightPaletteOpen(false);
        return;
      }
      const next = getSelectionBubbleMenuSnapshot(editor);
      setSnapshot((previous) => sameSelectionBubbleMenuSnapshot(previous, next) ? previous : next);
    };
    update();
    editor.on('transaction', update);
    return () => {
      editor.off('transaction', update);
    };
  }, [editor]);

  const compute = useCallback((root: HTMLElement) => {
    if (!focusedRef.current) return null;
    if (!hasFormattableTextSelection(editor)) return null;

    const { from, to } = editor.state.selection;
    // 优先用 DOM Range 的真实包围盒: posToDOMRect 只拼「起点光标→终点光标」,
    // 多行选中时宽度可能只有几十 px, 居中点会贴到选区左边缘。
    const reference = createSelectionBubbleReference(editor);
    const anchor = reference
      ? reference.getBoundingClientRect()
      : posToDOMRect(editor.view, from, to);
    const panel = panelRef.current;
    return computeOverlayFrame({
      anchor,
      root: root.getBoundingClientRect(),
      menu: {
        width: panel?.offsetWidth || BUBBLE_FALLBACK_SIZE.width,
        height: panel?.offsetHeight || BUBBLE_FALLBACK_SIZE.height,
      },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
  }, [editor]);

  const { root, frame, requestUpdate } = useEditorOverlayAnchor(editor, compute);

  useEffect(() => {
    focusedRef.current = editor.view.hasFocus();
    const handleFocus = () => {
      focusedRef.current = true;
      requestUpdate(true);
    };
    const handleBlur = () => {
      // 与 tiptap 的 preventHide 等价: 在菜单上按下鼠标会引发 blur,
      // 但那是「把焦点交给菜单/弹层」, 不是真的离开编辑器。
      if (suppressNextBlurRef.current) {
        suppressNextBlurRef.current = false;
        return;
      }
      if (panelRef.current?.contains(document.activeElement)) return;
      focusedRef.current = false;
      requestUpdate(true);
    };
    editor.on('focus', handleFocus);
    editor.on('blur', handleBlur);
    return () => {
      editor.off('focus', handleFocus);
      editor.off('blur', handleBlur);
    };
  }, [editor, requestUpdate]);

  // 菜单尺寸由内容决定 (回显图标/当前块类型), 首帧用估算值, 这里在绘制前校正,
  // 之后靠 ResizeObserver 跟进。
  const visible = frame !== null;

  // 选区气泡的显示优先级高于链接 hover 气泡 (见 selection-bubble-menu-state
  // 里的可见性广播), 可见性一变就同步出去, 链接气泡据此让位 / 收起。
  useEffect(() => {
    setSelectionBubbleMenuVisible(visible);
    return () => setSelectionBubbleMenuVisible(false);
  }, [visible]);

  useLayoutEffect(() => {
    if (!visible) return;
    requestUpdate(true);
    const panel = panelRef.current;
    if (!panel) return;
    const observer = new ResizeObserver(() => requestUpdate(true));
    observer.observe(panel);
    return () => observer.disconnect();
  }, [visible, requestUpdate]);

  const linkHref = snapshot.linkHref;
  const blockTrigger = blockTriggerContent(snapshot, t);

  const blockItems: BubbleDropdownItem[] = [
    { key: 'h1', icon: dropdownHeadingIcon(1), text: t('editor.bubble.heading1'), active: snapshot.heading === 1, shortcut: 'Mod+1', onRun: () => editor.chain().focus().toggleHeading({ level: 1 }).run() },
    { key: 'h2', icon: dropdownHeadingIcon(2), text: t('editor.bubble.heading2'), active: snapshot.heading === 2, shortcut: 'Mod+2', onRun: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { key: 'h3', icon: dropdownHeadingIcon(3), text: t('editor.bubble.heading3'), active: snapshot.heading === 3, shortcut: 'Mod+3', onRun: () => editor.chain().focus().toggleHeading({ level: 3 }).run() },
    { key: 'h4', icon: dropdownHeadingIcon(4), text: t('editor.bubble.heading4'), active: snapshot.heading === 4, shortcut: 'Mod+4', onRun: () => editor.chain().focus().toggleHeading({ level: 4 }).run() },
    { key: 'paragraph', icon: <TextTIcon size={bubbleDropdownIconSize} weight="bold" aria-hidden="true" />, text: t('editor.toolbar.paragraph'), active: snapshot.heading === null && !snapshot.bulletList && !snapshot.orderedList && !snapshot.taskList && !snapshot.blockquote && !snapshot.codeBlock, shortcut: 'Mod+0', onRun: () => editor.chain().focus().setParagraph().run() },
    { key: 'divider-lists', divider: true },
    { key: 'bulletList', icon: <ListBulletsIcon size={bubbleDropdownIconSize} weight="bold" aria-hidden="true" />, text: t('editor.block.bulletList'), active: snapshot.bulletList, shortcut: 'Mod+Alt+8', onRun: () => applyListType(editor, 'bulletList' satisfies ListTypeName) },
    { key: 'orderedList', icon: <ListNumbersIcon size={bubbleDropdownIconSize} weight="bold" aria-hidden="true" />, text: t('editor.block.orderedList'), active: snapshot.orderedList, shortcut: 'Mod+Alt+7', onRun: () => applyListType(editor, 'orderedList' satisfies ListTypeName) },
    { key: 'taskList', icon: <CheckSquareIcon size={bubbleDropdownIconSize} weight="bold" aria-hidden="true" />, text: t('editor.block.taskList'), active: snapshot.taskList, shortcut: 'Mod+Alt+9', onRun: () => applyListType(editor, 'taskList' satisfies ListTypeName) },
    { key: 'divider-quote-code', divider: true },
    { key: 'blockquote', icon: <QuotesIcon size={bubbleDropdownIconSize} weight="bold" aria-hidden="true" />, text: t('editor.slash.label.quote'), active: snapshot.blockquote, onRun: () => editor.chain().focus().toggleBlockquote().run() },
    { key: 'codeBlock', icon: <CodeIcon size={bubbleDropdownIconSize} weight="bold" aria-hidden="true" />, text: t('editor.slash.label.codeBlock'), active: snapshot.codeBlock, onRun: () => editor.chain().focus().toggleCodeBlock().run() },
  ];

  if (!root || !frame) return null;

  // 挂到 body, 不要挂 `.markdown-editor`: 后者声明了 `container: … / inline-size`,
  // 而 inline-size 容器会应用 layout containment —— 按规范它因此成为 fixed 后代的
  // **包含块**。挂在面板里时 `position: fixed` 会按面板定位, 视口坐标整体偏一个
  // 面板原点 (双栏布局下能偏出几百 px), 面板的 overflow: hidden 也照旧裁它。
  // 只有挂在 body 上, `fixed` 才真的等于视口, 窄栏里也才能溢出到面板外。
  return createPortal(
    <div
      ref={panelRef}
      className="selection-bubble-menu"
      role="toolbar"
      aria-label={t('editor.bubble.formatting')}
      tabIndex={0}
      style={{
        position: 'fixed',
        left: `${frame.left}px`,
        top: `${frame.top}px`,
      }}
      onMouseDownCapture={() => {
        suppressNextBlurRef.current = true;
      }}
    >      <BubbleDropdown
        label={t('editor.bubble.turnInto')}
        triggerIcon={blockTrigger.icon}
        triggerLabel={blockTrigger.label}
        items={blockItems}
      />
      <span className="selection-bubble-divider" aria-hidden="true" />
      <FormatButton
        active={snapshot.bold}
        disabled={!snapshot.boldEnabled}
        icon={<TextBIcon size={bubbleIconSize} weight="bold" aria-hidden="true" />}
        label={t('editor.bubble.bold')}
        onRun={() => editor.chain().focus().toggleBold().run()}
      />
      <FormatButton
        active={snapshot.italic}
        disabled={!snapshot.italicEnabled}
        icon={<TextItalicIcon size={bubbleIconSize} weight="bold" aria-hidden="true" />}
        label={t('editor.bubble.italic')}
        onRun={() => editor.chain().focus().toggleItalic().run()}
      />
      <FormatButton
        active={snapshot.underline}
        disabled={!snapshot.underlineEnabled}
        icon={<TextUnderlineIcon size={bubbleIconSize} weight="bold" aria-hidden="true" />}
        label={t('editor.bubble.underline')}
        onRun={() => editor.chain().focus().toggleUnderline().run()}
      />
      <FormatButton
        active={snapshot.strike}
        disabled={!snapshot.strikeEnabled}
        icon={
          <TextStrikethroughIcon size={bubbleIconSize} weight="bold" aria-hidden="true" />
        }
        label={t('editor.bubble.strikethrough')}
        onRun={() => editor.chain().focus().toggleStrike().run()}
      />
      <span className="selection-bubble-divider" aria-hidden="true" />
      <Popover open={highlightPaletteOpen} onOpenChange={setHighlightPaletteOpen}>
        {/* Tooltip 不能直接包 Radix PopoverTrigger (两层 render-merge 会互相
         * 吞掉 ref/hover 链路), 挂在普通 span 包裹层上才可靠。 */}
        <Tooltip content={t('editor.bubble.highlight')}>
          <span className="inline-flex">
            <PopoverTrigger asChild>
              <button
                type="button"
                className={`selection-bubble-button selection-bubble-highlight-trigger${snapshot.highlight ? ' is-active' : ''}`}
                aria-label={t('editor.bubble.highlight')}
                aria-pressed={snapshot.highlight}
                aria-expanded={highlightPaletteOpen}
                onMouseDown={(event) => event.preventDefault()}
              >
                {/* 高亮图标 = 矩形色块内嵌字母 A (参照表格工具条背景色设置的色块
                 * 样式): 色块底色回显当前高亮底色, A 回显当前高亮前景色。 */}
                <span
                  aria-hidden="true"
                  className="flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-[4px] border border-[var(--border)] text-[14px] font-normal leading-none"
                  style={{
                    backgroundColor: snapshot.highlightColor ? flowixHighlightBackground(snapshot.highlightColor) : 'white',
                    color: snapshot.highlightFg ? `var(--flowix-text-${snapshot.highlightFg})` : undefined,
                  }}
                >
                  A
                </span>
              </button>
            </PopoverTrigger>
          </span>
        </Tooltip>
        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={4}
          className="editor-highlight-palette--bubble"
        >
          <FlowixHighlightPalette
            editor={editor}
          />
        </PopoverContent>
      </Popover>
      <span className="selection-bubble-divider" aria-hidden="true" />
      <FormatButton
        active={snapshot.code}
        disabled={!snapshot.codeEnabled}
        icon={<Code size={bubbleIconSize} strokeWidth={2.25} aria-hidden="true" />}
        label={t('editor.bubble.inlineCode')}
        onRun={() => editor.chain().focus().toggleCode().run()}
      />
      <FormatButton
        active={Boolean(linkHref)}
        icon={<Link size={bubbleLinkIconSize} strokeWidth={2.25} aria-hidden="true" />}
        buttonClassName="selection-bubble-link-trigger"
        label={
          linkHref ? t('editor.bubble.editLink') : t('editor.bubble.addLink')
        }
        onRun={() => {
          // 与 hover 气泡的「编辑」用同一个链接输入组件 (无外框地址框 + 保存),
          // 区别只在落点: 这里贴选中内容正下方居中, 窗口底部放不下再上移。
          const { from, to } = editor.state.selection;
          if (from === to) return;
          openLinkInlineEditor({
            editor,
            range: { from, to },
            initialHref: editorLinkInputValue(linkHref),
            mode: linkHref ? 'edit' : 'create',
            placement: 'below',
            // 锚点每次按 from/to 重算 (旧版链接弹窗的口径): 焦点交给输入框后
            // 浏览器选区已经塌陷, 不能缓存一个会失效的 Range。
            getAnchorRect: () => textRangeRect(editor, from, to) ?? posToDOMRect(editor.view, from, to),
            onClose: () => editor.commands.focus(),
          });
        }}
      />
    </div>,
    document.body,
  );
}
