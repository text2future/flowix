import type { I18nKey } from '@/lib/i18n';

/** A partial pass may contain several unrelated errors, so it takes precedence. */
export function cloudSyncFailureKey(error: string): I18nKey {
  if (error.startsWith('CLOUD_PATH_SYNC_PARTIAL:')) return 'cloudSync.failed.partial';
  if (error.startsWith('CLOUD_NOTEBOOK_PATH_UNAVAILABLE:')) return 'cloudSync.failed.notebookPath';
  if (/^CLOUD_(?:NOTEBOOK_(?:CONFIG_READ|METADATA_READ|SCAN|SCAN_TASK)|DIRECTORY_(?:STATE_READ|STATE_WRITE|CREATE|REMOVE))_FAILED:/.test(error)
    || error.includes('sync database error:') || error.includes('local file error for ')) return 'cloudSync.failed.local';
  if (/STORAGE_QUOTA_EXCEEDED|cloud API error\s+402\b/i.test(error)) return 'cloudSync.failed.quota';
  if (/not authenticated|INVALID_REFRESH_TOKEN|cloud API error\s+401\b/i.test(error)) return 'cloudSync.failed.session';
  if (/notebook is not enabled for cloud sync/i.test(error)) return 'cloudSync.failed.disabled';
  if (/cloud API error\s+403\b/i.test(error)) return 'cloudSync.failed.permission';
  if (/CLOUD_SYNC_TIMEOUT|\b(?:ETIMEDOUT|TIMED_OUT)\b|timed? out/i.test(error)) return 'cloudSync.failed.timeout';
  if (/cloud request failed:|error sending request|network unavailable/i.test(error)) return 'cloudSync.failed.network';
  return 'cloudSync.failed.body';
}
