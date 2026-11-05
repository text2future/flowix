import { create } from 'zustand';

import { STORAGE_KEYS } from '@/lib/constants';
import { system } from '@platform/tauri/client';
import type { MemoItem } from '@/types/memo-item';
import type { NoteListItem } from '@/types/note-item';

import { createLogger } from '@/lib/logger';
const logger = createLogger('custom-filter-store');
export type CustomFilterOperator = 'contains' | 'equals';
export type CustomViewDocumentType = 'note' | 'image' | 'video';

export interface CustomFilter {
  id: string;
  name: string;
  documentType: CustomViewDocumentType;
  key: string;
  operator: CustomFilterOperator;
  value: string;
}

interface CustomFilterStore {
  filtersByNotebook: Record<string, CustomFilter[]>;
  loadedNotebookIds: string[];
  loadNotebookFilters: (notebookId: string) => Promise<void>;
  addFilter: (notebookId: string, filter: Omit<CustomFilter, 'id'>) => string;
  updateFilter: (notebookId: string, id: string, filter: Omit<CustomFilter, 'id'>) => void;
  removeFilter: (notebookId: string, id: string) => void;
}

const LEGACY_STORAGE_KEY = STORAGE_KEYS.CUSTOM_FILTER;
const LEGACY_MIGRATED_KEY = 'flowix-custom-filter-notebook-migration-v1';
const inFlightLoads = new Map<string, Promise<void>>();
const writesByNotebook = new Map<string, Promise<void>>();
let legacyMigrationClaimed = false;

function createFilterId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `custom-filter-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function valueParts(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(valueParts);
  if (value === null || value === undefined) return [];
  if (typeof value === 'object') return [JSON.stringify(value)];
  return [String(value)];
}

function readLegacyFilters(): CustomFilter[] {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { state?: { filters?: unknown } };
    if (!Array.isArray(parsed.state?.filters)) return [];
    return parsed.state.filters.filter((item): item is CustomFilter => (
      Boolean(item)
      && typeof item === 'object'
      && typeof (item as CustomFilter).id === 'string'
      && typeof (item as CustomFilter).name === 'string'
      && (['note', 'image', 'video'].includes((item as CustomFilter).documentType) || (item as CustomFilter).documentType === undefined)
      && typeof (item as CustomFilter).key === 'string'
      && ['contains', 'equals'].includes((item as CustomFilter).operator)
      && typeof (item as CustomFilter).value === 'string'
    )).map((item) => ({ ...item, documentType: item.documentType ?? 'note' }));
  } catch {
    return [];
  }
}

function persistNotebookFilters(notebookId: string, filters: CustomFilter[]): void {
  const previous = writesByNotebook.get(notebookId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => system.setCustomViews(notebookId, { filters }))
    .catch((error) => {
      logger.warn('Failed to save notebook views:', error);
    });
  writesByNotebook.set(notebookId, next);
}

/** Match user-defined frontmatter properties without changing the file format. */
export function memoMatchesCustomFilter(memo: Pick<MemoItem | NoteListItem, 'properties'>, filter: CustomFilter): boolean {
  const actualValues = valueParts(memo.properties?.[filter.key]);
  const expected = filter.value.trim();
  if (!expected || actualValues.length === 0) return false;

  if (filter.operator === 'contains') {
    const normalizedExpected = expected.toLocaleLowerCase();
    return actualValues.some((actual) => actual.toLocaleLowerCase().includes(normalizedExpected));
  }

  return actualValues.some((actual) => actual === expected);
}

export const useCustomFilterStore = create<CustomFilterStore>()((set, get) => ({
  filtersByNotebook: {},
  loadedNotebookIds: [],
  loadNotebookFilters: (notebookId) => {
    if (get().loadedNotebookIds.includes(notebookId)) return Promise.resolve();
    const pending = inFlightLoads.get(notebookId);
    if (pending) return pending;
    const request = system.getCustomViews(notebookId).then(async ({ filters }) => {
      let notebookFilters: CustomFilter[] = filters.map((filter) => ({
        ...filter,
        documentType: filter.documentType === 'image' || filter.documentType === 'video' ? filter.documentType : 'note',
      }));
      let didMigrateLegacy = false;
      if (
        typeof localStorage !== 'undefined'
        && !legacyMigrationClaimed
        && !localStorage.getItem(LEGACY_MIGRATED_KEY)
      ) {
        legacyMigrationClaimed = true;
        const legacyFilters = readLegacyFilters();
        if (notebookFilters.length === 0 && legacyFilters.length > 0) {
          notebookFilters = legacyFilters;
          didMigrateLegacy = true;
        }
        localStorage.setItem(LEGACY_MIGRATED_KEY, '1');
      }
      set((state) => ({
        filtersByNotebook: { ...state.filtersByNotebook, [notebookId]: notebookFilters },
        loadedNotebookIds: [...state.loadedNotebookIds, notebookId],
      }));
      if (didMigrateLegacy) persistNotebookFilters(notebookId, notebookFilters);
    }).catch((error) => {
      logger.warn('Failed to load notebook views:', error);
      set((state) => ({
        filtersByNotebook: { ...state.filtersByNotebook, [notebookId]: [] },
        loadedNotebookIds: [...state.loadedNotebookIds, notebookId],
      }));
    }).finally(() => {
      inFlightLoads.delete(notebookId);
    });
    inFlightLoads.set(notebookId, request);
    return request;
  },
  addFilter: (notebookId, filter) => {
    const id = createFilterId();
    set((state) => {
      const filters = [...(state.filtersByNotebook[notebookId] ?? []), { ...filter, id }];
      persistNotebookFilters(notebookId, filters);
      return { filtersByNotebook: { ...state.filtersByNotebook, [notebookId]: filters } };
    });
    return id;
  },
  updateFilter: (notebookId, id, filter) => set((state) => {
    const filters = (state.filtersByNotebook[notebookId] ?? []).map((item) => (
      item.id === id ? { ...filter, id } : item
    ));
    persistNotebookFilters(notebookId, filters);
    return { filtersByNotebook: { ...state.filtersByNotebook, [notebookId]: filters } };
  }),
  removeFilter: (notebookId, id) => set((state) => {
    const filters = (state.filtersByNotebook[notebookId] ?? []).filter((filter) => filter.id !== id);
    persistNotebookFilters(notebookId, filters);
    return { filtersByNotebook: { ...state.filtersByNotebook, [notebookId]: filters } };
  }),
}));
