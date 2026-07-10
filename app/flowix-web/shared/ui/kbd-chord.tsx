'use client';

import { Kbd } from '@shared/ui/shortcut-kbd';
import { cn } from '@/lib/utils';

/**
 * 平台感知的快捷键展示组件 — 给一个 chord 字符串 (e.g. 'Mod+Shift+K'),
 * 按当前平台渲染为:
 *   - Mac:   ⌘⇧K   (Unicode 修饰符 + 大写主键)
 *   - Win:   Ctrl+Shift+K
 *
 * 与 `ShortcutKbd` 的区别: 那个吃 `actionId` (去 lookup 拿 chord), 这里
 * 吃 chord 字符串 — 用在用户已经捕获到键的场景 (偏好设置行显示当前 binding、
 * ShortcutRecorder 实时显示按下的键)。
 *
 * 视觉委托给 `Kbd` — 四个调用点 (Tooltip / 命令面板 / 偏好设置 / Recorder)
 * 共享同一套 baseline, 字体 / 大小 / tracking 一致, 改样式只动一处。
 *
 * **默认颜色**: muted-foreground — 偏好设置和 ShortcutRecorder 都在 normal
 * 背景上, 用前景色会和 action 标题抢视觉权重。调用方可通过 className 覆盖
 * (cn 会处理顺序, 传入的 className 在后面)。
 */
export interface KbdChordProps {
  /** chord 字符串 — 与 actions.ts defaultBinding / parser.parseChord 同格式。 */
  chord: string;
  className?: string;
}

export function KbdChord({ chord, className }: KbdChordProps) {
  return (
    <Kbd chord={chord} className={cn('text-[var(--muted-foreground)]', className)} />
  );
}