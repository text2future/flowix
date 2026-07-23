'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronLeft, ChevronRight, Plus, Trash2, X } from 'lucide-react';
import { CalendarBlankIcon, CaretDownIcon } from '@phosphor-icons/react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@shared/ui/dialog';
import { Input } from '@shared/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { useI18n, translate, type AppLanguage } from '@features/i18n';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import {
  PRESETS,
  PROPERTY_KINDS,
  resolvePreset,
  type PropertyKind,
  type PropertyPreset,
} from '@features/document/properties/presets';
import { SelectValueInput } from '@features/document/properties/select-value-input';
import { MultiSelectValueInput } from '@features/document/properties/multi-select-value-input';
import { IconValueInput } from '@features/document/properties/icon-value-input';
import {
  canonicalizePropertyKey,
  generatePropertyKey,
} from '@features/document/properties/property-key';
import {
  extractFrontmatter,
  replaceVisibleFrontmatterProperties,
} from '@features/document/properties/frontmatter-model';
import type { PropertyFieldConfig } from '@/lib/constants';
import { cn } from '@/lib/utils';

function getWeekdayKeys(): Array<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'> {
  return ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
}

type PropertyType = PropertyKind;

interface PropertyRow {
  id: string;
  key: string;
  type: PropertyType;
  value: string;
  /** Optional preset binding. Drives the key-cell label/icon and the value
   *  cell's option list for Select / MultiSelect rows. Not written to YAML. */
  preset?: PropertyPreset;
  /** Custom 展示名 (UI-only, 不写入 YAML)。 命中预设时此字段被忽略 —
   *  trigger 走 preset.labelKey。 仅对未命中预设的自由 key 生效,
   *  非空时替换 raw key 的显示。 */
  customLabel?: string;
  /** 用户为 Select / MultiSelect 自定义的选项列表 (UI-only, 不写入 YAML)。
   *  命中预设时此字段被忽略, 走 preset.options; Custom 行读此字段。
   *  设计取舍: 选项不持久化, 关闭重开会丢, 用户接受即可 — 与 preset 同
   *  处理方式保持一致 ("类型" 等预设的 options 也是 UI-only)。 */
  options?: string[];
}

type PopoverAnchor = { top: number; left: number; width: number; height: number };

interface NotePropertiesDialogProps {
  open: boolean;
  content: string;
  onOpenChange: (open: boolean) => void;
  onSave: (nextContent: string) => void | Promise<void>;
}

const FIELD_POPOVER_WIDTH = 240;
const FIELD_POPOVER_MAX_HEIGHT = 280;
const FIELD_POPOVER_SIDE_OFFSET = 4;
const FIELD_POPOVER_VIEWPORT_MARGIN = 8;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

// PROPERTY_TYPES \u5728 dialog \u4E2D\u539F\u672C\u662F\u7C7B\u578B\u5217 dropdown \u7684\u5FAA\u73AF\u6E90, \u73B0\u5728\u7C7B\u578B
// \u5217\u5DF2\u53BB\u6389, \u8FD9\u91CC\u4FDD\u7559\u4E00\u4E2A\u5F15\u7528\u4EE5\u5907 PRESETS \u4E4B\u5916\u7684\u7C7B\u578B\u76F8\u5173\u67E5\u8BE2 (\u4F8B\u5982
// \u65E7 memo \u52A0\u8F7D\u65F6 rowsFromData \u63A8\u65AD type)\u3002 PresetKeyCell \u5185\u90E8 chip group
// \u76F4\u63A5\u8D70 presets.ts \u7684 PROPERTY_KINDS, \u4E0D\u7ECF\u8FC7\u672C\u6587\u4EF6\u3002

const URL_RE = /^https?:\/\/\S+$/i;
let rowIdSeq = 0;

function createRowId(): string {
  rowIdSeq += 1;
  return `property-${rowIdSeq}`;
}

function inferType(value: unknown): PropertyType {
  // 数组 → MultiSelect (旧 Tags 已合并到 MultiSelect)。
  if (Array.isArray(value)) return 'MultiSelect';
  if (typeof value === 'number') return 'Number';
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Date';
    if (URL_RE.test(value)) return 'URL';
  }
  return 'Text';
}

function stringifyValue(value: unknown, type: PropertyType): string {
  if (type === 'MultiSelect') {
    return Array.isArray(value) ? value.map((item) => String(item)).join(', ') : String(value ?? '');
  }
  if (value === null || value === undefined) return '';
  return String(value);
}

function rowsFromData(
  data: Record<string, unknown>,
  savedFieldsByKey: Map<string, PropertyFieldConfig> = new Map()
): PropertyRow[] {
  const hasCanonicalTags = Object.prototype.hasOwnProperty.call(data, 'tags');
  return Object.entries(data)
    .filter(([key]) => key.trim() !== 'key' && !(key === 'tag' && hasCanonicalTags))
    .map(([sourceKey, value]) => {
      const key = canonicalizePropertyKey(sourceKey);
      const preset = resolvePreset(key);
      const savedField = savedFieldsByKey.get(key);
      // 预设命中时优先用 preset.kind, 这样 'type' 不会被推断成 Text,
      // 'agent-role' 也能被识别成预设。 Custom (resolvePreset → null)
      // 走老路的 inferType, 保持向后兼容。
      const type: PropertyType = preset
        ? (preset.kind as PropertyType)
        : (savedField?.type ?? inferType(value));
      return {
        id: createRowId(),
        key,
        type,
        value: stringifyValue(value, type),
        preset: preset ?? undefined,
        customLabel: preset ? undefined : savedField?.name,
        options: preset ? undefined : savedField?.options,
      };
    });
}

