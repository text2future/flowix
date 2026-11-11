'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';

interface TableTextValueInputProps {
  value: string;
  disabled?: boolean;
  placeholder?: string;
  singleLineDisplay?: boolean;
  validate?: (value: string) => boolean;
  validationMessage?: string;
  onChange: (next: string | null) => void;
}

export function TableTextValueInput({ value, disabled = false, placeholder, singleLineDisplay = false, validate, validationMessage = '请输入有效内容', onChange }: TableTextValueInputProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [validationError, setValidationError] = useState(false);
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
      setValidationError(false);
      setOpen(true);
      return;
    }
    if (open && draft !== value) {
      const nextValue = draft.trim();
      if (validate && !validate(nextValue)) {
        setValidationError(true);
        return;
      }
      onChange(nextValue || null);
    }
    setValidationError(false);
    setOpen(false);
  };

  return <Popover open={disabled ? false : open} onOpenChange={handleOpenChange} cellPopup>
    <PopoverTrigger asChild anchorToCell>
      <button
        type="button"
        disabled={disabled}
        aria-label={placeholder || '编辑文本'}
        className={`multidimensional-table__text-value min-h-8 w-full min-w-0 border-0 bg-transparent px-0 py-1 text-left text-sm disabled:cursor-not-allowed ${singleLineDisplay ? 'multidimensional-table__text-value--single-line' : 'whitespace-pre-wrap'}`}
      >
        {value ? <span className={singleLineDisplay ? 'block truncate' : undefined}>{value}</span> : <span className="text-[var(--muted-foreground)] opacity-80">{placeholder}</span>}
      </button>
    </PopoverTrigger>
    <PopoverContent
      align="start"
      side="bottom"
      sideOffset={4}
      className="multidimensional-table__field-editor-popover !z-[170]"
      matchAnchorWidth={1.02}
      matchAnchorHeight={1.08}
      style={{ maxWidth: 'calc(100vw - 8px)', maxHeight: '280px', overflowY: 'auto' }}
    >
      <div className="min-w-0">
        <textarea
          ref={setTextareaRef}
          autoFocus
          disabled={disabled}
          aria-label={placeholder || '文本内容'}
          aria-invalid={validationError || undefined}
          rows={1}
          wrap="soft"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            if (validationError) setValidationError(false);
          }}
          className="multidimensional-table__text-value block max-h-[264px] min-h-7 w-full resize-none whitespace-pre-wrap rounded-lg border-0 bg-transparent px-1.5 py-1 text-sm leading-5 outline-none focus:border-0"
        />
        {validationError && <p className="px-1.5 pb-1 text-xs text-[var(--destructive)]">{validationMessage}</p>}
      </div>
    </PopoverContent>
  </Popover>;
}
