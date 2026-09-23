'use client';

import type { Editor } from '@tiptap/core';
import { BubbleMenu } from '@tiptap/react/menus';
import {
  CodeIcon,
  HighlighterIcon,
  LinkSimpleIcon,
  TextBIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  TextUnderlineIcon,
} from '@phosphor-icons/react';
import { type ReactNode, useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import type { BubbleMenuProps } from '@tiptap/react/menus';
import { openLinkEditPopup } from '@features/editor/components/link-edit-popup';
import { FlowixHighlightPalette } from '@features/editor/components/flowix-highlight-palette';
import { hasFormattableTextSelection } from '@features/editor/components/selection-bubble-menu-state';
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
}

function FormatButton({
  active,
  disabled = false,
  icon,
  label,
  onRun,
}: FormatButtonProps) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        className={`selection-bubble-button${active ? ' is-active' : ''}`}
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

export function SelectionBubbleMenu({ editor }: SelectionBubbleMenuProps) {
  const { t } = useI18n();
  const [, rerender] = useReducer((revision: number) => revision + 1, 0);
  const [highlightPaletteOpen, setHighlightPaletteOpen] = useState(false);

  useEffect(() => {
    const update = () => {
      rerender();
      if (!hasFormattableTextSelection(editor)) {
        setHighlightPaletteOpen(false);
      }
    };
    editor.on('transaction', update);
    return () => {
      editor.off('transaction', update);
    };
  }, [editor]);

  // These props feed tiptap's internal "updateOptions" effect, whose deps
  // include shouldShow / options / appendTo. Fresh identities each render would
  // make that effect dispatch a transaction every render, which our
  // transaction listener above turns back into a re-render → infinite loop
  // ("Maximum update depth exceeded"). Memoize to keep identities stable.
  const appendTo = useCallback((): HTMLElement => document.body, []);
  const shouldShow = useCallback<NonNullable<BubbleMenuProps['shouldShow']>>(
    ({ element, view }) =>
      (view.hasFocus() || element.contains(document.activeElement)) &&
      hasFormattableTextSelection(editor),
    [editor],
  );
  const options = useMemo<BubbleMenuProps['options']>(
    () => ({
      strategy: 'fixed',
      placement: 'top',
      offset: 8,
      flip: { padding: 8 },
      shift: { padding: 8 },
      inline: true,
    }),
    [],
  );

  const linkHref = editor.isActive('link')
    ? String(editor.getAttributes('link').href ?? '')
    : '';

  return (
    <BubbleMenu
      editor={editor}
      className="selection-bubble-menu"
      role="toolbar"
      aria-label={t('editor.bubble.formatting')}
      updateDelay={80}
      appendTo={appendTo}
      shouldShow={shouldShow}
      options={options}
    >
      <FormatButton
        active={editor.isActive('bold')}
        disabled={!editor.can().chain().focus().toggleBold().run()}
        icon={<TextBIcon size={17} weight="bold" aria-hidden="true" />}
        label={t('editor.bubble.bold')}
        onRun={() => editor.chain().focus().toggleBold().run()}
      />
      <FormatButton
        active={editor.isActive('italic')}
        disabled={!editor.can().chain().focus().toggleItalic().run()}
        icon={<TextItalicIcon size={17} weight="bold" aria-hidden="true" />}
        label={t('editor.bubble.italic')}
        onRun={() => editor.chain().focus().toggleItalic().run()}
      />
      <FormatButton
        active={editor.isActive('underline')}
        disabled={!editor.can().chain().focus().toggleUnderline().run()}
        icon={<TextUnderlineIcon size={17} weight="bold" aria-hidden="true" />}
        label={t('editor.bubble.underline')}
        onRun={() => editor.chain().focus().toggleUnderline().run()}
      />
      <FormatButton
        active={editor.isActive('strike')}
        disabled={!editor.can().chain().focus().toggleStrike().run()}
        icon={
          <TextStrikethroughIcon size={17} weight="bold" aria-hidden="true" />
        }
        label={t('editor.bubble.strikethrough')}
        onRun={() => editor.chain().focus().toggleStrike().run()}
      />
      <span className="selection-bubble-divider" aria-hidden="true" />
      <FormatButton
        active={editor.isActive('code')}
        disabled={!editor.can().chain().focus().toggleCode().run()}
        icon={<CodeIcon size={17} weight="bold" aria-hidden="true" />}
        label={t('editor.bubble.inlineCode')}
        onRun={() => editor.chain().focus().toggleCode().run()}
      />
      <Popover open={highlightPaletteOpen} onOpenChange={setHighlightPaletteOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={`selection-bubble-button${editor.isActive('highlight') ? ' is-active' : ''}`}
            aria-label={t('editor.bubble.highlight')}
            aria-pressed={editor.isActive('highlight')}
            aria-expanded={highlightPaletteOpen}
            onMouseDown={(event) => event.preventDefault()}
          >
            <HighlighterIcon size={17} weight="bold" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="center"
          sideOffset={8}
          className="editor-highlight-palette--bubble"
        >
          <FlowixHighlightPalette
            editor={editor}
          />
        </PopoverContent>
      </Popover>
      <FormatButton
        active={Boolean(linkHref)}
        icon={<LinkSimpleIcon size={17} weight="bold" aria-hidden="true" />}
        label={
          linkHref ? t('editor.bubble.editLink') : t('editor.bubble.addLink')
        }
        onRun={() =>
          openLinkEditPopup(editor, () => editor.commands.focus(), {
            href: linkHref,
            mode: linkHref ? 'edit' : 'create',
          })
        }
      />
    </BubbleMenu>
  );
}
