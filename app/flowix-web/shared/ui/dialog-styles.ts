import { cn } from '@/lib/utils';

// Shared modal appearance. Width and content layout belong to each dialog.
export const DIALOG_OVERLAY_CLASS = 'bg-white/65 backdrop-blur-[14px] dark:bg-black/45';
export const DIALOG_SURFACE_CLASS = 'rounded-[28px] border border-[var(--border-popup)] bg-[var(--card)] text-[var(--foreground)] shadow-[0_22px_70px_rgba(15,23,42,0.16)]';
export const DIALOG_HEADING_CLASS = 'text-xl font-semibold leading-tight tracking-[-0.025em]';
const DIALOG_BUTTON_FRAME_CLASS = 'rounded-full border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)] shadow-none transition-colors duration-150 hover:border-[color-mix(in_oklch,var(--border)_65%,var(--muted-foreground))] hover:text-[color-mix(in_oklch,var(--muted-foreground)_75%,var(--foreground))]';
export const DIALOG_CLOSE_CLASS = `inline-flex h-8 w-8 items-center justify-center p-0 ${DIALOG_BUTTON_FRAME_CLASS}`;
const DIALOG_ACTION_CLASS = 'h-[38px] min-h-[38px] rounded-[9px] px-[15px] text-sm disabled:cursor-not-allowed disabled:opacity-50';
const DIALOG_PRIMARY_ACTION_CLASS = 'border border-[var(--info)] bg-[var(--info)] font-semibold text-[var(--info-foreground)] shadow-none hover:bg-[var(--info)] hover:opacity-90';
const DIALOG_SECONDARY_ACTION_CLASS = 'border border-[var(--border)] bg-[var(--card)] font-medium text-[var(--muted-foreground)] shadow-none transition-colors duration-150 hover:border-[color-mix(in_oklch,var(--border)_65%,var(--muted-foreground))] hover:bg-[var(--card)] hover:text-[var(--foreground)] dark:bg-[var(--card)] dark:hover:bg-[var(--card)]';
const DIALOG_DESTRUCTIVE_ACTION_CLASS = 'border border-[var(--destructive)] bg-[var(--destructive)] font-semibold text-white shadow-none hover:bg-[var(--destructive)] hover:opacity-90 dark:bg-[var(--destructive)] dark:hover:bg-[var(--destructive)]';

export type DialogActionTone = 'info' | 'error' | 'secondary' | 'brand';

const DIALOG_ACTION_TONES: Record<DialogActionTone, string> = {
  info: DIALOG_PRIMARY_ACTION_CLASS,
  error: DIALOG_DESTRUCTIVE_ACTION_CLASS,
  secondary: DIALOG_SECONDARY_ACTION_CLASS,
  // Only notebook creation opts into brand color; ordinary confirmations use info.
  brand: 'border border-[var(--brand)] bg-[var(--brand)] font-semibold text-[var(--primary-foreground)] shadow-none hover:bg-[var(--brand)] hover:opacity-90',
};

export function dialogActionClasses(tone: DialogActionTone) {
  return cn(DIALOG_ACTION_CLASS, DIALOG_ACTION_TONES[tone]);
}
