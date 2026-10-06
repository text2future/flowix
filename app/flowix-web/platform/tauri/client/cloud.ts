import { invoke } from '@tauri-apps/api/core';
import { subscribe } from '@platform/tauri/event-bus';
import type { UnlistenFn } from '@tauri-apps/api/event';

export interface CloudUser {
  id: string;
  email: string;
  displayName: string;
  systemRole: string;
}

export interface CloudMembership {
  active: boolean;
  startsAt?: number | null;
  expiresAt?: number | null;
  usedBytes: number;
  quotaBytes: number;
  availableBytes: number;
  noteCount: number;
  readOnly: boolean;
}

export interface CloudState {
  authenticated: boolean;
  account?: {
    user: CloudUser;
    protocolEpoch: 2;
  } | null;
  membership?: CloudMembership | null;
  lastError?: string | null;
}

export interface CloudNotebookSyncState {
  notebookId: string;
  enabled: boolean;
  bootstrapRequired: boolean;
  updatedAt: number;
}

export interface CloudNotebook {
  id: string;
  name: string;
  icon?: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  synced: boolean;
  usedBytes: number;
}

export interface CloudSyncResult {
  notebooks: number;
  uploaded: number;
  deleted: number;
  downloaded: number;
  conflicts: number;
}

export type CloudSyncStatusState =
  | 'idle'
  | 'queued'
  | 'checking'
  | 'syncing'
  | 'finalizing'
  | 'success'
  | 'error'
  | 'offline';

export interface CloudSyncStatus {
  notebookId: string;
  runId: string;
  state: CloudSyncStatusState;
  phase: string;
  uploaded: number;
  deleted: number;
  downloaded: number;
  startedAt: number;
  finishedAt?: number | null;
  lastError?: string | null;
}

export interface CloudProduct {
  id: string;
  name: string;
  description: string;
  price: { amount: number; currency: string };
  entitlement: {
    storageBytes: number;
    duration: { unit: string; count: number };
    features: Record<string, unknown>;
  };
}

export interface CloudCheckout {
  orderId: string;
  status: string;
  checkoutUrl: string;
  expiresAt?: number | null;
}

export interface CloudNoteHistory {
  noteId: string;
  notebookId: string;
  currentRevision: string;
  revisions: Array<{
    revision: string;
    deleted: boolean;
    relativePath: string | null;
    contentHash: string | null;
    sizeBytes: number;
    syncSeq: number;
    createdAt: number;
  }>;
}

export const cloud = {
  getState: () => invoke<CloudState>('cloud_get_state'),
  register: (email: string, password: string, displayName: string) =>
    invoke<CloudState>('cloud_register', { email, password, displayName }),
  login: (email: string, password: string) =>
    invoke<CloudState>('cloud_login', { email, password }),
  signInWithApple: () => invoke<CloudState>('cloud_sign_in_with_apple'),
  startGoogleSignIn: () => invoke<void>('cloud_start_google_sign_in'),
  linkApple: () => invoke<CloudState>('cloud_link_apple'),
  logout: () => invoke<CloudState>('cloud_logout'),
  getNotebookState: (notebookId: string) =>
    invoke<CloudNotebookSyncState | null>('cloud_get_notebook_state', { notebookId }),
  listNotebookStates: () =>
    invoke<CloudNotebookSyncState[]>('cloud_list_notebook_states'),
  listPendingFileOperationCounts: () =>
    invoke<Record<string, number>>('cloud_list_pending_file_operation_counts'),
  listNotebooks: () => invoke<CloudNotebook[]>('cloud_list_notebooks'),
  linkNotebook: (notebookId: string, cloudNotebookId: string) =>
    invoke<CloudNotebookSyncState>('cloud_link_notebook', { notebookId, cloudNotebookId }),
  setNotebookEnabled: (notebookId: string, enabled: boolean) =>
    invoke<CloudNotebookSyncState>('cloud_set_notebook_enabled', { notebookId, enabled }),
  refreshMembership: () =>
    invoke<CloudMembership>('cloud_refresh_membership'),
  listProducts: () => invoke<CloudProduct[]>('cloud_list_products'),
  createCheckout: (productId: string) =>
    invoke<CloudCheckout>('cloud_create_checkout', { productId }),
  syncNow: (notebookId?: string) =>
    invoke<CloudSyncResult>('cloud_sync_now', { notebookId }),
  noteHistory: (notebookId: string, relativePath: string) =>
    invoke<CloudNoteHistory>('cloud_note_history', { notebookId, relativePath }),
  previewNoteRevision: (notebookId: string, relativePath: string, revision: string) =>
    invoke<string>('cloud_preview_note_revision', { notebookId, relativePath, revision }),
  restoreNoteRevision: (notebookId: string, relativePath: string, revision: string) =>
    invoke<void>('cloud_restore_note_revision', { notebookId, relativePath, revision }),
  listConflicts: (notebookId: string) =>
    invoke<string[]>('cloud_list_conflicts', { notebookId }),
  resolveMarkdownConflict: (notebookId: string, relativePath: string, conflictPath: string, useLocal: boolean) =>
    invoke<void>('cloud_resolve_markdown_conflict', { notebookId, relativePath, conflictPath, useLocal }),
  resolveAttachmentConflict: (notebookId: string, relativePath: string, conflictPath: string, useLocal: boolean) =>
    invoke<void>('cloud_resolve_attachment_conflict', { notebookId, relativePath, conflictPath, useLocal }),
};

export function listenToCloudStateChanges(
  handler: (state: CloudState) => void,
): UnlistenFn {
  return subscribe<CloudState>('cloud-state-changed', handler);
}

export function listenToCloudSyncStatusChanges(
  handler: (status: CloudSyncStatus) => void,
): UnlistenFn {
  return subscribe<CloudSyncStatus>('cloud-sync-status-changed', handler);
}

// Files
