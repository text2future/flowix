import { translate, type AppLanguage, type I18nKey } from '@features/i18n';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';

export function tauriErrorMessage(error: unknown): string {
  return String(error ?? '');
}

export function hasTauriErrorCode(error: unknown, code: string): boolean {
  return tauriErrorMessage(error).includes(code);
}

function getLanguage(): AppLanguage {
  return useUserSettingsStore.getState().settings.language;
}

function tKey(key: I18nKey): string {
  return translate(getLanguage(), key);
}

export function notebookCreateErrorMessage(error: unknown): string {
  if (hasTauriErrorCode(error, 'PATH_ALREADY_REGISTERED')) return tKey('preferences.error.pathAlreadyRegistered');
  if (hasTauriErrorCode(error, 'PATH_MISSING')) return tKey('preferences.error.pathMissing');
  if (hasTauriErrorCode(error, 'INVALID_NAME')) return tKey('preferences.error.invalidName');
  if (hasTauriErrorCode(error, 'INVALID_PATH')) return tKey('preferences.error.invalidPath');
  if (hasTauriErrorCode(error, 'INDEX_WRITE_FAILED')) return tKey('preferences.error.indexWriteFailedCreate');
  return tKey('preferences.error.createFailed');
}

export function notebookDeleteErrorMessage(error: unknown): string {
  if (hasTauriErrorCode(error, 'NOTEBOOK_NOT_FOUND')) return tKey('preferences.error.notebookNotFound');
  if (hasTauriErrorCode(error, 'INDEX_WRITE_FAILED')) return tKey('preferences.error.indexWriteFailedDelete');
  return tKey('preferences.error.deleteFailed');
}
