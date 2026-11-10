import type zhCN from './messages.memo-list-tabs.zh-CN';

/**
 * English counterpart of the memo list view tab message shard. The type
 * annotation keeps its key set aligned with the zh-CN shard at compile time.
 */
const enUS: Record<keyof typeof zhCN, string> = {
  "memo.list.viewFoldersShort": "Space",
  "memo.list.viewCardsShort": "Notes",
  "memo.list.headerAll": "All",
};

export default enUS;
