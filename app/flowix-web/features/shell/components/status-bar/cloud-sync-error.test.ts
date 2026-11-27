import { describe, expect, it } from 'vitest';
import { cloudSyncFailureKey } from './cloud-sync-error';

describe('cloudSyncFailureKey', () => {
  it.each([
    ['CLOUD_DIRECTORY_LIST_FAILED: nb: cloud request failed: error sending request for url', 'network'],
    ['CLOUD_DIRECTORY_WRITE_FAILED: folder: cloud request failed: error sending request', 'network'],
    ['CLOUD_PATH_SYNC_PARTIAL: nb: 2 item(s) failed: cloud request failed: error sending request', 'partial'],
    ['CLOUD_NOTEBOOK_PATH_UNAVAILABLE: /notes', 'notebookPath'],
    ['CLOUD_DIRECTORY_STATE_WRITE_FAILED: nb: sync database error: disk full', 'local'],
    ['CLOUD_NOTEBOOK_SCAN_FAILED: nb: permission denied', 'local'],
    ['cloud API error 403 ACCESS_DENIED: denied', 'permission'],
    ['cloud API error 401 INVALID_REFRESH_TOKEN: expired', 'session'],
    ['cloud API error 402 STORAGE_QUOTA_EXCEEDED: full', 'quota'],
    ['notebook is not enabled for cloud sync', 'disabled'],
    ['CLOUD_SYNC_TIMEOUT: path sync made no progress', 'timeout'],
    ['unexpected error', 'body'],
  ])('classifies %s', (error, category) => {
    expect(cloudSyncFailureKey(error)).toBe(`cloudSync.failed.${category}`);
  });
});
