import { getBuffer } from '../../store/buffer-registry';
import { getDocumentSession } from '../../store/document-runtime-session';
import { restoreTitleDraft } from '@features/document/store/document-title-session';
import { useCallback, useEffect, useRef, useState } from 'react';

import { localDocumentOperations } from '@features/document/use-cases/local-document-operations';
import {
  captureLatestDocumentContent,
  setActiveDocumentPath,
  applyLoadedDocumentContent,
  consumeStagedDocumentSnapshot,
  applyRecoveryDraftContent,
  protectDocumentDraft,
  saveDocumentContent,
} from '@features/document/store/document-session-service';
import { readRecoveryDraft, type RecoveryDraft } from '@features/document/store/recovery-draft-store';
import { useDocumentStore } from '@features/document/store/document-store';
import type { DocumentIdentity } from '@features/document/store/document-identity';
import { translate } from '@/lib/i18n';
import { isFileDisplayIdLive } from '@/lib/file-display-registry';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { markDocumentOpenTrace } from '@/lib/document-open-perf';
import {
  initialDocumentContainerState,
  type DocumentContainerState,
  type LoadContentOptions,
} from '@features/document/components/session/types';
import {
  countTextUnits,
  extractBodyContent,
} from '@features/document/components/session/document-utils';

interface UseDocumentContentOptions {
  identity: DocumentIdentity;
  externalScopePath: string | null;
  /** Non-text external files are rendered by a dedicated preview surface. */
  skipContentLoad?: boolean;
  transitionId: number | null;
  isolatedSession?: boolean;
}

function logOpenDocPerf(label: string, startedAt: number, meta?: Record<string, unknown>) {
  console.info('[perf:open-doc]', label, {
    elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
    ...meta,
  });
  const transitionId = meta?.transitionId;
  if (typeof transitionId === 'number') {
    markDocumentOpenTrace(transitionId, `content:${label}`, {
      stageElapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
      ...meta,
    });
  }
}

function readFailureMessage(error: unknown, language: ReturnType<typeof getCurrentAppLanguage>): string {
  const reason = error instanceof Error ? error.message : String(error);
  const normalized = reason.toLowerCase();
  if (normalized.includes('outside its authorized scope') || normalized.includes('permission denied')) {
    return translate(language, 'document.load.accessDenied');
  }
  if (normalized.includes('no such file') || normalized.includes('not found') || normalized.includes('failed to resolve')) {
    return translate(language, 'document.load.fileNotFound');
  }
  if (normalized.includes('not a supported text file') || normalized.includes('is a directory')
    || normalized.includes('not a regular file') || normalized.includes('expected file')) {
    return translate(language, 'document.load.notTextFile');
  }
  return `${translate(language, 'document.load.failed')}: ${reason}`;
}

