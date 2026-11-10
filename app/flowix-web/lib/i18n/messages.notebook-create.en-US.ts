import type zhCN from './messages.notebook-create.zh-CN';

/**
 * English counterpart of the notebook-create dialog message shard. The type
 * annotation keeps its key set aligned with the zh-CN shard at compile time.
 */
const enUS: Record<keyof typeof zhCN, string> = {
  "notebook.create.readAiSpace": "Read AI Space",
  "notebook.create.readAiSpaceMenuHint": "Read content from the source location",
};

export default enUS;
