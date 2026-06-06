'use client';

import { useCallback, useRef } from 'react';
import gsap from 'gsap';

const FLIP_DURATION = 0.3;
const ENTRANCE_DURATION = 0.3;
const FLIP_EASE = 'power3.out';
const ENTRANCE_EASE = 'power2.out';

const nextPaint = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Manages the FLIP-style "slide-in from left" animation for a newly inserted memo card.
 *
 * Flow:
 *   1. `captureSnapshot(newId)` — call BEFORE the new memo is added to the list.
 *   2. mutate the list / re-render.
 *   3. `animateInsert(snapshot, newId)` — call AFTER the DOM has updated.
 *
 * Existing cards slide to their new positions; the new card slides in from the left.
 * Respects `prefers-reduced-motion`.
 */
export function useMemoInsertAnimation() {
  const listContainerRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());

  const registerCard = useCallback((id: string) => (el: HTMLDivElement | null) => {
    if (el) cardRefs.current.set(id, el);
    else cardRefs.current.delete(id);
  }, []);

  const captureSnapshot = useCallback((excludeId: string) => {
    const snapshot = new Map<string, number>();
    cardRefs.current.forEach((el, id) => {
      if (id === excludeId) return;
      snapshot.set(id, el.getBoundingClientRect().top);
    });
    return snapshot;
  }, []);

  const animateInsert = useCallback(
    async (snapshot: Map<string, number>, newId: string) => {
      await nextPaint();
      if (prefersReducedMotion()) return;

      // FLIP: existing cards slide to their new positions
      cardRefs.current.forEach((el, id) => {
        const oldTop = snapshot.get(id);
        if (oldTop == null) return;
        const dy = oldTop - el.getBoundingClientRect().top;
        if (Math.abs(dy) < 1) return;
        gsap.killTweensOf(el);
        gsap.fromTo(el, { y: dy }, { y: 0, duration: FLIP_DURATION, ease: FLIP_EASE });
      });

      // Entrance: new card slides in from the left
      const newEl = cardRefs.current.get(newId);
      if (!newEl) return;

      newEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      gsap.killTweensOf(newEl);
      gsap.fromTo(
        newEl,
        { x: -newEl.offsetWidth },
        { x: 0, duration: ENTRANCE_DURATION, ease: ENTRANCE_EASE }
      );
    },
    []
  );

  return { listContainerRef, registerCard, captureSnapshot, animateInsert };
}
