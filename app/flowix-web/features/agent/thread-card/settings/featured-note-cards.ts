import { system } from "@platform/tauri/client";
import { getPropertyIconOption } from "@features/document/properties/property-icons";
import { getNotebookIconMarkup } from "@features/memo/components/notebook-icon";
import type { MemoItem } from "@/types/memo-item";

// Keep one row visible: one or two cards are centered, three fill the row,
// and any additional cards move to the next page.
export const FEATURED_NOTE_PAGE_SIZE = 3;
export const FEATURED_NOTE_MOBILE_PAGE_SIZE = 3;

/**
 * 笔记没有自定义图标时的默认图标。
 *
 * 取值是 assets/notebook-icons 里的 id, 由 appendFeaturedNoteIconContent 渲染成
 * 内联 SVG (而非像以前的 "✦" 那样当纯文本显示)。
 */
export const DEFAULT_FEATURED_NOTE_ICON = "bulb_2_ai_fill";

export type FeaturedNoteFilterOperator = "equals" | "contains" | "excludes";

/** 单条筛选条件: 笔记属性 key + 判定方式 + 期望值。 */
export interface FeaturedNoteFilter {
  key: string;
  operator: FeaturedNoteFilterOperator;
  value: string;
}

/**
 * 常用笔记的筛选配置。
 *
 * 多条条件之间是 **并集** 关系: 一条笔记命中任意一条条件即视为常用笔记。
 * 数组为空时回落到默认条件。
 */
export interface FeaturedNoteFilterConfig {
  conditions: FeaturedNoteFilter[];
}

export const DEFAULT_FEATURED_NOTE_FILTER: FeaturedNoteFilter = {
  key: "type",
  operator: "equals",
  value: "skill",
};

export const DEFAULT_FEATURED_NOTE_FILTER_CONFIG: FeaturedNoteFilterConfig = {
  conditions: [{ ...DEFAULT_FEATURED_NOTE_FILTER }],
};

/** 条件条数上限: 弹层高度有限, 且继续加下去对"常用笔记"已无意义。 */
export const MAX_FEATURED_NOTE_CONDITIONS = 5;

