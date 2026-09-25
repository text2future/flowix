'use client';

import { Editor } from '@tiptap/core';
import { ChevronDown, MoreHorizontal } from 'lucide-react';
import { TextHOneIcon, TextHTwoIcon, TextHThreeIcon, TextHFourIcon, TextTIcon, ListBulletsIcon, ListNumbersIcon, CheckSquareIcon, TextBIcon, TextUnderlineIcon, TextItalicIcon, TextStrikethroughIcon, HighlighterIcon, CodeIcon, PaperclipIcon, LinkSimpleIcon, CaretDownIcon, CaretUpIcon } from '@phosphor-icons/react';
import { useEffect, useState, useRef } from 'react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@shared/ui/dropdown-menu';
import { Tooltip } from '@shared/ui/tooltip';
import { openLinkEditPopup } from '@features/editor/components/link-edit-popup';
import { useI18n } from '@/lib/i18n';
import { FlowixHighlightPalette } from '@features/editor/components/flowix-highlight-palette';
import { applyListType } from '@features/editor/extensions/list-transforms';

interface EditorToolbarProps {
  editor: Editor | null;
  // 折叠态: true 仅展示展开按钮, false 展示完整工具栏 (常驻可见, 不再跟随 focus)。
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

type HeadingLevel = 1 | 2 | 3 | 4;

interface ToolbarState {
  heading: HeadingLevel | null;
  bold: boolean;
  underline: boolean;
  italic: boolean;
  bulletList: boolean;
  orderedList: boolean;
  taskList: boolean;
  highlight: boolean;
  strikethrough: boolean;
  link: boolean;
}

const headingConfigs: { level: HeadingLevel; icon: React.ReactNode; symbol: string }[] = [
  { level: 1, icon: <TextHOneIcon size={16} weight="bold" />, symbol: '#' },
  { level: 2, icon: <TextHTwoIcon size={16} weight="bold" />, symbol: '##' },
  { level: 3, icon: <TextHThreeIcon size={16} weight="bold" />, symbol: '###' },
  { level: 4, icon: <TextHFourIcon size={16} weight="bold" />, symbol: '####' },
];

const paragraphIcon = <TextTIcon size={16} weight="bold" />;

const INITIAL_STATE: ToolbarState = {
  heading: null,
  bold: false,
  underline: false,
  italic: false,
  bulletList: false,
  orderedList: false,
  taskList: false,
  highlight: false,
  strikethrough: false,
  link: false,
};

const iconButtonStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

export function EditorToolbar({ editor, collapsed, onCollapsedChange }: EditorToolbarProps) {
  const { t } = useI18n();
  const [state, setState] = useState<ToolbarState>(INITIAL_STATE);
  const [highlightPaletteOpen, setHighlightPaletteOpen] = useState(false);
  const editorRef = useRef<Editor | null>(null);

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor) return;

    const updateActiveStates = () => {
      let heading: HeadingLevel | null = null;
      for (let i = 1; i <= 4; i++) {
        if (currentEditor.isActive('heading', { level: i as HeadingLevel })) {
          heading = i as HeadingLevel;
          break;
        }
      }

      setState({
        heading,
        bold: currentEditor.isActive('bold'),
        underline: currentEditor.isActive('underline'),
        italic: currentEditor.isActive('italic'),
        bulletList: currentEditor.isActive('bulletList'),
        orderedList: currentEditor.isActive('orderedList'),
        taskList: currentEditor.isActive('taskList'),
        highlight: currentEditor.isActive('highlight'),
        strikethrough: currentEditor.isActive('strike'),
        link: currentEditor.isActive('link'),
      });
    };

    updateActiveStates();

    currentEditor.on('selectionUpdate', updateActiveStates);
    currentEditor.on('transaction', updateActiveStates);

