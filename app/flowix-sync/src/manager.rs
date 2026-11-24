//! Notebook synchronization composed with an independently owned account service.
use crate::account::{AccountService, PendingLogout};
use crate::client::CloudClient;
use crate::error::SyncError;
use crate::models::*;
use crate::store::SyncStore;
use std::path::Path;
use std::sync::Arc;

#[derive(Clone)]
pub struct SyncManager {
    account: AccountService,
    client: CloudClient,
    store: SyncStore,
    /// Serialises everything that writes the notebook: passes, manifests and
    /// directory markers.
    ///
    /// A lock that only covered passes made the other two writers look safe
    /// while publishing a manifest that describes a tree the pass was in the
    /// middle of changing.
    write_lock: Arc<tokio::sync::Mutex<()>>,
    credentials: Arc<tokio::sync::Mutex<engine::CredentialCache>>,
    /// Device clock plus the offset the object store last implied.
    ///
    /// Grants are checked against their expiry and requests are signed with the
    /// current time; both have to agree with the store, not with a clock the
    /// user can set.
    clock: Arc<crate::object_store::ClockSkew>,
    credential_refresh: Arc<tokio::sync::Mutex<()>>,
    directory_cache: Arc<tokio::sync::Mutex<engine::DirectoryCache>>,
    remote: Arc<std::sync::Mutex<crate::remote::RemoteSelection>>,
    /// Notebooks whose next pass may apply a bulk deletion the user confirmed.
    ///
    /// One-shot: the pass that reads an entry removes it. A confirmation is an
    /// answer about one batch, and carrying it into the next one would turn a
    /// single "yes" into standing permission to wipe the notebook.
    mass_deletion_allowed: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    /// Object storage is not the control plane: a single object can be large
    /// and a slow uplink must not be cut off at the API client's 30 seconds.
    http: reqwest::Client,
}

impl SyncManager {
    pub fn account(&self) -> &AccountService {
        &self.account
    }

    fn from_account(account: AccountService) -> Self {
        Self {
            client: account.client().clone(),
            store: account.store().clone(),
            account,
            write_lock: Arc::new(tokio::sync::Mutex::new(())),
            credentials: Arc::new(tokio::sync::Mutex::new(Default::default())),
            clock: Arc::new(crate::object_store::ClockSkew::default()),
            credential_refresh: Arc::new(tokio::sync::Mutex::new(())),
            directory_cache: Arc::new(tokio::sync::Mutex::new(Default::default())),
            remote: Arc::new(std::sync::Mutex::new(Default::default())),
            mass_deletion_allowed: Arc::new(std::sync::Mutex::new(Default::default())),
            http: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                .read_timeout(std::time::Duration::from_secs(300))
                .build()
                .unwrap_or_default(),
        }
    }
}

impl SyncManager {
    /// Records the user's answer to the bulk-deletion prompt: the next pass for
    /// this notebook may carry the deletions out.
    ///
    /// Deliberately not persisted. An unspent confirmation describes a batch the
    /// user saw minutes ago; after a restart there is nothing to match it
    /// against, and silently applying it to whatever the next pass finds is the
    /// failure mode the confirmation exists to prevent.
    pub fn allow_next_mass_deletion(&self, notebook_id: &str) {
        self.mass_deletion_allowed
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(notebook_id.to_string());
    }

    fn take_mass_deletion_allowance(&self, notebook_id: &str) -> bool {
        self.mass_deletion_allowed
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(notebook_id)
    }

    /// Undoes a deferred bulk deletion by forgetting these paths.
    ///
    /// Without a state row the next pass reads the cloud copies as files this
    /// device has never seen (`download:new`) and writes them back, which is
    /// what "undo the deletion" has to mean once the local files are gone.
    /// Their directories are queued for listing because nothing wrote there:
    /// a pass that trusts the stamps would never look at them again.
    pub fn restore_paths(&self, notebook_id: &str, paths: &[String]) -> Result<(), SyncError> {
        if paths.is_empty() {
            return Ok(());
        }
        self.store.remove_path_states(notebook_id, paths)?;
        let dirs: Vec<String> = paths
            .iter()
            .map(|path| crate::reconcile::dir_of(path).to_string())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        self.store.queue_stamps(notebook_id, &dirs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PathState;

    fn manager() -> (tempfile::TempDir, SyncManager) {
        let directory = tempfile::tempdir().unwrap();
        let manager =
            SyncManager::new("http://127.0.0.1:9", directory.path().join("sync.db")).unwrap();
        (directory, manager)
    }

    fn state(path: &str) -> PathState {
        PathState {
            path: path.to_string(),
            display_path: path.to_string(),
            content_hash: Some("sha256:00".into()),
            local_size: 8,
            local_mtime_millis: 1_000,
            last_synced_at: 1_000,
            pending_since: Some(1_000),
            remote_etag: Some("\"etag\"".into()),
        }
    }

    /// A confirmation is an answer about one batch. Spending it twice would
    /// turn one "yes" into standing permission, which is exactly the guard the
    /// prompt exists to be.
    #[test]
    fn a_mass_deletion_confirmation_is_spent_by_one_pass() {
        let (_directory, manager) = manager();
        assert!(!manager.take_mass_deletion_allowance("nb"));
        manager.allow_next_mass_deletion("nb");
        assert!(manager.take_mass_deletion_allowance("nb"));
        assert!(!manager.take_mass_deletion_allowance("nb"));
    }

    /// The flag belongs to a notebook: answering the prompt on one must not
    /// authorise a bulk delete on another.
    #[test]
    fn a_confirmation_does_not_leak_between_notebooks() {
        let (_directory, manager) = manager();
        manager.allow_next_mass_deletion("nb_a");
        assert!(!manager.take_mass_deletion_allowance("nb_b"));
        assert!(manager.take_mass_deletion_allowance("nb_a"));
    }

    /// Undo has to leave nothing behind that would re-plan the same deletion:
    /// the row carries both the baseline and the pending marker, and the
    /// directory stamp is what makes the next pass look at all.
    #[test]
    fn undo_drops_the_state_rows_and_reopens_their_directories() {
        let (_directory, manager) = manager();
        manager
            .store
            .save_path_states("nb", &[state("notes/a.md"), state("notes/b.md")])
            .unwrap();
        assert_eq!(manager.store.snapshot("nb").unwrap().states.len(), 2);

        manager
            .restore_paths("nb", &["notes/a.md".into(), "notes/b.md".into()])
            .unwrap();

        assert!(manager.store.snapshot("nb").unwrap().states.is_empty());
        assert_eq!(manager.store.pending_stamps("nb").unwrap(), ["notes"]);
    }

    #[test]
    fn undo_with_no_paths_touches_nothing() {
        let (_directory, manager) = manager();
        manager
            .store
            .save_path_states("nb", &[state("a.md")])
            .unwrap();
        manager.restore_paths("nb", &[]).unwrap();
        assert_eq!(manager.store.snapshot("nb").unwrap().states.len(), 1);
        assert!(manager.store.pending_stamps("nb").unwrap().is_empty());
    }
}

mod account_api;
mod engine;

pub use engine::{PassInput, V4_CREDENTIAL_RENEWAL_MARGIN_MS};