export function useDocumentContent({
  identity,
  externalScopePath,
  skipContentLoad = false,
  transitionId,
  isolatedSession = false,
}: UseDocumentContentOptions) {
  const [state, setState] = useState<DocumentContainerState>(initialDocumentContainerState);
  // Buffer state (content / lastSavedContent / pendingContent) lives in
  // the document session service now, not in this hook. We only track
  // UI state here (charCount, isLoading, etc.).
  //
  // Monotonic counter for the latest reloadDocument call. Stale IPC
  // reads compare against this and abort.
  const counter = useRef(0);

  const readOpeningRecovery = useCallback(() => {
    const session = getDocumentSession(identity);
    if (session.openingRecovery) return session.openingRecovery;
    const pending = readRecoveryDraft(identity).catch(() => null);
    session.openingRecovery = pending;
    void pending.finally(() => {
      if (session.openingRecovery === pending) session.openingRecovery = undefined;
    });
    return pending;
  }, [identity]);

  useEffect(() => () => {
    // Prevent an IPC read from recreating a buffer after its last surface has
    // unmounted and the runtime display identity has been reclaimed.
    counter.current += 1;
  }, []);

  const applyLoadedContent = useCallback(
    (
      path: string,
      fullContent: string,
      options?: Pick<LoadContentOptions, 'preservePending'> & { recovery?: RecoveryDraft | null },
    ) => {
      const startedAt = performance.now();
      markDocumentOpenTrace(transitionId, 'content:apply-start', {
        bytes: fullContent.length,
        isolatedSession,
      });
      const buf = applyLoadedDocumentContent(identity, path, fullContent, {
        preservePending: options?.preservePending ?? true,
        setAsCurrent: !isolatedSession,
      });
      const recovery = options?.recovery ?? null;
      if (recovery && recovery.originalPath === path) {
        const session = getDocumentSession(identity);
        session.recoveryRevision = Math.max(session.recoveryRevision, recovery.revision);
      }
      if (recovery?.title && recovery.originalPath === path) restoreTitleDraft(identity.displayId, recovery.title);
      const recoveryNeedsMerge = Boolean(recovery
        && recovery.originalPath === path
        && recovery.content !== fullContent
        && recovery.baseContent !== fullContent);
      if (
        recovery
        && recovery.originalPath === path
      ) {
        applyRecoveryDraftContent(identity, recovery.content, recovery.bodyRevision ?? recovery.revision);
        if (recoveryNeedsMerge) {
          // The same conditional write used by live edits attempts a diffy
          // merge. An overlap will mark the buffer conflicted for review.
          buf.lastSavedContent = recovery.baseContent;
          buf.saveState = 'dirty';
        }
      }
      // A document heading does not imply that the file was just created.
      const initialContent = recovery
        && recovery.originalPath === path
        ? recovery.content
        : buf.content;
      const initialBody = extractBodyContent(initialContent);
      const initialCharCount = countTextUnits(initialBody);

      setState({
        fullContent: initialContent,
        isLoaded: true,
        isLoading: false,
        error: null,
        isScrolled: false,
        isNewlyCreated: false,
        charCount: initialCharCount,
        tokenCount: Math.ceil(initialCharCount / 4),
        createdAt: '',
        updatedAt: '',
        updatedAtDate: null,
        isFavorited: false,
        frontmatterMeta: {},
      });
      if (recoveryNeedsMerge && recovery) {
        void saveDocumentContent({
          identity, path, content: recovery.content,
          scopePath: externalScopePath, force: true,
        });
      }
      logOpenDocPerf('applyLoadedContent', startedAt, {
        transitionId,
        bytes: fullContent.length,
        chars: initialCharCount,
      });
    },
    [identity, externalScopePath, isolatedSession, transitionId],
  );

  const reloadDocument = useCallback(
    async (path: string, options?: LoadContentOptions) => {
      if (!path) return;
      const startedAt = performance.now();
      markDocumentOpenTrace(transitionId, 'content:load-start', {
        path,
        isolatedSession,
      });

      // Switch the active buffer up-front so any in-flight writes from
      // the previous document that resolve after this point still
      // target the right buffer.
      if (!isolatedSession) setActiveDocumentPath(identity, path);
      captureLatestDocumentContent(identity);
      const startRevision = getBuffer(identity)?.capturedRevision ?? 0;
      const currentLoadId = ++counter.current;
      if (skipContentLoad) {
        setState((prev) => ({
          ...prev,
          fullContent: '',
          isLoaded: false,
          isLoading: false,
          error: null,
          isScrolled: false,
          charCount: 0,
          tokenCount: 0,
        }));
        if (!isolatedSession && transitionId !== null) {
          useDocumentStore.getState().finishDocumentTransition(transitionId);
        }
        return;
      }
      const session = getDocumentSession(identity);
      if ((options?.showLoading ?? true) && session.loaded && session.buffer) {
        applyLoadedContent(identity.path, session.buffer.lastSavedContent, { preservePending: true });
        if (!isolatedSession && transitionId !== null) useDocumentStore.getState().finishDocumentTransition(transitionId);
        return;
      }
      const stagedContent = consumeStagedDocumentSnapshot(identity, path);
      if (stagedContent !== null) {
        // The just-committed create result is already authoritative. There
        // cannot be a recovery draft from this new note before its first edit.
        if (currentLoadId !== counter.current || !isFileDisplayIdLive(identity.displayId)) return;
        if (session.loaded && session.buffer) {
          applyLoadedContent(session.identity.path, session.buffer.lastSavedContent, { preservePending: true });
          return;
        }
        applyLoadedContent(path, stagedContent, { preservePending: true });
        logOpenDocPerf('reloadDocument:staged', startedAt, {
          transitionId,
          bytes: stagedContent.length,
        });
        if (!isolatedSession && transitionId !== null) {
          useDocumentStore.getState().finishDocumentTransition(transitionId);
        }
        return;
      }
      if (options?.showLoading ?? true) {
        setState((prev) => ({
          ...prev,
          isLoading: true,
          isLoaded: false,
          error: null,
          isScrolled: false,
          isNewlyCreated: false,
        }));
      }

      try {
        logOpenDocPerf('reloadDocument:start', startedAt, {
          transitionId,
          path,
        });
        const readStartedAt = performance.now();
        markDocumentOpenTrace(transitionId, 'ipc:read-start', {
          path,
        });
        let readPath = path;
        const read = () => localDocumentOperations.read({ path: readPath, scopePath: externalScopePath });
        const opening = options?.showLoading ?? true;
        const operation = opening && session.openingRead?.path === readPath
          ? session.openingRead.promise : read();
        if (opening) session.openingRead = { path: readPath, promise: operation };
        let fullContent: string | null;
        try { fullContent = await operation; }
        finally { if (session.openingRead?.promise === operation) session.openingRead = undefined; }

        logOpenDocPerf('readDocument', readStartedAt, {
          transitionId,
          path: readPath,
          bytes: fullContent?.length ?? 0,
        });
        markDocumentOpenTrace(transitionId, 'ipc:read-end', {
          path: readPath,
          bytes: fullContent?.length ?? 0,
        });

        if (fullContent === null || fullContent === undefined) {
          if (currentLoadId !== counter.current) return;
          const language = getCurrentAppLanguage();
          setState((prev) => ({ ...prev, isLoading: false, error: translate(language, 'document.load.fileNotFound') }));
          if (!isolatedSession && transitionId !== null) {
            useDocumentStore.getState().finishDocumentTransition(transitionId);
          }
          return;
        }

        if (currentLoadId !== counter.current || !isFileDisplayIdLive(identity.displayId)) return;
        if ((options?.showLoading ?? true) && session.loaded && session.buffer) {
          applyLoadedContent(session.identity.path, session.buffer.lastSavedContent, { preservePending: true });
          return;
        }
        markDocumentOpenTrace(transitionId, 'recovery:read-start', { path });
        const recovery = (options?.showLoading ?? true)
          ? await readOpeningRecovery() : await readRecoveryDraft(identity).catch(() => null);
        markDocumentOpenTrace(transitionId, 'recovery:read-end', {
            found: recovery !== null,
        });
        if (currentLoadId !== counter.current || !isFileDisplayIdLive(identity.displayId)) return;
        captureLatestDocumentContent(identity);
        const liveBuffer = getBuffer(identity);
        if (options?.showLoading === false && liveBuffer
          && (liveBuffer.capturedRevision !== startRevision || liveBuffer.pendingContent !== null)) {
          if (fullContent !== liveBuffer.lastSavedContent) {
            // Input arrived while the disk read was in flight. Reconcile it
            // through the same conditional merge used by normal saves.
            if (await protectDocumentDraft(identity, readPath, 'autosave')) {
              if (currentLoadId !== counter.current || !isFileDisplayIdLive(identity.displayId)) return;
              captureLatestDocumentContent(identity);
              void saveDocumentContent({
                identity, path: readPath, content: getBuffer(identity)?.content ?? liveBuffer.content,
                scopePath: externalScopePath, force: true,
              });
            }
          }
          return;
        }
        // Another view may have finished the same opening and accepted input
        // while this view was still reading recovery. Adopt that live buffer.
        if ((options?.showLoading ?? true) && session.loaded && session.buffer) {
          applyLoadedContent(session.identity.path, session.buffer.lastSavedContent, { preservePending: true });
          return;
        }
        applyLoadedContent(readPath, fullContent, {
          preservePending: options?.preservePending,
          recovery,
        });
        logOpenDocPerf('reloadDocument:loaded', startedAt, {
          transitionId,
          bytes: fullContent.length,
        });
        if (!isolatedSession && transitionId !== null) {
          useDocumentStore.getState().finishDocumentTransition(transitionId);
        }
      } catch (err) {
        if (currentLoadId !== counter.current) return;
        const language = getCurrentAppLanguage();
        setState((prev) => ({ ...prev, isLoading: false, error: readFailureMessage(err, language) }));
        logOpenDocPerf('reloadDocument:error', startedAt, {
          transitionId,
        });
      } finally {
        if (currentLoadId === counter.current && !isolatedSession && transitionId !== null) {
          useDocumentStore.getState().finishDocumentTransition(transitionId);
        }
      }
    },
    [applyLoadedContent, identity, isolatedSession, externalScopePath, readOpeningRecovery, skipContentLoad, transitionId],
  );

  return {
    state,
    setState,
    reloadDocument,
  };
}
