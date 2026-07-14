'use client';

import { useCallback, useMemo, useState } from 'react';
import { Pencil, RotateCcw, AlertTriangle } from 'lucide-react';
import {
  type ActionDefinition,
  type ConflictReport,
} from '@features/shortcuts';
import {
  detectConflicts,
  listActions,
  resolveBinding,
} from '@features/shortcuts/registry';
import { useUserSettings } from '@features/preferences/hooks/use-user-settings';
import { Button } from '@shared/ui/button';
import { KbdChord } from '@shared/ui/kbd-chord';
import { ShortcutRecorder } from '@shared/ui/shortcut-recorder';
import { SectionHeader } from '@features/preferences/sections/primitives';
import { useI18n } from '@features/i18n';
import {
  getShortcutActionDescription,
  getShortcutActionTitle,
  getShortcutGroupLabel,
} from '@features/preferences/sections/shortcut-i18n';

/** 渲染顺序: editor 组放最后 (条目最多, 视觉负担最大, 沉到底部), 其它组保留 actions.ts 中的声明顺序。 */
const GROUP_ORDER_LAST = 'editor';

/**
 * 偏好设置 → 快捷键 tab。
 *
 * - 数据源: `listActions()` 集中声明, 不再写死静态数组。
 * - 显示当前 binding: `resolveBinding(id, overrides).chordString`
 * - 改键: 每行 "改键" 按钮 → 打开 <ShortcutRecorder>
 * - 重置: 每行 "重置" 按钮 (仅 hasOverride 时显示) + 底部 "重置为默认"
 * - 冲突高亮: 用 `detectConflicts(overrides)` 拿到冲突列表, 对应行加红框 +
 *   顶部汇总提示。
 *
 * 跨窗口同步: settings.shortcuts 走 UserSettings → 'user-config-changed'
 * 链路, 这边只读, 写入调 setShortcutOverride / resetShortcutOverride,
 * 200ms debounce 落盘。
 */
export function ShortcutsSection() {
  const { t } = useI18n();
  const { settings, setShortcutOverride, resetShortcutOverride, resetAllShortcutOverrides } =
    useUserSettings();
  const overrides = settings.shortcuts;

  // 当前正在编辑的 actionId (recorder 打开时非空)
  const [editingId, setEditingId] = useState<string | null>(null);

  // 按 group 分组, 然后把 GROUP_ORDER_LAST (editor) 强制挪到末尾, 其余按 actions.ts 声明顺序
  const grouped = useMemo(() => {
    const all = groupActions(listActions());
    const entries = Object.entries(all);
    const tail = entries.filter(([g]) => g === GROUP_ORDER_LAST);
    const head = entries.filter(([g]) => g !== GROUP_ORDER_LAST);
    return [...head, ...tail];
  }, []);

  // 冲突检测 — 9 个 action, O(n²) 走 resolveBinding, 性能无忧
  const conflicts = useMemo<ConflictReport[]>(() => detectConflicts(overrides), [overrides]);
  const conflictChordSet = useMemo(
    () => new Set(conflicts.map(c => c.chordString)),
    [conflicts],
  );

  // 查找与候选 chord 冲突的其它 actionId (排除 self)
  const findConflict = useCallback(
    (chord: string): string | null => {
      for (const action of listActions()) {
        if (action.id === editingId) continue;
        const { chordString } = resolveBinding(action.id, overrides);
        if (chordString === chord) return action.id;
      }
      return null;
    },
    [editingId, overrides],
  );

  const editingAction = editingId ? listActions().find(a => a.id === editingId) : null;
  const editingBinding = editingId ? resolveBinding(editingId, overrides) : null;
  const editingHasOverride = editingId ? editingId in overrides : false;

  return (
    <div className="space-y-4 pb-6">
      <SectionHeader title={t('preferences.shortcuts.title')} />

      {conflicts.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-[var(--destructive)]/40 bg-[var(--destructive)]/5 px-3 py-2 text-xs text-[var(--destructive)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            <div className="font-medium">
              {t('preferences.shortcuts.conflictsDetected').replace('{count}', String(conflicts.length))}
            </div>
            <div className="mt-0.5 text-[var(--muted-foreground)]">
              {conflicts
                .map(c => {
                  const titles = c.actionIds
                    .map(id => {
                      const action = listActions().find(a => a.id === id);
                      return action ? getShortcutActionTitle(action, t) : id;
                    })
                    .join(' / ');
                  return `${c.chordString} → ${titles}`;
                })
                .join('；')}
            </div>
          </div>
        </div>
      )}

      {grouped.map(([group, actions]) => (
        <div key={group} className="space-y-2">
          <div className="flex items-center justify-between pt-2">
            <h4 className="text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
              {getShortcutGroupLabel(group, t)}
            </h4>
          </div>
          <div className="space-y-1">
            {actions.map(action => (
              <ShortcutRow
                key={action.id}
                action={action}
                overrides={overrides}
                isConflicting={conflictChordSet.has(resolveBinding(action.id, overrides).chordString ?? '')}
                onEdit={() => setEditingId(action.id)}
                t={t}
              />
            ))}
          </div>
        </div>
      ))}

      <div className="flex justify-start pt-2">
        <Button
          variant="outline"
          className="px-3"
          onClick={() => {
            if (
              window.confirm(
                t('preferences.shortcuts.resetAllConfirm'),
              )
            ) {
              resetAllShortcutOverrides();
            }
          }}
          disabled={Object.keys(overrides).length === 0}
        >
          {t('preferences.shortcuts.resetDefaults')}
        </Button>
      </div>

      {editingAction && (
        <ShortcutRecorder
          open={!!editingId}
          onOpenChange={open => {
            if (!open) setEditingId(null);
          }}
          actionId={editingAction.id}
          currentChord={editingBinding?.chordString ?? null}
          hasOverride={editingHasOverride}
          findConflict={findConflict}
          onSave={chord => setShortcutOverride(editingAction.id, chord)}
          onReset={() => resetShortcutOverride(editingAction.id)}
        />
      )}
    </div>
  );
}

