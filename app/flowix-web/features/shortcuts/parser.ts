import type { KeyChord } from '@features/shortcuts';

/**
 * chord 字符串解析与归一 — 快捷键系统与"用户写的字符串"之间的桥。
 *
 * 三个归一函数, 各管一摊:
 *
 *  - `normalizeKey(key)`     — KeyboardEvent.key → 标准形式
 *      输入示例: 'K' / 'ArrowUp' / ' ' / 'Escape'
 *      输出示例: 'k' / 'arrowup' / 'space' / 'escape'
 *      用途: 给 chord 字符串解析、显示、event.key 兜底匹配。
 *      注意: Mac Option+letter 会让 event.key 变成 alternate 字符 (e.g. '†'),
 *      所以单独用 normalizeKey 匹配会 miss — 见下。
 *
 *  - `normalizeCode(code)`   — KeyboardEvent.code → 标准形式
 *      输入示例: 'KeyT' / 'Digit1' / 'Comma' / 'ArrowUp' / 'F5'
 *      输出示例: 't'   / '1'      / ','      / 'arrowup' / 'f5'
 *      用途: 物理键位归一, 跨 Mac/Win/Linux 一致, 不受修饰键 / 键盘布局 / IME 影响。
 *      matcher 优先用 code, key 兜底。
 *
 *  - `parseChord(str)`       — 'Mod+Shift+K' 字符串 → 结构化 KeyChord
 *      约束: 至少一个修饰键, 或键是"独立键" (F1-F12 / Escape / Enter / ...);
 *      修饰键顺序任意, 但必须排在非修饰键前面。 失败抛 ChordParseError。
 */

export class ChordParseError extends Error {
  public readonly input: string;
  constructor(message: string, input: string) {
    super(`Invalid chord "${input}": ${message}`);
    this.name = 'ChordParseError';
    this.input = input;
  }
}

type ModifierField = 'mod' | 'ctrl' | 'alt' | 'shift';

const MODIFIER_MAP: Record<string, ModifierField> = {
  mod: 'mod',
  cmd: 'mod',
  command: 'mod',
  meta: 'mod',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
};

/** 单独就能成 chord 的"特殊键", 不要求修饰键伴随。 */
const STANDALONE_KEYS = new Set([
  'escape',
  'enter',
  'tab',
  'space',
  'backspace',
  'delete',
  'home',
  'end',
  'pageup',
  'pagedown',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

/**
 * 把 KeyboardEvent.key 归一到 chord 里用的标准形式。
 *
 * 规则:
 *  - 单字符: lowercase
 *  - 空白: 'space'
 *  - 命名键: lowercase (e.g. 'ArrowUp' → 'arrowup')
 */
export function normalizeKey(key: string): string {
  if (!key) return '';
  if (key === ' ') return 'space';
  if (key.length === 1) return key.toLowerCase();
  return key.toLowerCase();
}

/**
 * 把 KeyboardEvent.code (物理键位, 不受修饰键/键盘布局/IME 影响) 归一到
 * 与 normalizeKey 同一套标准形式。
 *
 * 为什么需要这个: Mac 上 `Option+T` 会被 OS 替换成 alternate 字符 `†`,
 * 此时 event.key = '†', 但 event.code = 'KeyT' 还是物理 T 键。 用 event.key
 * 匹配会让 `⌘⌥T` 永远 miss; 用 event.code 则跨 Mac/Win/Linux 一致。
 *
 * 映射规则:
 *  - 'KeyX'        → 'x'      (字母键)
 *  - 'DigitN'      → 'n'      (顶部数字键)
 *  - 'NumpadN'     → 'n'      (小数字键, 与 Digit 归一)
 *  - 'F1'…'F12'    → 'f1'…'f12'
 *  - 'ArrowUp'…    → 'arrowup' (4 个方向键)
 *  - 'Comma'/'Period'/'Slash'/... → 对应字符 ',' '.' '/' etc.
 *    (Mac/Win 一致, 保证 "Cmd+," 在偏好里录出来是 'Mod+,' 而非 'Mod+comma')
 *  - 其他          → 原样 lowercase
 */
const CODE_TO_CHAR: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
};

export function normalizeCode(code: string): string {
  if (!code) return '';
  // 字母键: KeyA..KeyZ → a..z
  if (code.startsWith('Key') && code.length === 4) {
    return code.charAt(3).toLowerCase();
  }
  // 数字键: Digit0..Digit9 → 0..9
  if (code.startsWith('Digit') && code.length === 6) {
    return code.charAt(5);
  }
  // 小数字键: Numpad0..Numpad9 → 0..9
  if (code.startsWith('Numpad') && code.length === 7) {
    return code.charAt(6);
  }
  // 方向键: ArrowUp/Down/Left/Right
  if (code.startsWith('Arrow') && code.length === 6) {
    return 'arrow' + code.charAt(5).toLowerCase();
  }
  // 标点键: Comma/Period/Slash/etc. → 字符
  if (CODE_TO_CHAR[code]) {
    return CODE_TO_CHAR[code];
  }
  // 其它 (Enter / Escape / Space / Backspace / Tab / Delete / Home / End / F1..F12)
  return code.toLowerCase();
}

/** 判断某个 key 是否可以不配修饰键单独成为 chord。 */
export function isStandaloneKey(key: string): boolean {
  return STANDALONE_KEYS.has(key);
}

/**
 * 把 chord 字符串解析为结构化 KeyChord。
 *
 * @throws ChordParseError
 */
export function parseChord(input: string): KeyChord {
  const trimmed = input.trim();
  if (!trimmed) throw new ChordParseError('empty chord', input);

  const parts = trimmed.split('+').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new ChordParseError('no parts', input);

  const chord: KeyChord = { mod: false, ctrl: false, alt: false, shift: false, key: '' };
  let hasModifier = false;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].toLowerCase();
    const isLast = i === parts.length - 1;

    if (MODIFIER_MAP[part]) {
      if (isLast) {
        throw new ChordParseError('a non-modifier key is required', input);
      }
      (chord as Record<ModifierField, boolean>)[MODIFIER_MAP[part]] = true;
      hasModifier = true;
      continue;
    }

    if (!isLast) {
      // 修饰键必须排在非修饰键前面 — 拒绝 'K+Mod'
      throw new ChordParseError(`unexpected token "${parts[i]}" before key`, input);
    }

    chord.key = normalizeKey(part);
  }

  if (!chord.key) {
    throw new ChordParseError('a non-modifier key is required', input);
  }

  if (!hasModifier && !isStandaloneKey(chord.key)) {
    throw new ChordParseError(
      'at least one modifier is required (or use a special key like F1-F12 / Escape / Enter)',
      input,
    );
  }

  return chord;
}

/**
 * 安全解析 — 失败返回 null 不抛错, 给"用户编辑/读取覆盖层"等容错场景用。
 */
export function tryParseChord(input: string): KeyChord | null {
  try {
    return parseChord(input);
  } catch {
    return null;
  }
}
