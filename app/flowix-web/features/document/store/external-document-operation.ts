import { canonicalPath } from '@/lib/path';
import { pinFileDisplayId } from '@/lib/file-display-registry';

type ExpectedExternalDocumentEventKind = 'modified' | 'deleted';

interface ExpectedExternalDocumentEvent {
  timeout: ReturnType<typeof setTimeout>;
  revision: string | null;
}

export interface ExternalDocumentRenameOperation {
  expectSourceDelete: (path: string) => () => void;
  expectFollowupWrite: (path: string) => void;
  finish: () => void;
}

const expectedEvents = new Map<string, ExpectedExternalDocumentEvent>();
const renamingDisplays = new Map<string, number>();
const renameLockSubscribers = new Set<(displayId: string) => void>();
const renameDisplayPins = new Map<string, Set<() => void>>();

function expectedEventKey(path: string, kind: ExpectedExternalDocumentEventKind): string {
  return `${kind}:${canonicalPath(path)}`;
}

function expectEvent(path: string, kind: ExpectedExternalDocumentEventKind): () => void {
  const key = expectedEventKey(path, kind);
  const existing = expectedEvents.get(key);
  if (existing) clearTimeout(existing.timeout);
  const timeout = setTimeout(() => expectedEvents.delete(key), 5_000);
  const expected: ExpectedExternalDocumentEvent = { timeout, revision: null };
  expectedEvents.set(key, expected);
  return () => {
    const current = expectedEvents.get(key);
    if (current !== expected) return;
    clearTimeout(timeout);
    expectedEvents.delete(key);
  };
}

/** Suppress the watcher delete event produced by an explicit local delete. */
export function expectExternalDocumentDelete(path: string): () => void {
  return expectEvent(path, 'deleted');
}

/** Suppress a known local write that follows a title-only rename. */
export function expectExternalDocumentWrite(path: string): void {
  expectEvent(path, 'modified');
}

export function consumeExpectedExternalDocumentEvent(
  path: string,
  kind: ExpectedExternalDocumentEventKind,
  revision: string,
): boolean {
  const key = expectedEventKey(path, kind);
  const expected = expectedEvents.get(key);
  if (!expected) return false;
  if (expected.revision === null) {
    expected.revision = revision;
    return true;
  }
  if (expected.revision === revision) return true;
  clearTimeout(expected.timeout);
  expectedEvents.delete(key);
  return false;
}

export function isExternalDocumentRenameInProgress(displayId: string): boolean {
  return (renamingDisplays.get(displayId) ?? 0) > 0;
}

export function beginExternalDocumentRename(
  displayId: string,
): ExternalDocumentRenameOperation {
  renamingDisplays.set(displayId, (renamingDisplays.get(displayId) ?? 0) + 1);
  const releaseDisplayPin = pinFileDisplayId(displayId);
  const displayPins = renameDisplayPins.get(displayId) ?? new Set<() => void>();
  displayPins.add(releaseDisplayPin);
  renameDisplayPins.set(displayId, displayPins);
  for (const subscriber of renameLockSubscribers) subscriber(displayId);
  let finished = false;
  return {
    expectSourceDelete: (path) => expectEvent(path, 'deleted'),
    expectFollowupWrite: (path) => {
      expectEvent(path, 'modified');
    },
    finish: () => {
      if (finished) return;
      finished = true;
      const remainingRenames = (renamingDisplays.get(displayId) ?? 1) - 1;
      if (remainingRenames > 0) renamingDisplays.set(displayId, remainingRenames);
      else renamingDisplays.delete(displayId);
      releaseDisplayPin();
      displayPins.delete(releaseDisplayPin);
      if (displayPins.size === 0) renameDisplayPins.delete(displayId);
      for (const subscriber of renameLockSubscribers) subscriber(displayId);
    },
  };
}
