'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '@/lib/error-message';
import { cloud, listenToCloudStateChanges, type CloudState } from '@platform/tauri/client';

type MembershipRefreshResult = 'refreshed' | 'failed' | 'stale' | 'skipped';
// Focus and visibility events often arrive together; keep them from duplicating requests.
const MEMBERSHIP_AUTO_REFRESH_COOLDOWN_MS = 60_000;

/** Opt in on views that need a fresh server-owned membership and usage snapshot. */
export function useCloudAccountState(options: { autoRefreshMembershipWhenVisible?: boolean } = {}) {
  const autoRefreshMembershipWhenVisible = options.autoRefreshMembershipWhenVisible ?? false;
  const [state, setState] = useState<CloudState | null>(null);
  const latestState = useRef<CloudState | null>(null);
  const [membershipLoading, setMembershipLoading] = useState(false);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const membershipRequest = useRef(0);
  const membershipInFlight = useRef<{ userId: string; promise: Promise<MembershipRefreshResult> } | null>(null);
  const lastMembershipRefreshAt = useRef(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const applyState = useCallback((next: CloudState) => {
    const current = latestState.current;
    if (current && next.revision < current.revision) return false;
    latestState.current = next;
    setState(next);
    setLoadError(null);
    return !current || next.revision > current.revision;
  }, []);

  useEffect(() => {
    let active = true;
    let receivedState = false;
    const receive = (next: CloudState) => {
      if (!active) return;
      receivedState = true;
      const newer = applyState(next);
      if (newer) {
        if (next.membershipStatus === 'error') {
          setMembershipError(next.membershipError ?? null);
        } else if (next.membershipStatus === 'verified' || next.membershipStatus === 'refreshing') {
          setMembershipError(null);
        }
      }
    };
    const refreshSnapshot = () => {
      if (!active) return;
      void cloud.getState().then(receive).catch((error) => {
        if (active && !receivedState) setLoadError(errorMessage(error));
      });
    };
    // Re-query after the native listener is ready (or recovers) to cover
    // events emitted while the asynchronous native subscription was pending.
    const unlisten = listenToCloudStateChanges(receive, { onListenerReady: refreshSnapshot });
    refreshSnapshot();
    return () => { active = false; unlisten(); };
  }, [applyState]);

  const refreshMembership = useCallback(async (): Promise<MembershipRefreshResult> => {
    const userId = state?.account?.user.id;
    if (!state?.authenticated || !userId) return 'skipped';
    if (membershipInFlight.current?.userId === userId) return membershipInFlight.current.promise;
    const request = ++membershipRequest.current;
    lastMembershipRefreshAt.current = Date.now();
    setMembershipLoading(true);
    const promise = (async (): Promise<MembershipRefreshResult> => {
      try {
        await cloud.refreshMembership();
        if (request !== membershipRequest.current) return 'stale';
        setMembershipError(null);
        return 'refreshed';
      } catch (error) {
        if (request !== membershipRequest.current) return 'stale';
        setMembershipError(errorMessage(error));
        return 'failed';
      } finally {
        if (request === membershipRequest.current) setMembershipLoading(false);
      }
    })();
    membershipInFlight.current = { userId, promise };
    try { return await promise; }
    finally {
      if (membershipInFlight.current?.promise === promise) membershipInFlight.current = null;
    }
  }, [state?.authenticated, state?.account?.user.id]);

  useEffect(() => {
    ++membershipRequest.current;
    lastMembershipRefreshAt.current = 0;
    setMembershipError(null);
    setMembershipLoading(false);
    membershipInFlight.current = null;
    return () => {
      ++membershipRequest.current;
      membershipInFlight.current = null;
    };
  }, [state?.authenticated, state?.account?.user.id]);

  useEffect(() => {
    const userId = state?.account?.user.id;
    if (!autoRefreshMembershipWhenVisible || !state?.authenticated || !userId) return;

    // This re-reads the latest server snapshot; object enumeration remains server-owned.
    const refreshIfStale = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastMembershipRefreshAt.current < MEMBERSHIP_AUTO_REFRESH_COOLDOWN_MS) return;
      void refreshMembership();
    };

    refreshIfStale();
    window.addEventListener('focus', refreshIfStale);
    document.addEventListener('visibilitychange', refreshIfStale);
    return () => {
      window.removeEventListener('focus', refreshIfStale);
      document.removeEventListener('visibilitychange', refreshIfStale);
    };
  }, [autoRefreshMembershipWhenVisible, state?.authenticated, state?.account?.user.id, refreshMembership]);

  return {
    state,
    loadError,
    membershipLoading,
    membershipError: membershipError ?? state?.membershipError ?? null,
    refreshMembership,
    applyState,
    loading: (!state && !loadError) || state?.authStatus === 'restoring',
  };
}
