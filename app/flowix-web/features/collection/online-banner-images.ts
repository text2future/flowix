/**
 * 集合头图「在线图库」的预置链接清单。
 *
 * 每一项是一个 Unsplash CDN 基础直链（不带查询参数）。点选后经
 * `onlineBannerCropUrl` 统一裁切成 900×200、质量 q=60 再写进 `banner_image`
 * （与本地相对路径共用同一个 Text 属性，渲染时按 `http(s)://` 前缀区分），
 * 不下载、不落盘；离线或链接失效时 `<img onError>` 置空展示地址，
 * 回落到标题派生的纯色占位。
 *
 * 清单由产品侧维护：替换下面数组即可（只存基础 URL，不带 `?w=..&h=..`，
 * 裁切尺寸与质量统一在 `withCropParams` 里控制）。下拉窗里按双列网格只展示
 * 图片缩略图，不展示标题。
 */
export const ONLINE_BANNER_IMAGES: readonly string[] = [
  'https://images.unsplash.com/photo-1541961017774-22349e4a1262',
  'https://images.unsplash.com/photo-1549289524-06cf8837ace5',
  'https://images.unsplash.com/photo-1550684848-fac1c5b4e853',
  'https://images.unsplash.com/photo-1557672172-298e090bd0f1',
  'https://images.unsplash.com/photo-1558591710-4b4a1ae0f04d',
  'https://images.unsplash.com/photo-1567095761054-7a02e69e5c43',
  'https://images.unsplash.com/photo-1579783902614-a3fb3927b6a5',
  'https://images.unsplash.com/photo-1580136579312-94651dfd596d',
  'https://images.unsplash.com/photo-1590422749897-47036da0b0ff',
  'https://images.unsplash.com/photo-1620503374956-c942862f0372',
  'https://images.unsplash.com/photo-1633177317976-3f9bc45e1d1d',
  'https://images.unsplash.com/photo-1502082553048-f009c37129b9',
  'https://images.unsplash.com/photo-1470770841072-f978cf4d019e',
  'https://images.unsplash.com/photo-1441974231531-c6227db76b6e',
  'https://images.unsplash.com/photo-1506744038136-46273834b3fb',
  'https://images.unsplash.com/photo-1501785888041-af3ef285b470',
  'https://images.unsplash.com/photo-1472214103451-9374bd1c798e',
  'https://images.unsplash.com/photo-1502602898657-3e91760cbb34',
  'https://images.unsplash.com/photo-1499856871958-5b9627545d1a',
  'https://images.unsplash.com/photo-1526481280693-3bfa7568e0f3',
  'https://images.unsplash.com/photo-1513635269975-59663e0ac1ad',
  'https://images.unsplash.com/photo-1523906834658-6e24ef2386f9',
  'https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e',
  'https://images.unsplash.com/photo-1512453979798-5ea266f8880c',
  'https://images.unsplash.com/photo-1531572753322-ad063cecc140',
  'https://images.unsplash.com/photo-1518684079-3c830dcef090',
  'https://images.unsplash.com/photo-1523482580672-f109ba8cb9be',
  'https://images.unsplash.com/photo-1516483638261-f4dbaf036963',
  'https://images.unsplash.com/photo-1505761671935-60b3a7427bad',
  'https://images.unsplash.com/photo-1508062878650-88b52897f298',
  'https://images.unsplash.com/photo-1519681393784-d120267933ba',
  'https://images.unsplash.com/photo-1507525428034-b723cf961d3e',
  'https://images.unsplash.com/photo-1476514525535-07fb3b4ae5f1',
  'https://images.unsplash.com/photo-1467269204594-9661b134dd2b',
  'https://images.unsplash.com/photo-1533105079780-92b9be482077',
  'https://images.unsplash.com/photo-1519125323398-675f0ddb6308',
  'https://images.unsplash.com/photo-1508672019048-805c876b67e2',
  'https://images.unsplash.com/photo-1477959858617-67f85cf4f1df',
  'https://images.unsplash.com/photo-1449824913935-59a10b8d2000',
  'https://images.unsplash.com/photo-1444723121867-7a241cacace9',
  'https://images.unsplash.com/photo-1502920917128-1aa500764cbd',
];

const UNSPLASH_IMAGE_PATTERN = /^https:\/\/images\.unsplash\.com\//;

/** 给 Unsplash 链接拼 imgix 裁切参数（质量统一 q=60）；非 Unsplash 链接原样返回。 */
function withCropParams(url: string, width: number, height: number): string {
  if (!UNSPLASH_IMAGE_PATTERN.test(url)) return url;
  return `${url}?auto=format&fit=crop&w=${width}&h=${height}&q=60`;
}

/** 横幅展示与写入 `banner_image` 的最终 URL：统一按 900×200 裁切。 */
export function onlineBannerCropUrl(url: string): string {
  return withCropParams(url, 900, 200);
}

/** 下拉窗缩略图：同一裁切比例的适中尺寸版（双列网格一格约 250 CSS px）。 */
export function onlineBannerThumbUrl(url: string): string {
  return withCropParams(url, 520, 115);
}

/** 去掉查询串的基础地址：把已写入的带参 URL 对回清单项（选中高亮用）。 */
export function onlineBannerBase(url: string): string {
  return url.split('?')[0] ?? url;
}
