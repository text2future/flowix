import type { I18nKey, I18nParams } from '@/lib/i18n';

/**
 * Tauri IPC 错误格式化。
 *
 * 不直接读 user-settings-store / 不内嵌 translate ── 那会让 platform 层反向依赖
 * features。改为接受调用方传入的 `t` (通常来自 useI18n), 由 features 层负责翻译。
 * platform 层只做错误码识别 + 文案键映射。
 */

export function tauriErrorMessage(error: unknown): string {
  return String(error ?? '');
}

export function hasTauriErrorCode(error: unknown, code: string): boolean {
  return tauriErrorMessage(error).includes(code);
}

export function isInvalidRefreshTokenError(error: unknown): boolean {
  return hasTauriErrorCode(error, 'INVALID_REFRESH_TOKEN');
}

type Translate = (key: I18nKey, params?: I18nParams) => string;

interface NotebookTemplateFileFailure {
  path: string;
  reason: string;
}

function notebookTemplateFileFailure(error: unknown): NotebookTemplateFileFailure | null {
  const marker = 'NOTEBOOK_TEMPLATE_FILE_FAILED:';
  const message = tauriErrorMessage(error);
  const markerIndex = message.indexOf(marker);
  if (markerIndex < 0) return null;

  try {
    const details = JSON.parse(message.slice(markerIndex + marker.length)) as Partial<NotebookTemplateFileFailure>;
    if (typeof details.path !== 'string' || typeof details.reason !== 'string') return null;
    return { path: details.path, reason: details.reason };
  } catch {
    return null;
  }
}

function notebookTemplateFinalizeFailure(error: unknown): string | null {
  const marker = 'NOTEBOOK_TEMPLATE_FINALIZE_FAILED:';
  const message = tauriErrorMessage(error);
  const markerIndex = message.indexOf(marker);
  return markerIndex < 0 ? null : message.slice(markerIndex + marker.length).trim();
}

function formatBytes(value: unknown): string {
  const bytes = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function cloudErrorDetails(message: string): Record<string, unknown> {
  const separator = message.indexOf(':');
  if (separator < 0) return {};
  try {
    const parsed = JSON.parse(message.slice(separator + 1));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function cloudSyncErrorMessage(error: unknown, t: Translate): string {
  const message = tauriErrorMessage(error);
  if (message.includes('MEMBERSHIP_REQUIRED')) {
    return t('preferences.cloud.membershipRequired');
  }
  if (message.includes('STORAGE_QUOTA_EXCEEDED')) {
    const details = cloudErrorDetails(message);
    return t('preferences.cloud.quotaExceeded', {
      used: formatBytes(details.usedBytes),
      quota: formatBytes(details.quotaBytes),
      requested: formatBytes(details.requestedDeltaBytes),
    });
  }
  return message;
}

export function notebookCreateErrorMessage(error: unknown, t: Translate): string {
  const templateFailure = notebookTemplateFileFailure(error);
  if (templateFailure) {
    return t('notebook.template.fileFailed', {
      path: templateFailure.path,
      reason: templateFailure.reason,
    });
  }
  const finalizeFailure = notebookTemplateFinalizeFailure(error);
  if (finalizeFailure !== null) {
    return t('notebook.template.finalizeFailed', { reason: finalizeFailure });
  }
  if (hasTauriErrorCode(error, 'PATH_ALREADY_REGISTERED')) return t('preferences.error.pathAlreadyRegistered');
  if (hasTauriErrorCode(error, 'PATH_NOT_EMPTY')) return t('preferences.error.pathNotEmpty');
  if (hasTauriErrorCode(error, 'NOTEBOOK_ALREADY_REGISTERED')) return t('preferences.error.pathAlreadyRegistered');
  if (hasTauriErrorCode(error, 'NOTEBOOK_NOT_EMPTY')) return t('notebook.template.destinationNotEmpty');
  if (hasTauriErrorCode(error, 'PATH_MISSING')) return t('preferences.error.pathMissing');
  if (hasTauriErrorCode(error, 'INVALID_NAME')) return t('preferences.error.invalidName');
  if (hasTauriErrorCode(error, 'INVALID_PATH')) return t('preferences.error.invalidPath');
  if (hasTauriErrorCode(error, 'INDEX_WRITE_FAILED')) return t('preferences.error.indexWriteFailedCreate');
  return t('preferences.error.createFailed');
}

export function notebookDeleteErrorMessage(error: unknown, t: Translate): string {
  if (hasTauriErrorCode(error, 'NOTEBOOK_NOT_FOUND')) return t('preferences.error.notebookNotFound');
  if (hasTauriErrorCode(error, 'INDEX_WRITE_FAILED')) return t('preferences.error.indexWriteFailedDelete');
  return t('preferences.error.deleteFailed');
}
