'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';

interface TableTextValueInputProps {
  value: string;
  disabled?: boolean;
  placeholder?: string;
  onChange: (next: string | null) => void;
}

export function TableTextValueInput({ value, disabled = false, placeholder, onChange }: TableTextValueInputProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const resizeTextarea = useCallback((textarea = textareaRef.current) => {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(264, Math.max(28, textarea.scrollHeight))}px`;
  }, []);
  const setTextareaRef = useCallback((textarea: HTMLTextAreaElement | null) => {
    textareaRef.current = textarea;
    if (textarea) resizeTextarea(textarea);
  }, [resizeTextarea]);

  useLayoutEffect(() => {
    if (open) resizeTextarea();
  }, [draft, open, resizeTextarea]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (disabled) return;
    if (nextOpen) {
      setDraft(value);
      setOpen(true);
      return;
    }
    if (open && draft !== value) onChange(draft || null);
    setOpen(false);
  };

  return <Popover open={disabled ? false : open} onOpenChange={handleOpenChange} cellPopup>
    <PopoverTrigger asChild anchorToCell>
      <button
        type="button"
        disabled={disabled}
        aria-label={placeholder || '编辑文本'}
        className="multidimensional-table__text-value min-h-8 w-full min-w-0 whitespace-pre-wrap border-0 bg-transparent px-0 py-1 text-left text-sm disabled:cursor-not-allowed"
      >
        {value || <span className="text-[var(--muted-foreground)] opacity-80">{placeholder}</span>}
      </button>
    </PopoverTrigger>
    <PopoverContent
      align="start"
      side="bottom"
      sideOffset={4}
      className="rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
      matchAnchorWidth={1.2}
      style={{ maxWidth: 'calc(100vw - 8px)', maxHeight: '280px', overflowY: 'auto' }}
    >
      <textarea
        ref={setTextareaRef}
        autoFocus
        disabled={disabled}
        aria-label={placeholder || '文本内容'}
        rows={1}
        wrap="soft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="multidimensional-table__text-value block max-h-[264px] min-h-7 w-full resize-none whitespace-pre-wrap rounded-lg border-0 bg-transparent px-1.5 py-1 text-sm leading-5 outline-none focus:border-0"
      />
    </PopoverContent>
  </Popover>;
}
