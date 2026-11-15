import { useEffect, useMemo, useRef, useState } from 'react';
import { PopupScrollArea } from '@shared/ui/popup-scroll-area';
import { POPUP_SEPARATOR_CLASS } from '@shared/ui/popup-separator';
import { getPropertyTypeDefinition } from '@/lib/property-types';
import type { I18nKey } from '@/lib/i18n';
import { moveNameAndDescriptionPresetsToEnd, type PropertyPreset } from '@features/document/properties/presets';
import { canonicalizePropertyKey } from '@features/properties/property-key';

function findMatchingPreset(presets: readonly PropertyPreset[], key: string) {
  const normalizedKey = canonicalizePropertyKey(key).toLocaleLowerCase();
  return presets.find((preset) => (
    canonicalizePropertyKey(preset.key).toLocaleLowerCase() === normalizedKey
  )) ?? null;
}

export function FrontmatterPropertyKeyPicker({
  presets,
  propertyKey,
  t,
  onSelect,
}: {
  presets: readonly PropertyPreset[];
  propertyKey: string;
  t: (key: I18nKey) => string;
  onSelect: (preset: PropertyPreset) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [searchText, setSearchText] = useState('');
  const isComposingRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const selectedPreset = findMatchingPreset(presets, propertyKey);
  const visiblePresets = useMemo(() => presets.filter((preset) => (
    !normalizedQuery
    || preset.label.toLocaleLowerCase().includes(normalizedQuery)
    || preset.key.toLocaleLowerCase().includes(normalizedQuery)
  )), [normalizedQuery, presets]);
  const builtinPresets = moveNameAndDescriptionPresetsToEnd(
    visiblePresets.filter((preset) => preset.source === 'builtin'),
    (preset) => preset.key,
  );
  const customPresets = visiblePresets.filter((preset) => preset.source === 'custom');

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

  const renderGroup = (label: string, items: PropertyPreset[]) => items.length > 0 && (
    <section role="group" aria-label={label} className="space-y-0.5">
      <p className="agent-thread-card__codex-settings-title">{label}</p>
      {items.map((preset) => {
        const selected = selectedPreset?.key === preset.key;
        return (
          <button
            key={`${preset.source}:${preset.key}`}
            type="button"
            role="option"
            aria-selected={selected}
            title={preset.label}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setOpen(false);
              onSelect(preset);
            }}
            className="frontmatter-property__edit-key-preset-option flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-1.5 text-left text-sm hover:bg-[var(--hover-bg)]"
          >
            <span className="min-w-0 flex-1 truncate">{preset.label}</span>
            <span className="shrink-0 text-right text-xs text-[var(--muted-foreground)]">
              {t(getPropertyTypeDefinition(preset.kind).labelKey)}
            </span>
          </button>
        );
      })}
    </section>
  );

  return (
    <div className="frontmatter-property__edit-key-preset-picker">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('document.properties.presetProperties')}
        title={selectedPreset?.label ?? t('document.properties.addFieldPanel.input')}
        className="frontmatter-property__edit-key-preset-trigger"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="frontmatter-property__edit-key-preset-trigger-label">
          {selectedPreset?.label ?? t('document.properties.addFieldPanel.input')}
        </span>
      </button>
      {open && (
        <div className="frontmatter-property__edit-key-preset-menu flex max-h-[60vh] flex-col overflow-hidden rounded-xl p-1.5 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
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
          <PopupScrollArea
            className="overlay-scrollbar-frame--edge-aligned min-h-0 max-h-[calc(60vh-60px)] flex-1"
            scrollerClassName="min-h-0 max-h-[calc(60vh-60px)] "
          >
            <div role="listbox" className="space-y-2">
              {renderGroup(t('preferences.documentProperties.group.presets'), builtinPresets)}
              {renderGroup(t('preferences.documentProperties.group.mine'), customPresets)}
              {normalizedQuery && visiblePresets.length === 0 && (
                <div className="agent-composer__note-empty">
                  {t('document.properties.picker.empty')}
                </div>
              )}
            </div>
          </PopupScrollArea>
        </div>
      )}
    </div>
  );
}
