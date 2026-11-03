/**
 * 新建菜单里「对话类型」这一段的展示组件。
 *
 * 笔记列表的新建菜单需要列出本地/外部 agent 类型，但它不该直接 import agent 的
 * 内部组件目录，因此由这里作为公开入口转发。
 */
export { AgentConversationTypeMenuItems } from '../components/agent-conversation-type-menu-items';
