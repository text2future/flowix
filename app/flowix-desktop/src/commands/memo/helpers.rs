// ==================== Helpers ====================
//
// Helpers shared by every other section in this module. Marked
// `pub(super)` so the sibling sections (`reads`, `creates`, `versions`,
// `deletes`) can call them directly. They are re-exported via
// `pub use helpers::*` in `mod.rs` so the `mod.rs` `use super::helpers::*`
// for cross-section access keeps working without re-imports.

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

use super::AppState;
use crate::commands::helpers::{
    force_rebuild_index, mark_self_write_for, rebuild_index_in_background,
    start_security_bookmark_access, synthesize_minimal_memo, try_index_remove, try_index_upsert,
};

use super::*;
pub(super) fn read_memo_or_none(state: &AppState, id: &str) -> Option<Memo> {
    read_lock(&state.memo_file, "memo_file").read_memo_global(id)
}

pub(super) fn current_notebook_id(state: &AppState) -> String {
    read_lock(&state.memo_file, "memo_file")
        .current_notebook_id_value()
        .unwrap_or_else(|| "nb_default".to_string())
}

pub(super) fn notebook_id_for_memo(state: &AppState, id: &str) -> String {
    read_lock(&state.memo_file, "memo_file")
        .resolve_memo_location(id)
        .ok()
        .flatten()
        .map(|location| location.notebook.id)
        .unwrap_or_else(|| current_notebook_id(state))
}

/// Resolve the physical file path for an event payload.
pub(super) fn abs_path_for(state: &AppState, id: &str) -> String {
    read_lock(&state.memo_file, "memo_file")
        .find_memo_file_path(id)
        .map(|p| p.display().to_string())
        .unwrap_or_default()
}

pub(super) fn emit_updated_memo_event(
    state: &AppState,
    app: &AppHandle,
    id: &str,
    path: String,
    memo: Memo,
    notebook_id: String,
    derived_changed: MemoDerivedChanged,
    source: MemoChangeSource,
) {
    try_index_upsert(state, id);
    memo_events::emit(
        app,
        MemoEvent::Updated {
            id: id.to_string(),
            path,
            notebook_id,
            memo,
            derived_changed,
            source,
        },
    );
}

/// Mark the written file, refresh the search index, and notify the UI.
pub(super) fn emit_updated_after_write(
    state: &AppState,
    app: &AppHandle,
    id: &str,
    before: Option<Memo>,
) {
    let path = abs_path_for(state, id);
    if !path.is_empty() {
        mark_self_write_for(app, Path::new(&path));
    }
    let memo = read_memo_or_none(state, id).unwrap_or_else(|| synthesize_minimal_memo(id));
    let notebook_id = notebook_id_for_memo(state, id);
    let derived_changed = MemoDerivedChanged::from_memos(before.as_ref(), &memo);
    emit_updated_memo_event(
        state,
        app,
        id,
        path,
        memo,
        notebook_id,
        derived_changed,
        MemoChangeSource::UserEdit,
    );
}

/// Lightweight CAS fallback normalization.
///
/// The fast path stays byte-for-byte equality. This is only used after that
/// fails, to tolerate editor serialization noise that does not change the
/// document body meaning: CRLF/LF, frontmatter rewrite, line-end spaces, and
/// empty paragraphs represented as `&nbsp;`/NBSP.
pub(super) fn normalize_markdown_for_cas(content: &str) -> String {
    let lf = content.replace("\r\n", "\n").replace('\r', "\n");
    let body = extract_body_content(&lf);
    let mut out = String::new();
    let mut pending_blank = false;
    let mut wrote_line = false;

    for raw_line in body.lines() {
        let line = raw_line.trim_end();
        let marker = line.trim();
        let is_blank = marker.is_empty() || marker == "&nbsp;" || marker == "\u{00a0}";

        if is_blank {
            pending_blank = true;
            continue;
        }

        if wrote_line {
            out.push('\n');
            if pending_blank {
                out.push('\n');
            }
        }

        out.push_str(line);
        wrote_line = true;
        pending_blank = false;
    }

    out
}

pub(super) fn cas_content_matches(current: &str, expected: &str, incoming: &str) -> bool {
    if current == expected || current == incoming {
        return true;
    }

    normalize_markdown_for_cas(current) == normalize_markdown_for_cas(expected)
}

pub(super) fn note_title(filename: &str) -> String {
    filename
        .strip_suffix(".md")
        .or_else(|| filename.strip_suffix(".MD"))
        .unwrap_or(filename)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::cas_content_matches;

    #[test]
    fn cas_accepts_markdown_serialization_noise() {
        let current = "---\nkey: abc123\n---\r\n\r\n# Title\r\n&nbsp;\r\nBody  \r\n";
        let expected = "---\nkey: oldkey\n---\n\n# Title\n\nBody\n";
        let incoming = "---\nkey: abc123\n---\n\n# Title\n&nbsp;\nBody\n";

        assert!(cas_content_matches(current, expected, incoming));
    }

    #[test]
    fn cas_rejects_real_body_change() {
        let current = "---\nkey: abc123\n---\n\n# Title\nChanged\n";
        let expected = "---\nkey: abc123\n---\n\n# Title\nBody\n";
        let incoming = "---\nkey: abc123\n---\n\n# Title\nBody plus local edit\n";

        assert!(!cas_content_matches(current, expected, incoming));
    }

    #[test]
    fn cas_accepts_idempotent_incoming_content() {
        let current = "# Title\n\nBody\n";
        let expected = "# Title\n\nOld body\n";
        let incoming = "# Title\n\nBody\n";

        assert!(cas_content_matches(current, expected, incoming));
    }

    #[test]
    fn cas_accepts_frontmatter_body_leading_blank_drift() {
        let current = "---\nkey: d7ngibb3\n---\n\n# 2026-07-05\n";
        let expected = "---\nkey: d7ngibb3\n---\n# 2026-07-05\n";
        let incoming = "---\nkey: d7ngibb3\n---\n\n\n# 2026-07-05\n\n你好";

        assert!(cas_content_matches(current, expected, incoming));
    }
}
