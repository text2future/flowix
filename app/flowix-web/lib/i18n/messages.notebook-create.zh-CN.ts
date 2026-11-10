/**
 * 新建/编辑笔记本弹窗的文案分片。
 *
 * 主表 `messages.*` 行数冻结，笔记本弹窗新增文案放这里，新增文案不再撑大主表。
 */
const zhCN = {
  // 弹窗空状态操作按钮（与「+ 选择本地」并排的下拉按钮）
  "notebook.create.readAiSpace": "读取 AI 空间",
  // 读取 AI 空间下拉窗顶部的提示文案
  "notebook.create.readAiSpaceMenuHint": "阅读源位置内容",
} as const;

export default zhCN;
