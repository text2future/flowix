import { scheduleSave } from '@features/document/store/save-queue';
import { emptyDocumentBuffer, type DocumentBuffer } from '@features/document/store/document-buffer';
import { canonicalPath } from '@/lib/path';
import { isContentSemanticallyEqual } from '@features/document/store/buffer-equality';
import {
  documentIdentityKey,
  normalizeDocumentIdentity,
  type DocumentIdentity,
} from '@features/document/store/document-identity';

const memoBuffers = new Map<string, DocumentBuffer>();
const externalBuffers = new Map<string, DocumentBuffer>();
const BUFFER_LRU_CAP = 100;

function bumpLru<K, V>(map: Map<K, V>, key: K, factory: () => V): V {
  const existing = map.get(key);
  if (existing !== undefined) {
    map.delete(key);
    map.set(key, existing);
    return existing;
  }
  if (map.size >= BUFFER_LRU_CAP) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  const created = factory();
  map.set(key, created);
  return created;
}

let currentPath: string | null = null;
let currentIdentity: DocumentIdentity | null = null;
let currentBuffer: DocumentBuffer = emptyDocumentBuffer();

export function getCurrentPath(): string | null {
  return currentPath;
}

export function getCurrentIdentity(): DocumentIdentity | null {
  return currentIdentity;
}

export function getBuffer(identity: DocumentIdentity): DocumentBuffer | undefined {
  const normalized = normalizeDocumentIdentity(identity);
  return normalized.kind === 'memo'
    ? memoBuffers.get(normalized.id)
    : externalBuffers.get(normalized.path);
}

export function getOrCreateBuffer(identity: DocumentIdentity): DocumentBuffer {
  const normalized = normalizeDocumentIdentity(identity);
  return normalized.kind === 'memo'
    ? bumpLru(memoBuffers, normalized.id, emptyDocumentBuffer)
    : bumpLru(externalBuffers, normalized.path, emptyDocumentBuffer);
}

export function setCurrentDocument(identity: DocumentIdentity | null, path: string | null): void {
  if (!identity || !path) {
    currentPath = null;
    currentIdentity = null;
    currentBuffer = emptyDocumentBuffer();
    return;
  }

  const normalized = normalizeDocumentIdentity(identity);
  const nextPath = canonicalPath(path);
  const currentKey = currentIdentity ? documentIdentityKey(currentIdentity) : null;
  if (documentIdentityKey(normalized) === currentKey && nextPath === currentPath) {
    return;
  }

  currentIdentity = normalized;
  currentPath = nextPath;
  currentBuffer = getOrCreateBuffer(normalized);
}

export function hasUnsavedLocalChanges(identity?: DocumentIdentity): boolean {
  const target = identity ?? getCurrentIdentity();
  if (!target) return false;
  const buf = getBuffer(target);
  if (!buf) return false;
  return !isContentSemanticallyEqual(buf.content, buf.lastSavedContent);
}

export function hasUnsavedLocalChangesForMemo(memoId: string): boolean {
  return hasUnsavedLocalChanges({ kind: 'memo', id: memoId });
}

export function applyLoadedContent(
  identity: DocumentIdentity,
  path: string,
  fullContent: string,
  options?: { preservePending?: boolean },
): DocumentBuffer {
  setCurrentDocument(identity, path);
  const buf = currentBuffer;
  const initialContent = options?.preservePending
    ? (buf.pendingContent ?? fullContent)
    : fullContent;
  buf.content = initialContent;
  buf.lastSavedContent = fullContent;
  if (!options?.preservePending) {
    buf.pendingContent = null;
  }
  return buf;
}

export interface FlushCallbacks {
  onSaved?: (writtenPath: string, content: string) => void;
  onCasRefused?: (content: string) => void;
  onError?: (content: string, err: unknown) => void;
}

export async function flushDocument(
  identity: DocumentIdentity,
  path: string,
  callbacks?: FlushCallbacks & {
    channel?: 'internal' | 'external';
    key?: string | null;
    force?: boolean;
  },
): Promise<boolean> {
  const normalized = normalizeDocumentIdentity(identity);
  const buf = getBuffer(normalized);
  if (!buf) return true;
  if (!callbacks?.force && isContentSemanticallyEqual(buf.content, buf.lastSavedContent)) {
    return true;
  }

  const channel: 'internal' | 'external' = callbacks?.channel
    ?? (normalized.kind === 'memo' ? 'internal' : 'external');
  const key: string | null = callbacks?.key
    ?? (normalized.kind === 'memo' ? normalized.id : null);

  return scheduleSave({
    queueKey: documentIdentityKey(normalized),
    path: canonicalPath(path),
    channel,
    key,
    readExpected: () => buf.lastSavedContent,
    onSaved: (writtenPath, writtenContent) => {
      buf.lastSavedContent = writtenContent;
      if (isContentSemanticallyEqual(buf.content, writtenContent)) {
        buf.pendingContent = null;
      } else if (buf.pendingContent !== null && isContentSemanticallyEqual(buf.pendingContent, writtenContent)) {
        buf.pendingContent = null;
      }
      callbacks?.onSaved?.(writtenPath, writtenContent);
    },
    onCasRefused: (written) => {
      callbacks?.onCasRefused?.(written);
    },
    onError: (written, err) => {
      callbacks?.onError?.(written, err);
    },
  }, buf.content);
}
