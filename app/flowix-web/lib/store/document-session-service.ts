import {
  applyLoadedContent,
  flushDocument,
  getBuffer,
  getCurrentIdentity,
  getCurrentPath,
  getOrCreateBuffer,
  hasUnsavedLocalChanges,
  setCurrentDocument,
  type FlushCallbacks,
} from './buffer-registry';
import { isContentSemanticallyEqual } from './buffer-equality';
import type { DocumentBuffer } from './document-buffer';
import type { DocumentIdentity } from './document-identity';
import { canonicalPath } from '../path';


export interface DocumentDraftSnapshot {
  identity: DocumentIdentity;
  path: string;
  content: string;
}

export interface DocumentEditResult {
  changed: boolean;
  buffer: DocumentBuffer;
}

export interface SaveDocumentContentOptions {
  path: string;
  identity: DocumentIdentity;
  content: string;
  /**
   * `internal` (内部 memo 文档) 或 `external` (外部 .md 文件)。后端
   * 据此分流: 内部走 key 反查 + 派生改名 + index.json 同步, 外部只
   * 做 fs::write + CAS, 不改名不动 index.json。
   */
  channel: 'internal' | 'external';
  /**
   * 内部 memo 文档的 memoId ── closure 期间稳定, 后端用它反查 index.json
   * 拿当前 entry.filename, 走新路径写。外部文件可传 null。
   */
  key: string | null;
  callbacks?: FlushCallbacks;
}

const SELF_DOCUMENT_WRITE_TTL_MS = 5000;
const selfPathUpdates = new Set<string>();
const selfDocumentWrites = new Map<string, number>();

function selfPathUpdateKey(memoId: string, path: string): string {
  return `${memoId}:${canonicalPath(path)}`;
}

function pruneExpiredSelfDocumentWrites(now = Date.now()): void {
  for (const [key, expiresAt] of selfDocumentWrites) {
    if (expiresAt <= now) {
      selfDocumentWrites.delete(key);
    }
  }
}

export function markSelfDocumentPathUpdate(memoId: string, path: string): void {
  selfPathUpdates.add(selfPathUpdateKey(memoId, path));
}

export function markSelfDocumentWrite(memoId: string, path: string): void {
  pruneExpiredSelfDocumentWrites();
  selfDocumentWrites.set(selfPathUpdateKey(memoId, path), Date.now() + SELF_DOCUMENT_WRITE_TTL_MS);
}

export function consumeSelfDocumentPathUpdate(memoId: string, path: string): boolean {
  const key = selfPathUpdateKey(memoId, path);
  const exists = selfPathUpdates.has(key);
  if (exists) {
    selfPathUpdates.delete(key);
  }
  return exists;
}

export function isRecentSelfDocumentWrite(memoId: string, path: string): boolean {
  pruneExpiredSelfDocumentWrites();
  return selfDocumentWrites.has(selfPathUpdateKey(memoId, path));
}

export function getActiveDocumentDraft(): DocumentDraftSnapshot | null {
  const identity = getCurrentIdentity();
  const path = getCurrentPath();
  const buffer = identity ? getBuffer(identity) : undefined;
  if (!identity || !path || !buffer?.content) return null;
  return { identity, path, content: buffer.content };
}

/**
 * 记录用户敲字产生的编辑。
 *
 * 行为不变量 ── 在双 Map 索引 (memoId / canonicalPath) 下, 物理 rename
 * 期间 memo 路径对应的 buffer 不会被换出, recordDocumentEdit 内部
 * 永远命中同一个 buffer object。race 自然消失, 不再需要 P1 修复 (O)
 * 那 3 层防御兜底。
 *
 * dirty 判定改用语义比较 ── 详见 [buffer-equality.ts]。原 byte equality
 * 在 Windows 上会被 Tiptap mount 阶段把磁盘 CRLF 重写为 LF 的"伪编辑"误
 * 判为真实编辑, 1s 后触发 write_document → 后端 emit `user_edit` →
 * 出现"打开即写盘"的现象。语义比较抹掉行尾 / frontmatter / trailing
 * 空白等归一化差异, 只把"实质不同的内容" 标 dirty。
 */
export function recordDocumentEdit(identity: DocumentIdentity, content: string): DocumentEditResult {
  const buffer = getOrCreateBuffer(identity);
  if (isContentSemanticallyEqual(content, buffer.lastSavedContent)) {
    return { changed: false, buffer };
  }
  buffer.content = content;
  buffer.pendingContent = content;
  return { changed: true, buffer };
}

/**
 * 把 content 写盘。
 *
 * 跟 recordDocumentEdit 同形 ── buffer key 在双索引下永不漂移, 直接
 * getOrCreateBuffer 拿到当前 memo 对应的 buffer 即可。
 */
export async function saveDocumentContent({
  path,
  identity,
  content,
  channel,
  key,
  callbacks,
}: SaveDocumentContentOptions): Promise<boolean> {
  if (!path) return true;
  const buffer = getOrCreateBuffer(identity);

  if (content !== buffer.content) {
    buffer.content = content;
    buffer.pendingContent = content;
  }

  return flushDocument(identity, path, { key, channel, ...callbacks });
}

export function flushDocumentPath(identity: DocumentIdentity, path: string): Promise<boolean> {
  return flushDocument(identity, path);
}

export function getDocumentBuffer(identity: DocumentIdentity): DocumentBuffer {
  return getOrCreateBuffer(identity);
}

export function hasDocumentUnsavedChanges(identity?: DocumentIdentity): boolean {
  return hasUnsavedLocalChanges(identity);
}

// 暴露 buffer-registry 内部的 "current path" 读取给 store 之外的调用方
// (例如 useDocumentAutosave 在 closure 落后于 currentPath 时需要兜底)。
// 不暴露 setCurrentPath ── 状态切换仍走 store / hook 的副作用路径。
export { getCurrentPath };
export { getCurrentIdentity };

export function applyLoadedDocumentContent(
  identity: DocumentIdentity,
  path: string,
  fullContent: string,
  options?: { preservePending?: boolean },
): DocumentBuffer {
  return applyLoadedContent(identity, path, fullContent, options);
}

export function setActiveDocumentPath(identity: DocumentIdentity | null, path: string | null): void {
  setCurrentDocument(identity, path);
}

// moveDocumentBuffer 取消 ── buffer-registry 双 Map 索引下, 物理 rename
// 期间 buffer 不会换出, 调用方 (useMemoEvents.syncActiveDocumentPathIfRenamed
// / useDocumentFinalize.finalizeMemoRename) 改为 IPC 写盘后只切
// active path, 不再需要搬 buffer。
