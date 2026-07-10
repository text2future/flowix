import type { KeyChord, Platform, Scope } from '@features/shortcuts';
import { matchesModifier } from '@features/shortcuts';
import { normalizeCode, normalizeKey } from '@features/shortcuts/parser';

/**
 * KeyboardEvent 匹配规则:
 *
 * 1. IME 合成中不匹配 — 复用 agent-inputbox.tsx:151-162 的双兜底
 *    (isComposing + keyCode === 229), 集中在一处避免散落。
 * 2. 修饰键"精确匹配" — chord 里要求 mod 且 shift, event 必须 mod 且 shift;
 *    chord 里不要求 alt, event 也不能 alt (避免 'Mod+K' 误匹配 'Mod+Alt+K')。
 *    这是 VS Code / Linear / Notion 的通用约定。
 * 3. 键名归一比较。
 */

export interface MatchContext {
  /** 用于把 chord 里的 `Mod` 解析为 ⌘ (Mac) 或 Ctrl (Win/Linux)。 */
  platform: Platform;
}

/**
 * 双兜底 IME 检测 — 浏览器对 isComposing 的实现不一致:
 *  - Chrome: 进入 IME 预选时 isComposing=true
 *  - Safari: 仅 keyCode=229 (isComposing 不可靠)
 *  - 某些输入法: 两者都不可靠, 但 keyCode=229 几乎是通用信号
 * 见 agent-inputbox.tsx:151-162 现有用法。
 */
export function isImeComposing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

/** 焦点元素是否在可编辑区 (input / textarea / contenteditable / select)。 */
export function isInEditableField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * 检查 KeyboardEvent 是否匹配给定的 chord。
 *
 * 返回 true 时, 调用方负责 preventDefault + stopPropagation。
 *
 * 主键匹配策略: 同时尝试 event.key 和 event.code 两种归一形式。
 *  - event.key: 带字符替换的输出, 受修饰键 (Mac Option) / 键盘布局 / IME 影响。
 *    e.g. Mac ⌥T → '†' 而非 't'。
 *  - event.code: 物理键位, 不受任何修饰键影响。 e.g. Mac ⌥T → 'KeyT'。
 * 用 OR 关系匹配, 任意一个归一形式等于 chord.key 即视为命中 — 这是 VS Code /
 * Linear / Notion 的标准做法, 跨平台一致。
 *
 * Mac 上的 Mod: 同时接受 ⌘ (metaKey) 和 ⌃ (ctrlKey) 作为「主修饰键」—
 * 这样 `Mod+K` 既能用 ⌘K 也能用 ⌃K 触发, 兼容 Windows 用户带过来的肌肉记忆。
 * `Ctrl+K` (chord.ctrl=true, chord.mod=false) 仍然只接受 ⌃K, 不被 ⌘K 误触发;
 * `Mod+Ctrl+K` 类组合按精确比对走。
 */
export function chordMatches(
  event: KeyboardEvent,
  chord: KeyChord,
  ctx: MatchContext,
): boolean {
  if (isImeComposing(event)) return false;

  // 修饰键精确比对
  if (ctx.platform === 'mac') {
    // 'Mod+X' 在 Mac 上兼容 ⌘X 和 ⌃X (用户从 Windows 切过来时 ⌃K 是常用键)
    if (chord.mod && !chord.ctrl) {
      const hasMod = event.metaKey || event.ctrlKey;
      if (!hasMod) return false;
    } else {
      if (matchesModifier('mod', event, ctx.platform) !== chord.mod) return false;
      if (matchesModifier('ctrl', event, ctx.platform) !== chord.ctrl) return false;
    }
  } else if (event.ctrlKey !== (chord.mod || chord.ctrl)) {
    return false;
  }
  if (matchesModifier('alt', event, ctx.platform) !== chord.alt) return false;
  if (event.shiftKey !== chord.shift) return false;

  // 主键归一比对 — 优先 code (跨平台/跨修饰键稳定), 兜底 key
  const codeKey = normalizeCode(event.code);
  if (codeKey && codeKey === chord.key) return true;
  const key = normalizeKey(event.key);
  if (key === chord.key) return true;

  return false;
}

/**
 * 判断当前活跃 scope 是否允许某个 action.scope 的 action 参与匹配。
 *
 * 规则:
 *  - 'editor'   — 仅当 'editor' 在 scope 栈中
 *  - 'dialog'   — 仅当 'dialog' 在 scope 栈中
 *  - 'no-input' — 仅当焦点不在可编辑区
 *  - 'window'   — 总是允许 (在 Tauri webview 里 window 事件天然 per-webview)
 *  - 'global'   — 总是允许
 */
export function scopeAllows(
  actionScope: Scope,
  scopeStack: readonly Scope[],
  editable: boolean,
): boolean {
  switch (actionScope) {
    case 'editor':
      return scopeStack.includes('editor');
    case 'dialog':
      return scopeStack.includes('dialog');
    case 'no-input':
      return !editable;
    case 'window':
    case 'global':
      return true;
  }
}