export interface FeaturedNoteMemoPage {
  memos: MemoItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface FeaturedNoteCard {
  id: string;
  icon: string;
  name: string;
  title: string;
  description: string;
}

function propertyString(properties: Record<string, unknown>, key: string): string {
  const value = properties[key];
  return typeof value === "string" ? value.trim() : "";
}

function normalizeFilter(filter: FeaturedNoteFilter): FeaturedNoteFilter | null {
  const key = filter.key.trim();
  const value = filter.value.trim();
  const operator: FeaturedNoteFilterOperator =
    filter.operator === "contains" || filter.operator === "excludes"
      ? filter.operator
      : "equals";
  // 无效条件返回 null, 由调用方决定是丢弃还是回落, 避免这里隐式替换成默认条件
  // (多条件场景下把空行替换成 type=skill 会莫名其妙地多匹配一批笔记)。
  return key && value ? { key, operator, value } : null;
}

/**
 * 归一化整份配置: 逐条 trim + operator 白名单, 丢弃不完整的条件。
 *
 * 全部条件都无效时回落到默认配置 —— 零条件会让"常用笔记"永远为空。
 */
export function normalizeFeaturedNoteFilterConfig(
  config: FeaturedNoteFilterConfig,
): FeaturedNoteFilterConfig {
  const conditions = (config.conditions ?? [])
    .slice(0, MAX_FEATURED_NOTE_CONDITIONS)
    .map(normalizeFilter)
    .filter((condition): condition is FeaturedNoteFilter => condition !== null);
  return conditions.length > 0
    ? { conditions }
    : { conditions: [{ ...DEFAULT_FEATURED_NOTE_FILTER }] };
}

/** 单个标量 (string / boolean / number) 与期望值的比较。 */
function scalarMatches(
  value: string | boolean | number,
  expected: string,
  operator: FeaturedNoteFilterOperator,
): boolean {
  const actual = String(value).trim().toLocaleLowerCase();
  const normalizedExpected = expected.toLocaleLowerCase();
  if (operator === "contains") return actual.includes(normalizedExpected);
  if (operator === "excludes") return !actual.includes(normalizedExpected);
  return actual === normalizedExpected;
}

/**
 * YAML 头信息里某个 key 的值是否满足条件。
 *
 * 标量直接比较; **数组逐元素比较**, 命中任意一个元素即算命中 —— YAML 里
 * `tags` 这类多值字段就是数组, 只有逐元素比较才能用 `equals`/`contains` 命中。
 *
 * `excludes` 在数组上的语义是「没有任何一个元素匹配」(而不是「存在某个元素
 * 不匹配」), 否则一个多值字段几乎永远满足 excludes, 条件会失去意义。
 */
function propertyMatches(
  value: unknown,
  expected: string,
  operator: FeaturedNoteFilterOperator,
): boolean {
  if (Array.isArray(value)) {
    // 空数组不匹配任何条件 (含 excludes): 没有值可供判定, 不应视为"已满足"。
    if (value.length === 0) return false;
    const scalars = value.filter(
      (item): item is string | boolean | number => (
        typeof item === "string" || typeof item === "boolean" || typeof item === "number"
      ),
    );
    if (scalars.length === 0) return false;
    return operator === "excludes"
      ? scalars.every((item) => scalarMatches(item, expected, "excludes"))
      : scalars.some((item) => scalarMatches(item, expected, operator));
  }
  if (typeof value !== "string" && typeof value !== "boolean" && typeof value !== "number") {
    return false;
  }
  return scalarMatches(value, expected, operator);
}

/** 是否命中任意一条条件 (并集)。 */
function matchesAnyCondition(
  properties: Record<string, unknown>,
  conditions: FeaturedNoteFilter[],
): boolean {
  return conditions.some((condition) => propertyMatches(
    properties[condition.key],
    condition.value,
    condition.operator,
  ));
}

/**
 * 读取某笔记本的常用笔记筛选条件。
 *
 * 存储位置是笔记本文件夹内的 `<notebook>/.flowix/system.json` (与 tag 元数据
 * 同文件不同段), 因此配置跟随笔记本走, 而不是绑在这台机器的 localStorage 上。
 *
 * 后端对"未配置"返回三个空字段, 这里统一回落到默认值 —— 默认值的唯一定义处
 * 就是本模块的 `DEFAULT_FEATURED_NOTE_FILTER`, 后端不重复定义。
 *
 * 读取失败 (笔记本不存在 / IPC 异常 / JSON 损坏) 同样回落到默认值: 常用笔记
 * 只是空状态的增强, 读不到配置不应该让整个对话面板不可用。
 */
export async function readFeaturedNoteFilter(
  notebookId: string,
): Promise<FeaturedNoteFilterConfig> {
  try {
    const stored = await system.getFeaturedNoteFilter(notebookId);
    if (!Array.isArray(stored?.conditions)) {
      return { conditions: [{ ...DEFAULT_FEATURED_NOTE_FILTER }] };
    }
    return normalizeFeaturedNoteFilterConfig({
      conditions: stored.conditions.map((condition) => ({
        key: typeof condition?.key === "string" ? condition.key : "",
        operator: condition?.operator as FeaturedNoteFilterOperator,
        value: typeof condition?.value === "string" ? condition.value : "",
      })),
    });
  } catch {
    return { conditions: [{ ...DEFAULT_FEATURED_NOTE_FILTER }] };
  }
}

/**
 * 写入某笔记本的常用笔记筛选配置, 返回归一化后的值。
 *
 * 归一化后再落盘, 保证磁盘上的 operator 始终是后端白名单里的值、且至少有一条
 * 有效条件; 写入失败向上抛出, 由调用方决定是否提示 —— 静默吞掉会让用户以为已保存。
 */
export async function writeFeaturedNoteFilter(
  notebookId: string,
  config: FeaturedNoteFilterConfig,
): Promise<FeaturedNoteFilterConfig> {
  const normalized = normalizeFeaturedNoteFilterConfig(config);
  await system.setFeaturedNoteFilter(notebookId, {
    conditions: normalized.conditions.map((condition) => ({ ...condition })),
  });
  return normalized;
}

function noteTitle(filename: string): string {
  return filename.replace(/\.md$/iu, "").trim() || filename;
}

/**
 * 把笔记图标写进卡片图标位。
 *
 * 图标值可能有两种形态, 与 `appendRoleIconContent` (agent 角色选择器) 保持同一
 * 套解析顺序:
 *   1. 属性图标 id (如 `dog-face`) → 渲染成 `<img>` 引用 assets/property-icons;
 *   2. 笔记本图标 id (如 `board_fill`) → 内联 SVG (assets/notebook-icons);
 *   3. 其他 (emoji / 一个字) → 直接作为文本。
 *
 * 之前直接把值塞进 textContent, 于是 `flowix_icon: board_fill` 这类 id 会以
 * 字面量 "board_fill" 显示在图标位, 看起来像"图标加载失败"。
 */
export function appendFeaturedNoteIconContent(target: HTMLElement, icon: string): void {
  const value = icon.trim();
  if (!value) return;

  const propertyIcon = getPropertyIconOption(value);
  if (propertyIcon) {
    const image = document.createElement("img");
    image.src = propertyIcon.src;
    image.alt = "";
    image.draggable = false;
    target.append(image);
    return;
  }

  const iconMarkup = getNotebookIconMarkup(value);
  if (iconMarkup) {
    target.innerHTML = iconMarkup;
    return;
  }

  target.textContent = value;
}

/**
 * Resolve notes that are useful as first-turn shortcuts.
 *
 * The default convention is `type: skill`. The property key and expected
 * value are configurable, so conventions such as `pin: true` also work.
 *
 * 多条条件按 **并集** 处理: 命中任意一条即入选。
 */
export function getFeaturedNoteCards(
  memos: MemoItem[],
  config: FeaturedNoteFilterConfig = DEFAULT_FEATURED_NOTE_FILTER_CONFIG,
): FeaturedNoteCard[] {
  const { conditions } = normalizeFeaturedNoteFilterConfig(config);
  return memos.flatMap((memo) => {
    const properties = memo.properties && typeof memo.properties === "object"
      ? memo.properties
      : {};
    if (!matchesAnyCondition(properties, conditions)) return [];

    const name = propertyString(properties, "name");
    const description =
      propertyString(properties, "desc")
      || propertyString(properties, "description")
      || memo.preview.trim();
    // 与 getMemoIconValue 保持同一优先级: 用户显式写在 frontmatter 的 icon 优先,
    // 其次是后端从 flowix_icon 解析出的 memo.icon; 都没有时用统一的默认图标
    // (笔记本图标库里的 id, 由 appendFeaturedNoteIconContent 渲染成 SVG)。
    const icon = propertyString(properties, "icon")
      || memo.icon?.trim()
      || DEFAULT_FEATURED_NOTE_ICON;

    return [{
      id: memo.id,
      icon,
      name,
      title: noteTitle(memo.filename),
      description,
    }];
  });
}

export function getFeaturedNotePageCount(noteCount: number): number {
  return getFeaturedNotePageCountForSize(noteCount, FEATURED_NOTE_PAGE_SIZE);
}

export function getFeaturedNotePageCountForSize(
  noteCount: number,
  pageSize: number,
): number {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  return Math.max(1, Math.ceil(noteCount / safePageSize));
}

export function getFeaturedNotePage(
  notes: FeaturedNoteCard[],
  page: number,
  pageSize = FEATURED_NOTE_PAGE_SIZE,
): FeaturedNoteCard[] {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const pageCount = getFeaturedNotePageCountForSize(notes.length, safePageSize);
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const start = safePage * safePageSize;
  return notes.slice(start, start + safePageSize);
}

export async function loadAllFeaturedNoteCards(
  loadPage: (cursor?: string) => Promise<FeaturedNoteMemoPage>,
  isActive: () => boolean = () => true,
  config: FeaturedNoteFilterConfig = DEFAULT_FEATURED_NOTE_FILTER_CONFIG,
): Promise<FeaturedNoteCard[]> {
  const cards: FeaturedNoteCard[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  while (isActive()) {
    const page = await loadPage(cursor);
    if (!isActive()) return [];
    cards.push(...getFeaturedNoteCards(page.memos, config));

    const nextCursor = page.nextCursor?.trim() || undefined;
    if (!page.hasMore || !nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return cards;
}
