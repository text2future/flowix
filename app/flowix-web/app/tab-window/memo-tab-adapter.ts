import { create } from 'zustand';
import type { MemoItem } from '@features/memo';
import { useMemoStore } from '@features/memo';
import {
  memos as memosClient,
  type OpenMemoSession,
  type WindowTab,
} from '@platform/tauri/client';

interface MemoTabMetadataState {
  byMemoId: Record<string, MemoItem>;
  set: (memo: MemoItem) => void;
  remove: (memoId: string) => void;
}

export const useMemoTabMetadataStore = create<MemoTabMetadataState>((set) => ({
  byMemoId: {},
  set: (memo) => set((state) => ({ byMemoId: { ...state.byMemoId, [memo.id]: memo } })),
  remove: (memoId) => set((state) => {
    const byMemoId = { ...state.byMemoId };
    delete byMemoId[memoId];
    return { byMemoId };
  }),
}));

export function memoIdForTab(tab: WindowTab | null | undefined): string | null {
  return tab?.target.kind === 'memo' ? tab.target.memoId : null;
}

const sessionRequests = new Map<string, Promise<OpenMemoSession | null>>();

/**
 * Load metadata and body for an activated memo. Concurrent requests for the
 * same memo share one IPC, while completed sessions are deliberately not kept:
 * later activations must observe external or sibling-window changes.
 */
export async function hydrateMemoTab(tab: WindowTab): Promise<OpenMemoSession | null> {
  if (tab.target.kind !== 'memo') return null;
  const memoId = tab.target.memoId;
  let request = sessionRequests.get(memoId);
  if (!request) {
    request = memosClient.openMemoSession(memoId);
    sessionRequests.set(memoId, request);
  }
  let session: OpenMemoSession | null;
  try {
    session = await request;
  } finally {
    if (sessionRequests.get(memoId) === request) sessionRequests.delete(memoId);
  }
  if (!session) return null;
  const item: MemoItem = session.memo;
  useMemoStore.getState().handleMemoUpdated(item);
  useMemoTabMetadataStore.getState().set(item);
  return session;
}

export function updateMemoTabMetadata(memo: MemoItem): void {
  useMemoStore.getState().handleMemoUpdated(memo);
  useMemoTabMetadataStore.getState().set(memo);
}
