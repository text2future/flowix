/**
 * Key-cell picker. Replaces the plain `<Input>` previously used for the
 * key column in `note-properties-dialog.tsx`.
 *
 * Two popups, two responsibilities:
 *  - Picker (mode === 'picker'): shown when the user clicks the trigger
 *    button. Lists `PRESETS` by label only — no type column, no value
 *    column. The user is just deciding "which field is at this position".
 *  - CustomInputPanel (mode === 'custom'): shown when the user clicks
 *    "Custom property" in the picker. This is where the field is
 *    *defined*: key + display name + type chip group, all editable in
 *    one shot so a single commit finalizes key / 名称 / 类型 / 可能的选项.
 */

import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { CaretDownIcon } from '@phosphor-icons/react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { Input } from '@shared/ui/input';
import { useI18n, translate, type AppLanguage, type I18nKey } from '@features/i18n';
import { cn } from '@/lib/utils';
import {
  isReservedKey,
  PRESETS,
  PROPERTY_KINDS,
  resolvePreset,
  RESERVED_KEYS,
  type PropertyKind,
  type PropertyPreset,
} from '@features/document/properties/presets';

export type { PropertyKind };

interface CustomCommitPayload {
  key: string;
  customLabel: string;
  /** Always carried — the Custom popup is the field's complete-definition
   *  entry point and finalizes key / display name / type in one commit. */
  type: PropertyKind;
}

interface PresetKeyCellProps {
  value: string;
  customLabel?: string;
  type?: PropertyKind;
  onChange: (next: string) => void;
  onCustomCommit: (payload: CustomCommitPayload) => void;
  disabled?: boolean;
  invalid?: boolean;
}

const SPECIAL_KEY_FIELD = 'key';

function readReservedKeyError(language: AppLanguage): (key: string) => string {
  const template = translate(language, 'document.properties.picker.reservedKeyError');
  return (key: string) =>
    template.includes('{key}')
      ? template.replace('{key}', key)
      : template;
}

// PropertyKind (PascalCase) → i18n key 后缀 的映射。 'MultiSelect' 是
// camelCase (不是纯小写), 不能直接 .toLowerCase() — 显式列举保证映射
// 准确, 后续加新类型时强制在这里登记。
const KIND_LABEL_KEY: Record<PropertyKind, I18nKey> = {
  Text: 'document.properties.type.text',
  Number: 'document.properties.type.number',
  Date: 'document.properties.type.date',
  URL: 'document.properties.type.url',
  Icon: 'document.properties.type.icon',
  Select: 'document.properties.type.select',
  MultiSelect: 'document.properties.type.multiSelect',
};

function getKindLabel(kind: PropertyKind, t: (key: I18nKey) => string): string {
  return t(KIND_LABEL_KEY[kind]);
}

