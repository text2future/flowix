// 文档属性图标 — 统一来自 `/assets/property-icons/` (164 张彩色 emoji 风格 SVG)。
// properties.icon 存的是去后缀的 id, getPropertyIconOption 内部
// 用 id 找 svg url。
//
// 加载走 vite import.meta.glob (eager, import: 'default') ──
// 返回的 URL 直接喂 <img src=...> 即可, 不需要把文件再搬一份到 public/。

export interface PropertyIconOption {
  value: string;
  label: string;
  src: string;
}

const NOTE_ICON_MODULES = import.meta.glob<string>(
  '../../../assets/property-icons/*.svg',
  { eager: true, import: 'default' },
);

function getIconIdFromPath(path: string): string {
  return path.split('/').pop()?.replace(/\.svg$/i, '') ?? path;
}

function getIconLabel(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

const PROPERTY_ICON_OPTIONS: readonly PropertyIconOption[] = Object.entries(NOTE_ICON_MODULES)
  .map(([path, src]) => {
    const value = getIconIdFromPath(path);
    return { value, label: getIconLabel(value), src };
  })
  .sort((a, b) => a.label.localeCompare(b.label));

export { PROPERTY_ICON_OPTIONS };

/**
 * 按 value 查 option。兼容两种历史 value 形式:
 * - 旧版 (properties.icon 里的 JSON): 带 ".svg" 后缀, 例 "dog-face.svg"
 * - 新版 (在选择器里点出来的): 不带后缀, 例 "dog-face"
 * 两者都映射到去后缀的 option.value。
 */
export function getPropertyIconOption(value: string): PropertyIconOption | null {
  const normalized = value.trim().replace(/\.svg$/i, '');
  if (!normalized) return null;
  return PROPERTY_ICON_OPTIONS.find((option) => option.value === normalized) ?? null;
}