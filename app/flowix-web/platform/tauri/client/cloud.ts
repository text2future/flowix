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
  aiActive?: boolean | null;
  aiGrantExpiresAt?: number | null;
  aiGrantDurationUnit?: string | null;
  aiGrantDurationCount?: number | null;
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
  usageObservedAt?: number | null;
  usageReadStatus?: 'unknown' | 'ok' | 'error' | null;
  usageSource?: 'ledger' | 'object_store' | null;
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
  } | null;
  membership?: CloudMembership | null;
  membershipStatus?: 'unknown' | 'refreshing' | 'verified' | 'error';
  membershipError?: string | null;
  syncAccess?: CloudSyncAccess;
  /** This session revived a deleted account inside its grace window. */
  restored?: boolean;
}

/** Capabilities of the currently selected sync backend, independent of login. */
export interface CloudStorageAccess {
  target: 'official' | 'customS3';
  /** Named custom Remote bound to the running process at startup. */
  profileId?: string;
  configured: boolean;
  canRead: boolean;
  canUpload: boolean;
  canDelete: boolean;
}

export type CloudStorageTarget =
  | { type: 'official' }
  | { type: 'customS3'; profileId: string };

export interface CloudStorageProfile {
  id: string;
  remote: { endpoint: string; region: string; bucket: string; prefix: string };
}

export interface CloudStorageSettings {
  activeTarget: CloudStorageTarget;
  profiles: CloudStorageProfile[];
}

