import { tags } from '@platform/tauri/client';

export interface MentionTagItem {
  id: string;
  name: string;
  /** 是否是"新建"占位项 (用户敲了不存在的 tag 名, 用 query 文本构造出的临时条目) */
  create: boolean;
}

// mention 缓存按 notebookId 分: 切换笔记本时丢弃旧缓存, 下次 `#` 触发重新
// fetch 当前 notebook 的 tag。之前是模块级单例不带 notebook 维度, 切笔记本
// 后下拉仍显示旧笔记本的 tag。
//
// notebookId 通过 provider 注入 (setNotebookIdProvider), 而不是本模块直接
// import memo-store ── editor 模块在加载链上被 agent-thread-card 等引用,
// 若 editor -> memo-store 会改变模块初始化顺序, 破坏 composer 等的 mock
// 时序。provider 由 app 层 (main-window-effects) 启动时注入, 解耦。
let cachedNotebookId: string | null = null;
let cachedTags: MentionTagItem[] | null = null;
let tagCachePromise: Promise<MentionTagItem[]> | null = null;
let notebookIdProvider: (() => string | null | undefined) | null = null;

export function setNotebookIdProvider(
  fn: () => string | null | undefined,
): void {
  notebookIdProvider = fn;
}

function normalizeTagName(query: string): string {
  return query.trim().replace(/^#+/, '').replace(/\s+/g, '');
}

async function fetchMentionTags(notebookId: string | null): Promise<MentionTagItem[]> {
  const response = await tags.getAll(notebookId ?? undefined);
  return (response.tags ?? []).map((tag) => ({
    id: tag.id,
    name: tag.name,
    create: false,
  }));
}

function loadMentionTags(notebookId: string | null): Promise<MentionTagItem[]> {
  // notebook 切换: 丢弃旧缓存, mention 只展示当前 notebook 的 tag。
  if (cachedNotebookId !== notebookId) {
    cachedNotebookId = notebookId;
    cachedTags = null;
    tagCachePromise = null;
  }
  if (cachedTags) return Promise.resolve(cachedTags);
  if (!tagCachePromise) {
    tagCachePromise = fetchMentionTags(notebookId)
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
  const notebookId = notebookIdProvider?.() ?? null;
  const normalizedQuery = normalizeTagName(query).toLowerCase();
  const allTags = await loadMentionTags(notebookId);

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
