import { tags } from '@platform/tauri/client';

export interface MentionTagItem {
  id: string;
  name: string;
  /** 是否是"新建"占位项 (用户敲了不存在的 tag 名, 用 query 文本构造出的临时条目) */
  create: boolean;
}

let cachedTags: MentionTagItem[] | null = null;
let tagCachePromise: Promise<MentionTagItem[]> | null = null;

function normalizeTagName(query: string): string {
  return query.trim().replace(/^#+/, '').replace(/\s+/g, '');
}

async function fetchMentionTags(): Promise<MentionTagItem[]> {
  const response = await tags.getAll();
  return (response.tags ?? []).map((tag) => ({
    id: tag.id,
    name: tag.name,
    create: false,
  }));
}

function loadMentionTags(): Promise<MentionTagItem[]> {
  if (cachedTags) return Promise.resolve(cachedTags);
  if (!tagCachePromise) {
    tagCachePromise = fetchMentionTags()
      .then((items) => {
        cachedTags = items;
        return items;
      })
      .catch((err) => {
        console.warn('[tag-mention] load failed:', err);
        tagCachePromise = null;
        return [];
      });
  }
  return tagCachePromise;
}

export function invalidateMentionTags(): void {
  cachedTags = null;
  tagCachePromise = null;
}

export async function queryMentionTags(query: string): Promise<MentionTagItem[]> {
  const normalizedQuery = normalizeTagName(query).toLowerCase();
  const allTags = await loadMentionTags();

  if (!normalizedQuery) return allTags;

  const matched = allTags.filter((tag) => tag.name.toLowerCase().includes(normalizedQuery));
  const exact = matched.some((tag) => tag.name.toLowerCase() === normalizedQuery);
  if (!exact) {
    matched.unshift({
      id: normalizedQuery,
      name: normalizeTagName(query),
      create: true,
    });
  }
  return matched;
}