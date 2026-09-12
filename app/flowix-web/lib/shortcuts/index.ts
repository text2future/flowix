/**
 * 快捷键系统纯核心 - types / parser / platform / matcher / registry /
 * handler-registry / shortcuts-provider / use-shortcut-scope。
 *
 * 纯逻辑下沉到此层, 供 lib / shared (如 shortcut-kbd) 直接引用, 不反向依赖 features。
 * feature 耦合的 action 定义 (调用 document/theme/preferences store) 留在 features/shortcuts/actions。
 *
 * ShortcutsProvider 接收 overrides 作 prop (由 app.tsx 从 user-settings-store 读出传入),
 * 自身不读 store, 故可下沉。 useShortcutsContext 供 shared 层组件 (ShortcutKbd) 取 overrides。
 */

// 类型
export type {
  Platform,
  Scope,
  KeyChord,
  ActionSource,
  ActionContext,
  WhenContext,
  ActionDefinition,
  ShortcutOverrides,
  ResolvedBinding,
} from './types';

// Provider + hook
export { ShortcutsProvider, useShortcutsContext } from './shortcuts-provider';
export type { ShortcutsContextValue, ShortcutsProviderProps } from './shortcuts-provider';

export { useShortcutScope } from './use-shortcut-scope';

// Registry API (命令面板 / 冲突检测用)
export { defineAction, getAction, listActions, resolveBinding, resolveBindings, detectConflicts } from './registry';
export type { ConflictReport } from './registry';

// Handler registry (组件 mount/unmount 时挂载/卸载 action 的实例级 handler)
export { pushHandler, invokeHandler } from './handler-registry';

// Platform utilities (UI 显示用)
export { getPlatform, isMac, isWindowsPlatform, formatChord, matchesModifier } from './platform';

// Parser utilities (快捷键录制弹窗用)
export { parseChord, tryParseChord, normalizeKey, normalizeCode, isStandaloneKey, ChordParseError } from './parser';

// Matcher utilities (测试 / 内部使用)
export { chordMatches, isImeComposing, isInEditableField, scopeAllows } from './matcher';
export { isImeKeyboardEvent } from '@/lib/input-method';
export type { MatchContext } from './matcher';
