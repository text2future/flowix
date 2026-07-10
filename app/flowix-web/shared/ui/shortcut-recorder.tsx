'use client';

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@shared/ui/dialog';
import { Button } from '@shared/ui/button';
import { KbdChord } from '@shared/ui/kbd-chord';
import {
  normalizeCode,
  normalizeKey,
  tryParseChord,
  type ShortcutOverrides,
} from '@features/shortcuts';
import { getAction } from '@features/shortcuts/registry';
import { RotateCcw } from 'lucide-react';
import { useI18n } from '@features/i18n';
import { getShortcutActionTitle } from '@features/preferences/sections/shortcut-i18n';

/**
 * 快捷键录制弹窗 — 用户改键时弹出, 捕获下一个非修饰键的组合。
 *
 * 设计要点:
 *  - 监听挂在 window 的 capture phase, 并在打开期间设置全局 guard,
 *    避免被现有的 action 抢走按键。
 *  - Escape 关闭; Enter 确认 (仅在已捕获 chord 时); 单独按修饰键不触发。
 *  - 捕获到 chord 后用 parser.tryParseChord 二次校验, 失败时提示。
 *  - 冲突检测在父组件里做 (findConflict prop), 这里只负责显示。
 *  - 关闭 dialog 时重置 captured, 下次打开干净。
 */
export interface ShortcutRecorderProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 正在编辑的 actionId, 用于 Dialog 文案与冲突排除。 */
  actionId: string;
  /** 当前生效的 chord 字符串 (override 或 default), 显示在标题旁。 */
  currentChord: string | null;
  /** 当前是否有用户覆盖 (控制"重置默认"按钮 enabled)。 */
  hasOverride: boolean;
  /**
   * 给定一个候选 chord, 返回占用此 chord 的其它 actionId (无冲突返回 null)。
   * 父组件里用 listActions() + resolveBinding() 实现, 避免本组件依赖 store。
   */
  findConflict: (chord: string) => string | null;
  /** 保存候选 chord, 父组件调 setShortcutOverride。 */
  onSave: (chord: string) => void;
  /** 重置为 default, 父组件调 resetShortcutOverride。 */
  onReset: () => void;
}

export function ShortcutRecorder({
  open,
  onOpenChange,
  actionId,
  currentChord,
  hasOverride,
  findConflict,
  onSave,
  onReset,
}: ShortcutRecorderProps) {
  const { t } = useI18n();
  const [captured, setCaptured] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const action = getAction(actionId);

  // dialog 重新打开时清空 captured
  useEffect(() => {
    if (open) {
      setCaptured(null);
      setError(null);
    }
  }, [open]);

  // 捕获 keydown — capture phase 早于 ShortcutsProvider, 不会被现有 action 抢走
  useEffect(() => {
    if (!open) return;

    (window as unknown as { __flowixShortcutRecorderOpen?: boolean }).__flowixShortcutRecorderOpen = true;

    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // 单独按修饰键: 不当作 chord, 让用户继续按主键
      if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift') {
        return;
      }

      // Escape 关闭
      if (e.key === 'Escape') {
        onOpenChange(false);
        return;
      }

      // Enter 确认 (仅在有 captured 时)
      if (e.key === 'Enter' && captured) {
        onSave(captured);
        onOpenChange(false);
        return;
      }

      // Backspace 单独按 = 清空 captured (给用户"重录"的机会)
      if (e.key === 'Backspace' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setCaptured(null);
        setError(null);
        return;
      }

      // 构造 chord — 顺序固定 Mod > Ctrl > Alt > Shift > key
      // 用 event.code 而非 event.key 拿到物理键位: Mac 上 ⌥T 的 event.key
      // 是 '†' (alternate 字符), event.code 是 'KeyT' — 后者才是用户意图。
      const parts: string[] = [];
      if (e.metaKey) parts.push('Mod');
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.altKey) parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');
      const codeKey = normalizeCode(e.code);
      parts.push(codeKey || normalizeKey(e.key));
      const chord = parts.join('+');

      // 用 parser 二次校验, 防止边缘 case
      const parsed = tryParseChord(chord);
      if (!parsed) {
        setError(t('preferences.shortcuts.recorder.unrecognized'));
        setCaptured(null);
        return;
      }

      setError(null);
      setCaptured(chord);
    };

    window.addEventListener('keydown', handler, true);
    return () => {
      window.removeEventListener('keydown', handler, true);
      (window as unknown as { __flowixShortcutRecorderOpen?: boolean }).__flowixShortcutRecorderOpen = false;
    };
  }, [open, captured, onOpenChange, onSave]);

  // 计算冲突 — captured 变化时重算
  const conflictId = captured ? findConflict(captured) : null;
  const conflictAction = conflictId ? getAction(conflictId) : null;
  const actionTitle = action ? getShortcutActionTitle(action, t) : actionId;
  const conflictActionTitle = conflictAction ? getShortcutActionTitle(conflictAction, t) : '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('preferences.shortcuts.recorder.title')}</DialogTitle>
          <DialogDescription>
            <span className="text-[var(--foreground)]">
              {actionTitle}
            </span>
            {currentChord && (
              <span className="ml-2 inline-flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
                {t('preferences.shortcuts.recorder.current')}:
                <KbdChord chord={currentChord} />
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-4">
          {/* 捕获区 — 大块虚线框, 醒目提示"按一下" */}
          <div className="flex min-h-[88px] flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-[var(--border)] bg-[var(--muted)]/30 px-4 py-6">
            {captured ? (
              <KbdChord chord={captured} className="!h-7 !text-sm" />
            ) : (
              <span className="text-sm text-[var(--muted-foreground)]">
                {t('preferences.shortcuts.recorder.pressKeys')}
              </span>
            )}
            {captured && (
              <button
                type="button"
                onClick={() => {
                  setCaptured(null);
                  setError(null);
                }}
                className="text-xs text-[var(--muted-foreground)] underline-offset-2 hover:text-[var(--foreground)] hover:underline"
              >
                {t('preferences.shortcuts.recorder.recordAgain')}
              </button>
            )}
          </div>

          {error && (
            <p className="text-xs text-[var(--destructive)]">{error}</p>
          )}

          {conflictAction && (
            <div className="rounded-md border border-[var(--destructive)]/40 bg-[var(--destructive)]/5 px-3 py-2 text-xs text-[var(--destructive)]">
              {t('preferences.shortcuts.recorder.conflictWarning').replace('{title}', conflictActionTitle)}
            </div>
          )}

          <p className="text-[11px] text-[var(--muted-foreground)]">
            {t('preferences.shortcuts.recorder.hint')}
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('dialog.cancel')}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              onReset();
              onOpenChange(false);
            }}
            disabled={!hasOverride}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            {t('preferences.shortcuts.resetDefaults')}
          </Button>
          <Button
            onClick={() => {
              if (captured) {
                onSave(captured);
                onOpenChange(false);
              }
            }}
            disabled={!captured}
          >
            {t('preferences.agent.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// 抑制未使用导入警告 (ShortcutOverrides 在外部可能用到)
export type { ShortcutOverrides };
