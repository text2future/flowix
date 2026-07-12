import type { ActionDefinition, ShortcutOverrides, ResolvedBinding } from '@features/shortcuts';
import { tryParseChord } from '@features/shortcuts/parser';
import { getPlatform } from '@features/shortcuts';

/**
 * 全局动作注册表。
 *
 * - 单例 Map, 模块加载即存在。
 * - `defineAction` 在模块顶层调用 (actions.ts 里), 也可以在组件 useEffect 里
 *   动态注册 (不推荐 — 难以追溯)。
 * - `resolveBinding` 给定 actionId + 用户的覆盖层, 算出当前平台实际生效的 chord。
 *   覆盖层优先, 缺省回退到 defaultBinding[platform]。
 *
 * 故意不做的事:
 *  - 不做持久化 — 那是 useUserSettings 的事, 注册表只管内存。
 *  - 不做 React 订阅 — Provider 一次性 listActions(), 不会响应式重渲染。
 *    用户在 preferences 改 binding 时, Provider 通过 overrides prop 重新走 resolveBinding。
 */

const registry = new Map<string, ActionDefinition>();

/** 注册一个 action — 同 id 重复注册会覆盖并 warn, 帮助发现意外的 id 冲突。 */
export function defineAction(def: ActionDefinition): ActionDefinition {
  if (registry.has(def.id) && registry.get(def.id) !== def) {
    // 同对象二次注册 (HMR / StrictMode 双 mount) 不警告; 真正的 id 冲突才 warn。
    console.warn(`[shortcuts] action "${def.id}" redefined`);
  }
  registry.set(def.id, def);
  return def;
}

export function getAction(id: string): ActionDefinition | undefined {
  return registry.get(id);
}

export function listActions(): ActionDefinition[] {
  return Array.from(registry.values());
}

/**
 * 把 actionId + 用户覆盖层解析到当前平台实际生效的 chord。
 *
 * 优先级:
 *  1. overrides[actionId] (用户设置)
 *  2. defaultBinding[platform] (代码内默认)
 *  3. defaultBinding.mac (平台没定义, 兜底 Mac)
 *  4. null (无 binding)
 *
 * 解析失败的 override 会 warn 并回退到 default — 单条配置脏数据不能炸掉整个系统。
 */
export function resolveBinding(
  actionId: string,
  overrides: ShortcutOverrides = {},
): ResolvedBinding {
  const def = registry.get(actionId);
  if (!def) return { chord: null, chordString: null, isDefault: null };

  const platform = getPlatform();
  const platformKey: 'mac' | 'windows' | 'linux' =
    platform === 'mac' ? 'mac' : platform === 'windows' ? 'windows' : 'linux';

  // 1. 覆盖层
  if (Object.prototype.hasOwnProperty.call(overrides, actionId)) {
    const raw = overrides[actionId];
    const parsed = tryParseChord(raw);
    if (parsed) {
      return { chord: parsed, chordString: raw, isDefault: false };
    }
    console.warn(
      `[shortcuts] override for "${actionId}" is invalid ("${raw}"), falling back to default`,
    );
  }

  // 2/3. 平台默认 → Mac 兜底
  const candidates = [
    def.defaultBinding[platformKey],
    def.defaultBinding.mac,
    def.defaultBinding.windows,
    def.defaultBinding.linux,
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const parsed = tryParseChord(raw);
    if (parsed) return { chord: parsed, chordString: raw, isDefault: true };
  }

  return { chord: null, chordString: null, isDefault: null };
}

/**
 * 探测当前所有 action 的 binding 冲突。
 *
 * 规则: 同一 (chord, scope) 上绑了 >1 个 action 即冲突。
 * 偏好设置 UI 用此高亮提示用户。返回的列表是 *chord 字符串* 维度去重,
 * 方便 UI 一行展示。
 */
export interface ConflictReport {
  chordString: string;
  scope: string;
  actionIds: string[];
}

export function detectConflicts(overrides: ShortcutOverrides = {}): ConflictReport[] {
  const buckets = new Map<string, string[]>();
  for (const action of listActions()) {
    const { chord, chordString } = resolveBinding(action.id, overrides);
    if (!chord || !chordString) continue;
    const key = `${chordString}::${action.scope}`;
    const arr = buckets.get(key) ?? [];
    arr.push(action.id);
    buckets.set(key, arr);
  }
  const out: ConflictReport[] = [];
  for (const [key, ids] of buckets) {
    if (ids.length < 2) continue;
    const [chordString, scope] = key.split('::');
    out.push({ chordString, scope, actionIds: ids });
  }
  return out;
}
