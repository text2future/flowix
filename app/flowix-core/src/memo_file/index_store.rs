//! Notebook-relative-path projection stored in the notebook-local database.
//!
//! The separate Note catalog in `note_index` tracks filesystem metadata. This
//! module stores the content-derived listing fields used by memo surfaces.

use std::fs;
use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use super::derivation::{extract_agent_threads_from_body, extract_thumbnail};
use super::frontmatter::extract_frontmatter_properties;
use super::notebook::sqlite_to_io;
use super::types::{
    AgentThreadItem, Memo, MemoIndexEntry, MemoIndexFile, MemoLocation, NoteColor, NotebookConfig,
};
use super::MemoFile;

/// Path-keyed content revision for a note. The revision stream is
/// addressed by `(notebook_id, relative_path)`,
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

fn color_to_str(color: NoteColor) -> &'static str {
    match color {
        NoteColor::Red => "red",
        NoteColor::Orange => "orange",
        NoteColor::Yellow => "yellow",
        NoteColor::Green => "green",
        NoteColor::Cyan => "cyan",
        NoteColor::Blue => "blue",
        NoteColor::Gray => "gray",
    }
}

fn color_from_str(value: &str) -> Option<NoteColor> {
    match value {
        "red" => Some(NoteColor::Red),
        "orange" => Some(NoteColor::Orange),
        "yellow" => Some(NoteColor::Yellow),
        "green" => Some(NoteColor::Green),
        "cyan" => Some(NoteColor::Cyan),
        "blue" => Some(NoteColor::Blue),
        "gray" => Some(NoteColor::Gray),
        _ => None,
    }
}

mod persistence;
mod repository;
mod schema;
mod tags;
