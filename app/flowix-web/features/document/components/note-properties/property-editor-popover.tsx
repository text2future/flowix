import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { CaretDownIcon } from '@phosphor-icons/react';
import { Input } from '@shared/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@shared/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { PRESETS, PROPERTY_KINDS, resolvePreset, type PropertyPreset } from '@features/document/properties/presets';
import type { PropertyFieldConfig } from '@/lib/constants';
import { cn } from '@/lib/utils';
import type { PropertyRow, PropertyType } from './property-row-model';

export type PopoverAnchor = { top: number; left: number; width: number; height: number };

const FIELD_POPOVER_WIDTH = 240;
const FIELD_POPOVER_MAX_HEIGHT = 280;
const FIELD_POPOVER_SIDE_OFFSET = 4;
const FIELD_POPOVER_VIEWPORT_MARGIN = 8;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
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
export function CommonPropertyChips({
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
        className="z-[150] min-w-[120px] rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
      >
        {PROPERTY_KINDS.map((kind) => (
          <DropdownMenuItem
            key={kind}
            onClick={() => onChange(kind)}
            className="group h-7 items-center justify-between rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
          >
            <span className="truncate">
              {t(getPropertyTypeLabelKey(kind))}
            </span>
            {value === kind && (
              <Check className="h-4 w-4 shrink-0 text-[var(--primary)] group-hover:text-[var(--primary-foreground)]" />
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

export function AnchoredPropertyPopover({
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
        className="fixed inset-0 z-[150]"
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
        className="w-[240px] max-h-[280px] overflow-y-auto rounded-xl border border-[var(--border-popup)] bg-[var(--card)] p-2 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
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
export function PropertyKeyButton({
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
