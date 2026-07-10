import type { Notebook } from '@features/memo';
import { memos, system, tags } from '@platform/tauri/client';

export interface MemoLibraryMetadata {
  tagMap: Record<string, string>;
  tagOptions: MemoTagTreeItem[];
  tagLayout: MemoTagLayoutItem[];
  hiddenTagIds: string[];
  selectedTagId: string | null;
  totalMemoCount: number;
  agentMemoCount: number;
  todoMemoCount: number;
}

export interface MemoTagLayoutItem {
  id: string;
  parentId: string | null;
}

export interface MemoTagTreeItem extends MemoTagLayoutItem {
  /**
   * 节点显示名: 路径式 tag 拆成 segment 后, 这里只保留最后一段 (e.g.
   * `#中国/湖南/长沙` → `中国/湖南/长沙` 拆出三个节点, 名称分别是
   * `中国` / `湖南` / `长沙`)。同级靠 depth 缩进 + 父级 fullPath
   * 隐式表达。
   */
  name: string;
  /** 节点代表的完整路径 (= id = parent chain + name)。filter / 拖拽
   *  都走 fullPath, 选中 `中国` 即选中 fullPath = `中国`。 */
  fullPath: string;
  depth: number;
  /** prefix count: 自身 + 所有以 fullPath/ 为前缀的 descendant 的 memo
   *  数累加 (粗略; 一个 memo 有多个子 tag 时会 over-count, MVP 可接受)。 */
  count: number;
}

interface LoadMemoLibraryMetadataParams {
  notebook: Notebook;
  selectedTagId: string | null;
}

function normalizeSavedStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string')
    : [];
}

function normalizeSavedTagLayout(value: unknown): MemoTagLayoutItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): MemoTagLayoutItem | null => {
      if (!item || typeof item !== 'object') return null;
      const id = 'id' in item ? item.id : null;
      const parentId = 'parentId' in item ? item.parentId : null;
      if (typeof id !== 'string') return null;
      return {
        id,
        parentId: typeof parentId === 'string' ? parentId : null,
      };
    })
    .filter((item): item is MemoTagLayoutItem => Boolean(item));
}

function normalizeTagLayout({
  usedTagIds,
  savedLayout,
  savedOrder,
}: {
  usedTagIds: string[];
  savedLayout: MemoTagLayoutItem[];
  savedOrder: string[];
}): MemoTagLayoutItem[] {
  const usedTagIdSet = new Set(usedTagIds);
  const seen = new Set<string>();
  const base = savedLayout.length > 0
    ? savedLayout
    : savedOrder.map((id) => ({ id, parentId: null }));
  const normalized: MemoTagLayoutItem[] = [];

  for (const item of base) {
    if (!usedTagIdSet.has(item.id) || seen.has(item.id)) continue;
    normalized.push({
      id: item.id,
      parentId: item.parentId && usedTagIdSet.has(item.parentId) && item.parentId !== item.id
        ? item.parentId
        : null,
    });
    seen.add(item.id);
  }

  for (const id of usedTagIds) {
    if (!seen.has(id)) {
      normalized.push({ id, parentId: null });
      seen.add(id);
    }
  }

  const parentById = new Map(normalized.map((item) => [item.id, item.parentId]));
  for (const item of normalized) {
    let cursor = item.parentId;
    const visited = new Set<string>([item.id]);
    while (cursor) {
      if (visited.has(cursor)) {
        item.parentId = null;
        parentById.set(item.id, null);
        break;
      }
      visited.add(cursor);
      cursor = parentById.get(cursor) ?? null;
    }
  }

  return normalized;
}

