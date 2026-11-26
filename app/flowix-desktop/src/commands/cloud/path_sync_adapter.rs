//! The desktop [`LocalStore`] the state pass writes through.
//!
//! Why this is not `fs::write`: every note the user can see comes from the
//! SQLite projection (`note_index`), which feeds search, backlinks, the file
//! tree and the sidebar. Dropping bytes on disk without touching it produces a
//! *silent* failure — the file syncs, and then the user cannot find it. So
//! markdown goes through `write_note_by_path`, which takes the file lock, does
//! the atomic write and refreshes the projection in one place.
//!
//! Two things follow from that and are easy to get wrong:
//!
//! * **Self-write suppression must be registered before the write.** The
//!   watcher can see the native event before this call returns; a mark added
//!   afterwards is a mark the event never consulted. Without it the user gets
//!   "the document was modified externally" every time the cloud writes.
//! * **A failed index refresh must not fail the transfer.** The bytes are
//!   already durable and the index is rebuildable, so the note entry is marked
//!   pending and rebuilt later. The reverse choice — refusing the download
//!   because the index hiccuped — would turn a cache problem into a sync stall.
//!
//! Non-markdown paths (attachments, collection documents) are written with
//! `atomic_write_bytes`: they never had a note projection row, so there is
//! nothing to refresh and `write_note_by_path` would reject them outright.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, RwLock};

use flowix_core::memo_file::{
    atomic_create_bytes, atomic_write_bytes, is_syncable_notebook_directory_path,
    is_syncable_notebook_file_path, FileLockIntent, IsMd, MemoFile, MemoVersionSource,
    NoteWriteOutcome,
};
use flowix_sync::apply::{ArchiveReason, LocalRead, LocalStamp, LocalStore};
use flowix_sync::SyncError;
use tauri::AppHandle;

use crate::lock_utils::read_lock;
use crate::watcher::runtime::{
    mark_self_create_dir_for, mark_self_write_for, mark_self_write_missing_for,
};

pub(crate) struct MemoLocalStore {
    memo_file: Arc<RwLock<MemoFile>>,
    notebook_id: String,
    /// The notebook root as configured, not as resolved per call: a symlinked
    /// or renamed root must not silently redirect writes mid-pass.
    root: PathBuf,
    /// The watcher's suppression table only exists inside the Tauri runtime;
    /// tests build this store without one.
    app: Option<AppHandle>,
}

impl MemoLocalStore {
    pub(crate) fn new(
        memo_file: Arc<RwLock<MemoFile>>,
        notebook_id: impl Into<String>,
        root: impl Into<PathBuf>,
        app: Option<AppHandle>,
    ) -> Self {
        Self {
            memo_file,
            notebook_id: notebook_id.into(),
            root: root.into(),
            app,
        }
    }

    /// Joins a notebook-relative path onto the root, refusing anything that
    /// could leave it.
    ///
    /// The keys reaching this store have already been normalised
    /// (`state::normalize_key_path` rejects `..`), so this is the second gate, not
    /// the first: it defends against a `display_path` that was relativised
    /// wrongly on a case-insensitive or NFD file system.
    fn resolve(&self, path: &str) -> Result<PathBuf, SyncError> {
        let candidate = Path::new(path);
        let contained = !path.is_empty()
            && !candidate.is_absolute()
            && candidate
                .components()
                .all(|component| matches!(component, Component::Normal(_)));
        if !contained {
            return Err(SyncError::Local {
                path: path.to_string(),
                message: "path escapes the notebook root".to_string(),
            });
        }
        if !is_syncable_notebook_file_path(candidate) {
            return Err(SyncError::Local {
                path: path.to_string(),
                message: "path is excluded by the local notebook sync policy".to_string(),
            });
        }
        Ok(self.root.join(candidate))
    }

    fn resolve_directory(&self, path: &str) -> Result<PathBuf, SyncError> {
        let candidate = Path::new(path);
        let contained = !path.is_empty()
            && !candidate.is_absolute()
            && candidate
                .components()
                .all(|component| matches!(component, Component::Normal(_)));
        if !contained {
            return Err(SyncError::Local {
                path: path.to_string(),
                message: "path escapes the notebook root".to_string(),
            });
        }
        if !is_syncable_notebook_directory_path(candidate) {
            return Err(SyncError::Local {
                path: path.to_string(),
                message: "directory is excluded by the local notebook sync policy".to_string(),
            });
        }
        Ok(self.root.join(candidate))
    }

    /// Creates missing parent directories, announcing the create first so the
    /// watcher does not read a fresh cloud folder as a user action.
    fn ensure_parent(&self, path: &str, full: &Path) -> Result<(), SyncError> {
        let Some(parent) = full.parent() else {
            return Ok(());
        };
        if parent.is_dir() {
            return Ok(());
        }
        if let Some(app) = &self.app {
            mark_self_create_dir_for(app, parent);
        }
        fs::create_dir_all(parent).map_err(|error| local_error(path, error))
    }

    fn suppress_self_write(&self, full: &Path) {
        if let Some(app) = &self.app {
            mark_self_write_for(app, full);
        }
    }

