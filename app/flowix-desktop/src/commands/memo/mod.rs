//! Memo and document IPC commands.
//!
//! User-facing memo operations resolve globally by memo id. Watcher and
//! reconcile code stay scoped to the current notebook to avoid treating copied
//! files from another notebook as the original memo.
//!
//! File layout (split from the original 1414-line `commands/memo.rs` because
//! the file carried five distinct sub-domains):
//!
//! - [`helpers`] 鈥?shared functions used by every other section
//!   (`read_memo_or_none`, `emit_updated_after_write`, `cas_content_matches`,
//!   etc.) plus the unit tests for `cas_content_matches`.
//! - [`reads`]   鈥?read-only IPC: list / search / get_memos / read_document /
//!   mention / todo metadata / version listing.
//! - [`creates`] 鈥?create / import / template commands, plus single-field
//!   updates (favorite, unfavorite, set_colors, finalize_filename).
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

// `helpers` is `pub(crate)`: memo commands access it via `super::helpers`,
// and `commands::tag` reuses `emit_updated_after_write` for move_memo_tag.
pub use reads::*;

use serde::Serialize;

use flowix_core::memo_file::Memo;
use flowix_core::search::MemoSearchHit;

// Shared response / item structs 鈹€鈹€ referenced by multiple sections below.

#[derive(Serialize)]
pub struct GetMemosResponse {
    pub memos: Vec<Memo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenMemoSessionResponse {
    pub memo: Memo,
    pub notebook_id: String,
    pub notebook_path: String,
    pub path: String,
    pub content: String,
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
