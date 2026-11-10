'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { queryMentionTags, type MentionTagItem } from '@features/editor/public/mention-data-api';
import { normalizeTagInput } from '@features/document/properties/frontmatter-model';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useComposingValue } from '@shared/hooks/use-composing-value';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { TagSvgIcon } from '@shared/ui/tag-icon';
import { usePropertyValueTypography } from './value-typography';

interface TagValueInputProps {
  value: string[];
  disabled?: boolean;
  isNoteTags?: boolean;
  singleValue?: boolean;
  keepParentMenuOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
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
    `frontmatter-property__edit-tag-chip${isNoteTags ? '' : ' frontmatter-property__edit-tag-chip--plain multidimensional-table__plain-tag-chip'}`,
  )} data-keyboard-selected={selected ? 'true' : undefined}>
    {isNoteTags
      ? <><span className="tag-node-prefix">#</span><span className="tag-node-content">{tag}</span></>
      : <span className="tag-node-content">{tag}</span>}
  </span>;
}

export function TagValueInput({
  value,
  disabled = false,
  isNoteTags = false,
  singleValue = false,
  keepParentMenuOpen = false,
  onOpenChange,
  onChange,
}: TagValueInputProps) {
  const { t } = useI18n();
  const typography = usePropertyValueTypography();
  const [open, setOpen] = useState(false);
  const [tags, setTags] = useState<string[]>(value);
  const [draft, setDraft] = useState('');
  const [activeTagIndex, setActiveTagIndex] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<MentionTagItem[]>([]);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const suggestionListId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const draftInput = useComposingValue(draft, (next) => {
    setDraft(next);
    setSuggestions([]);
    setActiveSuggestion(0);
    setActiveTagIndex(null);
  });
  const cancelCloseRef = useRef(false);
  const closeStartedRef = useRef(false);
  const initialTagsRef = useRef<string[]>(value);
  useEffect(() => { if (disabled) { setOpen(false); onOpenChange?.(false); } }, [disabled, onOpenChange]);

  useEffect(() => {
    if (!open || disabled || !isNoteTags) {
      setSuggestions([]);
      return;
    }
    if (!draft.trim().replace(/^#+/, '').trim()) {
      setSuggestions([]);
      setActiveSuggestion(0);
      return;
    }
    let cancelled = false;
    setSuggestions([]);
    setActiveSuggestion(0);
    void queryMentionTags(draft).then((items) => {
      if (!cancelled) setSuggestions(items.filter((item) => !item.create && !tags.includes(normalizeTagInput(item.name))));
    });
    return () => { cancelled = true; };
  }, [open, disabled, isNoteTags, draft, tags]);

  useEffect(() => {
    if (open) document.getElementById(`${suggestionListId}-${activeSuggestion}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeSuggestion, suggestionListId]);

  const selectSuggestion = (name: string) => {
    const tag = normalizeTagInput(name);
    if (disabled || !tag) return;
    setTags((current) => singleValue ? [tag] : current.includes(tag) ? current : [...current, tag]);
    setDraft('');
    setActiveTagIndex(null);
    setActiveSuggestion(0);
    inputRef.current?.focus();
  };

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
      onOpenChange?.(false);
      setDraft('');
      return;
    }
    if (shouldOpen) {
      openEditor();
      onOpenChange?.(true);
      return;
    }
    if (!open || closeStartedRef.current) return;
    closeStartedRef.current = true;
    setOpen(false);
    onOpenChange?.(false);
    if (cancelCloseRef.current) {
      cancelCloseRef.current = false;
      setTags(initialTagsRef.current);
      setDraft('');
      return;
    }
    const nextDraft = normalizeDraft(draft, isNoteTags);
    const nextTags = singleValue
      ? (nextDraft ? [nextDraft] : tags)
      : [...tags, ...(nextDraft ? [nextDraft] : [])];
    const uniqueTags = nextTags.filter((tag, index) => nextTags.indexOf(tag) === index);
    if (JSON.stringify(uniqueTags) !== JSON.stringify(initialTagsRef.current)) onChange(uniqueTags);
    setDraft('');
    setActiveTagIndex(null);
  };

  const commitDraft = () => {
    if (disabled) return;
    const nextTag = normalizeDraft(draft, isNoteTags);
    if (nextTag && !tags.includes(nextTag)) setTags((current) => singleValue ? [nextTag] : [...current, nextTag]);
    setDraft('');
    setActiveTagIndex(null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (draftInput.isComposingKeyboardEvent(event.nativeEvent)) return;
    if (suggestions.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      setActiveSuggestion((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
      return;
    }
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && suggestions[activeSuggestion]) {
      event.preventDefault();
      selectSuggestion(suggestions[activeSuggestion].name);
      return;
    }
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
        style={typography}
        className="multidimensional-table__tag-value flex min-h-8 w-full items-center border-0 bg-transparent px-0 py-1 text-left disabled:cursor-not-allowed disabled:opacity-50"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="multidimensional-table__tag-chips flex min-w-0 flex-1 flex-wrap items-center gap-[0.3rem]">
          {displayTags.map((tag, index) => <TagChip key={`${tag}-${index}`} tag={tag} isNoteTags={isNoteTags} />)}
        </span>
      </button>
    </PopoverTrigger>
    <PopoverContent
      align="start"
      sideOffset={4}
      keepParentMenuOpen={keepParentMenuOpen}
      className="frontmatter-property__edit-popover !z-[170] rounded-xl p-1"
      matchAnchorWidth={1.2}
      style={{ ...typography, maxWidth: 'calc(100vw - 8px)', maxHeight: '280px', overflowY: 'auto' }}
    >
      <div
        className="frontmatter-property__edit-tags p-1"
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
          ref={inputRef}
          role={isNoteTags ? 'combobox' : undefined}
          aria-autocomplete={isNoteTags ? 'list' : undefined}
          aria-expanded={isNoteTags ? suggestions.length > 0 : undefined}
          aria-controls={isNoteTags && suggestions.length > 0 ? suggestionListId : undefined}
          aria-activedescendant={isNoteTags && suggestions[activeSuggestion] ? `${suggestionListId}-${activeSuggestion}` : undefined}
          autoFocus
          type="text"
          disabled={disabled}
          spellCheck={false}
          aria-label={t('document.properties.tagInputPlaceholder')}
          className="frontmatter-property__edit-input frontmatter-property__edit-tags-input multidimensional-table__tag-input min-h-7 rounded-lg px-1.5 py-1 text-sm leading-5"
          value={draftInput.value}
          placeholder={tags.length === 0 ? t('document.properties.tagInputPlaceholder') : ''}
          onChange={draftInput.onChange}
          onCompositionStart={draftInput.onCompositionStart}
          onCompositionEnd={draftInput.onCompositionEnd}
          onKeyDown={handleKeyDown}
        />
      </div>
      {isNoteTags && suggestions.length > 0 && <div
        id={suggestionListId}
        role="listbox"
        aria-label={t('document.properties.tagInputPlaceholder')}
        className="scrollbar-hide mt-1 max-h-40 overflow-y-auto pt-1"
      >
        {suggestions.map((item, index) => <button
          key={item.id}
          id={`${suggestionListId}-${index}`}
          type="button"
          role="option"
          aria-selected={activeSuggestion === index}
          tabIndex={-1}
          className={cn('frontmatter-property__edit-tag-suggestion', activeSuggestion === index && 'bg-[var(--hover-bg)]')}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => setActiveSuggestion(index)}
          onClick={() => selectSuggestion(item.name)}
        >
          <TagSvgIcon className="mr-1 h-4 w-4 shrink-0" /><span className="tag-node-content">{item.name}</span>
        </button>)}
      </div>}
    </PopoverContent>
  </Popover>;
}