    fn suppress_self_removal(&self, full: &Path) {
        if let Some(app) = &self.app {
            mark_self_write_missing_for(app, full);
        }
    }

    pub(crate) fn ensure_directory(&self, path: &str) -> Result<(), SyncError> {
        let full = self.resolve_directory(path)?;
        if full.is_dir() {
            return Ok(());
        }
        if let Some(app) = &self.app {
            mark_self_create_dir_for(app, &full);
        }
        fs::create_dir_all(&full).map_err(|error| local_error(path, error))
    }

    /// Removes a directory only when it is empty. A non-empty directory may
    /// still contain local data whose file-level deletion has not converged.
    pub(crate) fn remove_empty_directory(&self, path: &str) -> Result<bool, SyncError> {
        let full = self.resolve_directory(path)?;
        self.suppress_self_removal(&full);
        match fs::remove_dir(&full) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => Ok(false),
            Err(error) => Err(local_error(path, error)),
        }
    }
}

impl LocalStore for MemoLocalStore {
    fn is_syncable_path(&self, path: &str) -> bool {
        is_syncable_notebook_file_path(Path::new(path))
    }

    fn read(&self, path: &str) -> Result<Option<LocalRead>, SyncError> {
        let full = self.resolve(path)?;
        let mut file = match File::open(&full) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(local_error(path, error)),
        };
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|error| local_error(path, error))?;
        // Stat *after* the read. A save landing between the two then records a
        // newer mtime than the bytes, which only makes the path look dirty —
        // harmless, because the next pass re-reads it. The other order records
        // an older mtime and marks an edited file clean, dropping that edit.
        let metadata = file.metadata().map_err(|error| local_error(path, error))?;
        if !metadata.is_file() {
            return Ok(None);
        }
        Ok(Some(LocalRead {
            bytes,
            stamp: stamp_of(&metadata),
        }))
    }

    fn write(&self, path: &str, bytes: &[u8]) -> Result<LocalStamp, SyncError> {
        let full = self.resolve(path)?;
        self.ensure_parent(path, &full)?;
        self.suppress_self_write(&full);

        if full.is_md() {
            match std::str::from_utf8(bytes) {
                Ok(content) => {
                    // `write_note_by_path_creating` is the same save path an editor
                    // uses — notebook file lock, path validation, index and link
                    // registration — with existence relaxed, because a download
                    // usually lands on a path this device has never seen.
                    let outcome = read_lock(&self.memo_file, "memo_file")
                        .write_note_by_path_creating(&self.notebook_id, path, content)
                        .map_err(|error| local_error(path, error))?;
                    // No expectation is passed, so a conflict is impossible; treat
                    // one as a failure anyway rather than claim a write we did
                    // not perform.
                    if let NoteWriteOutcome::Conflict { .. } = outcome {
                        return Err(SyncError::Local {
                            path: path.to_string(),
                            message: "note changed while it was being written".to_string(),
                        });
                    }
                }
                // A `.md` that is not UTF-8 is corrupt, but it is still the
                // user's bytes: land them and let the index skip the row.
                Err(_) => {
                    atomic_write_bytes(&full, bytes).map_err(|error| local_error(path, error))?;
                }
            }
        } else {
            atomic_write_bytes(&full, bytes).map_err(|error| local_error(path, error))?;
        }

        let metadata = fs::metadata(&full).map_err(|error| local_error(path, error))?;
        Ok(stamp_of(&metadata))
    }

    fn write_if_unchanged(
        &self,
        path: &str,
        bytes: &[u8],
        expected: Option<&[u8]>,
    ) -> Result<Option<LocalStamp>, SyncError> {
        let Some(expected) = expected else {
            // A new remote path must not replace a file created while the
            // download was in flight. create_new is the atomic check here.
            return self.create_exclusive(path, bytes);
        };
        let full = self.resolve(path)?;
        self.suppress_self_write(&full);

        if full.is_md() {
            if let (Ok(content), Ok(expected_content)) =
                (std::str::from_utf8(bytes), std::str::from_utf8(expected))
            {
                let outcome = read_lock(&self.memo_file, "memo_file")
                    .write_note_by_path(&self.notebook_id, path, content, Some(expected_content))
                    .map_err(|error| local_error(path, error))?;
                if matches!(outcome, NoteWriteOutcome::Conflict { .. }) {
                    return Ok(None);
                }
                let metadata = fs::metadata(&full).map_err(|error| local_error(path, error))?;
                return Ok(Some(stamp_of(&metadata)));
            }
        }

        // Attachments and non-UTF-8 Markdown use the same cross-process file
        // lock as note writes. Compare and replace while holding that lock so
        // an editor save cannot slip between the check and the atomic rename.
        let wrote = read_lock(&self.memo_file, "memo_file")
            .with_file_write(
                &self.notebook_id,
                &full,
                FileLockIntent::Existing,
                "cloud_replace_if_unchanged",
                |locked_path| {
                    if fs::read(locked_path)?.as_slice() != expected {
                        return Ok(false);
                    }
                    atomic_write_bytes(locked_path, bytes)?;
                    Ok(true)
                },
            )
            .map_err(|error| local_error(path, error))?;
        if !wrote {
            return Ok(None);
        }
        if full.is_md() {
            read_lock(&self.memo_file, "memo_file")
                .refresh_note_path_after_write(&self.notebook_id, path);
        }
        let metadata = fs::metadata(&full).map_err(|error| local_error(path, error))?;
        Ok(Some(stamp_of(&metadata)))
    }

    fn create_exclusive(&self, path: &str, bytes: &[u8]) -> Result<Option<LocalStamp>, SyncError> {
        let full = self.resolve(path)?;
        self.ensure_parent(path, &full)?;
        self.suppress_self_write(&full);

        match atomic_create_bytes(&full, bytes) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(None),
            Err(error) => return Err(local_error(path, error)),
        }

        if full.is_md() {
            // A brand new file has no projection row, so the create path is a
            // refresh rather than a write. Failure is logged and deferred by
            // `refresh_note_path_after_write`; the copy already exists.
            read_lock(&self.memo_file, "memo_file")
                .refresh_note_path_after_write(&self.notebook_id, path);
        }

        let metadata = fs::metadata(&full).map_err(|error| local_error(path, error))?;
        Ok(Some(stamp_of(&metadata)))
    }

    fn archive(&self, path: &str, bytes: &[u8], reason: ArchiveReason) -> Result<(), SyncError> {
        self.resolve(path)?;

        let source = match reason {
            ArchiveReason::ConflictBackup => MemoVersionSource::ConflictBackup,
            ArchiveReason::RemoteDeletion => MemoVersionSource::RemoteDeletion,
            // Keep the archive schema readable by older clients. Remote
            // replacements use the existing ordinary, capped history source.
            ArchiveReason::RemoteReplacement => MemoVersionSource::Auto,
        };
        read_lock(&self.memo_file, "memo_file")
            .archive_sync_path_bytes(&self.notebook_id, path, bytes, source)
            .map_err(|error| local_error(path, error))?;
        Ok(())
    }

    fn remove(&self, path: &str) -> Result<(), SyncError> {
        let full = self.resolve(path)?;
        self.suppress_self_removal(&full);

        if full.is_md() {
            return match read_lock(&self.memo_file, "memo_file")
                .delete_note_by_path(&self.notebook_id, path)
            {
                Ok(_) => Ok(()),
                // Already gone: the plan wanted it gone and it is.
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(local_error(path, error)),
            };
        }

        match fs::remove_file(&full) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(local_error(path, error)),
        }
    }

    fn remove_if_unchanged(&self, path: &str, expected: &[u8]) -> Result<bool, SyncError> {
        let full = self.resolve(path)?;
        self.suppress_self_removal(&full);

        if full.is_md() {
            if let Ok(content) = std::str::from_utf8(expected) {
                return match read_lock(&self.memo_file, "memo_file").delete_note_by_path_checked(
                    &self.notebook_id,
                    path,
                    Some(content),
                ) {
                    Ok(removed) => Ok(removed),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(false),
                    Err(error) => Err(local_error(path, error)),
                };
            }
        }

        let removed = read_lock(&self.memo_file, "memo_file")
            .with_file_write(
                &self.notebook_id,
                &full,
                FileLockIntent::ExistingOrMissing,
                "cloud_remove_if_unchanged",
                |locked_path| {
                    let current = match fs::read(locked_path) {
                        Ok(bytes) => bytes,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                            return Ok(false);
                        }
                        Err(error) => return Err(error),
                    };
                    if current != expected {
                        return Ok(false);
                    }
                    fs::remove_file(locked_path)?;
                    Ok(true)
                },
            )
            .map_err(|error| local_error(path, error))?;
        if removed && full.is_md() {
            read_lock(&self.memo_file, "memo_file")
                .refresh_note_path_after_write(&self.notebook_id, path);
        }
        Ok(removed)
    }
}

