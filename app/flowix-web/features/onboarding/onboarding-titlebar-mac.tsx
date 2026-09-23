'use client';

/**
 * macOS drag strip for the first-run onboarding overlay.
 *
 * Design rules:
 * - Onboarding is a `position: fixed; inset: 0` layer (`styles/onboarding.css`)
 *   that covers the whole window, so nothing underneath can be grabbed to move
 *   the window. macOS uses `titleBarStyle(Overlay)` + `hiddenTitle(true)`
 *   (see `app/flowix-desktop/tauri.conf.json`), which means Tauri renders no
 *   chrome of its own — dragging only works on elements explicitly marked with
 *   `data-tauri-drag-region`.
 * - `<WindowsTitlebarControls />` returns `null` on macOS, so the overlay would
 *   otherwise expose no drag region at all. This component supplies it.
 * - `h-12` (48px) matches every other macOS title bar in the app
 *   (`memo-list-titlebar-mac`, `document-titlebar-mac`, `preferences-titlebar-mac`).
 * - The strip is intentionally empty and spans the full width, including the
 *   traffic-light cluster, which Rust pins at (x=15, y=25). Tauri treats the
 *   whole area as draggable, and there is no onboarding content at this height
 *   (`__main` starts below it), so nothing needs to reserve space for the lights.
 * - `aria-hidden` because the strip is a pure hit-target with no semantics.
 */
export function OnboardingTitlebarMac() {
  return (
    <div
      data-tauri-drag-region
      aria-hidden="true"
      className="flowix-onboarding__titlebar-mac"
    />
  );
}
