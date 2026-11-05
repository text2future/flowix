//! Rebuildable document references. Saving only dirties a source; extraction is
//! explicit background work. Targets are resolved against notes at query time.
mod parser;
mod queries;
mod store;
#[cfg(test)]
mod tests;

use serde::Serialize;
pub(crate) use store::{foreground_save, initialize_schema, remember_snapshot};

pub(crate) const PARSER_VERSION: i64 = 2;
pub(crate) const SCHEMA_VERSION: &str = "2";
pub(crate) const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
const MAX_REFERENCES: usize = 50_000;
const MAX_UNIQUE_REFERENCES: usize = 4096;
const MAX_DESTINATION_BYTES: usize = 8192;

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub(crate) struct Reference {
    pub syntax: String,
    pub kind: String,
    pub target_kind: String,
    pub target_key: String,
    pub lookup_key: String,
    pub count: u32,
}

pub(crate) fn lookup_key(kind: &str, key: &str) -> String {
    if kind == "wiki" {
        key.to_lowercase()
    } else if cfg!(windows) {
        key.to_ascii_lowercase()
    } else {
        key.to_owned()
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteLink {
    pub source_path: String,
    pub syntax: String,
    pub link_kind: String,
    pub target_kind: String,
    pub target_key: String,
    pub reference_count: u32,
    pub resolved_path: Option<String>,
    /// resolved, missing, ambiguous, or index-pending.
    pub resolution: String,
    pub fresh: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteLinkPage {
    pub links: Vec<NoteLink>,
    /// Outlinks: distinguishes an indexed empty document from pending work.
    /// Backlinks span multiple sources, so this is None.
    pub source_fresh: Option<bool>,
    /// Opaque cursor. Queries never reconcile the filesystem.
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteLinkStatus {
    pub pending: u64,
    pub failed: u64,
    pub indexed: u64,
}

#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteLinkBatch {
    pub processed: usize,
    pub changed: usize,
    pub failed: usize,
    pub pending: bool,
    pub retry_after_ms: Option<u64>,
}
