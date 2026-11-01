/**
 * 集合展示层的「更新时间」文案 —— **唯一实现**。
 *
 * 集合界面有三处会显示更新时间，口径不同但来源同一个时间戳：
 *   - 文件树 tab 与列表卡片：`formatUpdatedAt`，今天 / 昨天 / 今年内短日期 / 跨年完整日期；
 *   - 图墙与画廊卡片：`formatUpdatedAgo`，相对时间（刚刚 / N 分钟前 / … / N 年前）。
 *
 * 这两套文案原先在 `collection-files-tab` / `document-list-view` / `table-secondary-views`
 * 各写了一份（其中两份把中文硬编码在代码里，切到 en-US 也不变），现在统一到这里：
 * 时间戳归一、相对区间分档、Intl 日期缓存只有一份，文案全部走 i18n key
 * （`collection.time.*` 与 `collection.filesTab.updated*`）。
 */
import type { I18nKey, I18nParams } from '@/lib/i18n';

type Translate = (key: I18nKey, params?: I18nParams) => string;

const DAY_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
const SHORT_DAY_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** 跨年的完整日期（带年份）。 */
function formatDayLabel(date: Date, language: string): string {
  let formatter = DAY_FORMATTERS.get(language);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(language, { year: 'numeric', month: 'long', day: 'numeric' });
    DAY_FORMATTERS.set(language, formatter);
  }
  return formatter.format(date);
}

/**
 * 今年内的日期：不展示年份。zh 走「10月30」（ICU 的 zh 月日模式固定带「日」，
 * 与期望格式不符，单独拼）；其它语言走 Intl 短月日（en → `Oct 30`）。
 */
function formatShortDayLabel(date: Date, language: string): string {
  if (/^zh/i.test(language)) return `${date.getMonth() + 1}月${date.getDate()}`;
  let formatter = SHORT_DAY_FORMATTERS.get(language);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric' });
    SHORT_DAY_FORMATTERS.set(language, formatter);
  }
  return formatter.format(date);
}

/**
 * 绝对口径 ── `今天 12:23` / `昨天 12:30` / 今年内 `10月30 12:23`（不展示年份）/
 * 跨年 `2025年10月12日 12:30`，格式随语言走 Intl。非法时间戳返回空串（调用方据此不渲染）。
 */
export function formatUpdatedAt(timestamp: number, language: string, t: Translate): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday.getTime() - startOfDay) / 86_400_000);
  if (dayDiff === 0) return t('collection.filesTab.updatedToday', { time: clock });
  if (dayDiff === 1) return t('collection.filesTab.updatedYesterday', { time: clock });
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return `${sameYear ? formatShortDayLabel(date, language) : formatDayLabel(date, language)} ${clock}`;
}

/**
 * 相对口径 ── `更新 刚刚` / `更新 5分钟前` / `更新 3天前` …。
 *
 * 接受毫秒或 ISO 字符串（媒体记录用 `created_at` 字符串，笔记用 `modifiedMs`）；
 * 缺失或非法时给「更新时间未知」，与旧实现一致。
 */
export function formatUpdatedAgo(timestamp: number | string | null | undefined, t: Translate): string {
  const value = typeof timestamp === 'string' ? Date.parse(timestamp) : timestamp;
  if (value === null || value === undefined || !Number.isFinite(value)) return t('collection.time.unknown');
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  const relative = elapsedSeconds < 60 ? t('collection.time.justNow')
    : elapsedSeconds < 3_600 ? t('collection.time.minutesAgo', { n: Math.floor(elapsedSeconds / 60) })
      : elapsedSeconds < 86_400 ? t('collection.time.hoursAgo', { n: Math.floor(elapsedSeconds / 3_600) })
        : elapsedSeconds < 2_592_000 ? t('collection.time.daysAgo', { n: Math.floor(elapsedSeconds / 86_400) })
          : elapsedSeconds < 31_104_000 ? t('collection.time.monthsAgo', { n: Math.floor(elapsedSeconds / 2_592_000) })
            : t('collection.time.yearsAgo', { n: Math.floor(elapsedSeconds / 31_104_000) });
  return t('collection.time.updated', { time: relative });
}
