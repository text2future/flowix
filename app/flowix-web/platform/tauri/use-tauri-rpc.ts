'use client';

import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface TauriRpcActions {
  request: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

/**
 * Hook for Tauri RPC communication
 * Provides a request method that wraps Tauri invoke
 */
export function useTauriRpc(): TauriRpcActions {
  const request = useCallback(async <T = unknown>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> => {
    return await invoke<T>(method, params || {});
  }, []);

  return { request };
}