export function buildTagTreeOptions({
  layout,
  tagById,
  prefixCounts,
}: {
  layout: MemoTagLayoutItem[];
  tagById: Map<string, string>;
  /** 路径式 tag 树的前缀计数: 每个 prefix → 去重 memo 数。
   *  来源: 后端 `get_tag_prefix_counts` IPC (按 memo 数算, 不是 tag 数)。
   *  不在 layout / tagById 里的 prefix 节点不渲染 ── 用不到就丢弃。 */
  prefixCounts: Record<string, number>;
}): MemoTagTreeItem[] {
  // Step 3+: 每个 tag 路径 (e.g. `中国/湖南/长沙`) 拆成多个 segment 节点
  // (中国 / 湖南 / 长沙) ── 选中任一节点即按其 fullPath 做 prefix 过滤。
  // 兄弟顺序由 layout 里的全路径条目首次出现位置决定 (savedOrder 仍是
  // 真实 tag 全路径的列表, 这里展开时按出现顺序插入 segment)。
  //
  // count 来源: 后端 `get_tag_prefix_counts` 已经是按 distinct memo
  // 算好的, 直接读 fullPath 即可。比起累加 tagCounts 的好处:
  // 同一 memo 多个子 tag 在父 prefix 下只算 1。
  //
  // layout.parentId 字段在 saved format 里仍存, 但本函数忽略 ── 父子
  // 关系从 fullPath 字面推导, 不依赖 saved 数据。
  const segmentByFullPath = new Map<
    string,
    { name: string; fullPath: string; depth: number }
  >();

  const ensureSegment = (fullPath: string) => {
    if (segmentByFullPath.has(fullPath)) return;
    const lastSlash = fullPath.lastIndexOf('/');
    if (lastSlash > 0) {
      // 父 segment 必须先存在 (深度小 → 父 → 子)。递归 ensure 保证
      // 中间 parent 缺失时也能正确插入到合适位置。
      ensureSegment(fullPath.slice(0, lastSlash));
    }
    const name = lastSlash > 0 ? fullPath.slice(lastSlash + 1) : fullPath;
    // depth = slash 数量: `中国/湖南` (1 slash) → depth 1。注意不能
    // 用 lastSlash (它是字节位置), 必须重数 slash 数。
    const depthFromSlashes = (fullPath.match(/\//g) ?? []).length;
    segmentByFullPath.set(fullPath, {
      name,
      fullPath,
      depth: depthFromSlashes,
    });
  };

  // 按 layout 顺序展开: 先出现的全路径, 其 segment 节点先入树。
  for (const item of layout) {
    const name = tagById.get(item.id);
    if (!name) continue;
    ensureSegment(name);
  }

  // 1. 父→子 group (按 layout 中首次出现顺序排列 children)
  const childrenByParent = new Map<string | null, string[]>();
  for (const fullPath of segmentByFullPath.keys()) {
    const lastSlash = fullPath.lastIndexOf('/');
    const parentFullPath = lastSlash > 0 ? fullPath.slice(0, lastSlash) : null;
    const arr = childrenByParent.get(parentFullPath) ?? [];
    arr.push(fullPath);
    childrenByParent.set(parentFullPath, arr);
  }

  // 3. DFS visit
  const result: MemoTagTreeItem[] = [];
  const visit = (fullPath: string) => {
    const seg = segmentByFullPath.get(fullPath)!;
    const lastSlash = fullPath.lastIndexOf('/');
    const parentFullPath = lastSlash > 0 ? fullPath.slice(0, lastSlash) : null;
    result.push({
      id: fullPath, // 跟 fullPath 一致, React key 稳定
      parentId: parentFullPath, // 父 segment 的 fullPath
      name: seg.name, // segment (最后一段)
      fullPath,
      depth: seg.depth,
      count: prefixCounts[fullPath] ?? 0,
    });
    for (const child of childrenByParent.get(fullPath) ?? []) {
      visit(child);
    }
  };

  for (const root of childrenByParent.get(null) ?? []) {
    visit(root);
  }
  return result;
}

export async function loadMemoLibraryMetadata({
  notebook,
  selectedTagId,
}: LoadMemoLibraryMetadataParams): Promise<MemoLibraryMetadata | null> {
  const [
    tagsResult,
    usedTagIdsResult,
    tagSystemMetadata,
    prefixCountsResult,
  ] = await Promise.all([
    tags.getAll(notebook.id).catch((error) => {
      console.warn('[memo-list-metadata-service] Failed to load tags:', error);
      return { tags: [] };
    }),
    memos.getUsedTagIds(notebook.id).catch((error) => {
      console.warn('[memo-list-metadata-service] Failed to load used tags:', error);
      return { usedTagIds: [], tagCounts: [], totalMemoCount: 0, agentMemoCount: 0, todoMemoCount: 0 };
    }),
    system.getTagMetadata(notebook.id).catch((error) => {
      console.warn('[memo-list-metadata-service] Failed to load tag system metadata:', error);
      return { hidden: [], order: [], layout: [] };
    }),
    // 路径式 tag 树的前缀计数: 每个 prefix (e.g. `中国`) 对应"挂了
    // 以该 prefix 起始的 tag"的去重 memo 数。侧栏 tree 节点上显示
    // 数字必须用这个 (按 memo 数, 不能按 tag 数累加, 否则同一
    // memo 多个子 tag 会在父 prefix 重复计)。
    tags.getPrefixCounts(notebook.id).catch((error) => {
      console.warn('[memo-list-metadata-service] Failed to load tag prefix counts:', error);
      return {} as Record<string, number>;
    }),
  ]);

  const tagMap: Record<string, string> = {};
  const allTagDefinitions = tagsResult.tags ?? [];
  for (const tag of allTagDefinitions) {
    tagMap[tag.id] = tag.name;
  }

  const usedTagIds = usedTagIdsResult.usedTagIds;
  const usedTagIdSet = new Set(usedTagIds);

  const savedOrder = normalizeSavedStringArray(tagSystemMetadata.order);
  const savedLayout = normalizeSavedTagLayout(tagSystemMetadata.layout);
  const tagLayout = normalizeTagLayout({
    usedTagIds,
    savedLayout,
    savedOrder,
  });

  const tagById = new Map(
    usedTagIds.map((id) => [
      id,
      tagMap[id] ?? allTagDefinitions.find((tag) => tag.id === id)?.name ?? id,
    ]),
  );
  const tagOptions = buildTagTreeOptions({
    layout: tagLayout,
    tagById,
    prefixCounts: prefixCountsResult,
  });

  const savedHidden = normalizeSavedStringArray(tagSystemMetadata.hidden);
  const hiddenTagIds = savedHidden.filter((id) => usedTagIdSet.has(id));

  return {
    tagMap,
    tagOptions,
    tagLayout,
    hiddenTagIds,
    selectedTagId: selectedTagId && usedTagIdSet.has(selectedTagId) ? selectedTagId : null,
    totalMemoCount: usedTagIdsResult.totalMemoCount ?? 0,
    agentMemoCount: usedTagIdsResult.agentMemoCount ?? 0,
    todoMemoCount: usedTagIdsResult.todoMemoCount ?? 0,
  };
}

export async function getNotebookTodoCount(notebookId: string): Promise<number> {
  const metadata = await memos.getUsedTagIds(notebookId);
  return metadata.todoMemoCount ?? 0;
}

export async function persistTagLayout(
  nextLayout: MemoTagLayoutItem[],
  notebookId: string | null | undefined
): Promise<void> {
  if (!notebookId) return;
  await system.setTagLayout(notebookId, nextLayout);
}