export interface CloudNoteShareLink {
  url: string;
  expiresAt: number;
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

export interface RegistrationCodeRequest {
  verificationRequired: boolean;
  email: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

export interface RegistrationCodeResend {
  requested: boolean;
  expiresInSeconds?: number | null;
  resendAfterSeconds?: number | null;
}

export interface PasswordResetCodeRequest {
  requested: boolean;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

export interface CloudNotebookSyncState {
  notebookId: string;
  enabled: boolean;
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
  progressCompleted?: number | null;
  progressTotal?: number | null;
  startedAt: number;
  finishedAt?: number | null;
  lastError?: string | null;
  /**
   * Which engine produced these numbers: `indexed` is the epoch-3 protocol,
   * `path` the path-keyed one. Absent when only the indexed engine ran.
   */
  engine?: 'indexed' | 'path' | null;
  /**
   * The path engine accepted writes. `false` means the account is over quota or
   * its membership lapsed: downloads still happen, publishes wait for renewal.
   */
  writable?: boolean | null;
  /**
   * The path engine was allowed to delete. `false` during the window after a
   * fresh bind, after a bucket change, or when the server clock is untrusted.
   */
  allowsDeletes?: boolean | null;
  deletionDeferred?: boolean | null;
  /**
   * Paths a pass held back because applying the batch would delete this
   * device's copies (the cloud already recorded the deletions). Non-zero means
   * the user has to answer before those files go away.
   */
  massDeletionLocal?: number | null;
  /** Paths held back because applying the batch would delete the cloud copies. */
  massDeletionRemote?: number | null;
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
  qrCodeSvg?: string | null;
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
  getStorageAccess: () => invoke<CloudStorageAccess>('cloud_get_storage_access'),
  getStorageConfig: () => invoke<CloudStorageSettings>('cloud_get_storage_config'),
  selectStorageTarget: (target: CloudStorageTarget) =>
    invoke<CloudStorageSettings>('cloud_select_storage_target', { target }),
  deleteCustomS3Profile: (profileId: string) =>
    invoke<CloudStorageSettings>('cloud_delete_custom_s3_profile', { profileId }),
  checkCustomS3: (input: CustomS3Input) => invoke<void>('cloud_check_custom_s3', { input }),
  saveCustomS3Profile: (input: CustomS3ProfileInput) =>
    invoke<CloudStorageSettings>('cloud_save_custom_s3_profile', { input }),
  getState: () => invoke<CloudState>('cloud_get_state'),
  updateAccountRegion: (region: CloudUser['region']) =>
    invoke<CloudState>('cloud_update_account_region', { region }),
  requestPasswordResetCode: (email: string, emailLanguage: 'zh-CN' | 'en-US') =>
    invoke<PasswordResetCodeRequest>('cloud_request_password_reset_code', { email, emailLanguage }),
  confirmPasswordResetCode: (email: string, code: string, newPassword: string) =>
    invoke<void>('cloud_confirm_password_reset_code', { email, code, newPassword }),
  requestRegistrationCode: (email: string, password: string, displayName: string, emailLanguage: 'zh-CN' | 'en-US') =>
    invoke<RegistrationCodeRequest>('cloud_request_registration_code', { email, password, displayName, emailLanguage }),
  resendRegistrationCode: (email: string) =>
    invoke<RegistrationCodeResend>('cloud_resend_registration_code', { email }),
  confirmRegistration: (email: string, code: string, password: string) =>
    invoke<CloudState>('cloud_confirm_registration', { email, code, password }),
  login: (email: string, password: string, restoreDeleted = false) =>
    invoke<CloudState>('cloud_login', { email, password, restoreDeleted }),
  /** Where the account stands in its deletion window, with the real deadline. */
  accountDeletion: () => invoke<AccountDeletionState>('cloud_account_deletion'),
  /** Full server-side export document, written to disk as JSON. */
  exportAccount: () => invoke<Record<string, unknown>>('cloud_export_account'),
  /** Irreversible: starts the deletion clock and clears this account locally. */
  deleteAccount: (confirmEmail: string) =>
    invoke<AccountDeletionOutcome>('cloud_delete_account', { confirmEmail }),
  signInWithApple: (accountRegion: 'mainland' | 'non_mainland') =>
    invoke<CloudState>('cloud_sign_in_with_apple', { accountRegion }),
  startGoogleSignIn: (accountRegion: 'mainland' | 'non_mainland') =>
    invoke<void>('cloud_start_google_sign_in', { accountRegion }),
  linkApple: () => invoke<CloudState>('cloud_link_apple'),
  logout: () => invoke<CloudState>('cloud_logout'),
  getNotebookState: (notebookId: string) =>
    invoke<CloudNotebookSyncState | null>('cloud_get_notebook_state', { notebookId }),
  listNotebookStates: () =>
    invoke<CloudNotebookSyncState[]>('cloud_list_notebook_states'),
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
    id: string; title?: string; subtitle?: string; creditMultiplier?: number; iconUrl?: string; providerIconUrl?: string;
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
  /**
   * Answers the bulk-deletion prompt. `restore` means "undo": the deletion is
   * dropped and the files come back from whichever side still has them.
   */
  resolveMassDeletion: (notebookId: string, restore: boolean) =>
    invoke<void>('cloud_resolve_mass_deletion', { notebookId, restore }),
  createNoteShareLink: (notebookId: string, relativePath: string) =>
    invoke<CloudNoteShareLink>('cloud_create_note_share_link', { notebookId, relativePath }),
  createFolderShareLink: (notebookId: string, relativePath: string) =>
    invoke<CloudNoteShareLink>('cloud_create_folder_share_link', { notebookId, relativePath }),
};

export interface CustomS3Input {
  remote: { endpoint: string; region: string; bucket: string; prefix: string };
  profileId?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface CustomS3ProfileInput {
  profile: CloudStorageProfile;
  accessKeyId: string;
  secretAccessKey: string;
}

export function listenToCloudStateChanges(
  handler: (state: CloudState) => void,
  options?: SubscribeOptions,
): UnlistenFn {
  return subscribe<CloudState>('cloud-state-changed', handler, options);
}

export function listenToCloudStorageAccessChanges(handler: () => void): UnlistenFn {
  return subscribe<void>('cloud-storage-access-changed', handler);
}

export function listenToCloudSyncStatusChanges(
  handler: (status: CloudSyncStatus) => void,
): UnlistenFn {
  return subscribe<CloudSyncStatus>('cloud-sync-status-changed', handler);
}

export function listenToCloudDeleteConflictRestored(
  handler: (event: { notebookId: string; paths: string[] }) => void,
): UnlistenFn {
  return subscribe('cloud-delete-conflict-restored', handler);
}

// Files
