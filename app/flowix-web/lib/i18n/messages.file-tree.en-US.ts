import type zhCN from './messages.file-tree.zh-CN';

/**
 * English counterpart of the file-tree message shard. The type annotation keeps
 * its key set aligned with the zh-CN shard at compile time.
 */
const enUS: Record<keyof typeof zhCN, string> = {
  "memo.fileTree.invalidName": "Invalid file name format",
  "memo.fileTree.invalidNameReplaced": "Invalid file name format; it has been replaced automatically.",
  "memo.fileTree.openInLeft": "Open in main workspace",
  "memo.fileTree.sectionEmpty": "List is empty",
  "memo.fileTree.sectionEmptyHide": "Hide",
};

export default enUS;
