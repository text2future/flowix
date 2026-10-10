//! Memo and document IPC commands.
//!
//! Note file CRUD addresses Markdown by notebook-relative path. Internal IDs
//! remain temporarily in compatibility projections, version history, and cloud
//! association while their callers migrate independently.
//!
//! File layout (split from the original 1414-line `commands/memo.rs` because
//! the file carried five distinct sub-domains):
//!
//! - [`helpers`] 鈥?shared functions used by every other section
//!   (`read_memo_or_none`, `cas_content_matches`, etc.) plus the unit tests
//!   for `cas_content_matches`.
//! - [`reads`]   鈥?read-only IPC: list / search / get_memos / read_document /
//!   mention / todo metadata / version listing.
//! - [`creates`] 鈥?create / import / template and move commands.
//! - [`versions`] 鈥?memo version history (list / read / create / restore).
//! - [`deletes`] 鈥?delete commands.
//!
//! Shared response / item structs that cross section boundaries live here at
//! the `memo::` namespace level so siblings can `use super::*` to grab them.
//! `#[tauri::command]` functions are registered through their concrete
//! submodule paths in `app::bootstrap`, because the command macro wrappers live
//! beside the original function definitions.

pub mod creates;
pub mod deletes;
pub(crate) mod helpers;
pub mod reads;
pub mod versions;

// `helpers` is `pub(crate)`: memo commands access it via `super::helpers`.
pub use reads::*;

use serde::Serialize;

use flowix_core::memo_file::{Memo, NoteEntry};

// Shared response / item structs 鈹€鈹€ referenced by multiple sections below.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetPathNotesResponse {
    pub notes: Vec<NoteEntry>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
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
