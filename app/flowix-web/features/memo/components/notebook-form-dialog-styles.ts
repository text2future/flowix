import { DIALOG_HEADING_CLASS, DIALOG_OVERLAY_CLASS, DIALOG_SURFACE_CLASS } from '@shared/ui/dialog-styles';

export const NOTEBOOK_FORM_DIALOG_CONTENT_CLASS = [
  'max-h-[calc(100dvh-2rem)] w-[min(576px,calc(90vw-1.8rem))] max-w-none',
  'overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
  DIALOG_SURFACE_CLASS,
  'p-0',
  '[&>button]:top-5 [&>button]:right-5',
].join(' ');

export const NOTEBOOK_FORM_DIALOG_BODY_CLASS = 'relative z-[1] w-full px-5 py-6';

export const NOTEBOOK_FORM_DIALOG_OVERLAY_CLASS = DIALOG_OVERLAY_CLASS;

export const NOTEBOOK_DELETE_DIALOG_WIDTH_CLASS = 'w-[min(380px,calc(90vw-1.8rem))]';

export const NOTEBOOK_FORM_DIALOG_HEADING_CLASS = DIALOG_HEADING_CLASS;

export const NOTEBOOK_FORM_DIALOG_TITLE_CLASS = `${NOTEBOOK_FORM_DIALOG_HEADING_CLASS} mb-3 pr-10 text-[var(--onboarding-ink)]`;