function convertRowValue(row: PropertyRow): unknown {
  const value = row.value.trim();
  switch (row.type) {
    case 'Number': {
      if (!value) return '';
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : value;
    }
    case 'MultiSelect':
      return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    case 'Select': {
      // 空 Select 表示 "未选择" — 写入时跳过整行, 不留 `key: ''`。
      if (!value) return null;
      return value;
    }
    case 'Date':
    case 'URL':
    case 'Text':
    default:
      return row.value;
  }
}

function normalizeFieldOptions(type: PropertyType, options: string[] | undefined): string[] | undefined {
  if (type !== 'Select' && type !== 'MultiSelect') return undefined;
  const normalized = (options ?? [])
    .map((option) => option.trim())
    .filter(Boolean);
  return [...new Set(normalized)];
}

function buildContentWithFrontmatter(content: string, rows: PropertyRow[]): string {
  return replaceVisibleFrontmatterProperties(
    content,
    rows.flatMap((row) => {
      const key = row.key.trim();
      if (!key) return [];
      const value = convertRowValue(row);
      return value === null ? [] : [{ key, value }];
    }),
  );
}

function getDuplicateKeys(rows: PropertyRow[]): Set<string> {
  const counts = new Map<string, number>();
  rows.forEach((row) => {
    const key = row.key.trim();
    if (!key) return;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key));
}

function coerceValueForType(value: string, nextType: PropertyType): string {
  if (nextType === 'Date') {
    const match = value.match(/\d{4}-\d{2}-\d{2}/);
    return match?.[0] ?? '';
  }
  return value;
}

function parseDateValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

function formatDateValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getMonthDays(viewMonth: Date): Array<{ date: Date; inMonth: boolean }> {
  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const firstDay = new Date(year, month, 1);
  const firstWeekday = (firstDay.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - firstWeekday);

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return { date, inMonth: date.getMonth() === month };
  });
}

function getMonthTitle(t: (key: any, params?: Record<string, string | number>) => string, date: Date): string {
  return t('document.properties.monthTitle', {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
  });
}

function getPropertyTypeLabelKey(kind: PropertyType) {
  return `document.properties.type.${kind === 'MultiSelect' ? 'multiSelect' : kind.toLowerCase()}` as
    | 'document.properties.type.text'
    | 'document.properties.type.number'
    | 'document.properties.type.date'
    | 'document.properties.type.url'
    | 'document.properties.type.icon'
    | 'document.properties.type.select'
    | 'document.properties.type.multiSelect';
}