    return () => {
      currentEditor.off('selectionUpdate', updateActiveStates);
      currentEditor.off('transaction', updateActiveStates);
    };
  }, [editor]);

  if (!editor) {
    return null;
  }

  // 折叠态: 只渲染一个轻量的展开按钮, 不需要完整的 toolbar-content 卡片。
  if (collapsed) {
    return (
      <div className="editor-toolbar">
        <Tooltip content={t('editor.toolbar.expandTooltip')}>
          <button
            className="toolbar-expand-handle"
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onCollapsedChange?.(false)}
            aria-label={t('editor.toolbar.expand')}
            style={{ width: '2.4rem', height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <CaretUpIcon size={14} weight="bold" />
          </button>
        </Tooltip>
      </div>
    );
  }

  const getCurrentHeadingIcon = () => {
    if (state.heading) {
      const found = headingConfigs.find(h => h.level === state.heading);
      return found ? found.icon : paragraphIcon;
    }
    return paragraphIcon;
  };

  return (
    <div className="editor-toolbar">
      <div className="toolbar-content">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className={`toolbar-button ${state.heading ? 'active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              type="button"
              style={{ width: 42, height: 28, gap: 2, display: 'flex', alignItems: 'center' }}
            >
              {getCurrentHeadingIcon()}
              <ChevronDown size={12} className="opacity-50" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            sideOffset={5}
            align="center"
            className="w-auto min-w-[144px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
          >
            {headingConfigs.map(({ level, icon, symbol }) => (
              <DropdownMenuItem
                key={level}
                className={`group h-7 items-center justify-start gap-3 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)] ${state.heading === level ? 'bg-[var(--brand)] text-[var(--primary-foreground)]' : ''}`}
                onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
              >
                {icon}
                <span className={state.heading === level ? 'text-[var(--primary-foreground)]' : 'text-[var(--muted-foreground)] group-hover:text-[var(--primary-foreground)]'}>{symbol}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem
              className={`group h-7 items-center justify-start gap-3 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)] ${!state.heading ? 'bg-[var(--brand)] text-[var(--primary-foreground)]' : ''}`}
              onClick={() => editor.chain().focus().setParagraph().run()}
            >
              {paragraphIcon}
              <span className={!state.heading ? 'text-[var(--primary-foreground)]' : 'text-[var(--muted-foreground)] group-hover:text-[var(--primary-foreground)]'}>{t('editor.toolbar.paragraph')}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="toolbar-divider" />

        <button
          className={`toolbar-button ${state.bold ? 'active' : ''}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleBold().run()}
          type="button"
          style={iconButtonStyle}
        >
          <TextBIcon size={18} weight="bold" />
        </button>
        <button
          className={`toolbar-button ${state.underline ? 'active' : ''}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          type="button"
          style={iconButtonStyle}
        >
          <TextUnderlineIcon size={18} weight="bold" />
        </button>
        <button
          className={`toolbar-button ${state.italic ? 'active' : ''}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          type="button"
          style={iconButtonStyle}
        >
          <TextItalicIcon size={18} weight="bold" />
        </button>

        <div className="toolbar-divider" />

        <Tooltip content={t('editor.block.bulletList')}>
          <button
            className={`toolbar-button ${state.bulletList ? 'active' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => applyListType(editor, 'bulletList')}
            type="button"
            style={iconButtonStyle}
            aria-label={t('editor.block.bulletList')}
          >
            <ListBulletsIcon size={18} weight="bold" />
          </button>
        </Tooltip>

        <Tooltip content={t('editor.block.orderedList')}>
          <button
            className={`toolbar-button ${state.orderedList ? 'active' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => applyListType(editor, 'orderedList')}
            type="button"
            style={iconButtonStyle}
            aria-label={t('editor.block.orderedList')}
          >
            <ListNumbersIcon size={18} weight="bold" />
          </button>
        </Tooltip>

        <Tooltip content={t('editor.toolbar.taskList')} shortcut="editor.toggleTaskList">
          <button
            className={`toolbar-button ${state.taskList ? 'active' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => applyListType(editor, 'taskList')}
            type="button"
            style={iconButtonStyle}
          >
            <CheckSquareIcon size={18} weight="bold" />
          </button>
        </Tooltip>
        <DropdownMenu open={highlightPaletteOpen} onOpenChange={setHighlightPaletteOpen}>
          <DropdownMenuTrigger asChild>
            <button
              className={`toolbar-button ${state.highlight ? 'active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              type="button"
              style={iconButtonStyle}
              aria-label={t('editor.bubble.highlight')}
              title={t('editor.bubble.highlight')}
            >
              <HighlighterIcon size={18} weight="bold" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            sideOffset={5}
            align="center"
            className="editor-highlight-palette__menu"
          >
            <FlowixHighlightPalette editor={editor} />
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="toolbar-divider" />

        <div className="relative inline-block">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="toolbar-button"
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                style={iconButtonStyle}
                aria-label={t('editor.toolbar.more')}
                title={t('editor.toolbar.more')}
              >
                <MoreHorizontal size={18} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              sideOffset={5}
              align="center"
              className="w-auto min-w-[136px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
            >
              <DropdownMenuItem
                className={`group h-7 items-center justify-start gap-3 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)] ${state.link ? 'bg-[var(--brand)] text-[var(--primary-foreground)]' : ''}`}
                onClick={() => openLinkEditPopup(editor, () => undefined, { mode: 'create' })}
              >
                <LinkSimpleIcon size={16} weight="bold" />
                <span>{t('editor.toolbar.addLink')}</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="group h-7 items-center justify-start gap-3 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
                onClick={() => editor.chain().focus().toggleCodeBlock().run()}
              >
                <CodeIcon size={16} weight="bold" />
                <span>{t('editor.toolbar.insertCodeBlock')}</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className={`group h-7 items-center justify-start gap-3 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)] ${state.strikethrough ? 'bg-[var(--brand)] text-[var(--primary-foreground)]' : ''}`}
                onClick={() => editor.chain().focus().toggleStrike().run()}
              >
                <TextStrikethroughIcon size={16} weight="bold" />
                <span>{t('editor.toolbar.strikethrough')}</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="group h-7 items-center justify-start gap-3 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
                onClick={() => editor.commands.openFileDialog()}
              >
                <PaperclipIcon size={16} weight="bold" />
                <span>{t('editor.toolbar.addAttachment')}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Tooltip content={t('editor.toolbar.collapseTooltip')}>
          <button
            className="toolbar-button"
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onCollapsedChange?.(true)}
            aria-label={t('editor.toolbar.collapse')}
            style={iconButtonStyle}
          >
            <CaretDownIcon size={14} weight="bold" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
