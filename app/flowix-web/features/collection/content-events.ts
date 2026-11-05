import { canonicalPath } from '@/lib/path';

/**
 * 集合文件内容广播 ── 本进程内**所有**改写了某个集合文件的入口，写完都要广播一次
 * 落盘的最终内容；所有持有该文件内存副本的消费者（集合外壳、表格、图墙、列表）都
 * 订阅它，用 `acceptContent` 就地替换，而不是等下一次刷新。
 *
 * 为什么广播**内容**而不是动作（"新增了一个视图"）：动作消息会让消费端各自再推算
 * 一遍结果，等于又造出第二个真相源；内容只有一份，谁写的都一样。
 *
 * 写入本身默认走 `document-gateway`（它写完自动广播）；自带冲突重放语义的会话
 * （`useCollectionDocumentSession` / `useTableSession`）可以继续自己写，但必须自己广播。
 */
export interface CollectionContentChange {
  /** 集合体地址（`.index.yaml` / 独立集合文件）。 */
  indexPath: string;
  notebookPath: string | null;
  /** 落盘后的最终内容（可能是合并结果）。 */
  content: string;
}

const subscribers = new Set<(change: CollectionContentChange) => void>();

export function subscribeCollectionContent(listener: (change: CollectionContentChange) => void): () => void {
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
}

export function publishCollectionContent(change: CollectionContentChange): void {
  for (const listener of subscribers) {
    // 广播发生在写盘成功之后：某个消费者自己的解析/渲染出错，不能反过来让写盘方
    // 误报「保存失败」，也不能拖累其它消费者。
    try { listener(change); } catch (error) { console.error('[collection] content listener failed', error); }
  }
}

/** 两个地址是否指向同一个集合文件（跨平台分隔符归一）。 */
export function isSameCollectionFile(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return canonicalPath(left) === canonicalPath(right);
}
