/**
 * 快捷键系统 — 公开 API。
 *
 * 使用流程:
 *  1. 在 app.tsx 顶层包 <ShortcutsProvider overrides={...}> (overrides 来自 UserSettings.shortcuts)
 *  2. 在 actions.ts (或新文件) 里 defineAction({...})
 *  3. 业务组件用 useShortcutScope('editor') 声明上下文
 *  4. 命令面板 / 偏好 UI 用 listActions() + resolveBinding(id) 渲染
 *
 * 仅导出消费方需要的东西 — 内部 matcher / parser 细节不暴露, 便于重构。
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
} from '@features/shortcuts/types';

// Provider + hook
export { ShortcutsProvider, useShortcutsContext } from '@features/shortcuts/shortcuts-provider';
export type { ShortcutsContextValue, ShortcutsProviderProps } from '@features/shortcuts/shortcuts-provider';

export { useShortcutScope } from '@features/shortcuts/use-shortcut-scope';

// Registry API (命令面板 / 冲突检测用)
export { defineAction, getAction, listActions, resolveBinding, detectConflicts } from '@features/shortcuts/registry';
export type { ConflictReport } from '@features/shortcuts/registry';

// Handler registry (组件 mount/unmount 时挂载/卸载 action 的实例级 handler)
export { pushHandler, invokeHandler } from '@features/shortcuts/handler-registry';

// Platform utilities (UI 显示用)
export { getPlatform, isMac, isWindowsPlatform, formatChord, matchesModifier } from '@features/shortcuts/platform';

// Parser utilities (快捷键录制弹窗用)
export { parseChord, tryParseChord, normalizeKey, normalizeCode, isStandaloneKey, ChordParseError } from '@features/shortcuts/parser';

// Matcher utilities (测试 / 内部使用)
export { chordMatches, isImeComposing, isInEditableField, scopeAllows } from '@features/shortcuts/matcher';
export type { MatchContext } from '@features/shortcuts/matcher';
