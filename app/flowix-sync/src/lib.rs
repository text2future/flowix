//! Flowix Cloud authentication and synchronization engine.
//!
//! This crate deliberately has no Tauri dependency. `flowix-desktop` owns the
//! local Markdown adapter and secret persistence; this crate owns the Cloud
//! HTTP contract, sync state database, revisions, cursors and conflict plans.

pub mod account;
mod client;
mod environment;
mod error;
mod manager;
mod models;
mod store;
mod v2;

pub use client::CloudClient;
pub use environment::{default_cloud_environment, CloudEnvironment};
pub use error::SyncError;
pub use account::{AccountService, PendingLogout};
pub use manager::SyncManager;
pub use models::{
    AccountDeletionOutcome, AccountDeletionState, AppleAuthChallenge, AppleAuthorization,
    CloudAiCredential, CloudAiCreditBalance, CloudAiModel, CloudAiProvider, CloudAuthStatus,
    CloudCheckout, CloudEntitlementStatus, CloudMembership, CloudNotebook, CloudOrder,
    CloudOrderCheck, CloudPrice, CloudProduct, CloudState, CloudSubscription, CloudUser,
    LocalChangeKind, ProductDuration, ProductEntitlement, RefreshTokenStore,
};
pub use store::SyncStore;
pub use v2::{
    collect_v2_attachments, new_v2_operation_id, referenced_attachment_paths, v2_content_hash,
    v2_local_content_diverged, v2_notebook_metadata_hash, v2_path_note_id, V2AccountSyncReport,
    V2Attachment, V2BlobDownload, V2BlobDownloadCapability, V2BlobDownloadEnvelope,
    V2BlobReservation, V2BlobReservationEnvelope, V2BlobUpload, V2Bootstrap, V2BootstrapNote,
    V2Change, V2ChangesPage, V2CloudAccount, V2ConflictMaterial, V2DirtyEntity, V2EntityType,
    V2FreezeOperation, V2InflightOperation, V2LocalAttachment,
    V2LocalNote, V2LocalNotebook, V2NoteState, V2NotebookState, V2OperationError, V2OperationKind,
    V2PendingMove, V2PushOperation, V2PushResult, V2RemoteApply, V2RemoteAttachment, V2SyncStatus,
    V2SyncedNotebook, PROTOCOL_EPOCH,
};

pub mod text_merge;
