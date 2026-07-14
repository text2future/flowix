import type { ActionDefinition } from '@features/shortcuts';
import type { I18nKey } from '@features/i18n';

type Translate = (key: I18nKey) => string;

const GROUP_KEY_BY_ID: Record<string, I18nKey> = {
  editor: 'preferences.shortcuts.group.editor',
  navigation: 'preferences.shortcuts.group.navigation',
  view: 'preferences.shortcuts.group.view',
  system: 'preferences.shortcuts.group.system',
  memo: 'preferences.shortcuts.group.memo',
};

export function getShortcutGroupLabel(group: string, t: Translate): string {
  const key = GROUP_KEY_BY_ID[group];
  return key ? t(key) : group;
}

export function getShortcutActionTitle(
  action: Pick<ActionDefinition, 'titleKey'>,
  t: Translate,
): string {
  return t(action.titleKey);
}

export function getShortcutActionDescription(
  action: Pick<ActionDefinition, 'descriptionKey'>,
  t: Translate,
): string | undefined {
  return action.descriptionKey ? t(action.descriptionKey) : undefined;
}
