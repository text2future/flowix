import { friendlyErrorMessage } from '@/lib/friendly-error-message';
import type { I18nKey, I18nParams } from '@/lib/i18n';

import { createLogger } from '@/lib/logger';
const logger = createLogger('platform/tauri/errors');
const FLOWIX_MEMBERSHIP_ERROR =
  /^\s*(?:Error:\s*)?cloud API error\s+(?:402|403)\s+MEMBERSHIP_REQUIRED\b/i;

/**
 * Tauri IPC 错误格式化。
 *
 * 不直接读 user-settings-store / 不内嵌 translate ── 那会让 platform 层反向依赖
 * features。改为接受调用方传入的 `t` (通常来自 useI18n), 由 features 层负责翻译。
 * platform 层只做错误码识别 + 文案键映射。
 */

export function tauriErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return String(error ?? '');
}

export function hasTauriErrorCode(error: unknown, code: string): boolean {
  if (error && typeof error === 'object' && 'code' in error) return error.code === code;
  return tauriErrorMessage(error).includes(code);
}

export function isInvalidRefreshTokenError(error: unknown): boolean {
  return hasTauriErrorCode(error, 'INVALID_REFRESH_TOKEN');
}

type Translate = (key: I18nKey, params?: I18nParams) => string;

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

export function cloudSyncErrorMessage(error: unknown, t: Translate, fallback: I18nKey = 'errors.friendly.service'): string {
  const message = tauriErrorMessage(error);
  if (hasTauriErrorCode(error, 'INVALID_CREDENTIALS')) return t('errors.friendly.loginFailed');
  if (isInvalidRefreshTokenError(error) || /cloud API error\s+401\b/i.test(message)) return t('errors.friendly.session');
  if (hasTauriErrorCode(error, 'MEMBERSHIP_ALREADY_ACTIVE')) {
    return t('preferences.cloud.member.alreadyActive');
  }
  if (hasTauriErrorCode(error, 'WECHAT_PAY_NOT_AVAILABLE')) {
    return t('billing.dialog.wechatUnavailable');
  }
  if (hasTauriErrorCode(error, 'STORAGE_PLAN_REQUIRED')) {
    return t('preferences.cloud.storagePlanRequired');
  }
  if (['CHECKOUT_IN_PROGRESS', 'CHECKOUT_CREATION_IN_PROGRESS', 'CHECKOUT_PAYMENT_PROCESSING'].some((code) => hasTauriErrorCode(error, code))) {
    return t('preferences.cloud.order.pendingCheckout');
  }
  if (hasTauriErrorCode(error, 'BILLING_RATE_LIMITED')) {
    return t('preferences.cloud.order.rateLimited');
  }
  if (hasTauriErrorCode(error, 'BILLING_RATE_LIMIT_NOT_CONFIGURED')) {
    return t('preferences.cloud.order.checkUnavailable');
  }
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
  return friendlyErrorMessage(error, t, fallback);
}

export function cloudModelAccessErrorMessage(error: unknown, t: Translate, fallback: I18nKey = 'errors.friendly.cloudConnect'): string {
  const message = tauriErrorMessage(error);
  if (message.includes('INSUFFICIENT_CREDITS')) return t('agent.error.insufficientCredits');
  if (message.includes('CLOUD_MODELS_DISABLED')) return t('agent.error.cloudModelsDisabled');
  if (message.includes('MODEL_NOT_FOUND')) return t('agent.error.cloudModelUnavailable');
  if (message.includes('MODEL_PRICING_NOT_CONFIGURED')) return t('agent.error.cloudPricingUnavailable');
  if (isInvalidRefreshTokenError(error) || /cloud API error\s+401\b/i.test(message)) return t('errors.friendly.session');
  if (!FLOWIX_MEMBERSHIP_ERROR.test(message)) return friendlyErrorMessage(error, t, fallback);

  logger.warn('cloudModelAccessError', { error });
  return t('agent.error.membershipRequired');
}

export function notebookCreateErrorMessage(error: unknown, t: Translate): string {
  if (hasTauriErrorCode(error, 'PATH_ALREADY_REGISTERED')) return t('preferences.error.pathAlreadyRegistered');
  if (hasTauriErrorCode(error, 'PATH_NOT_EMPTY')) return t('preferences.error.pathNotEmpty');
  if (hasTauriErrorCode(error, 'NOTEBOOK_ALREADY_REGISTERED')) return t('preferences.error.pathAlreadyRegistered');
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
