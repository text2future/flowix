import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import { rebaseActiveDocumentPath } from '@features/document/store/document-session-service';
import { useMemoStore } from '@features/memo/store/memo-store';
import { syncMemoPathAfterLocalWrite } from '@features/document/use-cases/sync-memo-path-after-local-write';
import { memos as memosClient } from '@platform/tauri/client';
import { displayTitleFromFilename } from '@/lib/utils';
import { toast } from '@/lib/toast';

export const TITLE_SAVE_DEBOUNCE_MS = 1500;

export interface MemoTitleSessionSnapshot {
  filename: string;
  draft: string;
  saving: boolean;
  error: string | null;
}

interface MemoTitleSession extends MemoTitleSessionSnapshot {
  snapshot: MemoTitleSessionSnapshot;
  subscribers: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  pendingTitle: string | null;
  inFlight: Promise<void> | null;
  revision: number;
}

const sessions = new Map<string, MemoTitleSession>();

function notify(session: MemoTitleSession) {
  session.snapshot = {
    filename: session.filename,
    draft: session.draft,
    saving: session.saving,
    error: session.error,
  };
  session.revision += 1;
  for (const subscriber of session.subscribers) subscriber();
}

function normalizeTitle(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim().replace(/\.md$/i, '').trim();
}

function updateSnapshot(
  session: MemoTitleSession,
  patch: Partial<Pick<MemoTitleSession, 'filename' | 'draft' | 'saving' | 'error'>>,
) {
  Object.assign(session, patch);
  notify(session);
}

function getOrCreateSession(memoId: string, filename: string): MemoTitleSession {
  const existing = sessions.get(memoId);
  if (existing) return existing;

  const session: MemoTitleSession = {
    filename,
    draft: displayTitleFromFilename(filename),
    saving: false,
    error: null,
    subscribers: new Set(),
    timer: null,
    pendingTitle: null,
    inFlight: null,
    revision: 0,
    snapshot: {
      filename,
      draft: displayTitleFromFilename(filename),
      saving: false,
      error: null,
    },
  };
  sessions.set(memoId, session);
  return session;
}

function observeFilename(session: MemoTitleSession, filename: string) {
  if (!filename || filename === session.filename) return;
  const currentTitle = displayTitleFromFilename(session.filename);
  const hasLocalDraft = normalizeTitle(session.draft) !== normalizeTitle(currentTitle);
  if (session.inFlight || session.pendingTitle !== null || hasLocalDraft) return;
  updateSnapshot(session, {
    filename,
    draft: displayTitleFromFilename(filename),
    error: null,
  });
}

async function runQueue(memoId: string, session: MemoTitleSession): Promise<void> {
  if (session.inFlight) return session.inFlight;

  const run = (async () => {
    updateSnapshot(session, { saving: true, error: null });
    try {
      while (session.pendingTitle !== null) {
        const requestedTitle = session.pendingTitle;
        session.pendingTitle = null;
        const result = await memosClient.renameMemoTitle({
          id: memoId,
          title: requestedTitle,
          expectedFilename: session.filename,
        });

        session.filename = result.memo.filename;
        useMemoStore.getState().handleMemoUpdated(result.memo);

        const identity = { kind: 'memo' as const, id: memoId };
        rebaseActiveDocumentPath(identity, result.path);
        syncMemoPathAfterLocalWrite(memoId, result.path);

        if (
          session.pendingTitle === null
          && normalizeTitle(session.draft) === normalizeTitle(requestedTitle)
        ) {
          session.draft = displayTitleFromFilename(result.memo.filename);
        }
        notify(session);
      }
    } catch (error) {
      session.pendingTitle = null;
      const message = error instanceof Error ? error.message : String(error);
      updateSnapshot(session, { error: message, saving: false });
      toast.error(message);
    } finally {
      session.inFlight = null;
      if (session.saving) updateSnapshot(session, { saving: false });
    }
  })();

  session.inFlight = run;
  return run;
}

export function useMemoTitleSession(memoId: string, filename: string) {
  const session = useMemo(() => getOrCreateSession(memoId, filename), [memoId]);
  const subscribe = useCallback((listener: () => void) => {
    session.subscribers.add(listener);
    return () => session.subscribers.delete(listener);
  }, [session]);
  const getSnapshot = useCallback(() => session.snapshot, [session]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    observeFilename(session, filename);
  }, [filename, session]);

  return {
    snapshot,
    setDraft(value: string) {
      updateSnapshot(session, { draft: value, error: null });
      if (session.timer) clearTimeout(session.timer);
      session.timer = setTimeout(() => {
        session.timer = null;
        void commitMemoTitle(memoId, session, { restoreEmpty: false });
      }, TITLE_SAVE_DEBOUNCE_MS);
    },
    commit() {
      return commitMemoTitle(memoId, session);
    },
    cancel() {
      if (session.timer) clearTimeout(session.timer);
      session.timer = null;
      session.pendingTitle = null;
      updateSnapshot(session, {
        draft: displayTitleFromFilename(session.filename),
        error: null,
      });
    },
  };
}

async function commitMemoTitle(
  memoId: string,
  session: MemoTitleSession,
  options: { restoreEmpty: boolean } = { restoreEmpty: true },
): Promise<void> {
  if (session.timer) clearTimeout(session.timer);
  session.timer = null;

  const title = normalizeTitle(session.draft);
  const confirmedTitle = displayTitleFromFilename(session.filename);
  if (!title) {
    if (options.restoreEmpty) {
      updateSnapshot(session, { draft: confirmedTitle });
    }
    return;
  }
  if (title === normalizeTitle(confirmedTitle)) {
    updateSnapshot(session, { draft: confirmedTitle });
    return;
  }

  session.pendingTitle = title;
  await runQueue(memoId, session);
}
