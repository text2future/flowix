import type { Notebook } from '../store';
import { files, memos, settings, tags } from '../tauri/client';
import type { SortType } from './memo-repository';

const TAG_ORDER_SETTING_PREFIX = 'tag_order:';
const HIDDEN_TAGS_SETTING_PREFIX = 'hidden_tags:';
const PARSE_LOADING_THRESHOLD_BYTES = 80_000;

export interface MemoTodoMetadataEntry {
  content: string;
  status: string;
  memoId: string;
  priority?: string;
  timeRange?: string;
  owner?: string;
  assignee?: string;
  createdAt?: number;
  updatedAt?: number;
}

interface MemoMetadataFile {
  todos?: MemoTodoMetadataEntry[];
}

interface MemoIndexMetadataFile {
  memos?: Array<{
    tags?: string[];
  }>;
}

export interface MemoLibraryMetadata {
  tagMap: Record<string, string>;
  tagOptions: Array<{ id: string; name: string }>;
  tagOrder: string[];
  hiddenTagIds: string[];
  selectedTagId: string | null;
}

interface LoadMemoLibraryMetadataParams {
  notebook: Notebook;
  selectedTagId: string | null;
  beforeLargeParse?: (content: string) => Promise<boolean>;
}

interface LoadTodoMetadataParams {
  notebookPath: string;
  sort: SortType;
  beforeLargeParse?: (content: string) => Promise<boolean>;
}

function getTagOrderSettingKey(notebookId: string): string {
  return `${TAG_ORDER_SETTING_PREFIX}${notebookId}`;
}

function getHiddenTagsSettingKey(notebookId: string): string {
  return `${HIDDEN_TAGS_SETTING_PREFIX}${notebookId}`;
}

function getNotebookMemoMetadataPath(notebookPath: string): string {
  const clean = notebookPath.replace(/[\\/]+$/, '');
  return `${clean}/.metadata/memo.json`;
}

async function getNotebookListMetadataPath(notebookPath: string): Promise<string> {
  const filename = await memos.getIndexFilename();
  const clean = notebookPath.replace(/[\\/]+$/, '');
  return `${clean}/.metadata/${filename}`;
}

function parseStringArraySetting(value: string | null | undefined, warningLabel: string): string[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string')
      : [];
  } catch (error) {
    console.warn(`[memo-list-metadata-service] Failed to parse ${warningLabel}:`, error);
    return [];
  }
}

function parseUsedTagIds(listContent: string | null): string[] {
  if (!listContent) return [];

  try {
    const indexMetadata = JSON.parse(listContent) as MemoIndexMetadataFile;
    const usedTagIds: string[] = [];
    const seenTagIds = new Set<string>();

    for (const memo of indexMetadata.memos ?? []) {
      for (const tagId of memo.tags ?? []) {
        if (tagId && !seenTagIds.has(tagId)) {
          seenTagIds.add(tagId);
          usedTagIds.push(tagId);
        }
      }
    }

    return usedTagIds;
  } catch (error) {
    console.warn('[memo-list-metadata-service] Failed to read list metadata tags:', error);
    return [];
  }
}

function parseTodoEntries(content: string | null): MemoTodoMetadataEntry[] {
  if (!content) return [];

  try {
    const metadata = JSON.parse(content) as MemoMetadataFile;
    return Array.isArray(metadata.todos) ? metadata.todos : [];
  } catch (error) {
    console.warn('[memo-list-metadata-service] Failed to read memo metadata todos:', error);
    return [];
  }
}

export function shouldShowMetadataParseLoading(content: string | null | undefined): boolean {
  return (content?.length ?? 0) >= PARSE_LOADING_THRESHOLD_BYTES;
}

export async function loadMemoLibraryMetadata({
  notebook,
  selectedTagId,
  beforeLargeParse,
}: LoadMemoLibraryMetadataParams): Promise<MemoLibraryMetadata | null> {
  const nbPath = notebook.path;
  const [tagsResult, listContent, tagOrderSetting, hiddenTagsSetting] = await Promise.all([
    tags.getAll().catch((error) => {
      console.warn('[memo-list-metadata-service] Failed to load tags:', error);
      return { tags: [] };
    }),
    nbPath
      ? getNotebookListMetadataPath(nbPath).then((path) => files.read(path, nbPath))
      : Promise.resolve(''),
    settings.get(getTagOrderSettingKey(notebook.id)).catch(() => ({ value: null })),
    settings.get(getHiddenTagsSettingKey(notebook.id)).catch(() => ({ value: null })),
  ]);

  if (
    shouldShowMetadataParseLoading(listContent) &&
    beforeLargeParse &&
    !(await beforeLargeParse(listContent ?? ''))
  ) {
    return null;
  }

  const tagMap: Record<string, string> = {};
  const allTagDefinitions = tagsResult.tags ?? [];
  for (const tag of allTagDefinitions) {
    tagMap[tag.id] = tag.name;
  }

  const usedTagIds = parseUsedTagIds(listContent);
  const usedTagIdSet = new Set(usedTagIds);

  const savedOrder = parseStringArraySetting(tagOrderSetting?.value, 'saved tag order');
  const savedOrderFiltered = savedOrder.filter((id) => usedTagIdSet.has(id));
  const missingIds = usedTagIds.filter((id) => !savedOrderFiltered.includes(id));
  const tagOrder = [...savedOrderFiltered, ...missingIds];

  const tagById = new Map(
    usedTagIds.map((id) => [
      id,
      tagMap[id] ?? allTagDefinitions.find((tag) => tag.id === id)?.name ?? id,
    ]),
  );
  const tagOptions = tagOrder
    .map((id) => ({ id, name: tagById.get(id) ?? id }))
    .filter((tag) => tagById.has(tag.id));

  const savedHidden = parseStringArraySetting(hiddenTagsSetting?.value, 'saved hidden tags');
  const hiddenTagIds = savedHidden.filter((id) => usedTagIdSet.has(id));

  return {
    tagMap,
    tagOptions,
    tagOrder,
    hiddenTagIds,
    selectedTagId: selectedTagId && usedTagIdSet.has(selectedTagId) ? selectedTagId : null,
  };
}

export async function loadTodoMetadata({
  notebookPath,
  sort,
  beforeLargeParse,
}: LoadTodoMetadataParams): Promise<MemoTodoMetadataEntry[] | null> {
  const content = await files.read(
    getNotebookMemoMetadataPath(notebookPath),
    notebookPath,
  );

  if (
    shouldShowMetadataParseLoading(content) &&
    beforeLargeParse &&
    !(await beforeLargeParse(content ?? ''))
  ) {
    return null;
  }

  const todos = parseTodoEntries(content);
  return [...todos].sort((a, b) => {
    const aTime = sort === 'updatedAt' ? a.updatedAt : a.createdAt;
    const bTime = sort === 'updatedAt' ? b.updatedAt : b.createdAt;
    return (bTime ?? 0) - (aTime ?? 0);
  });
}

export async function getNotebookTodoCount(notebookPath: string): Promise<number> {
  const content = await files.read(
    getNotebookMemoMetadataPath(notebookPath),
    notebookPath,
  );
  return parseTodoEntries(content).length;
}

export async function persistTagOrder(nextOrder: string[], notebookId: string | null | undefined): Promise<void> {
  if (!notebookId) return;
  await settings.set(getTagOrderSettingKey(notebookId), JSON.stringify(nextOrder));
}

export async function persistHiddenTags(nextHidden: string[], notebookId: string | null | undefined): Promise<void> {
  if (!notebookId) return;
  await settings.set(getHiddenTagsSettingKey(notebookId), JSON.stringify(nextHidden));
}
