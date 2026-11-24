//! Flowix Cloud authentication and synchronization engine.
//!
//! This crate deliberately has no Tauri dependency. `flowix-desktop` owns the
//! local Markdown adapter and secret persistence; this crate owns the Cloud
//! account contract, object-store credentials, and path-keyed sync engine.

pub mod account;
mod client;
mod environment;
mod error;
mod manager;
mod models;
pub mod object_store;
pub mod object_store_ops;
pub mod reconcile;
pub mod remote;
mod store;
pub mod telemetry;
pub mod v4;
pub mod v4_apply;
pub mod v4_pass;

pub use account::{AccountService, PendingLogout};
pub use client::CloudClient;
pub use environment::{default_cloud_environment, CloudEnvironment};
pub use error::SyncError;
pub use manager::SyncManager;
pub use manager::{V4PassInput, V4_CREDENTIAL_RENEWAL_MARGIN_MS};
pub use models::{
    AccountDeletionOutcome, AccountDeletionState, AppleAuthChallenge, AppleAuthorization,
    CloudAccount, CloudAiCredential, CloudAiCreditBalance, CloudAiModel, CloudAiProvider,
    CloudAuthStatus, CloudCheckout, CloudEntitlementStatus, CloudMembership, CloudNoteShareLink,
    CloudNotebook, CloudOrder, CloudOrderCheck, CloudPrice, CloudProduct, CloudState,
    CloudSubscription, CloudUser, PasswordResetCodeRequest, ProductDuration, ProductEntitlement,
    RefreshTokenStore, RegistrationCodeRequest, RegistrationCodeResend,
};
pub use object_store::{
    list_prefix, ListedObject, ObjectStoreCredentials, StorageCredentialEnvelope, StorageQuota,
};
pub use reconcile::{
    directories_to_scan, reconcile, Baseline, ConflictBackup, Defer, DeferReason, DeleteLocal,
    DirScanRecord, Download, DownloadReason, LocalFile, LocalView, Probe, ReconcilePlan,
    ReconcileStats, RemoteListing, RemoteObject, SyncAction, Tombstone, Upload, UploadReason,
    DELETE_CONFIRM_WINDOW_MS, STAMP_BOUNDARY_MS,
};
pub use remote::RemoteKind;
pub use store::SyncStore;
pub use v4::{
    CloudDirectoryMarker, CloudNotebookManifest, PathNotebookLink, PathNotebookMetadata,
    PendingNotebookAction, PendingNotebookChange, ScannedLocalFile, V4DirectoryState,
    V4NotebookState, V4PathState,
};
pub use v4_pass::{
    plan_pass, run_pass, state_updates, DirectSource, ObjectSource, PassEnv, PassPlan, PassReport,
    PassRequest, StateUpdates, BIND_GRACE_MS,
};
