'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const OPEN_DELAY_MS = 420;
const CLOSE_DELAY_MS = 150;
const LEAVE_ANIMATION_MS = 160;

export type MemoListPreviewPhase = 'closed' | 'open' | 'closing';

/**
 * Owns hover timing while MainLayout keeps one MemoList instance mounted and
 * switches its surface between the sidebar and the floating preview.
 *
 */
export function useMemoListHoverPreview(enabled: boolean) {
  const [phase, setPhase] = useState<MemoListPreviewPhase>('closed');
  const phaseRef = useRef<MemoListPreviewPhase>('closed');
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const leaveTimerRef = useRef<number | null>(null);

  const updatePhase = useCallback((nextPhase: MemoListPreviewPhase) => {
    phaseRef.current = nextPhase;
    setPhase(nextPhase);
  }, []);

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current === null) return;
    window.clearTimeout(openTimerRef.current);
    openTimerRef.current = null;
  }, []);

  const clearCloseTimers = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (leaveTimerRef.current !== null) {
      window.clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
  }, []);

  const beginClose = useCallback(() => {
    closeTimerRef.current = null;
    if (phaseRef.current !== 'open') return;
    updatePhase('closing');
    leaveTimerRef.current = window.setTimeout(() => {
      leaveTimerRef.current = null;
      updatePhase('closed');
    }, LEAVE_ANIMATION_MS);
  }, [updatePhase]);

  const scheduleClose = useCallback(() => {
    clearOpenTimer();
    if (phaseRef.current !== 'open' || closeTimerRef.current !== null) return;
    closeTimerRef.current = window.setTimeout(beginClose, CLOSE_DELAY_MS);
  }, [beginClose, clearOpenTimer]);

  const handleTriggerEnter = useCallback(() => {
    if (!enabled) return;
    clearCloseTimers();
    if (phaseRef.current === 'closing') {
      updatePhase('open');
      return;
    }
    if (phaseRef.current === 'open' || openTimerRef.current !== null) return;
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      updatePhase('open');
    }, OPEN_DELAY_MS);
  }, [clearCloseTimers, enabled, updatePhase]);

  const handleTriggerLeave = useCallback(() => {
    if (!enabled) return;
    scheduleClose();
  }, [enabled, scheduleClose]);

  const handlePreviewEnter = useCallback(() => {
    if (!enabled) return;
    clearOpenTimer();
    clearCloseTimers();
    if (phaseRef.current !== 'open') updatePhase('open');
  }, [clearCloseTimers, clearOpenTimer, enabled, updatePhase]);

  const handlePreviewLeave = useCallback(() => {
    if (!enabled) return;
    scheduleClose();
  }, [enabled, scheduleClose]);

  useEffect(() => {
    if (enabled) return;
    clearOpenTimer();
    clearCloseTimers();
    updatePhase('closed');
  }, [clearCloseTimers, clearOpenTimer, enabled, updatePhase]);

  useEffect(
    () => () => {
      clearOpenTimer();
      clearCloseTimers();
    },
    [clearCloseTimers, clearOpenTimer],
  );

  return {
    phase,
    handleTriggerEnter,
    handleTriggerLeave,
    handlePreviewEnter,
    handlePreviewLeave,
  };
}
