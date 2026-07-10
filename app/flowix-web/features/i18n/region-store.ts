import { create } from 'zustand';
import { detectRegion, type Region } from './detect';

/**
 * 地区识别 — 运行时单一可信源。
 *
 * 状态机:
 * - 初值: `detectRegion()` 兜底 (loadInitial 还没跑的极短窗口)
 * - loadInitial 完成后: `useUserSettingsStore.loadInitial` 调 `initialize`
 *   把持久化值 (或首次安装的检测值) 喂进来
 * - 之后: 以 preference.json 为准, 不再变
 *
 * 业务侧三档 API:
 * - `useRegionStore`  hook 订阅, 跟随状态变化
 * - `getCurrentRegion()`  同步读, 不订阅
 * - `isMainlandChina()`  同步判断是否大陆
 */

export { detectRegion, type Region } from './detect';

interface RegionState {
  region: Region;
  /**
   * 由 user-settings-store.loadInitial 调用: 首次安装时把 detectRegion()
   * 的结果落盘, 后续启动把磁盘上的持久化值喂进来, 保证运行时值与磁盘一致。
   */
  initialize: (region: Region) => void;
  /**
   * 极少数场景下 OS 语言会在运行时切换, 业务侧可显式调一下让订阅者刷新。
   * 普通业务代码不需要调 — region 是安装时一次性写入的偏好, 不会变。
   */
  refresh: () => void;
}

export const useRegionStore = create<RegionState>((set) => ({
  region: detectRegion(),
  initialize: (region) => set({ region }),
  refresh: () => set({ region: detectRegion() }),
}));

/** 同步读取当前 region — 不订阅, 业务代码单点判断时直接调。 */
export function getCurrentRegion(): Region {
  return useRegionStore.getState().region;
}

/** 同步判断是否大陆 — `getCurrentRegion() === 'mainland'` 的便捷包装。 */
export function isMainlandChina(): boolean {
  return getCurrentRegion() === 'mainland';
}

/**
 * 校验 / 兜底 Region 字符串 — preference.json 里 `region` 是裸字符串,
 * 拿到后做一次白名单校验; 不合法或缺失时回退到 detectRegion(), 而不是
 * 写死 'overseas' — 这样老版本升级到带 region 字段的新版本时, 用户的
 * 真实位置仍能被识别。
 */
export function sanitizeRegion(value: unknown): Region {
  return value === 'mainland' || value === 'overseas' ? value : detectRegion();
}