fn stamp_of(metadata: &fs::Metadata) -> LocalStamp {
    let mtime_millis = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as i64)
        // An unreadable mtime must not read as "1970": that would look older
        // than every baseline and turn into a permanent upload. Zero is the
        // same signal the listing side uses for "unknown".
        .unwrap_or(0);
    LocalStamp {
        size: metadata.len(),
        mtime_millis,
    }
}

fn local_error(path: &str, error: impl std::fmt::Display) -> SyncError {
    SyncError::Local {
        path: path.to_string(),
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flowix_core::memo_file::NotebookConfig;

    const NB: &str = "book";

    #[tokio::test]
    #[ignore = "requires a disposable staging R2 credential"]
    async fn live_r2_invalid_credential_reports_error_without_changing_local_data() {
        use flowix_core::memo_file::scan_syncable_notebook_files;
        use flowix_sync::pass::{DirectSource, PassEnv, PassRequest};
        use flowix_sync::{run_pass, ObjectStoreCredentials, ScannedLocalFile, SyncStore};

        let path = std::env::var("FLOWIX_R2_ACCEPTANCE_CREDENTIAL").unwrap();
        let mut credential: ObjectStoreCredentials =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(credential.backend_id, "r2-staging");
        assert_eq!(credential.bucket, "r2-flowix-cloud-staging-user-blobs");
        let valid_credential = credential.clone();
        credential.session_token = Some("invalid-acceptance-token".into());
        let (temp, _memo, local) = fixture();
        local
            .write("notes/offline.md", b"# Keep local bytes\n")
            .unwrap();
        let root = temp.path().join("book");
        let scanned = scan_syncable_notebook_files(&root)
            .unwrap()
            .into_iter()
            .map(|f| ScannedLocalFile::new(f.display_path, f.size, f.mtime_millis).unwrap())
            .collect::<Vec<_>>();
        let state = SyncStore::new(temp.path().join("sync.db")).unwrap();
        let http = reqwest::Client::new();
        let now = chrono::Utc::now();
        let mut source = DirectSource {
            http: &http,
            credentials: &credential,
            credential_resolver: &credential,
        };
        let mut env = PassEnv {
            source: &mut source,
            http: &http,
            credentials: &credential,
            credential_resolver: &credential,
            store: &state,
            local: &local,
        };
        let notebook_id = format!("nb_retry_{}", uuid::Uuid::new_v4().simple());
        let request = PassRequest {
            notebook_id: &notebook_id,
            device_id: "single-device",
            scanned: &scanned,
            force: true,
            quota: None,
            max_upload_file_bytes: None,
            allow_mass_deletion: false,
        };
        assert!(run_pass(&mut env, &request, now).await.is_err());
        assert_eq!(
            std::fs::read(root.join("notes/offline.md")).unwrap(),
            b"# Keep local bytes\n"
        );
        assert!(state.snapshot(&notebook_id).unwrap().states.is_empty());
        let now = chrono::Utc::now();
        let mut source = DirectSource {
            http: &http,
            credentials: &valid_credential,
            credential_resolver: &valid_credential,
        };
        let mut env = PassEnv {
            source: &mut source,
            http: &http,
            credentials: &valid_credential,
            credential_resolver: &valid_credential,
            store: &state,
            local: &local,
        };
        let recovered = run_pass(&mut env, &request, now).await.unwrap();
        assert_eq!(recovered.plan.stats.uploads, 1);
        assert!(
            recovered.applied.failures.is_empty(),
            "{:?}",
            recovered.applied.failures
        );
        assert!(recovered.list_failures.is_empty());
        assert!(recovered.stamp_failures.is_empty());
        assert_eq!(state.snapshot(&notebook_id).unwrap().states.len(), 1);
    }

    #[tokio::test]
    #[ignore = "requires a disposable staging account"]
    async fn live_r2_single_device_login_upload_and_restart() {
        use flowix_core::memo_file::scan_syncable_notebook_files;
        use flowix_sync::{
            CloudDirectoryMarker, CloudNotebookManifest, ScannedLocalFile, SyncManager, PassInput,
        };

        let account_path = std::env::var("FLOWIX_R2_ACCEPTANCE_ACCOUNT").unwrap();
        let account: serde_json::Value =
            serde_json::from_slice(&std::fs::read(account_path).unwrap()).unwrap();
        let email = account["email"].as_str().unwrap();
        assert!(
            email.ends_with("@example.invalid"),
            "only synthetic test accounts are permitted"
        );
        let password = account["password"].as_str().unwrap();
        let (temp, _memo, local) = fixture();
        let root = temp.path().join("book");
        local
            .write("notes/single.md", b"# Single device\n")
            .unwrap();
        local.write("attachments/single.bin", &[1, 2, 3]).unwrap();
        local.ensure_directory("notes/empty").unwrap();
        let state_path = temp.path().join("sync.db");
        let manager = SyncManager::new("https://staging-cloud.flowix.cc", &state_path).unwrap();
        manager.account().login(email, password).await.unwrap();
        let id = "nb_single_device";
        let manifest = CloudNotebookManifest {
            schema: 1,
            name: "Acceptance".into(),
            icon: None,
            sort_order: 0,
            deleted: false,
            created_at: 1,
        };
        let directory = CloudDirectoryMarker {
            schema: 1,
            path: "notes/empty".into(),
            deleted: false,
        };
        assert!(manager
            .put_notebook_manifest(id, &manifest)
            .await
            .unwrap());
        assert!(manager
            .put_directory_marker(id, &directory)
            .await
            .unwrap()
            .is_some());
        let scanned = scan_syncable_notebook_files(&root)
            .unwrap()
            .into_iter()
            .map(|f| ScannedLocalFile::new(f.display_path, f.size, f.mtime_millis).unwrap())
            .collect::<Vec<_>>();
        let report = manager
            .pass(PassInput {
                notebook_id: id,
                device_id: "single-device",
                scanned: &scanned,
                local: &local,
                on_transfer: None,
                on_progress: None,
                force: true,
                allow_mass_deletion: false,
            })
            .await
            .unwrap();
        assert_eq!(report.plan.stats.uploads, 2);
        assert!(
            report.applied.failures.is_empty(),
            "{:?}",
            report.applied.failures
        );
        assert!(report.list_failures.is_empty());
        assert!(report.stamp_failures.is_empty());
        drop(manager);

        // Reopen the persisted sync database and authenticate again, simulating
        // process restart without relying on the real user's Keychain.
        let reopened = SyncManager::new("https://staging-cloud.flowix.cc", &state_path).unwrap();
        reopened.account().login(email, password).await.unwrap();
        assert_eq!(
            reopened
                .get_notebook_manifest(id)
                .await
                .unwrap()
                .unwrap()
                .0,
            manifest
        );
        assert!(reopened
            .remote_notebooks()
            .await
            .unwrap()
            .iter()
            .any(|notebook| notebook.id == id));
        assert!(reopened
            .remote_directories(id)
            .await
            .unwrap()
            .0
            .iter()
            .any(|(marker, _)| marker == &directory));
        let report = reopened
            .pass(PassInput {
                notebook_id: id,
                device_id: "single-device",
                scanned: &scanned,
                local: &local,
                on_transfer: None,
                on_progress: None,
                force: true,
                allow_mass_deletion: false,
            })
            .await
            .unwrap();
        assert_eq!(report.plan.stats.uploads, 0);
        assert_eq!(report.plan.stats.downloads, 0);
        assert!(
            report.applied.failures.is_empty(),
            "{:?}",
            report.applied.failures
        );
        assert!(report.list_failures.is_empty());
        assert!(report.stamp_failures.is_empty());
    }

    #[tokio::test]
    #[ignore = "requires a disposable staging R2 credential"]
    async fn live_r2_upload_one_hundred_files() {
        use flowix_core::memo_file::scan_syncable_notebook_files;
        use flowix_sync::pass::{DirectSource, PassEnv, PassRequest};
        use flowix_sync::{run_pass, ObjectStoreCredentials, ScannedLocalFile, SyncStore};

        let path = std::env::var("FLOWIX_R2_ACCEPTANCE_CREDENTIAL").unwrap();
        let credential: ObjectStoreCredentials =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(credential.backend_id, "r2-staging");
        assert_eq!(credential.bucket, "r2-flowix-cloud-staging-user-blobs");
        let (temp, _memo, local) = fixture();
        let root = temp.path().join("book");
        let folder = root.join("notes");
        std::fs::create_dir(&folder).unwrap();
        for n in 0..100 {
            std::fs::write(folder.join(format!("note-{n:03}.md")), format!("# {n}\n")).unwrap();
        }
        let scanned = scan_syncable_notebook_files(&root)
            .unwrap()
            .into_iter()
            .map(|f| ScannedLocalFile::new(f.display_path, f.size, f.mtime_millis).unwrap())
            .collect::<Vec<_>>();
        let state = SyncStore::new(temp.path().join("sync.db")).unwrap();
        let http = reqwest::Client::new();
        let now = chrono::Utc::now();
        let mut source = DirectSource {
            http: &http,
            credentials: &credential,
            credential_resolver: &credential,
        };
        let mut env = PassEnv {
            source: &mut source,
            http: &http,
            credentials: &credential,
            credential_resolver: &credential,
            store: &state,
            local: &local,
        };
        let notebook_id = format!("nb_sample_{}", uuid::Uuid::new_v4().simple());
        let request = PassRequest {
            notebook_id: &notebook_id,
            device_id: "device-a",
            scanned: &scanned,
            force: true,
            quota: None,
            max_upload_file_bytes: None,
            allow_mass_deletion: false,
        };
        let start = std::time::Instant::now();
        let report = run_pass(&mut env, &request, now).await.unwrap();
        println!(
            "100-file initial pass: {:.2}s, uploads={}, failures={}",
            start.elapsed().as_secs_f64(),
            report.plan.stats.uploads,
            report.applied.failures.len()
        );
        assert_eq!(report.plan.stats.uploads, 100);
        assert!(report.list_failures.is_empty());
        let initial_failures = report.applied.failures.len() + report.stamp_failures.len();
        if initial_failures > 0 {
            let retry_started = std::time::Instant::now();
            let retry = run_pass(&mut env, &request, chrono::Utc::now())
                .await
                .unwrap();
            println!(
                "retry: {:.2}s, uploads={}, failures={}",
                retry_started.elapsed().as_secs_f64(),
                retry.plan.stats.uploads,
                retry.applied.failures.len()
            );
            assert!(
                retry.applied.failures.is_empty(),
                "{:?}",
                retry.applied.failures
            );
            assert!(retry.list_failures.is_empty());
            assert!(retry.stamp_failures.is_empty());
        }
        assert_eq!(state.snapshot(&notebook_id).unwrap().states.len(), 100);
    }

    #[tokio::test]
    #[ignore = "requires the disposable staging scale fixture"]
    async fn live_r2_list_ten_thousand_objects() {
        use flowix_sync::pass::{DirectSource, ObjectSource};
        use flowix_sync::ObjectStoreCredentials;

        let path = std::env::var("FLOWIX_R2_ACCEPTANCE_CREDENTIAL").unwrap();
        let credential: ObjectStoreCredentials =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(credential.backend_id, "r2-staging");
        assert_eq!(credential.bucket, "r2-flowix-cloud-staging-user-blobs");
        let http = reqwest::Client::new();
        let mut source = DirectSource {
            http: &http,
            credentials: &credential,
            credential_resolver: &credential,
        };
        let mut cursor = None;
        let mut count = 0;
        let mut pages = 0;
        let start = std::time::Instant::now();
        loop {
            let page = source
                .list("nb/nb_scale/f/".into(), cursor.clone(), None)
                .await
                .unwrap();
            assert!(page
                .objects
                .iter()
                .all(|object| object.key.starts_with("nb/nb_scale/f/")));
            count += page.objects.len();
            pages += 1;
            match page.next_cursor {
                Some(next) if cursor.as_ref() != Some(&next) => cursor = Some(next),
                Some(_) => panic!("repeated cursor"),
                None => break,
            }
        }
        println!(
            "listed {count} objects in {pages} pages, elapsed {:.2}s",
            start.elapsed().as_secs_f64()
        );
        assert_eq!(count, 10_000);
        assert!(pages > 1);
    }

    fn fixture() -> (tempfile::TempDir, Arc<RwLock<MemoFile>>, MemoLocalStore) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("book");
        std::fs::create_dir(&root).unwrap();
        let memo = MemoFile::new(temp.path().join("config"));
        memo.write_notebook_configs(&[NotebookConfig {
            id: NB.to_string(),
            name: "Book".to_string(),
            icon: None,
            path: root.to_string_lossy().into_owned(),
            is_default: true,
            sort: 0,
            created_at: 1,
            updated_at: 1,
        }])
        .unwrap();
        let memo = Arc::new(RwLock::new(memo));
        let store = MemoLocalStore::new(memo.clone(), NB, root, None);
        (temp, memo, store)
    }

    /// Opt-in live integration: isolated local stores and an explicitly supplied
    /// disposable-account R2 credential. This writes under `nb/book/` in that
    /// credential's account prefix; never point it at a real user's account.
    #[tokio::test]
    #[ignore = "requires a disposable staging R2 credential"]
    async fn live_r2_two_local_stores_transfer_notebook_content() {
        use flowix_core::memo_file::scan_syncable_notebook_files;
        use flowix_sync::pass::{DirectSource, PassEnv, PassRequest};
        use flowix_sync::{run_pass, ObjectStoreCredentials, ScannedLocalFile, SyncStore};

        let credential_path = std::env::var("FLOWIX_R2_ACCEPTANCE_CREDENTIAL").unwrap();
        let credential: ObjectStoreCredentials =
            serde_json::from_slice(&std::fs::read(credential_path).unwrap()).unwrap();
        assert_eq!(credential.backend_id, "r2-staging");
        assert_eq!(credential.bucket, "r2-flowix-cloud-staging-user-blobs");
        let (a_dir, _a_memo, a) = fixture();
        let (b_dir, b_memo, b) = fixture();
        let a_state = SyncStore::new(a_dir.path().join("sync.db")).unwrap();
        let b_state = SyncStore::new(b_dir.path().join("sync.db")).unwrap();
        let http = reqwest::Client::new();
        a.write("notes/hello.md", "# Hello 世界\n".as_bytes())
            .unwrap();
        a.write("attachments/picture.png", &[0, 1, 2, 255]).unwrap();
        a.write(".flowix/database/records/one.md", b"# record\n")
            .unwrap();
        std::fs::write(a_dir.path().join("book/.index.yaml"), b"device: A\n").unwrap();

        for (root, local, store, device) in [
            (a_dir.path().join("book"), &a, &a_state, "device-a"),
            (b_dir.path().join("book"), &b, &b_state, "device-b"),
        ] {
            let scanned = scan_syncable_notebook_files(&root)
                .unwrap()
                .into_iter()
                .map(|f| ScannedLocalFile::new(f.display_path, f.size, f.mtime_millis).unwrap())
                .collect::<Vec<_>>();
            let now = chrono::Utc::now();
            let mut source = DirectSource {
                http: &http,
                credentials: &credential,
                credential_resolver: &credential,
            };
            let mut env = PassEnv {
                source: &mut source,
                http: &http,
                credentials: &credential,
                credential_resolver: &credential,
                store,
                local,
            };
            let request = PassRequest {
                notebook_id: NB,
                device_id: device,
                scanned: &scanned,
                force: true,
                quota: None,
                max_upload_file_bytes: None,
                allow_mass_deletion: false,
            };
            let report = run_pass(&mut env, &request, now).await.unwrap();
            println!(
                "{device}: scanned={} uploads={} downloads={} deferred={} actions={:?}",
                scanned.len(),
                report.plan.stats.uploads,
                report.plan.stats.downloads,
                report.plan.stats.deferred,
                report.plan.actions
            );
            assert!(
                report.applied.failures.is_empty(),
                "{:?}",
                report.applied.failures
            );
            assert!(
                report.list_failures.is_empty(),
                "{:?}",
                report.list_failures
            );
            assert!(
                report.stamp_failures.is_empty(),
                "{:?}",
                report.stamp_failures
            );
        }
        assert_eq!(
            std::fs::read(b_dir.path().join("book/notes/hello.md")).unwrap(),
            "# Hello 世界\n".as_bytes()
        );
        assert_eq!(
            std::fs::read(b_dir.path().join("book/attachments/picture.png")).unwrap(),
            [0, 1, 2, 255]
        );
        assert_eq!(
            std::fs::read(b_dir.path().join("book/.flowix/database/records/one.md")).unwrap(),
            b"# record\n"
        );
        assert_eq!(
            std::fs::read(b_dir.path().join("book/.index.yaml")).unwrap(),
            b"device: A\n"
        );
        assert!(read_lock(&b_memo, "test")
            .read_note_entry_by_path(NB, "notes/hello.md")
            .unwrap()
            .is_some());

        // Both stores edit while disconnected. Publish A first, then sync B;
        // B must preserve its different bytes before applying the cloud winner.
        a.write("notes/hello.md", b"# Offline A\n").unwrap();
        b.write("notes/hello.md", b"# Offline B\n").unwrap();
        for (root, local, store, device) in [
            (a_dir.path().join("book"), &a, &a_state, "device-a"),
            (b_dir.path().join("book"), &b, &b_state, "device-b"),
        ] {
            let scanned = scan_syncable_notebook_files(&root)
                .unwrap()
                .into_iter()
                .map(|f| ScannedLocalFile::new(f.display_path, f.size, f.mtime_millis).unwrap())
                .collect::<Vec<_>>();
            let now = chrono::Utc::now();
            let mut source = DirectSource {
                http: &http,
                credentials: &credential,
                credential_resolver: &credential,
            };
            let mut env = PassEnv {
                source: &mut source,
                http: &http,
                credentials: &credential,
                credential_resolver: &credential,
                store,
                local,
            };
            let request = PassRequest {
                notebook_id: NB,
                device_id: device,
                scanned: &scanned,
                force: true,
                quota: None,
                max_upload_file_bytes: None,
                allow_mass_deletion: false,
            };
            let report = run_pass(&mut env, &request, now).await.unwrap();
            assert!(
                report.applied.failures.is_empty(),
                "{:?}",
                report.applied.failures
            );
            assert!(
                report.list_failures.is_empty(),
                "{:?}",
                report.list_failures
            );
            assert!(
                report.stamp_failures.is_empty(),
                "{:?}",
                report.stamp_failures
            );
            println!("offline {device}: {:?}", report.plan.actions);
            if device == "device-a" {
                assert_eq!(
                    report.plan.stats.uploads, 1,
                    "unchanged R2 objects must not look newer after HEAD"
                );
                assert_eq!(report.plan.stats.downloads, 0);
            }
        }
        let b_notes = b_dir.path().join("book/notes");
        let conflict_bytes = std::fs::read_dir(&b_notes)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.file_name().unwrap().to_string_lossy().contains("冲突"))
            .map(|path| std::fs::read(path).unwrap())
            .collect::<Vec<_>>();
        assert!(
            conflict_bytes.iter().any(|bytes| bytes == b"# Offline B\n"),
            "losing edit must be preserved"
        );
        assert_eq!(
            std::fs::read(b_notes.join("hello.md")).unwrap(),
            b"# Offline A\n"
        );
        let memo = read_lock(&b_memo, "test");
        let versions = memo.list_path_versions(NB, "notes/hello.md");
        assert!(
            versions.iter().any(|version| memo
                .read_path_version_bytes(NB, "notes/hello.md", &version.id)
                .as_deref()
                == Some(b"# Offline B\n".as_slice())),
            "losing edit must be archived"
        );
    }

    /// The whole reason this adapter exists. Writing with `fs::write` would pass
    /// every byte-level assertion and still leave the note invisible.
    #[test]
    fn markdown_writes_reach_the_note_index() {
        let (temp, memo, store) = fixture();

        store.write("notes/a.md", b"# Hello\n").unwrap();

        assert_eq!(
            std::fs::read(temp.path().join("book/notes/a.md")).unwrap(),
            b"# Hello\n"
        );
        let entry = read_lock(&memo, "test")
            .read_note_entry_by_path(NB, "notes/a.md")
            .unwrap();
        assert!(
            entry.is_some(),
            "a synced note must be indexed, not just written"
        );
    }

    /// Attachments never had a projection row, and `write_note_by_path` would
    /// reject them. They still have to land.
    #[test]
    fn attachments_are_written_without_a_projection_row() {
        let (temp, memo, store) = fixture();

        let stamp = store
            .write("attachments/x.png", &[0x89, b'P', b'N', b'G'])
            .unwrap();

        assert_eq!(stamp.size, 4);
        assert_eq!(
            std::fs::read(temp.path().join("book/attachments/x.png")).unwrap(),
            vec![0x89, b'P', b'N', b'G']
        );
        assert!(read_lock(&memo, "test")
            .read_note_entry_by_path(NB, "attachments/x.png")
            .is_err());
    }

    #[test]
    fn remote_index_configuration_can_be_read_written_and_removed() {
        let (temp, _memo, store) = fixture();
        let config_path = temp.path().join("book/notes/.index.yaml");
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();
        std::fs::write(&config_path, "local-only: true\n").unwrap();

        assert_eq!(
            store.read("notes/.index.yaml").unwrap().unwrap().bytes,
            b"local-only: true\n"
        );
        store.write("notes/.index.yaml", b"remote: true\n").unwrap();
        assert_eq!(std::fs::read(&config_path).unwrap(), b"remote: true\n");
        store.remove("notes/.index.yaml").unwrap();
        assert!(!config_path.exists());
    }

    #[test]
    fn user_records_under_flowix_database_remain_syncable() {
        let (temp, _memo, store) = fixture();

        store
            .write(".flowix/database/users/alice.md", b"# User record\n")
            .unwrap();

        assert_eq!(
            std::fs::read(temp.path().join("book/.flowix/database/users/alice.md")).unwrap(),
            b"# User record\n"
        );
    }

    #[test]
    fn remote_local_configuration_directories_are_not_created_or_removed() {
        let (temp, _memo, store) = fixture();
        let view_preferences = temp.path().join("book/.flowix/view-preferences");
        assert!(store.ensure_directory(".flowix/view-preferences").is_err());
        assert!(!view_preferences.exists());

        std::fs::create_dir_all(&view_preferences).unwrap();
        assert!(store
            .remove_empty_directory(".flowix/view-preferences")
            .is_err());
        assert!(view_preferences.is_dir());
    }

    /// The conflict-copy loop depends on this answer: `None` means "try the next
    /// suffix", not "failed".
    #[test]
    fn create_exclusive_refuses_a_taken_name() {
        let (_temp, _memo, store) = fixture();
        assert!(store
            .create_exclusive("notes/a (conflict).md", b"first")
            .unwrap()
            .is_some());
        assert!(store
            .create_exclusive("notes/a (conflict).md", b"second")
            .unwrap()
            .is_none());
        assert_eq!(
            std::fs::read(_temp.path().join("book/notes/a (conflict).md")).unwrap(),
            b"first",
            "the first copy must survive the refused second one"
        );
    }

    #[test]
    fn removing_a_note_drops_its_projection() {
        let (temp, memo, store) = fixture();
        store.write("notes/gone.md", b"# Gone\n").unwrap();

        store.remove("notes/gone.md").unwrap();

        assert!(!temp.path().join("book/notes/gone.md").exists());
        assert!(
            read_lock(&memo, "test")
                .read_note_entry_by_path(NB, "notes/gone.md")
                .unwrap()
                .is_none(),
            "a stale row would keep the deleted note in search results"
        );
        // Deleting something already gone is what a retried plan looks like.
        store.remove("notes/gone.md").unwrap();
    }

    #[test]
    fn conditional_delete_preserves_changed_notes_and_attachments() {
        let (temp, memo, store) = fixture();
        for path in ["notes/changed.md", "attachments/changed.bin"] {
            store.write(path, b"new bytes").unwrap();
            assert!(!store.remove_if_unchanged(path, b"old bytes").unwrap());
            assert_eq!(
                std::fs::read(temp.path().join("book").join(path)).unwrap(),
                b"new bytes"
            );
            assert!(store.remove_if_unchanged(path, b"new bytes").unwrap());
            assert!(!temp.path().join("book").join(path).exists());
        }
        assert!(read_lock(&memo, "test")
            .read_note_entry_by_path(NB, "notes/changed.md")
            .unwrap()
            .is_none());
    }

    #[test]
    fn archive_keeps_the_bytes_before_a_delete() {
        let (_temp, memo, store) = fixture();
        store.write("notes/keep.md", b"# Keep\n").unwrap();

        store
            .archive("notes/keep.md", b"# Keep\n", ArchiveReason::RemoteDeletion)
            .unwrap();

        let versions = read_lock(&memo, "test").list_path_versions(NB, "notes/keep.md");
        assert_eq!(versions.len(), 1);
        assert_eq!(
            read_lock(&memo, "test")
                .read_path_version_bytes(NB, "notes/keep.md", &versions[0].id)
                .as_deref(),
            Some(b"# Keep\n".as_slice())
        );
    }

    /// The key normaliser is the first gate; this is the second. A `display_path`
    /// that lost its relativisation must not become an arbitrary write.
    #[test]
    fn paths_cannot_escape_the_notebook() {
        let (_temp, _memo, store) = fixture();
        for path in ["../outside.md", "/etc/passwd", "notes/../../outside.md", ""] {
            assert!(store.write(path, b"x").is_err(), "{path} must be rejected");
            assert!(store.read(path).is_err(), "{path} must be rejected");
        }
    }
}
