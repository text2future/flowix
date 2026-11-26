//! Flowix Cloud authentication and synchronization engine.
//!
//! This crate deliberately has no Tauri dependency. `flowix-desktop` owns the
//! local Markdown adapter and secret persistence; this crate owns the Cloud
//! account contract, object-store credentials, and path-keyed sync engine.

pub mod account;
mod blocking;
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
pub mod state;
pub mod apply;
pub mod pass;

pub use account::{AccountService, PendingLogout};
pub use client::CloudClient;
pub use environment::{default_cloud_environment, CloudEnvironment};
pub use error::{FailureKind, SyncError};
pub use manager::SyncManager;
pub use manager::{PassInput, V4_CREDENTIAL_RENEWAL_MARGIN_MS};
pub use models::{
    AccountDeletionOutcome, AccountDeletionState, AppleAuthChallenge, AppleAuthorization,
    CloudAccount, CloudAiCredential, CloudAiCreditBalance, CloudAiCreditState, CloudAiCreditStatus, CloudAiModel, CloudAiProvider,
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
    STAMP_BOUNDARY_MS,
};
pub use remote::RemoteKind;
pub use store::SyncStore;
pub use state::{
    CloudDirectoryMarker, CloudNotebookManifest, PathNotebookLink, PathNotebookMetadata,
    PendingNotebookAction, PendingNotebookChange, ScannedLocalFile, DirectoryState,
    NotebookState, PathState,
};
pub use pass::{
    plan_pass, run_pass, state_updates, DirectSource, ObjectSource, PassEnv, PassPlan, PassReport,
    PassRequest, StateUpdates, BIND_GRACE_MS,
};
