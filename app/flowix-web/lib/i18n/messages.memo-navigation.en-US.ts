import type zhCN from './messages.memo-navigation.zh-CN';

/**
 * English counterpart of the note navigation panel message shard. The type
 * annotation keeps its key set aligned with the zh-CN shard at compile time.
 */
const enUS: Record<keyof typeof zhCN, string> = {
  "memo.navigation.closeDrawer": "Close navigation",
  "memo.navigation.notebookNavigation": "Notebook navigation",
  "memo.navigation.collapsePanelTooltip": "Collapse panel",
  "memo.navigation.collapsePanel": "Collapse panel",
};

export default enUS;
