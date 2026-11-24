use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::SyncError;

#[derive(Clone)]
pub struct SyncStore {
    path: PathBuf,
    schema_ready: std::sync::Arc<std::sync::atomic::AtomicBool>,
    schema_lock: std::sync::Arc<std::sync::Mutex<()>>,
}

mod account;
mod path_notebooks;
mod remote;
mod schema;
mod v4;

#[cfg(test)]
mod v4_tests;
