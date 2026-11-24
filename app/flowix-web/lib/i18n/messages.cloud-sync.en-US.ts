import type zhCN from './messages.cloud-sync.zh-CN';

/**
 * English counterpart of the cloud-sync message shard. The type annotation keeps
 * its key set aligned with the zh-CN shard at compile time.
 */
const enUS: Record<keyof typeof zhCN, string> = {
  "cloudSync.tabs.storage": "Cloud storage",
  "cloudSync.storage.title": "Storage plan",
  "cloudSync.custom.title": "Use your own cloud storage (S3)",
  "cloudSync.custom.description": "Enter the S3-compatible service address, region, bucket, path prefix, and access keys. Keys are securely stored on this device for local use. Save and select the profile, then restart the app to switch storage.",
  "cloudSync.custom.endpoint": "Endpoint",
  "cloudSync.custom.endpointHint": "Enter the service root without a bucket or path.",
  "cloudSync.custom.insecureEndpointWarning": "HTTP does not encrypt access keys or request contents. Use HTTPS except for trusted local environments.",
  "cloudSync.custom.region": "Region",
  "cloudSync.custom.bucket": "Name (Bucket)",
  "cloudSync.custom.prefix": "Storage subpath",
  "cloudSync.custom.accessKey": "Access Key ID",
  "cloudSync.custom.secretKey": "Secret Access Key",
  "cloudSync.custom.check": "Check read access",
  "cloudSync.custom.save": "Save settings",
  "cloudSync.custom.checked": "Read access verified",
  "cloudSync.custom.saved": "Saved. Restart the app to apply.",
  "cloudSync.custom.savedOnly": "Profile saved.",
  "cloudSync.custom.failed": "Could not complete the request. Check your settings and storage permissions.",
  "cloudSync.custom.readAccessFailed": "Could not verify read access. Check the endpoint, region, bucket, and prefix, and make sure the keys can list objects at that path.",
  "cloudSync.custom.readAccessDenied": "The storage service denied the read request. Grant the keys permission to list objects in the configured bucket and prefix.",
  "cloudSync.custom.credentialsPairRequired": "Enter both the Access Key ID and Secret Access Key, or leave both blank to use the saved keys.",
  "cloudSync.custom.credentialsRequired": "A new profile requires both the Access Key ID and Secret Access Key.",
  "cloudSync.custom.requiredFields": "The bucket, region, and both keys are required.",
  "cloudSync.custom.invalidEndpoint": "Use an HTTP(S) service root without a path, query, or credentials, for example https://s3.example.com.",
  "cloudSync.custom.invalidPrefix": "The dedicated prefix must not be empty or contain empty, . or .. path segments.",
  "cloudSync.custom.reenterCredentials": "The endpoint or storage scope changed. Enter both keys again before checking or saving.",
  "cloudSync.custom.savedCredentialsUnavailable": "Could not read the keys saved on this device. Enter both keys again.",
  "cloudSync.custom.duplicateProfileName": "A profile already uses this name. Choose a different name.",
  "cloudSync.custom.loginToUseOfficial": "Sign in and activate cloud storage to use Flowix official storage",
  "cloudSync.custom.noStoragePermission": "The signed-in account {email} has no cloud storage access. Upgrade and try again",
  "cloudSync.custom.usingOfficialAccount": "Using the {email} account for cloud storage",
  "cloudSync.custom.checkingAccount": "Checking account cloud storage access…",
  "cloudSync.custom.accountCheckFailed": "Could not confirm this account's cloud storage access. Try again later",
  "cloudSync.custom.active": "Active sync target: custom S3 storage",
  "cloudSync.custom.restartRequired": "The startup target changed. Restart the app to switch the storage used by this run.",
  "cloudSync.custom.targetAlreadyRunning": "Startup target saved. This run is already using that target.",
  "cloudSync.custom.credentialsUnavailable": "Custom storage credentials are unavailable. Save the settings again, then restart the app.",
  "cloudSync.custom.official": "Flowix official cloud storage",
  "cloudSync.custom.officialDescription": "Sign in with a Flowix account and use cloud storage under your plan.",
  "cloudSync.custom.useOwnStorage": "Use your own cloud storage (S3)",
  "cloudSync.custom.useTarget": "Select",
  "cloudSync.custom.edit": "Edit",
  "cloudSync.custom.delete": "Delete",
  "cloudSync.custom.editProfile": "Edit storage profile",
  "cloudSync.custom.addProfile": "Add profile",
  "cloudSync.custom.collapse": "Collapse",
  "cloudSync.custom.credentialsHint": "Leave both fields blank to keep saved keys. After changing the endpoint, region, bucket, or prefix, enter both keys again.",
  "cloudSync.custom.confirmDelete": "Delete this storage profile and its locally stored credentials?",
  "cloudSync.readOnly.badge": "Local only",
  "cloudSync.readOnly.title": "Cloud sync paused",
  "cloudSync.readOnly.body":
    "Your cloud storage is full, so new changes stay on this device. Uploading resumes once you free up space or upgrade.",
  "cloudSync.deletesPaused.badge": "Deletes paused",
  "cloudSync.deletesPaused.title": "Deletions are paused",
  "cloudSync.deletesPaused.body":
    "Some deletions are held back by a safety check to prevent accidental data loss. Uploads and downloads are unaffected.",
  "cloudSync.massDeletion.title": "A large number of documents were deleted. Continue syncing?",
  "cloudSync.massDeletion.bodyLocal":
    "The cloud already deleted {count} documents. Continuing also deletes these copies on this device.",
  "cloudSync.massDeletion.bodyRemote":
    "{count} documents were deleted on this device. Continuing also deletes the cloud copies.",
  "cloudSync.massDeletion.bodyBoth":
    "{count} documents disagree between this device and the cloud (one side deleted them). Continuing applies the deletion.",
  "cloudSync.massDeletion.warning": "Once confirmed, deleted content cannot be recovered",
  "cloudSync.massDeletion.confirm": "Confirm",
  "cloudSync.massDeletion.restore": "Undo deletion",
  "cloudSync.failed.title": "Cloud sync failed",
  "cloudSync.deleteConflictRestored": "A deleted file was updated on another device. The cloud version was kept.",
  "cloudSync.failed.body": "This sync pass did not finish. Error details:",
};

export default enUS;
