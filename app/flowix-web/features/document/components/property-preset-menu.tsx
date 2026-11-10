'use client';

import { useRef, useState, useEffect, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { moveNameAndDescriptionPresetsToEnd, type PropertyPreset } from '@features/document/properties/presets';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { POPUP_SEPARATOR_CLASS } from '@shared/ui/popup-separator';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { cn } from '@/lib/utils';
import type { I18nKey } from '@/lib/i18n';

export function PropertyPresetMenu({
  triggerLabel = '预设属性',
  triggerIcon,
  triggerPadding = 'px-1.5',
  showTrigger = true,
  anchorRect,
  side = 'left',
  align = 'end',
  customGroupLabel,
  customPresets,
  systemPresets,
  disabled,
  open,
  onOpenChange,
  t,
  onSelect,
  onRemove,
  onManage,
  isAdded,
}: {
  triggerLabel?: string;
  triggerIcon?: ReactNode;
  triggerPadding?: 'px-1.5' | 'px-2';
  /** Render only the picker popup when another menu owns its trigger. */
  showTrigger?: boolean;
  anchorRect?: DOMRect | null;
  side?: 'left' | 'right' | 'top' | 'bottom';
  align?: 'start' | 'center' | 'end';
  customGroupLabel?: string;
  customPresets: PropertyPreset[];
  systemPresets: PropertyPreset[];
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  t: (key: I18nKey) => string;
  onSelect: (preset: PropertyPreset) => void;
  onRemove?: (preset: PropertyPreset) => void;
  onManage: () => void;
  isAdded?: (preset: PropertyPreset) => boolean;
}) {
  const [query, setQuery] = useState('');
  const [searchText, setSearchText] = useState('');
  const isComposingRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) {
      setQuery('');
      setSearchText('');
      isComposingRef.current = false;
      return;
    }
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchesQuery = (preset: PropertyPreset) =>
    !normalizedQuery || preset.label.toLocaleLowerCase().includes(normalizedQuery);
  const visibleSystemPresets = moveNameAndDescriptionPresetsToEnd(
    systemPresets.filter(matchesQuery),
    (preset) => preset.key,
  );
  const visibleCustomPresets = customPresets.filter(matchesQuery);

  const renderGroup = (title: string, presets: PropertyPreset[]) => presets.length > 0 && <section className="space-y-0.5">
    <p className="agent-thread-card__codex-settings-title">{title}</p>
    {presets.map((preset) => {
      const added = isAdded?.(preset) ?? false;
      return <button
        key={`${preset.source}:${preset.key}`}
        type="button"
        disabled={disabled}
        aria-pressed={added}
        onClick={() => added ? onRemove?.(preset) : onSelect(preset)}
        className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-1.5 text-left text-sm hover:bg-[var(--hover-bg)] disabled:cursor-default disabled:opacity-50"
        title={preset.label}
      >
        <span className="min-w-0 flex-1 truncate">{preset.label}</span>
        <span
          aria-hidden="true"
          className={cn(
            'relative h-5 w-9 shrink-0 rounded-full transition-colors',
            added ? 'bg-[var(--primary)]' : 'bg-[var(--muted)]',
          )}
        >
          <span
            className={cn(
              'absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[var(--card)] shadow-sm transition-transform',
              added ? 'translate-x-4' : 'translate-x-0',
            )}
          />
        </span>
      </button>;
    })}</section>;

  return <Popover open={open} onOpenChange={onOpenChange} anchorRect={anchorRect}>
    {showTrigger && <PopoverTrigger asChild>
      <button type="button" disabled={disabled} className={`flex h-8 w-full items-center justify-between rounded-lg ${triggerPadding} text-left text-sm hover:bg-[var(--hover-bg)] data-[state=open]:bg-[var(--hover-bg)] data-[state=open]:text-[var(--foreground)] disabled:opacity-50`}>
        <span className="flex min-w-0 items-center gap-1.5">{triggerIcon}{triggerLabel}</span>
        <ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" aria-hidden="true" />
      </button>
    </PopoverTrigger>}
    <PopoverContent side={side} align={align} sideOffset={0} ignoreSelectOutside={false} style={{ zIndex: 170 }} className="property-preset-menu-content flex max-h-[60vh] w-[213px] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-xl p-1.5 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
      <input
        ref={searchInputRef}
        type="text"
        value={searchText}
        onChange={(event) => {
          const value = event.target.value;
          setSearchText(value);
          if (!isComposingRef.current) setQuery(value);
        }}
        onCompositionStart={() => { isComposingRef.current = true; }}
        onCompositionEnd={(event) => {
          isComposingRef.current = false;
          const value = event.currentTarget.value;
          setSearchText(value);
          setQuery(value);
        }}
        placeholder={t('document.properties.picker.search')}
        aria-label={t('document.properties.picker.search')}
        className="agent-composer__note-search multidimensional-table__preset-search shrink-0"
      />
      <div role="separator" aria-hidden="true" className={`${POPUP_SEPARATOR_CLASS} shrink-0`} />
      <OverlayScrollbar className="overlay-scrollbar-frame--edge-aligned min-h-0 max-h-[calc(60vh-60px)] flex-1" scrollerClassName="min-h-0 max-h-[calc(60vh-60px)] overflow-y-auto overflow-x-hidden">
        <div className="space-y-2">
          {renderGroup(t('preferences.documentProperties.group.presets'), visibleSystemPresets)}
          {renderGroup(customGroupLabel ?? t('preferences.documentProperties.group.mine'), visibleCustomPresets)}
          {normalizedQuery && visibleSystemPresets.length === 0 && visibleCustomPresets.length === 0 && (
            <div className="agent-composer__note-empty">{t('document.properties.picker.empty')}</div>
          )}
          <div role="separator" aria-hidden="true" className={POPUP_SEPARATOR_CLASS} />
          <button type="button" disabled={disabled} onClick={onManage} className="!mt-1 flex h-8 w-full items-center rounded-lg px-2 text-left text-sm text-[var(--foreground)] hover:bg-[var(--hover-bg)] disabled:opacity-50">
            预设属性管理
          </button>
        </div>
      </OverlayScrollbar>
    </PopoverContent>
  </Popover>;
}
