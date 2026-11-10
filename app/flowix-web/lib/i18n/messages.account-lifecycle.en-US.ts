import type zhCN from './messages.account-lifecycle.zh-CN';

/**
 * English counterpart of the account-lifecycle message shard. The type
 * annotation keeps its key set aligned with the zh-CN shard at compile time.
 */
const enUS: Record<keyof typeof zhCN, string> = {
  "preferences.cloud.export": "Export data",
  "preferences.cloud.exporting": "Preparing…",
  "preferences.cloud.exportSuccess": "Data exported",
  "preferences.cloud.exportFailed": "Export failed. Please try again.",
  "preferences.cloud.exportDialogTitle": "Export account data",
  "preferences.cloud.restored": "Your account has been restored. Welcome back.",

  "preferences.cloud.deletion.title": "Delete account",
  "preferences.cloud.deletion.intro":
    "You are signed out immediately and the cloud data is erased after {days} days. Signing in again before then restores the account.",
  "preferences.cloud.deletion.deadline": "Restorable until {date}",
  "preferences.cloud.deletion.localNote":
    "Local note files are not deleted, but they stop syncing; registering the same address again will not upload the old data.",
  "preferences.cloud.deletion.emailLabel": "Type the account email {email} to confirm",
  "preferences.cloud.deletion.emailPlaceholder": "Account email",
  "preferences.cloud.deletion.mismatch": "The email does not match",
  "preferences.cloud.deletion.confirm": "Delete account",
  "preferences.cloud.deletion.deleting": "Deleting…",
  "preferences.cloud.deletion.done": "Account deleted. Sign in before {date} to restore it.",
  "preferences.cloud.deletion.doneNoDeadline": "Account deleted",
  "preferences.cloud.deletion.pendingCancellations":
    "These subscriptions could not be cancelled at the payment provider. Please cancel them manually: {ids}",
  "preferences.cloud.deletion.exportFirst": "Export my data first",
  "preferences.cloud.deletion.loadFailed": "Could not read the account state. Please try again.",
};

export default enUS;