// ── 行 ──────────────────────────────────────────────────────

function ShortcutRow({
  action,
  overrides,
  isConflicting,
  onEdit,
  t,
}: {
  action: ActionDefinition;
  overrides: Record<string, string>;
  isConflicting: boolean;
  onEdit: () => void;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { chordString, isDefault } = resolveBinding(action.id, overrides);
  const hasOverride = action.id in overrides;
  const { resetShortcutOverride } = useUserSettings();
  const actionTitle = getShortcutActionTitle(action, t);
  const actionDescription = getShortcutActionDescription(action, t);

  return (
    <div
      className={`flex items-center justify-between gap-4 rounded-lg bg-[var(--card)] px-3 py-2.5 transition-colors hover:bg-[var(--muted)] ${
        isConflicting ? 'ring-1 ring-inset ring-[var(--destructive)]/40' : ''
      }`}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm text-[var(--foreground)]">{actionTitle}</span>
          {hasOverride && (
            <span className="rounded bg-[var(--primary)]/10 px-1.5 py-[1px] text-[10px] font-medium text-[var(--primary)]">
              {t('preferences.shortcuts.custom')}
            </span>
          )}
          {isConflicting && (
            <span className="rounded bg-[var(--destructive)]/10 px-1.5 py-[1px] text-[10px] font-medium text-[var(--destructive)]">
              {t('preferences.shortcuts.conflict')}
            </span>
          )}
        </div>
        {actionDescription && (
          <p className="truncate text-xs text-[var(--muted-foreground)]">
            {actionDescription}
          </p>
        )}
        {!isDefault && chordString && hasOverride === false && (
          // 防御: resolveBinding 说不是默认, 但 overrides 又没标 — 数据可能脏
          <p className="text-[10px] text-[var(--destructive)]">
            {t('preferences.shortcuts.invalidBinding')}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {chordString ? (
          <KbdChord chord={chordString} />
        ) : (
          <span className="text-xs text-[var(--muted-foreground)]">{t('preferences.shortcuts.unbound')}</span>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={onEdit}
          className="h-7 px-2 text-xs"
          aria-label={`${t('preferences.shortcuts.edit')} — ${actionTitle}`}
        >
          <Pencil className="mr-1 h-3 w-3" />
          {t('preferences.shortcuts.edit')}
        </Button>
        {hasOverride && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => resetShortcutOverride(action.id)}
            className="h-7 px-2 text-xs text-[var(--muted-foreground)]"
            aria-label={t('preferences.shortcuts.resetOneAria').replace('{title}', actionTitle)}
          >
            <RotateCcw className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  );
}

// ── 分组工具 ──────────────────────────────────────────────

function groupActions(actions: ActionDefinition[]): Record<string, ActionDefinition[]> {
  const out: Record<string, ActionDefinition[]> = {};
  for (const a of actions) {
    if (!out[a.group]) out[a.group] = [];
    out[a.group].push(a);
  }
  return out;
}
