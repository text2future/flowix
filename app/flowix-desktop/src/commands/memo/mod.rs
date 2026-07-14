//! Memo and document IPC commands.
//!
//! User-facing memo operations resolve globally by memo id. Watcher and
//! reconcile code stay scoped to the current notebook to avoid treating copied
//! files from another notebook as the original memo.
//!
//! File layout (split from the original 1414-line `commands/memo.rs` because
//! the file carried five distinct sub-domains):
//!
//! - [`helpers`] — shared functions used by every other section
//!   (`read_memo_or_none`, `emit_updated_after_write`, `cas_content_matches`,
//!   etc.) plus the unit tests for `cas_content_matches`.
//! - [`reads`]   — read-only IPC: list / search / get_memos / read_document /
//!   mention / todo metadata / version listing.
//! - [`creates`] — create / import / template commands, plus single-field
//!   updates (favorite, unfavorite, set_colors, finalize_filename).
//! - [`versions`] — memo version history (list / read / create / restore).
//! - [`deletes`] — delete commands.
//!
//! Shared response / item structs that cross section boundaries live here at
//! the `memo::` namespace level so siblings can `use super::*` to grab them.
//! Every `#[tauri::command]` from any section is re-exported via `pub use`,
//! so `tauri::generate_handler![commands::memo::create_memo]` keeps working
//! unchanged.

pub mod creates;
pub mod deletes;
mod helpers;
pub mod reads;
pub mod versions;

// Re-export all `#[tauri::command]`s and shared helpers so the IPC surface
// at `commands::memo::xxx` is identical to the pre-split flat file.
//
// The `pub mod` declarations above are required because `#[tauri::command]`
// generates per-command wrapper macros (`__cmd__xxx`, `__tauri_command_name_xxx`)
// at the function's module level. `tauri::generate_handler!` then expects
// these wrappers to be reachable at the path passed to it
// (`commands::memo::xxx`); `pub use creates::*;` doesn't reliably re-export
// the macro paths Rust-2018-style, so we keep `creates`, `reads`, `versions`,
// `deletes` as `pub mod` and reference their commands via
// `commands::memo::creates::add_document` etc.
//
// `helpers` stays private because nothing outside `memo/` needs it; commands
// inside `creates` / `reads` / etc. access it via `super::helpers`.
pub use creates::*;
pub use deletes::*;
pub use helpers::*;
pub use reads::*;
pub use versions::*;

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::lock_utils::{read_lock, write_lock};
use crate::memo_events::{self, MemoChangeSource, MemoDerivedChanged, MemoEvent};
use crate::watcher::path::normalize_for_compare;
use crate::USER_CONFIG_DIR_NAME;
use flowix_core::memo_file::{
    atomic_write_bytes, extract_body_content, Memo, MemoColor, MemoFile, MemoTodoEntry,
    MemoVersionMeta, MemoVersionSource,
};
use flowix_core::search::MemoSearchHit;

use super::helpers::{
    force_rebuild_index, mark_self_write_for, rebuild_index_in_background,
    start_security_bookmark_access, synthesize_minimal_memo, try_index_remove, try_index_upsert,
};
use super::AppState;

// Shared response / item structs ── referenced by multiple sections below.

#[derive(Serialize)]
pub struct GetMemosResponse {
    pub memos: Vec<Memo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMemosResponse {
    pub hits: Vec<MemoSearchHit>,
    pub index_ready: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MentionNoteSearchItem {
    pub id: String,
    pub filename: String,
    pub title: String,
    pub updated_at: i64,
    pub notebook_id: String,
    pub notebook_name: String,
    pub notebook_path: String,
    pub original_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRoleMemoItem {
    pub memo_id: String,
    pub role_name: String,
    pub filename: String,
    pub memo_icon: Option<String>,
    pub notebook_id: String,
    pub notebook_name: String,
    pub notebook_icon: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsedMemoTagIdsResponse {
    pub used_tag_ids: Vec<String>,
    pub tag_counts: Vec<MemoTagCount>,
    pub total_memo_count: usize,
    pub agent_memo_count: usize,
    pub todo_memo_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoTagCount {
    pub tag_id: String,
    pub count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoTemplate {
    pub id: String,
    pub name: String,
}
