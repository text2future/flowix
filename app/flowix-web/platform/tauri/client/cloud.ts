import type { CloudSyncAccess } from '@/lib/cloud-account';
import { invoke } from '@tauri-apps/api/core';
import { subscribe, type SubscribeOptions } from '@platform/tauri/event-bus';
import type { UnlistenFn } from '@tauri-apps/api/event';

export interface CloudUser {
  id: string;
  email: string;
  displayName: string;
  region: 'mainland' | 'non_mainland';
}

export interface CloudMembership {
  active: boolean;
  startsAt?: number | null;
  expiresAt?: number | null;
  features?: Record<string, unknown>;
  storageExpiresAt?: number | null;
  usedBytes: number;
  quotaBytes: number;
  availableBytes: number;
  noteCount: number;
  readOnly: boolean;
}

export interface CloudAiCreditBalance {
  balanceMicrocredits: number;
  monthlyBalanceMicrocredits: number;
  permanentBalanceMicrocredits: number;
  monthlyExpiresAt: number | null;
}

export interface CloudState {
  revision: number;
  authenticated: boolean;
  authStatus: 'signed_out' | 'restoring' | 'authenticated';
  authError?: string | null;
  account?: {
    user: CloudUser;
    protocolEpoch: 3;
  } | null;
  membership?: CloudMembership | null;
  membershipStatus?: 'unknown' | 'refreshing' | 'verified' | 'error';
  membershipError?: string | null;
  syncAccess?: CloudSyncAccess;
  /** This session revived a deleted account inside its grace window. */
  restored?: boolean;
}

/** Server-owned deletion lifecycle; the client never hardcodes the grace period. */
export interface AccountDeletionState {
  state: 'active' | 'restorable' | 'purged' | 'suspended';
  restorableUntil: number | null;
  graceDays: number;
  deletedAt?: number | null;
}

export interface AccountDeletionOutcome {
  state: string;
  restorableUntil: number | null;
  /**
   * Subscriptions a payment provider refused to cancel. The account is gone
   * either way, so these must be surfaced instead of silently dropped.
   */
  pendingSubscriptionCancellations: string[];
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
  billingType?: 'subscription' | 'one_time';
  /** Older cached catalog entries may not include region metadata. */
  marketRegion?: 'mainland' | 'non_mainland';
  /** The two entitlement kinds. Absent in catalogs cached before the split. */
  entitlementKind?: 'storage' | 'ai';
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

export interface CloudOrder {
  id: string;
  productId: string;
  productName: string;
  amount: number;
  currency: string;
  status: string;
  createdAt: number;
  paidAt?: number | null;
}

export interface CloudSubscription {
  id: string;
  status: string;
  productId?: string | null;
  productName?: string | null;
  currentPeriodEnd?: number | null;
  cancelAtPeriodEnd: boolean;
  isAnnualMembership: boolean;
}

export interface CloudOrderCheck {
  status: string;
  confirmed: boolean;
  checkStatus: string;
}

export interface CloudFeedbackAttachment {
  filename: string;
  contentType: string;
  dataBase64: string;
}

export const cloud = {
  getState: () => invoke<CloudState>('cloud_get_state'),
  register: (email: string, password: string, displayName: string) =>
    invoke<CloudState>('cloud_register', { email, password, displayName }),
  login: (email: string, password: string, restoreDeleted = false) =>
    invoke<CloudState>('cloud_login', { email, password, restoreDeleted }),
  /** Where the account stands in its deletion window, with the real deadline. */
  accountDeletion: () => invoke<AccountDeletionState>('cloud_account_deletion'),
  /** Full server-side export document, written to disk as JSON. */
  exportAccount: () => invoke<Record<string, unknown>>('cloud_export_account'),
  /** Irreversible: starts the deletion clock and clears this account locally. */
  deleteAccount: (confirmEmail: string) =>
    invoke<AccountDeletionOutcome>('cloud_delete_account', { confirmEmail }),
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
  getAiCreditBalance: () =>
    invoke<CloudAiCreditBalance>('cloud_ai_credit_balance'),
  piModelCatalog: () => invoke<{ data: { models: Array<{
    id: string; title?: string; subtitle?: string; creditMultiplier?: number; providerIconUrl?: string;
    sortOrder?: number;
  }> } }>('cloud_pi_model_catalog'),
  piModelAvailability: () => invoke<boolean>('cloud_pi_model_availability'),
  refreshPiModelProvider: () => invoke<boolean>('cloud_refresh_pi_model_provider'),
  refreshPiModelProviderAtStartup: () =>
    invoke<boolean>('cloud_refresh_pi_model_provider_at_startup'),
  listProducts: (region: CloudUser['region'] = 'non_mainland') =>
    invoke<CloudProduct[]>('cloud_list_products', { region }),
  listBillingOrders: () => invoke<CloudOrder[]>('cloud_list_billing_orders'),
  listSubscriptions: () => invoke<CloudSubscription[]>('cloud_list_subscriptions'),
  cancelSubscription: (subscriptionId: string) =>
    invoke<void>('cloud_cancel_subscription', { subscriptionId }),
  checkBillingOrder: (orderId: string) =>
    invoke<CloudOrderCheck>('cloud_check_billing_order', { orderId }),
  createCheckout: (productId: string) =>
    invoke<CloudCheckout>('cloud_create_checkout', { productId }),
  submitFeedback: (
    deviceId: string,
    kind: 'product_suggestion' | 'usage_issue',
    content: string,
    appVersion: string,
    platform: string,
    attachments: CloudFeedbackAttachment[],
  ) => invoke<void>('cloud_submit_feedback', { deviceId, kind, content, appVersion, platform, attachments }),
  syncNow: (notebookId?: string) =>
    invoke<CloudSyncResult>('cloud_sync_now', { notebookId }),
  listConflicts: (notebookId: string) =>
    invoke<string[]>('cloud_list_conflicts', { notebookId }),
  resolveMarkdownConflict: (notebookId: string, relativePath: string, conflictPath: string, useLocal: boolean) =>
    invoke<void>('cloud_resolve_markdown_conflict', { notebookId, relativePath, conflictPath, useLocal }),
  resolveAttachmentConflict: (notebookId: string, relativePath: string, conflictPath: string, useLocal: boolean) =>
    invoke<void>('cloud_resolve_attachment_conflict', { notebookId, relativePath, conflictPath, useLocal }),
};

export function listenToCloudStateChanges(
  handler: (state: CloudState) => void,
  options?: SubscribeOptions,
): UnlistenFn {
  return subscribe<CloudState>('cloud-state-changed', handler, options);
}

export function listenToCloudSyncStatusChanges(
  handler: (status: CloudSyncStatus) => void,
): UnlistenFn {
  return subscribe<CloudSyncStatus>('cloud-sync-status-changed', handler);
}

// Files
