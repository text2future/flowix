import type { CollectionDisplayDescriptor } from '@/lib/collection-display-registry';
import type { LegacyFolderListTarget } from './legacy-folder-list';

type ExternalHistoryEntry = {
  kind: 'external';
  path: string;
  scopePath: string | null;
  openedAt: number;
};

export type LegacyFolderListHistoryEntry = LegacyFolderListTarget & { openedAt: number };

export type AgentConversationHistoryEntry = {
  kind: 'agent-conversation';
  instanceId: string;
  blankIfMissing?: true;
  openedAt: number;
};

export type WebHistoryEntry = {
  kind: 'web';
  url: string;
  openedAt: number;
};

export type MediaHistoryEntry = {
  kind: 'media';
  filePath: string;
  notebookId: string | null;
  notebookPath: string | null;
  resourceKind: 'image' | 'video';
  openedAt: number;
};

export type CollectionHistoryEntry = CollectionDisplayDescriptor & { kind: 'collection'; relativePathHint?: string; openedAt: number };

/** 文件夹首页（folder-home）。一个文件夹一条记录：tab 切换不产生导航，键按 folderPath 归一。 */
export type FolderCollectionHistoryEntry = {
  kind: 'folder-collection';
  folderPath: string;
  notebookId: string;
  openedAt: number;
};

export type DocumentHistoryEntry =
  | (import('./surface-target').FileBrowserTarget & { openedAt: number })
  | CollectionHistoryEntry
  | LegacyFolderListHistoryEntry
  | FolderCollectionHistoryEntry
  | ExternalHistoryEntry
  | AgentConversationHistoryEntry
  | WebHistoryEntry
  | MediaHistoryEntry;

