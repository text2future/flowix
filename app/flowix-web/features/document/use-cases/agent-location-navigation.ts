import { canonicalPath } from '@/lib/path';
import type { SourceLocation } from '@features/agent/thread-card/link-navigation';

export interface AgentLocationRequest {
  id: number;
  path: string;
  location?: SourceLocation;
  anchor?: string;
  host: 'main-third' | 'browser-column';
  viewId: string;
}

let nextRequestId = 0;
const requests = new Map<string, AgentLocationRequest>();
const listeners = new Map<string, Set<() => void>>();

function key(path: string): string {
  return canonicalPath(path);
}

export function publishAgentLocationRequest(
  request: Omit<AgentLocationRequest, 'id'>,
): AgentLocationRequest {
  const value = { ...request, id: ++nextRequestId };
  const requestKey = key(request.path);
  requests.set(requestKey, value);
  listeners.get(requestKey)?.forEach((listener) => listener());
  return value;
}

export function peekAgentLocationRequest(path: string): AgentLocationRequest | null {
  return requests.get(key(path)) ?? null;
}

export function hasAgentLocationRequest(path: string, id: number): boolean {
  return requests.get(key(path))?.id === id;
}

export function consumeAgentLocationRequest(path: string, id: number): boolean {
  const requestKey = key(path);
  if (requests.get(requestKey)?.id !== id) return false;
  requests.delete(requestKey);
  listeners.get(requestKey)?.forEach((listener) => listener());
  return true;
}

export function cancelAgentLocationRequest(path: string, id?: number): void {
  const requestKey = key(path);
  if (id !== undefined && requests.get(requestKey)?.id !== id) return;
  if (!requests.delete(requestKey)) return;
  listeners.get(requestKey)?.forEach((listener) => listener());
}

export function subscribeAgentLocationRequest(path: string, listener: () => void): () => void {
  const requestKey = key(path);
  const current = listeners.get(requestKey) ?? new Set<() => void>();
  current.add(listener);
  listeners.set(requestKey, current);
  return () => {
    current.delete(listener);
    if (current.size === 0) listeners.delete(requestKey);
  };
}
