'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const OPEN_DELAY_MS = 420;
const CLOSE_DELAY_MS = 150;
const LEAVE_ANIMATION_MS = 160;

export type MemoListPreviewPhase = 'closed' | 'open' | 'closing';
export type MemoListNavigationPhase = 'closed' | 'open' | 'closing';

/**
 * Owns hover timing while MainLayout keeps one MemoList instance mounted and
 * switches its surface between the sidebar and the floating preview.
 *
 * The navigation drawer is a companion surface of the preview. When it is
 * opened from the preview, the preview is held open until the drawer closes;
 * this prevents the preview from disappearing when the pointer crosses into
 * the drawer after it shifts to the right.
 */
export function useMemoListHoverPreview(
  enabled: boolean,
  navigationDrawerPhase: MemoListNavigationPhase = 'closed',
) {
  const [phase, setPhase] = useState<MemoListPreviewPhase>('closed');
  const phaseRef = useRef<MemoListPreviewPhase>('closed');
  const navigationHoldRef = useRef(false);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const leaveTimerRef = useRef<number | null>(null);
  const pointerPositionRef = useRef<{ x: number; y: number } | null>(null);

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

  const isPointerOverPreview = useCallback(() => {
    const pointer = pointerPositionRef.current;
    if (!pointer) return false;

    const preview = document.querySelector('[data-memo-list-hover-preview]');
    const elementFromPoint = document.elementFromPoint?.(pointer.x, pointer.y);
    return Boolean(preview && elementFromPoint && preview.contains(elementFromPoint));
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
    if (navigationHoldRef.current) return;
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

  // The drawer is mounted outside the list column, so it cannot naturally
  // participate in the preview's mouseenter/mouseleave boundary. It should
  // never create a preview by itself, but it can keep an already-open preview
  // alive while the pointer is over the companion surface.
  const handleCompanionSurfaceEnter = useCallback(() => {
    if (!enabled || phaseRef.current === 'closed') return;
    handlePreviewEnter();
  }, [enabled, handlePreviewEnter]);

  const handleCompanionSurfaceLeave = useCallback(() => {
    if (!enabled) return;
    handlePreviewLeave();
  }, [enabled, handlePreviewLeave]);

  useEffect(() => {
    if (!enabled) return;

    const handlePointerMove = (event: PointerEvent) => {
      pointerPositionRef.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener('pointermove', handlePointerMove);
    return () => window.removeEventListener('pointermove', handlePointerMove);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;

    if (navigationDrawerPhase === 'closed') {
      if (!navigationHoldRef.current) return;
      navigationHoldRef.current = false;
      if (phaseRef.current !== 'open') return;

      // The drawer owns the closing transition. This effect runs only after
      // the shared layout phase reaches `closed`, so the list has already
      // finished moving left and can be hit-tested at its final position.
      clearOpenTimer();
      clearCloseTimers();
      if (isPointerOverPreview()) return;
      scheduleClose();
      return;
    }

    // A navigation drawer opened while the preview is closed should not
    // unexpectedly create a list preview. Only an existing preview can be
    // promoted to the paired/held state.
    if (phaseRef.current === 'closed') return;

    navigationHoldRef.current = true;
    clearOpenTimer();
    clearCloseTimers();
    if (phaseRef.current === 'closing') updatePhase('open');
  }, [
    clearCloseTimers,
    clearOpenTimer,
    enabled,
    isPointerOverPreview,
    navigationDrawerPhase,
    phase,
    scheduleClose,
    updatePhase,
  ]);

  useEffect(() => {
    if (enabled) return;
    navigationHoldRef.current = false;
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
    handleCompanionSurfaceEnter,
    handleCompanionSurfaceLeave,
  };
}