export function PresetKeyCell({
  value,
  customLabel,
  type,
  onChange,
  onCustomCommit,
  disabled = false,
  invalid = false,
}: PresetKeyCellProps) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'picker' | 'custom'>('picker');

  const preset = resolvePreset(value);
  const isReservedMemoId = value.trim() === SPECIAL_KEY_FIELD;

  useEffect(() => {
    if (!open) {
      setMode('picker');
    }
  }, [open]);

  const applyPreset = (next: PropertyPreset) => {
    onChange(next.key);
    setOpen(false);
  };

  const startCustom = () => {
    setMode('custom');
  };

  return (
    <DropdownMenu open={open && !disabled} onOpenChange={disabled ? undefined : setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={t('document.properties.picker.triggerLabel')}
          className={cn(
            'flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-background px-2 text-left text-sm transition-colors',
            'hover:bg-[var(--muted)]/40 focus-visible:border-[var(--primary)] focus-visible:outline-none',
            'data-[state=open]:border-[var(--primary)]',
            invalid && 'border-[var(--destructive)]',
            disabled && 'cursor-not-allowed opacity-50'
          )}
        >
          {preset ? (
            <span className="min-w-0 flex-1 truncate">{t(preset.labelKey)}</span>
          ) : isReservedMemoId ? (
            <span className="font-mono text-xs text-[var(--muted-foreground)]">{SPECIAL_KEY_FIELD}</span>
          ) : customLabel?.trim() ? (
            <span className="min-w-0 flex-1 truncate">{customLabel}</span>
          ) : value.trim() ? (
            <TriggerCustom value={value} />
          ) : (
            <span className="min-w-0 flex-1 truncate text-[var(--muted-foreground)]">{t('document.properties.keyPlaceholder')}</span>
          )}
          <CaretDownIcon
            className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)] transition-transform duration-150 [[data-state=open]_&]:rotate-180"
            weight="bold"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        className={cn(
          'min-w-[260px] px-1 py-1.5',
          mode === 'custom' ? 'space-y-0' : 'space-y-1'
        )}
      >
        {mode === 'picker' ? (
          <PickerList
            t={t}
            currentKey={value}
            onPickPreset={applyPreset}
            onPickCustom={startCustom}
          />
        ) : (
          <CustomInputPanel
            t={t}
            language={language}
            initialKey={value}
            initialLabel={customLabel ?? ''}
            initialType={type ?? 'Text'}
            onBack={() => setMode('picker')}
            onCommit={onCustomCommit}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PickerList({
  t,
  currentKey,
  onPickPreset,
  onPickCustom,
}: {
  t: (key: I18nKey, params?: Record<string, string | number>) => string;
  currentKey: string;
  onPickPreset: (preset: PropertyPreset) => void;
  onPickCustom: () => void;
}) {
  return (
    <>
      {PRESETS.map((preset) => {
        const isSelected = currentKey.trim() === preset.key;
        return (
          <DropdownMenuItem
            key={preset.key}
            onClick={() => onPickPreset(preset)}
            className="flex cursor-pointer items-center justify-between rounded-md px-2 hover:bg-[var(--muted)]"
          >
            <span className="truncate">{t(preset.labelKey)}</span>
            {isSelected && (
              <Check className="h-4 w-4 shrink-0 text-[var(--primary)]" />
            )}
          </DropdownMenuItem>
        );
      })}
      {/* Custom 选项用普通 button 而非 DropdownMenuItem:
          DropdownMenuItem 默认 click 后会关闭菜单, 而 Custom 要留在菜单
          内切换到 free-input 面板, 不能关闭。 样式与 DropdownMenuItem
          对齐以保持视觉一致。 */}
      <button
        type="button"
        onClick={onPickCustom}
        className="flex w-full cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-left text-sm text-[var(--foreground)] outline-none hover:bg-[var(--muted)]"
      >
        <span className="truncate">{t('document.properties.picker.customPrompt')}</span>
      </button>
    </>
  );
}

function CustomInputPanel({
  t,
  language,
  initialKey,
  initialLabel,
  initialType,
  onBack,
  onCommit,
}: {
  t: (key: I18nKey, params?: Record<string, string | number>) => string;
  language: AppLanguage;
  initialKey: string;
  initialLabel: string;
  initialType: PropertyKind;
  onBack: () => void;
  onCommit: (payload: CustomCommitPayload) => void;
}) {
  const [draftKey, setDraftKey] = useState(initialKey);
  const [draftLabel, setDraftLabel] = useState(initialLabel);
  const [draftType, setDraftType] = useState<PropertyKind>(initialType);
  const [error, setError] = useState<string | null>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // 切到 custom 面板时聚焦到 key input, 让用户直接打字。
    const id = window.setTimeout(() => keyInputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);

  const handleCommit = () => {
    const nextKey = draftKey.trim();
    if (!nextKey) {
      const formatReserved = readReservedKeyError(language);
      setError(formatReserved(draftKey));
      return;
    }
    if (isReservedKey(nextKey)) {
      const formatReserved = readReservedKeyError(language);
      setError(formatReserved(nextKey));
      return;
    }
    // 类型始终携带: 该弹窗是字段的"完整定义"入口, 一次提交定下
    // key / 展示名 / 类型。 即便用户没动类型 chip, dialog 也会拿当前
    // draftType 落盘, 跟行原 type 一致 — 行为等价但接口统一。
    onCommit({
      key: nextKey,
      customLabel: draftLabel.trim(),
      type: draftType,
    });
  };

  return (
    <div
      className="flex flex-col gap-2 px-2 py-1.5"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onBack();
        }
      }}
    >
      <Field label={t('document.properties.picker.customKeyLabel')}>
        <Input
          ref={keyInputRef}
          value={draftKey}
          onChange={(event) => {
            setDraftKey(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              handleCommit();
            }
          }}
          className="h-8"
          placeholder={t('document.properties.picker.customPlaceholder')}
        />
      </Field>

      <Field label={t('document.properties.picker.customDisplayNameLabel')}>
        <Input
          value={draftLabel}
          onChange={(event) => setDraftLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              handleCommit();
            }
          }}
          className="h-8"
          placeholder={t('document.properties.picker.customDisplayNamePlaceholder')}
        />
      </Field>

      <Field label={t('document.properties.picker.customTypeLabel')}>
        <div className="flex flex-wrap gap-1">
          {PROPERTY_KINDS.map((kind) => {
            const selected = kind === draftType;
            return (
              <button
                key={kind}
                type="button"
                onClick={() => setDraftType(kind)}
                className={cn(
                  'h-7 rounded-md px-2 text-xs transition-colors',
                  selected
                    ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                    : 'bg-[var(--muted)] text-[var(--foreground)] hover:bg-[var(--muted)]/70'
                )}
              >
                {getKindLabel(kind, t)}
              </button>
            );
          })}
        </div>
      </Field>

      {error && (
        <div className="text-xs text-[var(--destructive)]">{error}</div>
      )}

      <div className="flex items-center justify-between gap-2 pt-1">
        <button
          type="button"
          onClick={onBack}
          className="h-7 rounded-md px-2 text-xs text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
        >
          {t('document.properties.picker.customBack')}
        </button>
        <button
          type="button"
          onClick={handleCommit}
          className="h-7 rounded-md bg-[var(--primary)] px-3 text-xs text-[var(--primary-foreground)] hover:opacity-90"
        >
          {t('document.properties.picker.customConfirm')}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
        {label}
      </span>
      {children}
    </label>
  );
}

function TriggerCustom({ value }: { value: string }) {
  const { t } = useI18n();
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="min-w-0 flex-1 truncate font-mono text-[var(--foreground)]">{value}</span>
      <span className="shrink-0 rounded-md bg-[var(--muted)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">
        {t('document.properties.customBadge')}
      </span>
    </span>
  );
}

// 重新 export RESERVED_KEYS 给上层 dialog 复用。
export { RESERVED_KEYS };
