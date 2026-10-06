'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { normalizeTagInput } from '@features/document/properties/frontmatter-model';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';

interface TableTagValueInputProps {
  value: string[];
  disabled?: boolean;
  isNoteTags?: boolean;
  onChange: (next: string[]) => void;
}

function normalizeDraft(value: string, isNoteTags: boolean): string {
  return isNoteTags ? normalizeTagInput(value) : value.trim();
}

function TagChip({
  tag,
  isNoteTags,
  selected = false,
}: {
  tag: string;
  isNoteTags: boolean;
  selected?: boolean;
}) {
  return <span className={cn(
    `frontmatter-property__edit-tag-chip${isNoteTags ? '' : ' frontmatter-property__edit-tag-chip--plain'}`,
  )} data-keyboard-selected={selected ? 'true' : undefined}>
    {isNoteTags
      ? <><span className="tag-node-prefix">#</span><span className="tag-node-content">{tag}</span></>
      : tag}
  </span>;
}

export function TableTagValueInput({
  value,
  disabled = false,
  isNoteTags = false,
  onChange,
}: TableTagValueInputProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [tags, setTags] = useState<string[]>(value);
  const [draft, setDraft] = useState('');
  const [activeTagIndex, setActiveTagIndex] = useState<number | null>(null);
  const composingRef = useRef(false);
  const cancelCloseRef = useRef(false);
  const closeStartedRef = useRef(false);
  const initialTagsRef = useRef<string[]>(value);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const openEditor = () => {
    if (disabled) return;
    const nextTags = value.map((item) => normalizeDraft(item, isNoteTags)).filter(Boolean);
    initialTagsRef.current = nextTags;
    closeStartedRef.current = false;
    setTags(nextTags);
    setDraft('');
    setActiveTagIndex(null);
    setOpen(true);
  };

  const closeEditor = (shouldOpen: boolean) => {
    if (disabled) {
      setOpen(false);
      setDraft('');
      return;
    }
    if (shouldOpen) {
      openEditor();
      return;
    }
    if (!open || closeStartedRef.current) return;
    closeStartedRef.current = true;
    setOpen(false);
    if (cancelCloseRef.current) {
      cancelCloseRef.current = false;
      setTags(initialTagsRef.current);
      setDraft('');
      return;
    }
    const nextDraft = normalizeDraft(draft, isNoteTags);
    const nextTags = [...tags, ...(nextDraft ? [nextDraft] : [])];
    const uniqueTags = nextTags.filter((tag, index) => nextTags.indexOf(tag) === index);
    if (JSON.stringify(uniqueTags) !== JSON.stringify(initialTagsRef.current)) onChange(uniqueTags);
    setDraft('');
    setActiveTagIndex(null);
  };

  const commitDraft = () => {
    if (disabled) return;
    const nextTag = normalizeDraft(draft, isNoteTags);
    if (nextTag && !tags.includes(nextTag)) setTags((current) => [...current, nextTag]);
    setDraft('');
    setActiveTagIndex(null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (composingRef.current || event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelCloseRef.current = true;
      closeEditor(false);
      return;
    }
    if (event.key === 'ArrowLeft' && draft.length === 0) {
      event.preventDefault();
      if (tags.length > 0) setActiveTagIndex((current) => current === null ? tags.length - 1 : Math.max(0, current - 1));
      return;
    }
    if (event.key === 'ArrowRight' && activeTagIndex !== null) {
      event.preventDefault();
      setActiveTagIndex((current) => current !== null && current + 1 >= tags.length ? null : (current ?? -1) + 1);
      return;
    }
    if (event.key === 'Backspace' && draft.length === 0 && tags.length > 0) {
      event.preventDefault();
      const indexToRemove = activeTagIndex ?? tags.length - 1;
      setTags((current) => current.filter((_, index) => index !== indexToRemove));
      setActiveTagIndex(tags.length <= 1 ? null : Math.min(indexToRemove, tags.length - 2));
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      closeEditor(false);
      return;
    }
    if (event.key === 'Enter' || event.key === ',') {
      const nextTag = normalizeDraft(draft, isNoteTags);
      if (!nextTag) return;
      event.preventDefault();
      commitDraft();
    }
  };

  const displayTags = value.map((item) => normalizeDraft(item, isNoteTags)).filter(Boolean);

  return <Popover open={disabled ? false : open} onOpenChange={closeEditor} cellPopup>
    <PopoverTrigger asChild anchorToCell>
      <button
        type="button"
        disabled={disabled}
        aria-label={t('document.properties.tagInputPlaceholder')}
        className="flex min-h-8 w-full flex-wrap items-center gap-[0.3rem] border-0 bg-transparent px-0 py-1 text-left disabled:cursor-not-allowed disabled:opacity-50"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {displayTags.length > 0
          ? displayTags.map((tag, index) => <TagChip key={`${tag}-${index}`} tag={tag} isNoteTags={isNoteTags} />)
          : null}
        <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
      </button>
    </PopoverTrigger>
    <PopoverContent
      align="start"
      sideOffset={4}
      className="frontmatter-property__edit-popover p-1"
      matchAnchorWidth
      style={{ maxWidth: 'calc(100vw - 8px)', maxHeight: 'calc(100vh - 8px)', overflowY: 'auto' }}
    >
      <div
        className="frontmatter-property__edit-tags"
        role="group"
        aria-label={t('document.properties.tagInputPlaceholder')}
        onBlur={(event) => {
          const nextTarget = event.relatedTarget;
          if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
          queueMicrotask(() => closeEditor(false));
        }}
      >
        <div className="frontmatter-property__edit-tags-chips">
          {tags.map((tag, index) => <TagChip key={`${tag}-${index}`} tag={tag} isNoteTags={isNoteTags} selected={activeTagIndex === index} />)}
        </div>
        <input
          autoFocus
          type="text"
          disabled={disabled}
          spellCheck={false}
          aria-label={t('document.properties.tagInputPlaceholder')}
          className="frontmatter-property__edit-input frontmatter-property__edit-tags-input multidimensional-table__tag-input"
          value={draft}
          placeholder={tags.length === 0 ? t('document.properties.tagInputPlaceholder') : ''}
          onChange={(event) => { setDraft(event.target.value); setActiveTagIndex(null); }}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={handleKeyDown}
        />
      </div>
    </PopoverContent>
  </Popover>;
}
