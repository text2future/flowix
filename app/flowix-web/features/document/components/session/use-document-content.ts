import { getBuffer } from '../../store/buffer-registry';
import { getDocumentSession } from '../../store/document-runtime-session';
import { hasTitleDraft, restoreTitleDraft } from '@features/document/store/document-title-session';
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
import {
  clearRecoveryDraftThrough,
  readRecoveryDraft,
  type RecoveryDraft,
} from '@features/document/store/recovery-draft-store';
import { useDocumentStore } from '@features/document/store/document-store';
import type { DocumentIdentity } from '@features/document/store/document-identity';
import { translate } from '@/lib/i18n';
import { findFileDisplayPath, isFileDisplayIdLive } from '@/lib/file-display-registry';
import { canonicalPath } from '@/lib/path';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { markDocumentOpenTrace } from '@/lib/document-open-perf';
import {
  initialDocumentContainerState,
  type DocumentContainerState,
  type LoadContentOptions,
} from '@features/document/components/session/types';

interface UseDocumentContentOptions {
  identity: DocumentIdentity;
  externalScopePath: string | null;
  /** Non-text external files are rendered by a dedicated preview surface. */
  skipContentLoad?: boolean;
  transitionId: number | null;
  isolatedSession?: boolean;
}

const RECOVERY_DRAFT_READ_TIMEOUT_MS = 10_000;

