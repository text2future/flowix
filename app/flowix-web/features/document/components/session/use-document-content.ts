import { useCallback, useRef, useState } from 'react';

import { memos as memosClient } from '@platform/tauri/client';
import { useMemoStore } from '@features/memo';
import {
  setActiveDocumentPath,
  applyLoadedDocumentContent,
  useDocumentStore,
  type DocumentIdentity,
} from '@features/document';
import { translate } from '@features/i18n';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import { formatDateTime } from '@/lib/utils';
import {
  initialDocumentContainerState,
  type DocumentContainerState,
  type LoadContentOptions,
} from '@features/document/components/session/types';
import {
  countTextUnits,
  extractBodyContent,
  findMemoById,
  joinPath,
} from '@features/document/components/session/document-utils';

interface UseDocumentContentOptions {
  identity: DocumentIdentity;
  memoId: string | null;
  notebookPath?: string | null;
  isExternalDocument: boolean;
  transitionId: number | null;
}

function getMemoSnapshot(memoId: string | null | undefined) {
  return findMemoById(useMemoStore.getState(), memoId);
}

async function resolveLatestMemoPathFromBackend(
  memoId: string | null,
  notebookPath: string | null | undefined,
): Promise<string | null> {
  if (!memoId || !notebookPath) return null;
  const memo = await memosClient.readMemo(memoId);
  if (!memo?.filename) return null;
  useMemoStore.getState().handleMemoUpdated(memo);
  return joinPath(notebookPath, memo.filename);
}

function logOpenDocPerf(label: string, startedAt: number, meta?: Record<string, unknown>) {
  console.info('[perf:open-doc]', label, {
    elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
    ...meta,
  });
}

export function useDocumentContent({
  identity,
  memoId,
  notebookPath,
  isExternalDocument,
  transitionId,
}: UseDocumentContentOptions) {
  const [state, setState] = useState<DocumentContainerState>(initialDocumentContainerState);
  // Buffer state (content / lastSavedContent / pendingContent) lives in
  // the document session service now, not in this hook. We only track
  // UI state here (charCount, isLoading, etc.).
  //
  // Monotonic counter for the latest reloadDocument call. Stale IPC
  // reads compare against this and abort.
  const counter = useRef(0);

  const applyLoadedContent = useCallback(
    (path: string, fullContent: string, options?: Pick<LoadContentOptions, 'preservePending'>) => {
      const startedAt = performance.now();
      const buf = applyLoadedDocumentContent(identity, path, fullContent, { preservePending: options?.preservePending });
      const memo = isExternalDocument ? null : getMemoSnapshot(memoId);
      const createdAt = memo?.createdAt ? formatDateTime(memo.createdAt) : '';
      const updatedAt = memo?.updatedAt ? formatDateTime(memo.updatedAt) : '';
      const updatedAtDate = memo?.updatedAt ? new Date(memo.updatedAt) : null;
      const isFavorited = memo?.favorited || false;
      const isNew = fullContent.trimStart().startsWith('# ');
      const initialContent = buf.content;
      const initialBody = extractBodyContent(initialContent);
      const initialCharCount = countTextUnits(initialBody);

      setState({
        fullContent: initialContent,
        isLoading: false,
        error: null,
        isScrolled: false,
        isNewlyCreated: isNew,
        charCount: initialCharCount,
        tokenCount: Math.ceil(initialCharCount / 4),
        createdAt,
        updatedAt,
        updatedAtDate,
        isFavorited,
        frontmatterMeta: {},
      });
      logOpenDocPerf('applyLoadedContent', startedAt, {
        memoId,
        transitionId,
        bytes: fullContent.length,
        chars: initialCharCount,
      });
    },
    [identity, isExternalDocument, memoId, transitionId],
  );

  const reloadDocument = useCallback(
    async (path: string, options?: LoadContentOptions) => {
      if (!path) return;
      const startedAt = performance.now();

      // Switch the active buffer up-front so any in-flight writes from
      // the previous document that resolve after this point still
      // target the right buffer.
      setActiveDocumentPath(identity, path);
      const currentLoadId = ++counter.current;
      if (options?.showLoading ?? true) {
        setState((prev) => ({
          ...prev,
          isLoading: true,
          error: null,
          isScrolled: false,
          isNewlyCreated: false,
        }));
      }

      try {
        logOpenDocPerf('reloadDocument:start', startedAt, {
          memoId,
          transitionId,
          path,
        });
        const readStartedAt = performance.now();
        let readPath = path;
        let fullContent = await memosClient.readDocument(readPath);
        if (
          (fullContent === null || fullContent === undefined) &&
          !isExternalDocument
        ) {
          const latestPath = await resolveLatestMemoPathFromBackend(memoId, notebookPath);
          if (latestPath && latestPath !== path) {
            const retryStartedAt = performance.now();
            const retryContent = await memosClient.readDocument(latestPath);
            logOpenDocPerf('readDocument:retry-latest-path', retryStartedAt, {
              memoId,
              transitionId,
              previousPath: path,
              latestPath,
              bytes: retryContent?.length ?? 0,
            });
            if (retryContent !== null && retryContent !== undefined) {
              readPath = latestPath;
              fullContent = retryContent;
              setActiveDocumentPath(identity, latestPath);
              useDocumentStore.getState().replaceActiveMemoPath(memoId!, latestPath);
            }
          }
        }
        logOpenDocPerf('readDocument', readStartedAt, {
          memoId,
          transitionId,
          path: readPath,
          bytes: fullContent?.length ?? 0,
        });

        if (fullContent === null || fullContent === undefined) {
          if (currentLoadId !== counter.current) return;
          const language = useUserSettingsStore.getState().settings.language;
          setState((prev) => ({ ...prev, isLoading: false, error: translate(language, 'document.load.failed') }));
          if (transitionId !== null) {
            useDocumentStore.getState().finishDocumentTransition(transitionId);
          }
          return;
        }

        if (currentLoadId !== counter.current) return;
        applyLoadedContent(readPath, fullContent, { preservePending: options?.preservePending });
        logOpenDocPerf('reloadDocument:loaded', startedAt, {
          memoId,
          transitionId,
          bytes: fullContent.length,
        });
        if (transitionId !== null) {
          useDocumentStore.getState().finishDocumentTransition(transitionId);
        }
      } catch (err) {
        if (currentLoadId !== counter.current) return;
        const language = useUserSettingsStore.getState().settings.language;
        setState((prev) => ({ ...prev, isLoading: false, error: translate(language, 'document.load.failed') }));
        logOpenDocPerf('reloadDocument:error', startedAt, {
          memoId,
          transitionId,
        });
      } finally {
        if (currentLoadId === counter.current && transitionId !== null) {
          useDocumentStore.getState().finishDocumentTransition(transitionId);
        }
      }
    },
    [applyLoadedContent, identity, isExternalDocument, memoId, notebookPath, transitionId],
  );

  return {
    state,
    setState,
    reloadDocument,
  };
}
