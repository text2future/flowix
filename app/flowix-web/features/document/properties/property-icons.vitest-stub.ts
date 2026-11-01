// 测试专用替身: vitest 用它替换真正的 property-icons.ts。
//
// ── 为什么需要 ──
// 真实模块用 `import.meta.glob` 收集 1400+ 个 svg。浏览器里这没问题 (图标是
// 按需加载的独立资源), 但 vitest 会把每个 svg 当成一个模块逐个转译 + 执行,
// 每个用到图标的测试文件要多花 ~100s 导入, 甚至拖垮 worker。
// 测试关心的是「有包/分类、有 option、点选能回填」这类结构行为, 不需要真实
// 资产, 所以这里给一份小样本 (2 包 / 4 分类 / 8 图标), 形状与真模块完全一致。
//
// ── 注意 ──
// 包/分类列表和图标 id 要和真模块对得上, 否则测试过了线上却错。真模块的结构
// 由 scripts/sync-property-icons.mjs 与 sync-mochi-icons.mjs 生成,
// 改那里时记得同步这里。

export const PROPERTY_ICON_PACK_IDS = ['emoji', 'mochi'] as const;

export type PropertyIconPackId = (typeof PROPERTY_ICON_PACK_IDS)[number];

export const PROPERTY_ICON_CATEGORY_IDS = [
  'smileys-emotion',
  'animals-nature',
  'food-drink',
  'travel-places',
  'objects',
] as const;

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

const STUB_EMOJI_CATEGORIES: readonly { id: PropertyIconCategoryId; icons: readonly string[] }[] = [
  { id: 'smileys-emotion', icons: ['grinning-face', 'smiling-face-with-hearts'] },
  { id: 'animals-nature', icons: ['dog-face', 'cat-face'] },
  { id: 'food-drink', icons: ['avocado', 'pizza'] },
  { id: 'travel-places', icons: ['star'] },
  { id: 'objects', icons: ['light-bulb', 'pushpin', 'flashlight', 'briefcase'] },
];

const STUB_MOCHI_CATEGORIES: readonly { id: PropertyIconCategoryId; icons: readonly string[] }[] = [
  { id: 'all', icons: ['mochi-cactus', 'mochi-watermelon'] },
];

function toLabel(id: string): string {
  return id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function buildOptions(
  pack: PropertyIconPackId,
  categories: readonly { id: PropertyIconCategoryId; icons: readonly string[] }[],
): PropertyIconOption[] {
  return categories.flatMap(({ id, icons }) => icons.map((value) => ({
    value,
    label: toLabel(value),
    src: `/assets/property-icons/${pack}/${id}/${value}.svg`,
    pack,
    category: id,
  })));
}

export const PROPERTY_ICON_OPTIONS: readonly PropertyIconOption[] = [
  ...buildOptions('emoji', STUB_EMOJI_CATEGORIES),
  ...buildOptions('mochi', STUB_MOCHI_CATEGORIES),
];

export const PROPERTY_ICON_PACKS: readonly PropertyIconPack[] = [
  { id: 'emoji', categories: STUB_EMOJI_CATEGORIES.map(({ id, icons }) => ({ id, count: icons.length })) },
  { id: 'mochi', categories: STUB_MOCHI_CATEGORIES.map(({ id, icons }) => ({ id, count: icons.length })) },
];

export function getPropertyIconCategoryOptions(
  pack: PropertyIconPackId,
  category: PropertyIconCategoryId,
): readonly PropertyIconOption[] {
  return PROPERTY_ICON_OPTIONS.filter(
    (option) => option.pack === pack && option.category === category,
  );
}

export function getPropertyIconOption(value: string): PropertyIconOption | null {
  const normalized = value.trim().replace(/\.svg$/i, '');
  if (!normalized) return null;
  // 与真模块同语义: 未收录的 id 返回 null (渲染为「未设置图标」)。不要在这里
  // 给未知 id 合成 option —— frontmatter-property.test 依赖 unknown id 的
  // 空态断言, 真模块也不会命中。
  return PROPERTY_ICON_OPTIONS.find((option) => option.value === normalized) ?? null;
}

export function getDefaultPropertyIconPack(): PropertyIconPackId {
  return 'emoji';
}

export function getDefaultPropertyIconCategory(
  pack: PropertyIconPackId = getDefaultPropertyIconPack(),
): PropertyIconCategoryId {
  return pack === 'mochi' ? 'all' : PROPERTY_ICON_CATEGORY_IDS[0];
}
