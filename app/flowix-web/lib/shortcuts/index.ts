/**
 * 快捷键系统 — 公开 API。
 *
 * 使用流程:
 *  1. 在 App.tsx 顶层包 <ShortcutsProvider overrides={...}> (overrides 来自 UserSettings.shortcuts)
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
} from './types';

// Provider + hook
export { ShortcutsProvider, useShortcutsContext } from './shortcuts-provider';
export type { ShortcutsContextValue, ShortcutsProviderProps } from './shortcuts-provider';

export { useShortcutScope } from './use-shortcut-scope';

// Registry API (命令面板 / 冲突检测用)
export { defineAction, getAction, listActions, hasAction, resolveBinding, detectConflicts } from './registry';
export type { ConflictReport } from './registry';

// Handler registry (组件 mount/unmount 时挂载/卸载 action 的实例级 handler)
export { pushHandler, invokeHandler } from './handler-registry';

// Platform utilities (UI 显示用)
export { getPlatform, isMac, isWindowsPlatform, formatChord, matchesModifier } from './platform';

// Parser utilities (快捷键录制弹窗用)
export { parseChord, tryParseChord, stringifyChord, normalizeKey, normalizeCode, isStandaloneKey, ChordParseError } from './parser';

// Matcher utilities (测试 / 内部使用)
export { chordMatches, isImeComposing, isInEditableField, scopeAllows } from './matcher';
export type { MatchContext } from './matcher';
