use std::ops::{Deref, DerefMut};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::SyncError;

/// Handed out by [`SyncStore::open`]. Derefs to the shared connection, so call
/// sites keep writing `let mut connection = store.open()?;` and `transaction()`.
///
/// The guard, not a fresh handle, is the point: a pass checkpoints once per
/// transferred path, and each `Connection::open` used to re-run three PRAGMAs
/// on a brand-new handle. One handle per store removes that cost entirely.
pub(super) struct StoreConnection<'a>(MutexGuard<'a, Option<Connection>>);

impl Deref for StoreConnection<'_> {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        // `open` fills the slot before returning the guard, and only `open`
        // (which holds the same mutex) can clear it again.
        self.0
            .as_ref()
            .expect("connection slot is filled before the guard is handed out")
    }
}

impl DerefMut for StoreConnection<'_> {
    fn deref_mut(&mut self) -> &mut Connection {
        self.0
            .as_mut()
            .expect("connection slot is filled before the guard is handed out")
    }
}

#[derive(Clone)]
pub struct SyncStore {
    path: PathBuf,
    schema_ready: Arc<std::sync::atomic::AtomicBool>,
    schema_lock: Arc<Mutex<()>>,
    /// Shared by every clone: the store is a handle, not a connection owner, so
    /// clones must serialize on the same handle rather than open their own.
    connection: Arc<Mutex<Option<Connection>>>,
}

impl SyncStore {
    /// Drops the pooled handle. Required whenever the database *file* is
    /// replaced or rebuilt: the pooled connection keeps pointing at the old
    /// inode, where writes would be lost without an error.
    fn drop_connection(&self) {
        let mut slot = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *slot = None;
    }
}

mod account;
mod path_notebooks;
mod remote;
mod schema;
mod state;

#[cfg(test)]
mod state_tests;
