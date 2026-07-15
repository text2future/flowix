import '@/lib/memo-dispatcher';

/**
 * Legacy hook-shaped entrypoint for installing memo-event handling.
 *
 * The preferences window no longer mounts this. The main window installs the
 * dispatcher from app/main-window-effects.tsx so preferences startup stays
 * lightweight. Keep this hook for older feature code that still imports it as
 * the memo-event setup API.
 */
export function useMemoEvents(): void {
  /* Module import above performs the setup. */
}
