import type { NoteColor } from '@/types/note-item';

export const COLOR_LABEL_KEYS: Record<NoteColor, import('@/lib/i18n').I18nKey> = {
  red: 'document.color.red',
  orange: 'document.color.orange',
  yellow: 'document.color.yellow',
  green: 'document.color.green',
  cyan: 'document.color.cyan',
  blue: 'document.color.blue',
  gray: 'document.color.gray',
};
