// 文档属性图标 — 统一来自 `/assets/property-icons/<pack>/<分类>/<id>.svg`
// (由 scripts/sync-property-icons.mjs / sync-mochi-icons.mjs 同步)。
//
// 目录结构即「图标包 → 分类」两级: 一级子目录是图标包 (emoji = Microsoft
// Fluent Emoji Flat, mochi = Mochi 贴纸), 二级子目录是包内分类, 文件名去掉
// 扩展名是图标 id。properties.icon 存的是去后缀的 id, getPropertyIconOption
// 内部按 id 查 (全包唯一), 新增/重排分类都不会让已存的值失效。
//
// 加载走 vite import.meta.glob (eager, import: 'default') ──
// 返回的 URL 直接喂 <img src=...> 即可, 不需要把文件再搬一份到 public/。
// 注意: vite.config.ts 对这批 svg 关掉了内联, 否则上千张图会以 data URI
// 形式全部塞进 JS chunk。

/** 图标包 id 即一级子目录名, 顺序 = picker 的展示顺序。 */
export const PROPERTY_ICON_PACK_IDS = ['emoji', 'mochi'] as const;

export type PropertyIconPackId = (typeof PROPERTY_ICON_PACK_IDS)[number];

/** emoji 包内的分类 id, 顺序 = CLDR 标准分组顺序。 */
export const PROPERTY_ICON_CATEGORY_IDS = [
  'smileys-emotion',
  'people-body',
  'animals-nature',
  'food-drink',
  'travel-places',
  'activities',
  'objects',
  'symbols',
] as const;

/** mochi 包不细分, 固定单分类 (picker 对单分类包隐藏分类条)。 */
export const PROPERTY_ICON_MOCHI_CATEGORY_IDS = ['all'] as const;

export type PropertyIconCategoryId =
  | (typeof PROPERTY_ICON_CATEGORY_IDS)[number]
  | (typeof PROPERTY_ICON_MOCHI_CATEGORY_IDS)[number];

export interface PropertyIconOption {
  value: string;
  label: string;
  src: string;
  pack: PropertyIconPackId;
  category: PropertyIconCategoryId;
}

export interface PropertyIconCategory {
  id: PropertyIconCategoryId;
  count: number;
}

export interface PropertyIconPack {
  id: PropertyIconPackId;
  categories: readonly PropertyIconCategory[];
}

const NOTE_ICON_MODULES = import.meta.glob<string>(
  '../../../assets/property-icons/*/*/*.svg',
  { eager: true, import: 'default' },
);

const PACK_INDEX = new Map<PropertyIconPackId, number>(
  PROPERTY_ICON_PACK_IDS.map((id, index) => [id, index]),
);

const CATEGORY_IDS_BY_PACK: ReadonlyMap<PropertyIconPackId, ReadonlySet<string>> = new Map([
  ['emoji', new Set<string>(PROPERTY_ICON_CATEGORY_IDS)],
  ['mochi', new Set<string>(PROPERTY_ICON_MOCHI_CATEGORY_IDS)],
]);

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

/** `<pack>/<category>/<id>.svg` → pack + category; 不在已知列表里则丢弃。 */
function readPackAndCategory(path: string): {
  pack: PropertyIconPackId;
  category: PropertyIconCategoryId;
} | null {
  const parts = path.split('/');
  const pack = parts[parts.length - 3] as PropertyIconPackId;
  const category = parts[parts.length - 2] as PropertyIconCategoryId;
  if (!PACK_INDEX.has(pack)) return null;
  if (!CATEGORY_IDS_BY_PACK.get(pack)?.has(category)) return null;
  return { pack, category };
}

// 按「包顺序 → 分类顺序 → 分类内 label 字母序」排, 遍历时也是分组连续的。
const ALL_OPTIONS: readonly PropertyIconOption[] = Object.entries(NOTE_ICON_MODULES)
  .flatMap(([path, src]) => {
    const parsed = readPackAndCategory(path);
    if (!parsed) return [];
    const value = getIconIdFromPath(path);
    return [{ value, label: getIconLabel(value), src, ...parsed }];
  })
  .sort((a, b) => {
    const packOrder =
      PACK_INDEX.get(a.pack)! - PACK_INDEX.get(b.pack)!;
    if (packOrder !== 0) return packOrder;
    const categoryOrder =
      packCategoryOrder(a.pack, a.category) - packCategoryOrder(b.pack, b.category);
    if (categoryOrder !== 0) return categoryOrder;
    return a.label.localeCompare(b.label);
  });

function packCategoryOrder(pack: PropertyIconPackId, category: PropertyIconCategoryId): number {
  const ids = pack === 'mochi'
    ? PROPERTY_ICON_MOCHI_CATEGORY_IDS
    : PROPERTY_ICON_CATEGORY_IDS;
  const index = (ids as readonly string[]).indexOf(category);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

/** 全部图标 (已按包/分类排好), 供需要扁平列表的调用方使用。 */
export const PROPERTY_ICON_OPTIONS: readonly PropertyIconOption[] = ALL_OPTIONS;

function countByCategory(pack: PropertyIconPackId, id: PropertyIconCategoryId): number {
  return ALL_OPTIONS.reduce(
    (total, option) => (option.pack === pack && option.category === id ? total + 1 : total),
    0,
  );
}

/** 图标包分组: 只包含真实存在图标的分类, 供 picker 渲染两级切换。 */
export const PROPERTY_ICON_PACKS: readonly PropertyIconPack[] =
  PROPERTY_ICON_PACK_IDS.map((pack) => ({
    id: pack,
    categories: (pack === 'mochi'
      ? PROPERTY_ICON_MOCHI_CATEGORY_IDS
      : PROPERTY_ICON_CATEGORY_IDS).flatMap((id) => {
      const count = countByCategory(pack, id);
      return count > 0 ? [{ id, count }] : [];
    }),
  }));

/** 某个包内某分类的图标; picker 只渲染当前分类, 避免一次挂上千个 <img>。 */
export function getPropertyIconCategoryOptions(
  pack: PropertyIconPackId,
  category: PropertyIconCategoryId,
): readonly PropertyIconOption[] {
  return ALL_OPTIONS.filter((option) => option.pack === pack && option.category === category);
}

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

/** 当前值没有对应包/分类时给个兜底, 保证 picker 永远有内容可渲染。 */
export function getDefaultPropertyIconPack(): PropertyIconPackId {
  return PROPERTY_ICON_PACKS[0]?.id ?? 'emoji';
}

export function getDefaultPropertyIconCategory(
  pack: PropertyIconPackId = getDefaultPropertyIconPack(),
): PropertyIconCategoryId {
  const target = PROPERTY_ICON_PACKS.find((entry) => entry.id === pack);
  return target?.categories[0]?.id ?? PROPERTY_ICON_CATEGORY_IDS[0];
}