function DateValueInput({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const { t, language } = useI18n();
  const settingsLanguage = useUserSettingsStore((store) => store.settings.language);
  // 同步当前 user settings 语言; 跟 i18n provider 同源 ── 即便 Provider
  // 因为 react 批处理有微小延迟, 这里也能拿到最新值。
  const effectiveLanguage = (settingsLanguage ?? language) as AppLanguage;
  const [open, setOpen] = useState(false);
  const selectedDate = parseDateValue(value);
  const [viewMonth, setViewMonth] = useState(() => selectedDate ?? new Date());

  useEffect(() => {
    if (selectedDate) {
      setViewMonth(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
    }
  }, [selectedDate?.getFullYear(), selectedDate?.getMonth()]);

  const monthDays = useMemo(() => getMonthDays(viewMonth), [viewMonth]);

  // 周列标签: zh-CN "一/二/..."; en-US "Mon/Tue/..."。优先用 i18n key 走
  // locales.ts; 静态 hook 之外用 translate(language, ...)。
  const weekdayLabels = useMemo(() => {
    const keys = getWeekdayKeys();
    return keys.map((key) => translate(effectiveLanguage, `document.properties.weekdays.${key}` as const));
  }, [effectiveLanguage]);

  const changeMonth = (offset: number) => {
    setViewMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1));
  };

  const selectDate = (date: Date) => {
    onChange(formatDateValue(date));
    setOpen(false);
  };

  const clearDate = (event: React.MouseEvent) => {
    event.stopPropagation();
    onChange('');
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'group flex h-8 w-full items-center gap-2 rounded-lg border border-input bg-background px-2.5 text-left text-sm transition-colors',
            'hover:bg-[var(--muted)]/40 focus-visible:border-[var(--primary)] focus-visible:outline-none',
            open && 'border-[var(--primary)]',
            disabled && 'cursor-not-allowed opacity-50'
          )}
        >
          <CalendarBlankIcon
            className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]"
            weight="regular"
            aria-hidden="true"
          />
          <span className={cn('min-w-0 flex-1 truncate', value ? 'text-[var(--foreground)]' : 'text-[var(--muted-foreground)]')}>
            {value || t('document.properties.selectDate')}
          </span>
          {value && !disabled && (
            <span
              role="button"
              tabIndex={-1}
              onClick={clearDate}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--muted-foreground)] opacity-0 transition-opacity hover:bg-[var(--muted)] hover:text-[var(--foreground)] group-hover:opacity-100 group-focus-visible:opacity-100"
              aria-label={t('document.properties.clearDate')}
            >
              <X className="h-3.5 w-3.5" />
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[272px] rounded-xl border border-[var(--border)] bg-[var(--card)] p-2 shadow-xl"
      >
        <div className="rounded-lg bg-[var(--card)]">
          <div className="mb-2 flex items-center justify-between px-1">
            <button
              type="button"
              onClick={() => changeMonth(-1)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
              aria-label={t('document.properties.prevMonth')}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="text-sm font-medium text-[var(--foreground)]">
              {getMonthTitle(t, viewMonth)}
            </div>
            <button
              type="button"
              onClick={() => changeMonth(1)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
              aria-label={t('document.properties.nextMonth')}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 px-1 pb-1 text-center text-[11px] font-medium text-[var(--muted-foreground)]">
            {weekdayLabels.map((label) => (
              <div key={label} className="flex h-6 items-center justify-center">
                {label}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {monthDays.map(({ date, inMonth }) => {
              const dateValue = formatDateValue(date);
              const isSelected = value === dateValue;
              const isToday = dateValue === formatDateValue(new Date());

              return (
                <button
                  key={dateValue}
                  type="button"
                  onClick={() => selectDate(date)}
                  className={cn(
                    'flex h-8 items-center justify-center rounded-md text-sm transition-colors',
                    inMonth ? 'text-[var(--foreground)]' : 'text-[var(--muted-foreground)] opacity-45',
                    'hover:bg-[var(--muted)] hover:text-[var(--foreground)]',
                    isToday && !isSelected && 'ring-1 ring-inset ring-[var(--border)]',
                    isSelected && 'bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary)] hover:text-[var(--primary-foreground)]'
                  )}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function NotePropertiesDialog({
  open,
  content,
  onOpenChange,
  onSave,
}: NotePropertiesDialogProps) {
  const { t } = useI18n();
  const savedPropertyFields = useUserSettingsStore((store) => store.settings.properties.fields);
  const updateUserSettings = useUserSettingsStore((store) => store.updateSettings);
  const frontmatter = useMemo(() => extractFrontmatter(content), [content]);
  const savedFieldsByKey = useMemo(() => {
    return new Map(savedPropertyFields.map((field) => [field.key, field]));
  }, [savedPropertyFields]);
  const savedFieldsByKeyRef = useRef(savedFieldsByKey);
  const [rows, setRows] = useState<PropertyRow[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  // 共享 Popover 状态: 既用于 "添加属性" 按钮 (mode='add'), 也用于
  // 行内 key cell 点击 (mode='edit')。 anchor 记录触发按钮的 viewport
  // 坐标, AnchoredPropertyPopover 再决定显示在按钮上方或下方。
  const [popoverState, setPopoverState] = useState<{
    open: boolean;
    mode: 'add' | 'edit';
    rowId: string | null;
    anchor: PopoverAnchor | null;
  }>({
    open: false,
    mode: 'add',
    rowId: null,
    anchor: null,
  });

  const closePopover = () => {
    setPopoverState({
      open: false,
      mode: 'add',
      rowId: null,
      anchor: null,
    });
  };

  const openAddPopover = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setPopoverState({
      open: true,
      mode: 'add',
      rowId: null,
      anchor: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
    });
  };

  const openEditPopover = (row: PropertyRow, e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setPopoverState({
      open: true,
      mode: 'edit',
      rowId: row.id,
      anchor: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
    });
  };

  useEffect(() => {
    savedFieldsByKeyRef.current = savedFieldsByKey;
  }, [savedFieldsByKey]);

  useEffect(() => {
    if (!open) return;
    setRows(rowsFromData(frontmatter.data, savedFieldsByKeyRef.current));
  }, [frontmatter.data, open]);

  const duplicateKeys = useMemo(() => getDuplicateKeys(rows), [rows]);
  const hasInvalidKey = rows.some((row) => !row.key.trim());
  const canSave = !isSaving && !frontmatter.parseError && !hasInvalidKey && duplicateKeys.size === 0;

  const updateRow = (id: string, patch: Partial<PropertyRow>) => {
    setRows((current) => current.map((row) => {
      if (row.id !== id) return row;
      const nextType = patch.type ?? row.type;
      const nextValue = patch.type ? coerceValueForType(row.value, nextType) : row.value;
      return { ...row, ...patch, value: patch.value ?? nextValue };
    }));
  };

  // 直接添加一个预设行 (面板 "推荐" chip 命中)。 type 取 preset.kind,
  // value 留空。 选项走 preset.options (UI-only)。
  const addPresetRow = (preset: PropertyPreset) => {
    setRows((current) => [
      ...current,
      {
        id: createRowId(),
        key: preset.key,
        type: preset.kind as PropertyType,
        value: '',
        preset,
      },
    ]);
    closePopover();
  };

  const persistCustomFieldDefinition = (
    field: { key: string; name: string; type: PropertyType; options?: string[] },
    previousKey?: string
  ) => {
    const key = field.key.trim();
    const name = field.name.trim();
    if (!key || !name) return;
    const definition: PropertyFieldConfig = {
      key,
      name,
      type: field.type,
      options: normalizeFieldOptions(field.type, field.options),
    };
    const nextFields = [
      ...savedPropertyFields.filter((item) => item.key !== key && item.key !== previousKey),
      definition,
    ];
    void updateUserSettings({ properties: { fields: nextFields } });
  };

  // 自定义添加: name 是展示名, key 按固定 kebab-case 规则生成。
  const addCustomField = (payload: { name: string; type: PropertyType; options?: string[] }) => {
    const name = payload.name.trim();
    if (!name) return;
    const key = generatePropertyKey(name);
    const options = normalizeFieldOptions(payload.type, payload.options);
    setRows((current) => [
      ...current,
      {
        id: createRowId(),
        key,
        type: payload.type,
        value: '',
        customLabel: name,
        options,
      },
    ]);
    persistCustomFieldDefinition({ key, name, type: payload.type, options });
    closePopover();
  };

  const addSavedCustomField = (field: PropertyFieldConfig) => {
    setRows((current) => [
      ...current,
      {
        id: createRowId(),
        key: field.key,
        type: field.type,
        value: '',
        customLabel: field.name,
        options: normalizeFieldOptions(field.type, field.options),
      },
    ]);
    closePopover();
  };

  // 编辑现有行: 把整行替换成预设 — 重置 key/type/customLabel/options,
  // preset.options 由 preset 字段在渲染时取。 该路径会清空用户的 customLabel
  // 和 options, 因为切预设就是切语义, 旧的自定义数据不再适用。
  const switchRowToPreset = (id: string, preset: PropertyPreset) => {
    setRows((current) => current.map((row) => {
      if (row.id !== id) return row;
      return {
        ...row,
        key: preset.key,
        type: preset.kind as PropertyType,
        preset,
        customLabel: undefined,
        options: undefined,
      };
    }));
    closePopover();
  };

  // 编辑现有行: 自定义路径, 以展示名重新生成 key, 并更新 type/options。
  // 与 addCustomField 区别: 改的是已有行而不是 push 新行; preset 字段清掉。
  const updateRowFromEdit = (
    id: string,
    payload: { name: string; type: PropertyType; options?: string[] }
  ) => {
    const name = payload.name.trim();
    if (!name) return;
    const key = generatePropertyKey(name);
    const options = normalizeFieldOptions(payload.type, payload.options);
    const previousKey = rows.find((row) => row.id === id)?.key;
    setRows((current) => current.map((row) => {
      if (row.id !== id) return row;
      return {
        ...row,
        key,
        type: payload.type,
        customLabel: name,
        options,
        preset: undefined,
      };
    }));
    persistCustomFieldDefinition({ key, name, type: payload.type, options }, previousKey);
    closePopover();
  };

  const switchRowToSavedCustomField = (id: string, field: PropertyFieldConfig) => {
    setRows((current) => current.map((row) => {
      if (row.id !== id) return row;
      return {
        ...row,
        key: field.key,
        type: field.type,
        customLabel: field.name,
        options: normalizeFieldOptions(field.type, field.options),
        preset: undefined,
      };
    }));
    closePopover();
  };

  const removeRow = (id: string) => {
    setRows((current) => current.filter((row) => row.id !== id));
  };

  const handleSave = async () => {
    if (!canSave) return;
    setIsSaving(true);
    try {
      await onSave(buildContentWithFrontmatter(content, rows));
      onOpenChange(false);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[640px] max-w-[calc(100vw-32px)]">
        <DialogHeader>
          <DialogTitle>{t('document.properties.title')}</DialogTitle>
        </DialogHeader>

        <div className="mt-2 space-y-3">
          {frontmatter.parseError && (
            <div className="rounded-lg border border-[color-mix(in_oklch,var(--destructive)_35%,var(--border))] bg-[color-mix(in_oklch,var(--destructive)_8%,transparent)] px-3 py-2 text-xs text-[var(--destructive)]">
              {t('document.properties.yamlParseError')}
            </div>
          )}

          <div className="max-h-[360px] overflow-y-auto pr-1 [scrollbar-gutter:stable]">
            {/* 顶部列名 (字段 / 值) 已去掉 — 表头文案对引导式 picker 来说
                噪音大于信息, key 列触发键的 placeholder 已经说明了用法,
                值列因 type 不同形态各异也不宜硬贴一个 "值" 标签。 */}
            <div className="grid grid-cols-[minmax(88px,0.67fr)_minmax(192px,1.73fr)_32px] gap-2 pb-1">
              <span />
              <span />
              <span />
            </div>

            <div className="space-y-2">
              {rows.map((row) => {
                const keyInvalid = !row.key.trim() || duplicateKeys.has(row.key.trim());
                const isKeyField = row.key.trim() === 'key';
                // 类型列已去掉: 类型只在 Custom 弹窗内设置一次, 行内不再
                // 暴露 type 编辑入口。 row.type 仍用于值列分发 (MultiSelect /
                // Select / Date / 通用 Input) 与 Select 选项。
                // Select 的 option 列表优先级: row.options (自定义) >
                // row.preset.options (预设)。 MultiSelect 行无 option 上限,
                // 由用户在 chips 输入里随意加, 不读这个字段。
                const presetOptions = row.options ?? row.preset?.options ?? [];
                return (
                  <div
                    key={row.id}
                    className="grid grid-cols-[minmax(88px,0.67fr)_minmax(192px,1.73fr)_32px] items-center gap-2"
                  >
                    <PropertyKeyButton
                      row={row}
                      disabled={isKeyField}
                      invalid={keyInvalid}
                      onClick={(e: React.MouseEvent<HTMLButtonElement>) => openEditPopover(row, e)}
                    />
                    {row.type === 'MultiSelect' ? (
                      <MultiSelectValueInput
                        value={row.value}
                        disabled={isKeyField}
                        onChange={(value) => updateRow(row.id, { value })}
                      />
                    ) : row.type === 'Date' ? (
                      <DateValueInput
                        value={row.value}
                        disabled={isKeyField}
                        onChange={(value) => updateRow(row.id, { value })}
                      />
                    ) : row.type === 'Icon' ? (
                      <IconValueInput
                        value={row.value}
                        disabled={isKeyField}
                        onChange={(value) => updateRow(row.id, { value })}
                      />
                    ) : row.type === 'Select' ? (
                      <SelectValueInput
                        value={row.value}
                        options={presetOptions}
                        disabled={isKeyField}
                        onChange={(value) => updateRow(row.id, { value })}
                      />
                    ) : (
                      <Input
                        type={row.type === 'URL' ? 'url' : row.type === 'Number' ? 'number' : 'text'}
                        value={row.value}
                        onChange={(event) => updateRow(row.id, { value: event.target.value })}
                        disabled={isKeyField}
                        className="h-8"
                      />
                    )}
                    {isKeyField ? (
                      <div className="h-8 w-8" />
                    ) : (
                    <button
                      type="button"
                      onClick={() => removeRow(row.id)}
                      className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--destructive)]"
                      aria-label={t('document.properties.deleteField')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                    )}
                  </div>
                );
              })}
            </div>

            {rows.length === 0 && !frontmatter.parseError && (
              <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-[var(--border)] text-sm text-[var(--muted-foreground)]">
                {t('document.properties.empty')}
              </div>
            )}
          </div>

          {duplicateKeys.size > 0 && (
            <div className="text-xs text-[var(--destructive)]">{t('document.properties.duplicateKey')}</div>
          )}
          {hasInvalidKey && (
            <div className="text-xs text-[var(--destructive)]">{t('document.properties.emptyKey')}</div>
          )}

          {popoverState.open && popoverState.anchor && (
            <AnchoredPropertyPopover
              popoverState={popoverState}
              rows={rows}
              savedFields={savedPropertyFields}
              addPresetRow={addPresetRow}
              addCustomField={addCustomField}
              addSavedCustomField={addSavedCustomField}
              switchRowToPreset={switchRowToPreset}
              switchRowToSavedCustomField={switchRowToSavedCustomField}
              updateRowFromEdit={updateRowFromEdit}
              onCancel={closePopover}
            />
          )}

          {/* "添加属性" 按钮 — 单独挂在 Popover 外, 通过 openAddPopover
              把自己的 rect 写入 popoverState.anchor 触发 Popover 打开。
              这里不能用 PopoverTrigger asChild, 因为 PopoverTrigger 会
              接管 onClick 并尝试 toggle, 而我们想完全受控。 */}
          <button
            type="button"
            disabled={!!frontmatter.parseError}
            onClick={openAddPopover}
            className={cn(
              'inline-flex h-8 items-center gap-0.5 rounded-lg text-sm text-[var(--muted-foreground)] transition-colors',
              'hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-50',
              'data-[state=open]:text-[var(--foreground)]'
            )}
          >
            <Plus className="h-4 w-4 transition-transform duration-150 [[data-state=open]_&]:rotate-45" />
            {t('document.properties.addField')}
          </button>

          <div className="mt-2 flex flex-col gap-1.5">
            <span className="px-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
              {t('document.properties.addFieldPanel.common')}
            </span>
            <CommonPropertyChips
              savedFields={savedPropertyFields}
              onPickPreset={addPresetRow}
              onPickSavedField={addSavedCustomField}
              disabled={!!frontmatter.parseError}
            />
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)]"
          >
            {t('document.properties.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="h-8 rounded-lg bg-[var(--primary)] px-3 text-sm text-[var(--primary-foreground)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('document.properties.save')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 字段配置面板 — 同时支持 "新增" (mode='add') 与 "编辑" (mode='edit')。
 *
 *   推荐: 5 个 preset 一键添加/切换, 跳过 name/type 录入。
 *   输入: display name + type + (Select/MultiSelect) options, key 由
 *         display name 按固定 kebab-case 规则生成。
 *
 * 内部用 useState 管理 draft (而非外部受控), 由 initial props 初始化,
 * 用 useEffect 在 mode 或 initial props 变化时重置 — 让同一个 popover
 * 既能给 "添加属性" 用, 也能给 "行内 key cell" 用, 切行编辑不串味。
 */
function AddFieldPanel({
  mode,
  initialName,
  initialType,
  initialOptions,
  savedFields,
  onPickPreset,
  onPickSavedField,
  onSubmit,
  registerFlush,
}: {
  mode: 'add' | 'edit';
  initialName: string;
  initialType: PropertyType;
  initialOptions: string[];
  savedFields: PropertyFieldConfig[];
  onPickPreset: (preset: PropertyPreset) => void;
  onPickSavedField: (field: PropertyFieldConfig) => void;
  onSubmit: (payload: { name: string; type: PropertyType; options?: string[] }) => void;
  /**
   * 父级在需要"关闭前先尝试保存"时调用: 例如 overlay 点击 / Escape。
   * 我们提供一个无参 flush 函数, 内部用 ref 读取最新 draft state:
   * 名称非空则提交 (由 onSubmit 内部触发关闭), 否则什么都不做
   * (返回 false 让父级自己走 close)。
   */
  registerFlush?: (flush: () => boolean) => void;
}) {
  const { t } = useI18n();
  const [draftName, setDraftName] = useState(initialName);
  const [draftType, setDraftType] = useState<PropertyType>(initialType);
  const [draftOptions, setDraftOptions] = useState<string[]>(initialOptions);

  // mode 或 initial props 变化时重置 draft (例如 add 打开 → 关闭 →
  // 改以 edit 打开同一行 / 不同行)。 注: initialName 是只读的触发条件,
  // 这里用 [mode, initialName, initialType, initialOptions] 即可 —
  // 关闭重开总是新值, 不会出现"两次都打开同一个 row 但内容不变"的场景。
  useEffect(() => {
    setDraftName(initialName);
    setDraftType(initialType);
    setDraftOptions(initialOptions);
  }, [mode, initialName, initialType, initialOptions]);

  const canSubmit = draftName.trim().length > 0;
  const showOptions = draftType === 'Select' || draftType === 'MultiSelect';
  const submitLabel = mode === 'edit'
    ? t('document.properties.addFieldPanel.save')
    : t('document.properties.addFieldPanel.submit');

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit({
      name: draftName.trim(),
      type: draftType,
      options: showOptions ? draftOptions : undefined,
    });
  };

  // 用 ref 持有最新 draft + onSubmit, 让注册的 flush 闭包始终读到最新值,
  // 避免 onSubmit 身份变化时反复重新注册。
  const draftRef = useRef({ draftName, draftType, draftOptions });
  draftRef.current = { draftName, draftType, draftOptions };
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  useEffect(() => {
    if (!registerFlush) return;
    registerFlush(() => {
      const { draftName, draftType, draftOptions } = draftRef.current;
      if (draftName.trim().length === 0) return false;
      const showOpts = draftType === 'Select' || draftType === 'MultiSelect';
      onSubmitRef.current({
        name: draftName.trim(),
        type: draftType,
        options: showOpts ? draftOptions : undefined,
      });
      return true;
    });
  }, [registerFlush]);

  // 布局: 上下单列。 上 自定义输入 (name + type + options), 下 常用属性 chips。
  // 没有 "取消 / 保存" 按钮 — 关闭弹窗时, 父级先调用本组件注册的 flush:
  // 名称非空 → 自动保存后关闭; 名称为空 → 直接关闭 (不做任何事)。
  // Enter 仍可触发提交 (快存), Escape 让原生事件冒泡到 document, 由父级统一处理。
  return (
    <div className="flex flex-col gap-3">
      {/* 上: 输入 name + type + options */}
      <div className="flex flex-col gap-2">
        <span className="px-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
          {t('document.properties.addFieldPanel.input')}
        </span>
        <Input
          value={draftName}
          onChange={(event) => setDraftName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && canSubmit) {
              event.preventDefault();
              handleSubmit();
            }
          }}
          placeholder={t('document.properties.addFieldPanel.namePlaceholder')}
          className="h-8"
          autoFocus
        />
        <PropertyTypePicker
          value={draftType}
          onChange={setDraftType}
        />
        {showOptions && (
          <OptionsChipsInput
            value={draftOptions}
            onChange={setDraftOptions}
            placeholder={t('document.properties.addFieldPanel.optionsPlaceholder')}
          />
        )}
        <div className="mt-1 flex items-center justify-end">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="h-7 rounded-md bg-[var(--primary)] px-3 text-xs text-[var(--primary-foreground)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitLabel}
          </button>
        </div>
      </div>

      {/* 下: 常用属性 (推荐 + 已保存合并, 顺序: 内置在前, 用户自定义在后) */}
      {mode === 'edit' && (
        <div className="flex flex-col gap-1.5">
          <span className="px-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
            {t('document.properties.addFieldPanel.common')}
          </span>
          <CommonPropertyChips
            savedFields={savedFields}
            onPickPreset={onPickPreset}
            onPickSavedField={onPickSavedField}
          />
        </div>
      )}
    </div>
  );
}

/**
 * "新增字段" 面板里的类型选择 — 与行的 key 触发键样式一致的 DropdownMenu。
 * 不再使用之前行内的 DropdownMenu, 但样式保持一致 (h-8, px-2, caret)。
 */
function CommonPropertyChips({
  savedFields,
  onPickPreset,
  onPickSavedField,
  disabled = false,
}: {
  savedFields: PropertyFieldConfig[];
  onPickPreset: (preset: PropertyPreset) => void;
  onPickSavedField: (field: PropertyFieldConfig) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap gap-1.5">
      {PRESETS.map((preset) => (
        <button
          key={preset.key}
          type="button"
          disabled={disabled}
          onClick={() => onPickPreset(preset)}
          className="inline-flex h-6 w-fit items-center rounded-full border border-[var(--border)] bg-[var(--muted)] px-2.5 text-xs text-[var(--foreground)] shadow-sm transition-colors hover:bg-[var(--muted)]/70 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="truncate">{t(preset.labelKey)}</span>
        </button>
      ))}
      {savedFields.map((field) => (
        <button
          key={field.key}
          type="button"
          disabled={disabled}
          onClick={() => onPickSavedField(field)}
          className="inline-flex h-6 w-fit items-center rounded-full border border-[var(--border)] bg-[var(--muted)] px-2.5 text-xs text-[var(--foreground)] shadow-sm transition-colors hover:bg-[var(--muted)]/70 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="truncate">{field.name}</span>
        </button>
      ))}
    </div>
  );
}

function PropertyTypePicker({
  value,
  onChange,
}: {
  value: PropertyType;
  onChange: (next: PropertyType) => void;
}) {
  const { t } = useI18n();
  const label = t(getPropertyTypeLabelKey(value));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-background px-2 text-left text-sm transition-colors',
            'hover:bg-[var(--muted)]/40 focus-visible:border-[var(--primary)] focus-visible:outline-none',
            'data-[state=open]:border-[var(--primary)]'
          )}
        >
          <span className="min-w-0 flex-1 truncate">{label}</span>
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
        className="z-[1500] min-w-[120px] px-1 py-1.5"
      >
        {PROPERTY_KINDS.map((kind) => (
          <DropdownMenuItem
            key={kind}
            onClick={() => onChange(kind)}
            className="flex cursor-pointer items-center justify-between rounded-md px-2 hover:bg-[var(--muted)]"
          >
            <span className="truncate">
              {t(getPropertyTypeLabelKey(kind))}
            </span>
            {value === kind && (
              <Check className="h-4 w-4 shrink-0 text-[var(--primary)]" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * AddFieldPanel 里的选项 chips 输入 — 仅在 type 是 Select / MultiSelect
 * 时显示。 用户敲入选项名 → Enter/逗号 → 加入 chips; × 移除。 内部状态
 * 是 string[], 直接由 AddFieldPanel 的 draftOptions 拥有。
 *
 * 与 MultiSelectValueInput (值列) 不同: 这里维护的是 "可选哪些值" 的
 * 元数据, 而不是 "已选哪些值"。 二者形态相似 (都是 chips) 但语义不同,
 * 故不复用 — MultiSelectValueInput 的值仍由 row.value (string) 表达。
 */
function OptionsChipsInput({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  label?: string;
}) {
  const [draft, setDraft] = useState('');
  const commitDraft = () => {
    const next = draft.trim();
    if (!next) return;
    if (!value.includes(next)) {
      onChange([...value, next]);
    }
    setDraft('');
  };
  const removeOption = (option: string) => {
    onChange(value.filter((item) => item !== option));
  };
  return (
    <div className="flex flex-col gap-1">
      {label ? (
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
          {label}
        </span>
      ) : null}
      <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-lg border border-input bg-background px-2 py-1 text-sm focus-within:border-[var(--primary)]">
        {value.map((option) => (
          <span
            key={option}
            className="inline-flex h-5 items-center gap-1 rounded-md bg-[var(--muted)] px-1.5 text-xs text-[var(--foreground)]"
          >
            {option}
            <button
              type="button"
              onClick={() => removeOption(option)}
              className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              aria-label={option}
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={draft}
          placeholder={value.length === 0 ? placeholder : ''}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault();
              commitDraft();
            }
            if (event.key === 'Backspace' && !draft && value.length > 0) {
              onChange(value.slice(0, -1));
            }
          }}
          className="min-w-[80px] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
    </div>
  );
}

function getAnchoredPopoverPosition(anchor: PopoverAnchor, popoverHeight: number) {
  const usableHeight = Math.min(popoverHeight, FIELD_POPOVER_MAX_HEIGHT);
  const belowTop = anchor.top + anchor.height + FIELD_POPOVER_SIDE_OFFSET;
  const aboveTop = anchor.top - usableHeight - FIELD_POPOVER_SIDE_OFFSET;
  const spaceBelow = window.innerHeight - belowTop - FIELD_POPOVER_VIEWPORT_MARGIN;
  const spaceAbove = anchor.top - FIELD_POPOVER_VIEWPORT_MARGIN - FIELD_POPOVER_SIDE_OFFSET;
  const shouldPlaceAbove = spaceBelow < usableHeight && spaceAbove > spaceBelow;
  const rawTop = shouldPlaceAbove ? aboveTop : belowTop;
  const maxLeft = window.innerWidth - FIELD_POPOVER_WIDTH - FIELD_POPOVER_VIEWPORT_MARGIN;

  return {
    top: clamp(
      rawTop,
      FIELD_POPOVER_VIEWPORT_MARGIN,
      window.innerHeight - usableHeight - FIELD_POPOVER_VIEWPORT_MARGIN
    ),
    left: clamp(anchor.left, FIELD_POPOVER_VIEWPORT_MARGIN, Math.max(FIELD_POPOVER_VIEWPORT_MARGIN, maxLeft)),
  };
}

function AnchoredPropertyPopover({
  popoverState,
  rows,
  savedFields,
  addPresetRow,
  addCustomField,
  addSavedCustomField,
  switchRowToPreset,
  switchRowToSavedCustomField,
  updateRowFromEdit,
  onCancel,
}: {
  popoverState: {
    open: boolean;
    mode: 'add' | 'edit';
    rowId: string | null;
    anchor: PopoverAnchor | null;
  };
  rows: PropertyRow[];
  savedFields: PropertyFieldConfig[];
  addPresetRow: (preset: PropertyPreset) => void;
  addCustomField: (payload: { name: string; type: PropertyType; options?: string[] }) => void;
  addSavedCustomField: (field: PropertyFieldConfig) => void;
  switchRowToPreset: (id: string, preset: PropertyPreset) => void;
  switchRowToSavedCustomField: (id: string, field: PropertyFieldConfig) => void;
  updateRowFromEdit: (id: string, payload: { name: string; type: PropertyType; options?: string[] }) => void;
  onCancel: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [positioned, setPositioned] = useState(false);

  // AddFieldPanel 在挂载时会注册一个 flush 函数: 名称非空就提交 (由
  // onSubmit 内部触发关闭), 否则什么都不返回 false。 我们把这条注册
  // 闭包挂到本 ref 上, 让 overlay / Escape 触发的关闭统一走 "先 flush,
  // 没保存再关" 的流程, 实现 "关闭弹窗即保存"。
  const flushRef = useRef<(() => boolean) | null>(null);
  const handleRegisterFlush = useCallback((flush: (() => boolean) | null) => {
    flushRef.current = flush;
  }, []);
  const handleRequestClose = useCallback(() => {
    const flushed = flushRef.current?.() ?? false;
    if (!flushed) onCancel();
  }, [onCancel]);

  useLayoutEffect(() => {
    const anchor = popoverState.anchor;
    if (!popoverState.open || !anchor) {
      setPositioned(false);
      return;
    }

    let rafId = 0;
    let timeoutId = 0;

    const updatePosition = () => {
      const height = panelRef.current?.offsetHeight ?? FIELD_POPOVER_MAX_HEIGHT;
      setPosition(getAnchoredPopoverPosition(anchor, height));
      setPositioned(true);
    };

    updatePosition();
    rafId = requestAnimationFrame(updatePosition);
    timeoutId = window.setTimeout(updatePosition, 50);

    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);

    return () => {
      cancelAnimationFrame(rafId);
      window.clearTimeout(timeoutId);
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [popoverState.open, popoverState.anchor]);

  useEffect(() => {
    if (!popoverState.open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleRequestClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [popoverState.open, handleRequestClose]);

  if (!popoverState.open || !popoverState.anchor || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[1500]"
        onClick={handleRequestClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="false"
        style={{
          position: 'fixed',
          top: position.top,
          left: position.left,
          zIndex: 1501,
          visibility: positioned ? 'visible' : 'hidden',
        }}
        onClick={(event) => event.stopPropagation()}
        className="w-[240px] max-h-[280px] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--card)] p-2 shadow-xl"
      >
        <PopoverPanelBody
          popoverState={popoverState}
          rows={rows}
          savedFields={savedFields}
          addPresetRow={addPresetRow}
          addCustomField={addCustomField}
          addSavedCustomField={addSavedCustomField}
          switchRowToPreset={switchRowToPreset}
          switchRowToSavedCustomField={switchRowToSavedCustomField}
          updateRowFromEdit={updateRowFromEdit}
          registerFlush={handleRegisterFlush}
        />
      </div>
    </>,
    document.body
  );
}

/**
 * 把 popoverState (open / mode / rowId) 解析成 AddFieldPanel 的具体 props。
 * 抽这一层是因为 AddFieldPanel 不应该知道 row 的存在 — 它只负责表单,
 * row 的查询与回调绑定在父层做。 这样既隔离了 AddFieldPanel, 又能
 * 把 "open 时才渲染" 的优化 (避免空状态下也跑 useState/useEffect) 集中在一处。
 */
function PopoverPanelBody({
  popoverState,
  rows,
  savedFields,
  addPresetRow,
  addCustomField,
  addSavedCustomField,
  switchRowToPreset,
  switchRowToSavedCustomField,
  updateRowFromEdit,
  registerFlush,
}: {
  popoverState: {
    open: boolean;
    mode: 'add' | 'edit';
    rowId: string | null;
    anchor: PopoverAnchor | null;
  };
  rows: PropertyRow[];
  savedFields: PropertyFieldConfig[];
  addPresetRow: (preset: PropertyPreset) => void;
  addCustomField: (payload: { name: string; type: PropertyType; options?: string[] }) => void;
  addSavedCustomField: (field: PropertyFieldConfig) => void;
  switchRowToPreset: (id: string, preset: PropertyPreset) => void;
  switchRowToSavedCustomField: (id: string, field: PropertyFieldConfig) => void;
  updateRowFromEdit: (id: string, payload: { name: string; type: PropertyType; options?: string[] }) => void;
  /**
   * 透传给 AddFieldPanel: 让表单内部注册一个 "关闭前先尝试保存" 的回调。
   * AnchoredPropertyPopover 会拿这个回调在 overlay 点击 / Escape 时调用。
   */
  registerFlush: (flush: (() => boolean) | null) => void;
}) {
  if (popoverState.mode === 'add') {
    return (
      <AddFieldPanel
        mode="add"
        initialName=""
        initialType="Text"
        initialOptions={[]}
        savedFields={savedFields}
        onPickPreset={addPresetRow}
        onPickSavedField={addSavedCustomField}
        onSubmit={addCustomField}
        registerFlush={registerFlush}
      />
    );
  }

  // mode === 'edit' 时, 从 rows 找到对应行, 把当前状态作为 initial props
  // 注入 AddFieldPanel。 找不到行时 (理论上不该发生, 因为 rowId 是从
  // 真实 row 写入的) 走空字段兜底。
  const row = popoverState.rowId
    ? rows.find((r) => r.id === popoverState.rowId) ?? null
    : null;
  const initialName = row ? (row.customLabel ?? row.key) : '';
  const initialType = row ? row.type : 'Text';
  const initialOptions = row
    ? [...(row.options ?? row.preset?.options ?? [])]
    : [];
  const handlePickPreset = row
    ? (preset: PropertyPreset) => switchRowToPreset(row.id, preset)
    : addPresetRow;
  const handlePickSavedField = row
    ? (field: PropertyFieldConfig) => switchRowToSavedCustomField(row.id, field)
    : addSavedCustomField;
  const handleSubmit = row
    ? (payload: { name: string; type: PropertyType; options?: string[] }) =>
        updateRowFromEdit(row.id, payload)
    : addCustomField;

  return (
    <AddFieldPanel
      mode="edit"
      initialName={initialName}
      initialType={initialType}
      initialOptions={initialOptions}
      savedFields={savedFields}
      onPickPreset={handlePickPreset}
      onPickSavedField={handlePickSavedField}
      onSubmit={handleSubmit}
      registerFlush={registerFlush}
    />
  );
}

/**
 * 行内 key cell 触发按钮 — 替代之前的 PresetKeyCell (后者自身有 picker,
 * 与 AddFieldPanel 编辑模式重复)。 显示逻辑继承原 PresetKeyCell 的
 * trigger 部分: 命中 preset → mapped label; 命中 customLabel →
 * customLabel; 否则 raw key + Custom 徽章; 空 → placeholder。
 *
 * 点击后由父组件的 openEditPopover 接管, 通过动态 anchor 把同一个
 * AddFieldPanel 弹窗挪到按钮下方, mode='edit' 预填当前行状态。
 */
function PropertyKeyButton({
  row,
  disabled,
  invalid,
  onClick,
}: {
  row: PropertyRow;
  disabled?: boolean;
  invalid?: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const { t } = useI18n();
  const preset = resolvePreset(row.key);
  const isReservedMemoId = row.key.trim() === 'key';

  let display: React.ReactNode;
  if (preset) {
    display = <span className="min-w-0 flex-1 truncate">{t(preset.labelKey)}</span>;
  } else if (isReservedMemoId) {
    display = (
      <span className="font-mono text-xs text-[var(--muted-foreground)]">key</span>
    );
  } else if (row.customLabel?.trim()) {
    display = <span className="min-w-0 flex-1 truncate">{row.customLabel}</span>;
  } else if (row.key.trim()) {
    display = (
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[var(--foreground)]">
          {row.key}
        </span>
        <span className="shrink-0 rounded-md bg-[var(--muted)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">
          {t('document.properties.customBadge')}
        </span>
      </span>
    );
  } else {
    display = (
      <span className="min-w-0 flex-1 truncate text-[var(--muted-foreground)]">
        {t('document.properties.keyPlaceholder')}
      </span>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-background px-2 text-left text-sm transition-colors',
        'hover:bg-[var(--muted)]/40 focus-visible:border-[var(--primary)] focus-visible:outline-none',
        'data-[state=open]:border-[var(--primary)]',
        invalid && 'border-[var(--destructive)]',
        disabled && 'cursor-not-allowed opacity-50'
      )}
    >
      {display}
      <CaretDownIcon
        className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)] transition-transform duration-150 [[data-state=open]_&]:rotate-180"
        weight="bold"
        aria-hidden="true"
      />
    </button>
  );
}
