/** Shared icon button styles for window titlebar actions. */
export const TITLEBAR_ICON_BUTTON_CLASS =
  'w-8 h-8 flex enabled:!cursor-pointer disabled:!cursor-not-allowed items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded-xl transition-colors bg-[color-mix(in_srgb,var(--bg-titlebar)_72%,transparent)] border border-[var(--border)]';

/** Frameless variant for titlebar actions that should blend into the bar. */
export const TITLEBAR_ICON_BUTTON_FRAMELESS_CLASS =
  'w-8 h-8 flex enabled:!cursor-pointer disabled:!cursor-not-allowed items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded-xl transition-colors';
