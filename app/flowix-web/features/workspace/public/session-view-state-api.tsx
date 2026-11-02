'use client';

import { createContext, useContext, useMemo, useEffect } from 'react';
import type { WorkspaceSessionId } from '../model/workspace-session';
import { restoreViewSnapshot, type SessionViewSnapshot } from '../model/session-view-state';
import { useWorkspaceSessionStore } from '../store/workspace-session-store';

export const SessionViewRecoveryContext = createContext<{ sessionId: WorkspaceSessionId; entryId: string } | null>(null);

const captureOwners = new Map<string, symbol>();

export function createSessionViewChannel(sessionId: WorkspaceSessionId, entryId: string, slot: string) {
  const key = JSON.stringify([sessionId, entryId, slot]);
  const owner = Symbol();
  let claimed = false;
  return {
    claim: () => {
      claimed = true; captureOwners.set(key, owner);
      return () => { if (captureOwners.get(key) === owner) captureOwners.delete(key); };
    },
    read: () => useWorkspaceSessionStore.getState().sessions[sessionId].viewStates[entryId]?.recovery?.slots[slot],
    write: (value: SessionViewSnapshot) => {
      const snapshot = restoreViewSnapshot(value);
      if (!snapshot || slot.length > 1024 || (claimed && captureOwners.get(key) !== owner)) return;
      useWorkspaceSessionStore.getState().updateSession(sessionId, (session) => {
        // Old renderers may flush after navigation, but may only write retained entries.
        const n = session.navigation;
        if (![n.current, ...n.backStack, ...n.forwardStack].some((entry) => entry?.id === entryId)) return session;
        const previous = session.viewStates[entryId];
        if (JSON.stringify(previous?.recovery?.slots[slot]) === JSON.stringify(snapshot)) return session;
        const slots = Object.fromEntries([...Object.entries(previous?.recovery?.slots ?? {}).filter(([key]) => key !== slot), [slot, snapshot]].slice(-32));
        const viewStates = Object.fromEntries([...Object.entries(session.viewStates).filter(([key]) => key !== entryId),
          [entryId, { ...previous, recovery: { version: 1 as const, slots } }]].slice(-200));
        return { ...session, viewStates };
      });
    },
  };
}

/** Outside a workspace surface the editor remains a standalone editor. */
export function useSessionViewChannel(slot: string) {
  const scope = useContext(SessionViewRecoveryContext);
  const sessionId = scope?.sessionId;
  const entryId = scope?.entryId;
  return useMemo(() => sessionId && entryId ? createSessionViewChannel(sessionId, entryId, slot) : null,
    [sessionId, entryId, slot]);
}

/** Throttle persistent writes; flush before teardown or page suspension. */
export function attachSessionViewCapture(channel: ReturnType<typeof useSessionViewChannel>, capture: () => SessionViewSnapshot | null) {
  if (!channel) return { schedule: () => {}, dispose: () => {} };
  const release = channel.claim();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => { clearTimeout(timer); timer = undefined; const snapshot = capture(); if (snapshot) channel?.write(snapshot); };
  const schedule = () => { if (channel && timer === undefined) timer = setTimeout(flush, 250); };
  const visibility = () => { if (document.visibilityState === 'hidden') flush(); };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', visibility);
  return { schedule, dispose: () => {
    window.removeEventListener('pagehide', flush);
    document.removeEventListener('visibilitychange', visibility);
    flush(); release?.();
  } };
}

/** Use semantic slot names; never persist DOM paths or container geometry. */
export function useSessionScrollRecovery(element: HTMLElement | null, slot: string) {
  const channel = useSessionViewChannel(slot);
  useEffect(() => {
    if (!element || !channel) return;
    const saved = channel.read();
    let pending = saved?.kind === 'scroll' ? saved : null;
    const restore = () => {
      if (!pending) return;
      element.scrollTop = pending.scrollTop;
      element.scrollLeft = pending.scrollLeft;
      if (Math.abs(element.scrollTop - pending.scrollTop) < 1 && Math.abs(element.scrollLeft - pending.scrollLeft) < 1) pending = null;
    };
    const capture = attachSessionViewCapture(channel, () => pending ?? ({ kind: 'scroll', scrollTop: element.scrollTop, scrollLeft: element.scrollLeft }));
    const intent = () => { pending = null; };
    const scroll = () => { if (!pending) capture.schedule(); };
    restore();
    const observer = new MutationObserver(restore);
    observer.observe(element, { childList: true, subtree: true });
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(restore);
    resize?.observe(element);
    if (element.firstElementChild) resize?.observe(element.firstElementChild);
    element.addEventListener('scroll', scroll, { passive: true });
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
    events.forEach((event) => element.addEventListener(event, intent, { passive: true }));
    return () => {
      observer.disconnect(); resize?.disconnect();
      events.forEach((event) => element.removeEventListener(event, intent));
      element.removeEventListener('scroll', scroll);
      capture.dispose();
    };
  }, [element, channel]);
}
