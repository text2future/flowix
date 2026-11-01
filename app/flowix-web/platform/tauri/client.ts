'use client';

import { invoke } from '@tauri-apps/api/core';

export type { ChatMessage } from '@/types/agent';
export * from './client/agent';
export * from './client/cloud';
export * from './client/desktop';
export * from './client/pinned';
export * from './client/plugin';
export * from './client/general';
export * from './client/properties';
export * from './client/notes';
export * from './client/memos';
export * from './client/updater';
export * from './client/recovery';

type RpcRequest = <T = unknown>(method: string, params?: unknown) => Promise<T>;

declare global {
  interface Window {
    __tauriRpc?: RpcRequest;
  }
}

let rpcInstance: RpcRequest | null = null;

export function initTauriClient(): void {
  rpcInstance = async <T = unknown>(method: string, params?: unknown): Promise<T> => {
    return await invoke<T>(method, (params as Record<string, unknown>) || {});
  };
  window.__tauriRpc = rpcInstance;
}
