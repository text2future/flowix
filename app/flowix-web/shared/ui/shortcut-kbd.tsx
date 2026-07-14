'use client';

import { cn } from '@/lib/utils';
import { formatChord } from '@features/shortcuts';
import { resolveBinding } from '@features/shortcuts/registry';
import { useUserSettings } from '@features/preferences/hooks/use-user-settings';

/**
 * 平台感知的快捷键展示 — 统一视觉基础。
 *
 * 视觉规范 (system UI 字体 + 18px 行高 + 0.05em tracking) 在 Tooltip、命令
 * 面板、偏好设置行、ShortcutRecorder 之间保持一致 — 全部走 `<Kbd>` 渲染。
 *
 * **颜色 / 透明度不写在这里** — Tooltip Popup 是 inverse 背景, 需要
 * inverse-foreground; 命令面板和偏好设置是 normal 背景, 需要 muted-foreground。
 * 调用方通过 `className` 注入具体颜色, 这里只保证布局 / 字体 / 大小稳定。
 *
 * 历史: 早期 mono+border 风格 (现 KbdChord 旧实现) 在 Mac 上 ⌘ / ⇧ 修饰符
 * glyph 偏小 (mono 字体把这些符号压成 0.6em), 改成 system UI 字体后符号与
 * 字符同尺寸。三个调用点统一收敛到这条基线。
 */
export interface KbdProps {
  /** 已格式化好的 chord 字符串 (e.g. 'Mod+K', 'Alt+ArrowLeft')。 */
  chord: string;
  className?: string;
}

export function Kbd({ chord, className }: KbdProps) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] select-none items-center rounded text-xs font-medium tracking-[0.05em] font-['SF_Pro_Text',_'SF_Pro_Display',_'Segoe_UI',_'Segoe_UI_Variable',sans-serif]",
        className,
      )}
    >
      {formatChord(chord)}
    </kbd>
  );
}

/**
 * actionId → 平台感知的快捷键展示。
 *
 * 链路:
 *   1. useUserSettings 读当前用户的 override
 *   2. resolveBinding(actionId, overrides) 拿当前平台实际 chord
 *   3. formatChord(chord) 平台格式化 (Mac ⌘ / Win Ctrl)
 *
 * 没有 binding 时返回 null (调用方自行 fallback)。Tooltip 和命令面板 item
 * 走这个 — 它们知道 actionId, 不知道 chord 字符串。
 */
export interface ShortcutKbdProps {
  /** actions.ts 里注册的 actionId。 */
  actionId: string;
  className?: string;
}

export function ShortcutKbd({ actionId, className }: ShortcutKbdProps) {
  const overrides = useUserSettings().settings.shortcuts;
  const chordString = resolveBinding(actionId, overrides).chordString;
  if (!chordString) return null;
  return <Kbd chord={chordString} className={className} />;
}