function readRecoveryDraftWithin(promise: Promise<RecoveryDraft | null>): Promise<RecoveryDraft | null> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error('Recovery draft read timed out')),
      RECOVERY_DRAFT_READ_TIMEOUT_MS,
    );
    void promise.then(
      (draft) => {
        window.clearTimeout(timer);
        resolve(draft);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
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

function isMissingDocumentError(error: unknown): boolean {
  const reason = error instanceof Error ? error.message : String(error);
  const normalized = reason.toLowerCase();
  return normalized.includes('external document is unavailable')
    || normalized.includes('no such file')
    || normalized.includes('not found')
    || normalized.includes('failed to resolve');
}

function readFailureMessage(error: unknown, language: ReturnType<typeof getCurrentAppLanguage>): string {
  const reason = error instanceof Error ? error.message : String(error);
  const normalized = reason.toLowerCase();
  if (normalized.includes('recovery draft read timed out')) {
    return translate(language, 'document.load.recoveryTimeout');
  }
  if (normalized.includes('outside its authorized scope')) {
    return translate(language, 'document.load.scopeDenied');
  }
  if (normalized.includes('document_read_permission_denied') || normalized.includes('permission denied')
    || normalized.includes('access is denied')) {
    return translate(language, 'document.load.permissionDenied');
  }
  if (isMissingDocumentError(error)) return translate(language, 'document.load.fileNotFound');
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
  // UI state here (loading, metadata, errors, etc.).
  //
  // Monotonic counter for the latest reloadDocument call. Stale IPC
  // reads compare against this and abort.
  const counter = useRef(0);
  const reloadDocumentRef = useRef<((path: string, options?: LoadContentOptions) => Promise<void>) | null>(null);

  const readOpeningRecovery = useCallback((path: string) => {
    const session = getDocumentSession(identity);
    const recoveryPath = canonicalPath(path);
    if (session.openingRecovery?.path === recoveryPath) return session.openingRecovery.promise;
    const pending = readRecoveryDraft({ ...identity, path: recoveryPath });
    session.openingRecovery = { path: recoveryPath, promise: pending };
    const clearPending = () => {
      if (session.openingRecovery?.promise === pending) session.openingRecovery = undefined;
    };
    void pending.then(clearPending, clearPending);
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
      const recoveryMatchesPath = recovery?.originalPath === path;
      const recoveryNeedsSave = Boolean(recoveryMatchesPath && recovery.content !== fullContent);
      if (recoveryMatchesPath && recovery) {
        const session = getDocumentSession(identity);
        session.recoveryRevision = Math.max(session.recoveryRevision, recovery.revision);
      }
      if (recovery?.title && recoveryMatchesPath) restoreTitleDraft(identity.displayId, recovery.title);
      if (recoveryNeedsSave && recovery) {
        applyRecoveryDraftContent(identity, recovery.content, recovery.bodyRevision ?? recovery.revision);
        if (recovery.baseContent !== fullContent) {
          // The same conditional write used by live edits attempts a diffy
          // merge. An overlap will mark the buffer conflicted for review.
          buf.lastSavedContent = recovery.baseContent;
          buf.saveState = 'dirty';
        }
      } else if (recoveryMatchesPath && recovery && !hasTitleDraft(identity.displayId)) {
        // A completed body save can leave behind a checkpoint if clearing it
        // raced with shutdown. The disk already has these bytes, so only clear
        // the checkpoint after confirming there is no unsaved title input.
        void clearRecoveryDraftThrough(identity, recovery.revision);
      }
      setState({
        isLoaded: true,
        isLoading: false,
        error: null,
        errorKind: null,
        isScrolled: false,
        isNewlyCreated: false,
        createdAt: '',
        updatedAt: '',
        updatedAtDate: null,
        isFavorited: false,
        frontmatterMeta: {},
      });
      if (recoveryNeedsSave && recovery) {
        void saveDocumentContent({
          identity, path, content: recovery.content,
          scopePath: externalScopePath, force: true,
        });
      }
      logOpenDocPerf('applyLoadedContent', startedAt, {
        transitionId,
        bytes: fullContent.length,
      });
    },
    [identity, externalScopePath, isolatedSession, transitionId],
  );

  const reloadDocument = useCallback(
    async (path: string, options?: LoadContentOptions) => {
      if (!path) return;
      const readPath = findFileDisplayPath(identity.displayId) ?? path;
      const startedAt = performance.now();
      markDocumentOpenTrace(transitionId, 'content:load-start', {
        path: readPath,
        isolatedSession,
      });

      // Switch the active buffer up-front so any in-flight writes from
      // the previous document that resolve after this point still
      // target the right buffer.
      if (!isolatedSession) setActiveDocumentPath(identity, readPath);
      captureLatestDocumentContent(identity);
      const startRevision = getBuffer(identity)?.capturedRevision ?? 0;
      const currentLoadId = ++counter.current;
      const restartAfterPathMove = () => {
        const latestPath = findFileDisplayPath(identity.displayId);
        if (!latestPath || canonicalPath(latestPath) === canonicalPath(readPath)) return false;
        // The pathname is part of the durable address, while this editor and
        // its buffer keep the same display identity across a rename. Restart
        // against that address instead of applying an old-path read result.
        void reloadDocumentRef.current?.(latestPath, options);
        return true;
      };
      if (skipContentLoad) {
        setState((prev) => ({
          ...prev,
          isLoaded: false,
          isLoading: false,
          error: null,
          errorKind: null,
          isScrolled: false,
        }));
        if (!isolatedSession && transitionId !== null) {
          useDocumentStore.getState().finishDocumentTransition(transitionId);
        }
        return;
      }
      const session = getDocumentSession(identity);
      if ((options?.showLoading ?? true) && session.loaded && session.buffer) {
        applyLoadedContent(readPath, session.buffer.lastSavedContent, { preservePending: true });
        if (!isolatedSession && transitionId !== null) useDocumentStore.getState().finishDocumentTransition(transitionId);
        return;
      }
      const stagedContent = consumeStagedDocumentSnapshot(identity, readPath);
      if (stagedContent !== null) {
        // The just-committed create result is already authoritative. There
        // cannot be a recovery draft from this new note before its first edit.
        if (currentLoadId !== counter.current || !isFileDisplayIdLive(identity.displayId)) return;
        if (session.loaded && session.buffer) {
          applyLoadedContent(readPath, session.buffer.lastSavedContent, { preservePending: true });
          return;
        }
        applyLoadedContent(readPath, stagedContent, { preservePending: true });
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
          errorKind: null,
          isScrolled: false,
          isNewlyCreated: false,
        }));
      }

      try {
        logOpenDocPerf('reloadDocument:start', startedAt, {
          transitionId,
          path: readPath,
          // Two reloads racing on the same session produce serial duplicate
          // IPC reads; flag whether this call reused (or could reuse) the
          // in-flight opening read instead of issuing its own.
          openingReadShared: session.openingRead?.path === readPath,
        });
        const readStartedAt = performance.now();
        markDocumentOpenTrace(transitionId, 'ipc:read-start', {
          path: readPath,
        });
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

        if (currentLoadId !== counter.current) return;
        if (restartAfterPathMove()) return;
        if (!isFileDisplayIdLive(identity.displayId)) return;

        if (fullContent === null || fullContent === undefined) {
          session.loaded = false;
          const language = getCurrentAppLanguage();
          setState((prev) => ({
            ...prev,
            isLoading: false,
            error: translate(language, 'document.load.fileNotFound'),
            errorKind: 'missing-note',
          }));
          if (!isolatedSession && transitionId !== null) {
            useDocumentStore.getState().finishDocumentTransition(transitionId, 'unavailable');
          }
          return;
        }

        if ((options?.showLoading ?? true) && session.loaded && session.buffer) {
          applyLoadedContent(readPath, session.buffer.lastSavedContent, { preservePending: true });
          return;
        }
        markDocumentOpenTrace(transitionId, 'recovery:read-start', { path: readPath });
        const recovery = (options?.showLoading ?? true)
          ? await readRecoveryDraftWithin(readOpeningRecovery(readPath))
          : await readRecoveryDraftWithin(readRecoveryDraft({ ...identity, path: readPath }));
        markDocumentOpenTrace(transitionId, 'recovery:read-end', {
            found: recovery !== null,
        });
        if (currentLoadId !== counter.current || !isFileDisplayIdLive(identity.displayId)) return;
        if (restartAfterPathMove()) return;
        captureLatestDocumentContent(identity);
        const liveBuffer = getBuffer(identity);
        if (options?.showLoading === false && liveBuffer
          && (liveBuffer.capturedRevision !== startRevision || liveBuffer.pendingContent !== null)) {
          if (fullContent !== liveBuffer.lastSavedContent) {
            // Input arrived while the disk read was in flight. Reconcile it
            // through the same conditional merge used by normal saves.
            if (await protectDocumentDraft(identity, readPath, 'autosave')) {
              if (currentLoadId !== counter.current || !isFileDisplayIdLive(identity.displayId)) return;
              if (restartAfterPathMove()) return;
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
          applyLoadedContent(readPath, session.buffer.lastSavedContent, { preservePending: true });
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
        if (restartAfterPathMove()) return;
        console.warn('[document-load] read failed', {
          displayId: identity.displayId, transitionId, hasScope: Boolean(externalScopePath), error: String(err),
        });
        session.loaded = false;
        const language = getCurrentAppLanguage();
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: readFailureMessage(err, language),
          errorKind: isMissingDocumentError(err) ? 'missing-note' : 'error',
        }));
        logOpenDocPerf('reloadDocument:error', startedAt, {
          transitionId,
        });
        if (!isolatedSession && transitionId !== null) {
          useDocumentStore.getState().finishDocumentTransition(transitionId, 'unavailable');
        }
      } finally {
        if (currentLoadId === counter.current && !isolatedSession && transitionId !== null) {
          useDocumentStore.getState().finishDocumentTransition(transitionId);
        }
      }
    },
    [applyLoadedContent, identity, isolatedSession, externalScopePath, readOpeningRecovery, skipContentLoad, transitionId],
  );
  reloadDocumentRef.current = reloadDocument;

  return {
    state,
    setState,
    reloadDocument,
  };
}
