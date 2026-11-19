'use client';

import { TrashIcon } from '@phosphor-icons/react';
import { Plus } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import type { AiMemoryLocation } from '@/lib/constants';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import { FIELD_INPUT_CLASS, SectionHeader } from '@features/preferences/sections/primitives';
import { useComposingValue } from '@shared/hooks/use-composing-value';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Textarea } from '@shared/ui/textarea';

const MEMORY_PATH_INVALID_CHARACTERS = /[\\<>:"|?*`]/;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) <= 0x1f);
}

function isEditableMemoryPath(path: string): boolean {
  return !path.startsWith('/')
    && !path.includes('//')
    && !hasControlCharacter(path)
    && !MEMORY_PATH_INVALID_CHARACTERS.test(path)
    && !path.split('/').some((segment) =>
      segment === '.' || segment === '..' || segment.endsWith('.') || segment.endsWith(' '),
    );
}

function createLocationId(): string {
  return `custom-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

export function MemoryPreferencesTab() {
  const { t } = useI18n();
  const locations = useUserSettingsStore((state) => state.settings.aiMemoryLocations);
  const personality = useUserSettingsStore((state) => state.settings.aiPersonality);
  const updateSettings = useUserSettingsStore((state) => state.updateSettings);
  const personalityInput = useComposingValue(personality, (value) => {
    void updateSettings({ aiPersonality: value });
  });

  const updateLocation = (id: string, updates: Partial<AiMemoryLocation>) => {
    void updateSettings({
      aiMemoryLocations: locations.map((location) =>
        location.id === id ? { ...location, ...updates } : location,
      ),
    });
  };

  const addLocation = () => {
    void updateSettings({
      aiMemoryLocations: [...locations, { id: createLocationId(), name: '', path: '' }],
    });
  };

  const removeLocation = (id: string) => {
    void updateSettings({ aiMemoryLocations: locations.filter((location) => location.id !== id) });
  };

  return (
    <section className="space-y-5">
      <SectionHeader
        title={t('preferences.memory.title')}
        description={t('preferences.memory.description')}
      />

      <div className="space-y-3">
        <div className="hidden grid-cols-[10rem_minmax(0,28rem)_1.75rem] items-center gap-x-6 gap-y-3 sm:grid">
          <span className="text-xs font-medium text-[var(--muted-foreground)]">
            {t('preferences.memory.columns.scene')}
          </span>
          <span className="text-xs font-medium text-[var(--muted-foreground)]">
            {t('preferences.memory.columns.folder')}
          </span>
          <span aria-hidden="true" />
        </div>
        {locations.map((location) => {
          const isGeneral = location.id === 'general';
          const nameKey = location.id === 'general'
            ? 'preferences.memory.locations.general'
            : location.id === 'solution'
              ? 'preferences.memory.locations.solution'
              : location.id === 'workflow'
                ? 'preferences.memory.locations.workflow'
                : null;
          const usesDefaultBuiltinName = isGeneral
            || (location.id === 'solution' && location.name === '方案')
            || (location.id === 'workflow' && location.name === '工作流');
          const name = nameKey && usesDefaultBuiltinName ? t(nameKey) : location.name;
          const pathPlaceholderKey = location.id === 'solution'
            ? 'preferences.memory.locations.solutionPathPlaceholder'
            : location.id === 'workflow'
              ? 'preferences.memory.locations.workflowPathPlaceholder'
              : 'preferences.memory.locations.pathPlaceholder';
          const nameInputId = `ai-memory-name-${location.id}`;
          const pathInputId = `ai-memory-path-${location.id}`;

          return (
            <div
              key={location.id}
              className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[10rem_minmax(0,28rem)_1.75rem] sm:gap-x-6 sm:gap-y-3"
            >
              <div className="min-w-0">
                <span className="mb-1 block text-xs text-[var(--muted-foreground)] sm:hidden">
                  {t('preferences.memory.columns.scene')}
                </span>
                {isGeneral ? (
                  <label htmlFor={pathInputId} className="text-sm text-[var(--foreground)]">
                    {name}
                  </label>
                ) : (
                  <Input
                    id={nameInputId}
                    aria-label={t('preferences.memory.locations.name')}
                    className={`${FIELD_INPUT_CLASS} h-8 w-full`}
                    value={name}
                    placeholder={t('preferences.memory.locations.namePlaceholder')}
                    maxLength={64}
                    autoComplete="off"
                    onChange={(event) => {
                      const nameValue = event.target.value;
                      if (!hasControlCharacter(nameValue) && !/[/\\]/.test(nameValue)) {
                        updateLocation(location.id, { name: nameValue });
                      }
                    }}
                    onBlur={() => {
                      const nameValue = location.name.trim();
                      if (!nameValue && (location.id === 'solution' || location.id === 'workflow')) {
                        updateLocation(location.id, { name: location.id === 'solution' ? '方案' : '工作流' });
                      } else if (nameValue !== location.name) {
                        updateLocation(location.id, { name: nameValue });
                      }
                    }}
                  />
                )}
              </div>
              {!isGeneral && (
                <label htmlFor={pathInputId} className="sr-only">
                  {`${name || t('preferences.memory.locations.name')} ${t('preferences.memory.locations.path')}`}
                </label>
              )}
              <div className="min-w-0">
                <span className="mb-1 block text-xs text-[var(--muted-foreground)] sm:hidden">
                  {t('preferences.memory.columns.folder')}
                </span>
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 text-sm text-[var(--brand)]">
                    {t('preferences.memory.locations.notebookPrefix')} /
                  </span>
                  <Input
                    id={pathInputId}
                    aria-label={isGeneral ? name : `${name || t('preferences.memory.locations.name')} ${t('preferences.memory.locations.path')}`}
                    className={`${FIELD_INPUT_CLASS} h-8 w-4/5`}
                    value={location.path}
                    placeholder={t(pathPlaceholderKey)}
                    maxLength={512}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => {
                      const path = event.target.value;
                      if (isEditableMemoryPath(path)) updateLocation(location.id, { path });
                    }}
                    onBlur={() => {
                      const path = location.path.trim().replace(/\/+$/, '');
                      if (path !== location.path) updateLocation(location.id, { path });
                    }}
                  />
                </div>
              </div>
              {location.id === 'general' ? (
                <span className="hidden size-7 sm:block" aria-hidden="true" />
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-lg"
                  aria-label={t('preferences.memory.locations.remove')}
                  onClick={() => removeLocation(location.id)}
                >
                  <TrashIcon aria-hidden="true" />
                </Button>
              )}
            </div>
          );
        })}
      </div>

      <Button
        type="button"
        variant="outline"
        className="h-8 gap-0.5"
        style={{ marginTop: '20px' }}
        onClick={addLocation}
      >
        <Plus className="size-3.5" aria-hidden="true" />
        {t('preferences.memory.locations.add')}
      </Button>

      <div className="space-y-3" style={{ marginTop: '40px' }}>
        <SectionHeader title={t('preferences.memory.personality.title')} />
        <Textarea
          aria-label={t('preferences.memory.personality.title')}
          className={`${FIELD_INPUT_CLASS} min-h-24 resize-y rounded-xl`}
          placeholder={t('preferences.memory.personality.placeholder')}
          maxLength={500}
          value={personalityInput.value}
          onChange={personalityInput.onChange}
          onCompositionStart={personalityInput.onCompositionStart}
          onCompositionEnd={personalityInput.onCompositionEnd}
        />
      </div>

      <aside
        role="note"
        className="space-y-2"
      >
        <h4 className="text-sm font-medium text-[var(--muted-foreground)]">
          {t('preferences.memory.guide.title')}
        </h4>
        <p className="text-sm text-[var(--muted-foreground)]">
          {t('preferences.memory.guide.lead')}
        </p>
        <ul className="flex flex-col items-start gap-2 text-sm text-[var(--muted-foreground)]">
          <li className="w-fit max-w-full rounded-[8px_16px_8px_8px] bg-[var(--muted)] px-3 py-2">
            {t('preferences.memory.guide.plan')}
          </li>
          <li className="w-fit max-w-full rounded-[8px_16px_8px_8px] bg-[var(--muted)] px-3 py-2">
            {t('preferences.memory.guide.workflow')}
          </li>
          <li className="w-fit max-w-full rounded-[8px_16px_8px_8px] bg-[var(--muted)] px-3 py-2">
            {t('preferences.memory.guide.pitfall')}
          </li>
        </ul>
      </aside>
    </section>
  );
}
