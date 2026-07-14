/**
 * 快捷键系统核心类型。
 *
 * - `Platform`  —— 抽象的运行平台, 用于 modifier 互转与显示格式。
 * - `Scope`    —— 触发域, 决定 action 在什么上下文里被分发。
 * - `KeyChord` —— 结构化按键组合, 内部运行时表示。
 * - `ActionDefinition` —— 注册表里的"动作" — 键只是绑定, 动作才是真源。
 * - `ShortcutOverrides` —— UserSettings 里存的覆盖层, 只记录与默认不同的部分。
 */

import type { I18nKey } from '@features/i18n';

/** 抽象平台。'unknown' 是兜底 — 通常只在测试或非 Tauri 环境出现。 */
export type Platform = 'mac' | 'windows' | 'linux' | 'unknown';

/**
 * 触发域 (从最具体到最宽松):
 *
 * - `editor`   —— 编辑器 (Tiptap / Monaco) 获得焦点时。Provider 暴露
 *                pushScope/popScope, 编辑器 mount 时 push, unmount 时 pop。
 * - `no-input` —— 当前焦点不在任何可编辑元素 (input/textarea/contenteditable) 时。
 *                这是 `Mod+K` 打开命令面板的典型 scope。
 * - `dialog`   —— 当前有模态弹窗打开时。弹窗组件 mount 时 push, unmount 时 pop。
 *                与 `editor` 互不干扰 — 编辑器里的查找替换弹窗, 顶层 confirm
 *                弹窗都用同一个 scope。
 * - `window`   —— 当前 Tauri webview 焦点 (在 Tauri 里 `window.addEventListener` 天然
 *                per-webview, 因此默认就是)。
 * - `global`   —— 字面意义全平台全局, 目前保留作扩展位, 没有实际 binding 强制跨窗口同步。
 */
export type Scope = 'global' | 'window' | 'editor' | 'dialog' | 'no-input';

/** 结构化按键组合 — 注册表内部用, 持久化走字符串 (parser 层互转)。 */
export interface KeyChord {
  /** 主修饰键: Mac = ⌘ (Meta), Windows / Linux = Ctrl。 */
  mod: boolean;
  /** Ctrl 键: Mac 上是物理 Control 键, Windows / Linux 上与 mod 互为别名。 */
  ctrl: boolean;
  /** Alt / Option 键。 */
  alt: boolean;
  /** Shift 键。 */
  shift: boolean;
  /**
   * 非修饰键, 已 lowercase 化并归一:
   *   'k', '/', '[', 'arrowup', 'f5', 'enter', 'escape', 'space', 'backspace' ...
   * 完整规则见 parser.normalizeKey。
   */
  key: string;
}

/** 触发源 — action.run 收到后可按需分支 (例如 palette 触发不 preventDefault)。 */
export type ActionSource = 'key' | 'palette' | 'menu' | 'api';

/** action.run 调用上下文。 */
export interface ActionContext {
  scope: Scope;
  source: ActionSource;
  /** 触发时所在的平台 — 便于在 run 里做平台分支。 */
  platform: Platform;
}

/** `when` hook 的输入 — 给动作一次机会拒绝触发 (例如 agent 流式时禁用某些快捷键)。 */
export interface WhenContext {
  activeScope: Scope;
  /** 焦点元素的 tagName 小写 (如 'input', 'div'), 便于精细判断; null = 无具体元素。 */
  focusedTag: string | null;
  platform: Platform;
}

/**
 * 单个动作的完整声明。
 *
 * `defaultBinding` 按平台分键; key 缺省则 fallback 到 'mac' (有的话)。
 * 整组都缺省 = 该动作无默认绑定, 用户必须显式绑定才会被触发。
 */
export interface ActionDefinition {
  /** 稳定 ID (跨版本不变), 形如 'memo.create'。Settings 覆盖层以此为 key。 */
  id: string;
  /**
   * 命令面板 / 偏好里展示给用户看的标签的 i18n key。
   * 解析走 `translate(language, titleKey)`，对应 `preferences.shortcuts.action.<id>.title`。
   */
  titleKey: I18nKey;
  /**
   * 命令面板搜索的补充描述的 i18n key，可选。
   * 解析走 `translate(language, descriptionKey)`，对应 `preferences.shortcuts.action.<id>.description`。
   */
  descriptionKey?: I18nKey;
  /** 命令面板分组 (导航 / Memo / 笔记本 / 视图 / 代理 / 系统)。 */
  group: string;
  /** 触发域。 */
  scope: Scope;
  /** 按平台的默认绑定。 */
  defaultBinding: {
    mac?: string;
    windows?: string;
    linux?: string;
  };
  /** 额外条件, return false 时跳过 (但其它 action 仍有机会匹配)。 */
  when?: (ctx: WhenContext) => boolean;
  /**
   * 触发逻辑。
   *
   * 返回值语义:
   *  - `true` / `undefined` / `Promise<void>`: 已处理, Provider 会 preventDefault + stopPropagation。
   *  - `false`: 拒绝处理 (例如 invokeHandler 找不到实例级 handler), Provider
   *    不 preventDefault, 继续尝试后续 action; 如果没有匹配则落到浏览器默认。
   *  - 抛出异常: Provider 捕获, console.error, 视为拒绝 (返回 false 等价)。
   */
  run: (ctx: ActionContext) => boolean | void | Promise<boolean | void>;
}

/**
 * Settings 里存的覆盖层 — 只记录用户改过的部分, 缺省走 `ActionDefinition.defaultBinding`。
 *
 * 值是 chord 字符串 (parser.parseChord 接受的格式), 例如 'Mod+Alt+N'。
 */
export type ShortcutOverrides = Record<string, string>;

/** Provider 内部使用的解析后 binding — 包含字符串与结构化两种形式。 */
export interface ResolvedBinding {
  chord: KeyChord | null;
  chordString: string | null;
  /** true = 来自 defaultBinding, false = 来自用户覆盖, null = 无 binding。 */
  isDefault: boolean | null;
}
