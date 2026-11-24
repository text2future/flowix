//! Cheap notify-callback filtering plus stable revision state.
//!
//! The callback only applies `PathFilter`. Content-based self-write
//! reconciliation and duplicate revision suppression run later on the worker,
//! after the Markdown file has settled.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use super::event::{FilterDecision, RawFsEvent};

pub mod path_filter;
pub mod self_write;

pub use path_filter::PathFilter;

/// Maximum lifetime of an expected backend-write revision that has not yet
/// been observed by the worker.
pub const SELF_WRITE_TTL: Duration = Duration::from_secs(30);
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileRevision([u8; 32]);

impl FileRevision {
    pub fn from_bytes(bytes: &[u8]) -> Self {
        Self(Sha256::digest(bytes).into())
    }

    pub fn read(path: &std::path::Path) -> Option<Self> {
        let bytes = std::fs::read(path).ok()?;
        Some(Self::from_bytes(&bytes))
    }

    /// Indexed resources use a stat revision so observing a large file never
    /// reads its contents on the watcher worker.
    pub fn read_metadata(path: &std::path::Path) -> Option<Self> {
        let metadata = std::fs::metadata(path).ok()?;
        let modified = metadata
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?;
        let mut digest = Sha256::new();
        digest.update(metadata.len().to_le_bytes());
        digest.update(modified.as_nanos().to_le_bytes());
        Some(Self(digest.finalize().into()))
    }
}

#[derive(Clone, Debug)]
pub struct SelfWriteMark {
    pub marked_at: Instant,
    pub expected_revision: Option<FileRevision>,
}

pub type SelfWriteMap = HashMap<PathBuf, SelfWriteMark>;

/// Reserved path-filter context.
pub struct FilterCtx;

impl FilterCtx {
    pub fn new() -> Self {
        Self
    }
}

/// Filter trait —一段�?�? 返回 Pass / PassMutated / Drop�?
pub trait Filter: Send + Sync {
    /// `event` �?��参事�? 返回 `FilterDecision` 决定去向�?
    fn decide(&self, event: &RawFsEvent, ctx: &mut FilterCtx) -> FilterDecision;
}

/// Apply only callback-safe path filtering. Revision logic belongs to worker.
pub fn run_pipeline(event: &RawFsEvent, path_filter: &PathFilter) -> FilterDecision {
    let mut ctx = FilterCtx::new();
    path_filter.decide(event, &mut ctx)
}
