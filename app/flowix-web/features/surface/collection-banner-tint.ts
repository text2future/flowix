/**
 * 集合头图占位的底色：从集合标题文案派生一个固定色相。
 *
 * 纯函数、不读 DOM、不落库 —— 同一个名字永远得到同一个色相，改名即换色；
 * 具体明度/彩度在同一色相上写成纯色，放在 `styles/collection-banner.css` 里按主题分档。
 */

/** FNV-1a 32 位：标题这种短文本用它散列，稳定且分布均匀。 */
function hashTitle(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * 标题 → 色相（0~359.9，0.1° 步进）。
 *
 * 取 3600 个桶而不是 360：整度只有 360 个桶，几十个集合里出现同色很常见
 * （「客户周报」「客户月报」就会撞），0.1° 步进把撞色概率降一个数量级，
 * 观感上又是同一个色系，不需要更好看的调色板。
 * 空标题固定回落 `collection`，避免空名集合都撞同一档。
 */
export function bannerHue(title: string): number {
  return (hashTitle(title.trim() || 'collection') % 3600) / 10;
}
