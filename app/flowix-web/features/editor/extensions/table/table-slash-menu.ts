import { TableIcon } from '@phosphor-icons/react';
import { translate, type AppLanguage } from '@/lib/i18n';
import type { SlashMenuItem } from '@features/editor/components/slash-menu-dropdown';
import { TABLE_TEMPLATE_OPTIONS } from './table-templates';

/** Keep search and insertion on the same template registry as the toolbar. */
export function getTableSlashMenuItems(query: string, language: AppLanguage): SlashMenuItem[] {
  const normalized = query.trim().toLowerCase();
  return TABLE_TEMPLATE_OPTIONS.filter(option => [
    option.styleId,
    translate(language, option.labelKey),
    ...option.keywords,
  ].join(' ').toLowerCase().includes(normalized)).map(option => ({
    id: `table-style-${option.styleId}`,
    tableStyle: option.styleId,
    labelKey: option.labelKey,
    keywords: [...option.keywords],
    icon: TableIcon,
  }));
}
