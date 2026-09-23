import type { MemoItem } from "@/types/memo-item";

// Keep one row visible: one or two cards are centered, three fill the row,
// and any additional cards move to the next page.
export const FEATURED_NOTE_PAGE_SIZE = 3;
export const FEATURED_NOTE_MOBILE_PAGE_SIZE = 3;
const FEATURED_NOTE_FILTER_STORAGE_KEY = "flowix.agent.featured-note-filter";

export type FeaturedNoteFilterOperator = "equals" | "contains" | "excludes";

export interface FeaturedNoteFilter {
  key: string;
  operator: FeaturedNoteFilterOperator;
  value: string;
}

export const DEFAULT_FEATURED_NOTE_FILTER: FeaturedNoteFilter = {
  key: "type",
  operator: "equals",
  value: "skill",
};

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

function normalizeFilter(filter: FeaturedNoteFilter): FeaturedNoteFilter {
  const key = filter.key.trim();
  const value = filter.value.trim();
  const operator: FeaturedNoteFilterOperator =
    filter.operator === "contains" || filter.operator === "excludes"
      ? filter.operator
      : "equals";
  return key && value ? { key, operator, value } : { ...DEFAULT_FEATURED_NOTE_FILTER };
}

function propertyMatches(
  value: unknown,
  expected: string,
  operator: FeaturedNoteFilterOperator,
): boolean {
  if (typeof value !== "string" && typeof value !== "boolean" && typeof value !== "number") {
    return false;
  }
  const actual = String(value).trim().toLocaleLowerCase();
  const normalizedExpected = expected.toLocaleLowerCase();
  if (operator === "contains") return actual.includes(normalizedExpected);
  if (operator === "excludes") return !actual.includes(normalizedExpected);
  return actual === normalizedExpected;
}

export function readFeaturedNoteFilter(): FeaturedNoteFilter {
  try {
    const stored = JSON.parse(window.localStorage.getItem(FEATURED_NOTE_FILTER_STORAGE_KEY) ?? "null") as unknown;
    if (!stored || typeof stored !== "object") return { ...DEFAULT_FEATURED_NOTE_FILTER };
    const candidate = stored as Partial<FeaturedNoteFilter>;
    if (typeof candidate.key !== "string" || typeof candidate.value !== "string") {
      return { ...DEFAULT_FEATURED_NOTE_FILTER };
    }
    return normalizeFilter({
      key: candidate.key,
      operator: candidate.operator ?? "equals",
      value: candidate.value,
    });
  } catch {
    return { ...DEFAULT_FEATURED_NOTE_FILTER };
  }
}

export function writeFeaturedNoteFilter(filter: FeaturedNoteFilter): FeaturedNoteFilter {
  const normalized = normalizeFilter(filter);
  try {
    window.localStorage.setItem(FEATURED_NOTE_FILTER_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Local storage is optional in embedded/private browser contexts.
  }
  return normalized;
}

function noteTitle(filename: string): string {
  return filename.replace(/\.md$/iu, "").trim() || filename;
}

/**
 * Resolve notes that are useful as first-turn shortcuts.
 *
 * The default convention is `type: skill`. The property key and expected
 * value are configurable, so conventions such as `pin: true` also work.
 */
export function getFeaturedNoteCards(
  memos: MemoItem[],
  filter: FeaturedNoteFilter = DEFAULT_FEATURED_NOTE_FILTER,
): FeaturedNoteCard[] {
  const normalizedFilter = normalizeFilter(filter);
  return memos.flatMap((memo) => {
    const properties = memo.properties && typeof memo.properties === "object"
      ? memo.properties
      : {};
    if (!propertyMatches(
      properties[normalizedFilter.key],
      normalizedFilter.value,
      normalizedFilter.operator,
    )) return [];

    const name = propertyString(properties, "name");
    const description =
      propertyString(properties, "desc")
      || propertyString(properties, "description")
      || memo.preview.trim();
    const icon = propertyString(properties, "icon") || memo.icon?.trim() || "✦";

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
  filter: FeaturedNoteFilter = DEFAULT_FEATURED_NOTE_FILTER,
): Promise<FeaturedNoteCard[]> {
  const cards: FeaturedNoteCard[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  while (isActive()) {
    const page = await loadPage(cursor);
    if (!isActive()) return [];
    cards.push(...getFeaturedNoteCards(page.memos, filter));

    const nextCursor = page.nextCursor?.trim() || undefined;
    if (!page.hasMore || !nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return cards;
}
