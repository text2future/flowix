//! Legacy memo-ID records and metadata stored in the notebook-local database.
//!
//! The Note projection is path-keyed in `note_index`; this module remains
//! for callers and records that still require memo IDs. Older global rows are
//! imported from the user-level registry database during notebook setup.

use std::fs;
use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use super::derivation::{extract_agent_threads_from_body, extract_thumbnail};
use super::frontmatter::extract_frontmatter_properties;
use super::notebook::sqlite_to_io;
use super::types::{
    AgentThreadItem, Memo, MemoColor, MemoIndexEntry, MemoIndexFile, MemoLocation, MemoTodoEntry,
    NotebookConfig, TodoItem,
};
use super::MemoFile;

/// Durable identity of the latest committed bytes for one memo.
///
/// `revision` is a local, monotonically increasing counter. `change_id`
/// identifies one concrete content transition and is stable when duplicate
/// filesystem notifications observe the same bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoContentRevision {
    pub memo_id: String,
    pub notebook_id: String,
    pub content_hash: String,
    pub revision: i64,
    pub change_id: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoContentCommit {
    pub state: MemoContentRevision,
    pub changed: bool,
}

/// Path-keyed successor of [`MemoContentRevision`]. The revision stream is
/// addressed by `(notebook_id, relative_path)` instead of a legacy memo ID,
/// so renames must carry the row over (see rename/move flows).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteContentRevision {
    pub notebook_id: String,
    pub relative_path: String,
    pub content_hash: String,
    pub revision: i64,
    pub change_id: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteContentCommit {
    pub state: NoteContentRevision,
    pub changed: bool,
}

// Pending markers only bridge a live Desktop watcher and a concurrent CLI/MCP
// process. Expiry prevents an offline create from being mistaken for a create
// when that document is edited much later.
const EXTERNAL_CREATE_MARKER_TTL_MS: i64 = 60_000;

fn color_to_str(color: MemoColor) -> &'static str {
    match color {
        MemoColor::Red => "red",
        MemoColor::Orange => "orange",
        MemoColor::Yellow => "yellow",
        MemoColor::Green => "green",
        MemoColor::Cyan => "cyan",
        MemoColor::Blue => "blue",
        MemoColor::Gray => "gray",
    }
}

fn color_from_str(value: &str) -> Option<MemoColor> {
    match value {
        "red" => Some(MemoColor::Red),
        "orange" => Some(MemoColor::Orange),
        "yellow" => Some(MemoColor::Yellow),
        "green" => Some(MemoColor::Green),
        "cyan" => Some(MemoColor::Cyan),
        "blue" => Some(MemoColor::Blue),
        "gray" => Some(MemoColor::Gray),
        _ => None,
    }
}

fn tag_path_prefixes(path: &str) -> Vec<String> {
    let segments: Vec<&str> = path.split('/').collect();
    (1..=segments.len())
        .map(|end| segments[..end].join("/"))
        .collect()
}

mod persistence;
mod repository;
mod schema;
mod tags;
mod todos;
