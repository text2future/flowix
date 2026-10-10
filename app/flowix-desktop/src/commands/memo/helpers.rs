// ==================== Helpers ====================
//
// Helpers shared by every other section in this module. Marked
// `pub(super)` so the sibling sections (`reads`, `creates`, `versions`,
// `deletes`) can call them directly without leaking them outside `memo`.

use tauri::AppHandle;

use crate::document_mutation::DocumentCommit;
use crate::lock_utils::read_lock;
use crate::memo_events::{self, MemoChangeSource, MemoDerivedChanged, MemoEvent};
use flowix_core::memo_file::{extract_body_content, is_system_frontmatter_key, Memo};

use crate::app::state::AppState;
pub(super) use crate::commands::helpers::notebook_note_address;

pub(super) fn current_notebook_id(state: &AppState) -> String {
    read_lock(&state.memo_file, "memo_file")
        .current_notebook_id_value()
        .unwrap_or_else(|| "nb_default".to_string())
}

pub(super) fn emit_updated_memo_event(
    app: &AppHandle,
    id: &str,
    path: String,
    memo: Memo,
    notebook_id: String,
    derived_changed: MemoDerivedChanged,
    source: MemoChangeSource,
    origin_window_label: Option<&str>,
) -> Option<DocumentCommit> {
    crate::document_derived::schedule(app, id);
    memo_events::emit_with_commit_from_window(
        app,
        MemoEvent::Updated {
            id: id.to_string(),
            path,
            notebook_id,
            memo,
            derived_changed,
            source,
        },
        origin_window_label,
    )
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

fn code_content_for_cas(content: &str) -> Vec<String> {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let mut fence: Option<(char, usize)> = None;
    let mut lines = Vec::new();
    for line in extract_body_content(&normalized).lines() {
        let trimmed = line.trim_start_matches(' ');
        let indentation = line.len() - trimmed.len();
        if let Some((marker, length)) = fence {
            lines.push(line.to_string());
            let run = trimmed.chars().take_while(|value| *value == marker).count();
            if indentation <= 3 && run >= length && trimmed[run..].trim().is_empty() {
                fence = None;
            }
        } else if indentation <= 3 && (trimmed.starts_with("```") || trimmed.starts_with("~~~")) {
            let marker = trimmed.chars().next().unwrap_or('`');
            let length = trimmed.chars().take_while(|value| *value == marker).count();
            fence = Some((marker, length));
            lines.push(line.to_string());
        } else if indentation >= 4 || line.starts_with('\t') {
            lines.push(line.to_string());
        }
    }
    lines
}

pub(super) fn cas_content_matches(current: &str, expected: &str, incoming: &str) -> bool {
    let current = flowix_core::memo_file::normalize_markdown_encoding_boundaries(current);
    let expected = flowix_core::memo_file::normalize_markdown_encoding_boundaries(expected);
    let incoming = flowix_core::memo_file::normalize_markdown_encoding_boundaries(incoming);
    let current = current.as_ref();
    let expected = expected.as_ref();
    let incoming = incoming.as_ref();
    if current == expected || current == incoming {
        return true;
    }

    let metadata = |content: &str| {
        flowix_core::memo_file::extract_document_metadata(content)
            .ok()
            .map(|mut metadata| {
                if let Some(properties) = metadata.properties.as_object_mut() {
                    for key in properties.keys().cloned().collect::<Vec<_>>() {
                        if is_system_frontmatter_key(&key) {
                            properties.remove(&key);
                        }
                    }
                }
                metadata
            })
    };
    matches!((metadata(current), metadata(expected)), (Some(current), Some(expected)) if current == expected)
        && code_content_for_cas(current) == code_content_for_cas(expected)
        && normalize_markdown_for_cas(current) == normalize_markdown_for_cas(expected)
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
    fn cas_rejects_frontmatter_only_changes() {
        let current = "---\nflowix_key: note\nstatus: changed\n---\n# Title\n";
        let expected = "---\nflowix_key: note\nstatus: original\n---\n# Title\n";
        assert!(!cas_content_matches(current, expected, "# Title\nnew body"));
    }

    #[test]
    fn cas_preserves_significant_code_whitespace() {
        assert!(!cas_content_matches(
            "```\nvalue  \n```",
            "```\nvalue\n```",
            "updated"
        ));
        assert!(!cas_content_matches(
            "~~~\n\n\nvalue\n~~~",
            "~~~\n\nvalue\n~~~",
            "updated"
        ));
        assert!(!cas_content_matches("    value  ", "    value", "updated"));
    }

    #[test]
    fn cas_does_not_treat_invalid_metadata_as_empty() {
        let current = "---\nstatus: [broken\n---\n# Title\n";
        let expected = "---\nflowix_key: note\n---\n# Title\n";
        assert!(!cas_content_matches(current, expected, "# Title\nnew body"));
    }

    #[test]
    fn cas_accepts_markdown_serialization_noise() {
        let current = "---\nflowix_key: abc123\nkey: legacy-current\n---\r\n\r\n# Title\r\n&nbsp;\r\nBody  \r\n";
        let expected = "---\nflowix_key: oldkey\nkey: legacy-expected\n---\n\n# Title\n\nBody\n";
        let incoming = "---\nflowix_key: abc123\n---\n\n# Title\n&nbsp;\nBody\n";

        assert!(cas_content_matches(current, expected, incoming));
    }

    #[test]
    fn cas_rejects_real_body_change() {
        let current = "---\nflowix_key: abc123\n---\n\n# Title\nChanged\n";
        let expected = "---\nflowix_key: abc123\n---\n\n# Title\nBody\n";
        let incoming = "---\nflowix_key: abc123\n---\n\n# Title\nBody plus local edit\n";

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
    fn cas_accepts_legacy_bom_boundary_normalization() {
        let current = "---\nflowix_key: abc123\n---\n\u{FEFF}Body\n";
        let expected = "---\nflowix_key: abc123\n---\nBody\n";
        let incoming = "---\nflowix_key: abc123\n---\nEdited body\n";

        assert!(cas_content_matches(current, expected, incoming));
    }

    #[test]
    fn cas_accepts_frontmatter_body_leading_blank_drift() {
        let current = "---\nflowix_key: d7ngibb3\n---\n\n# 2026-07-05\n";
        let expected = "---\nflowix_key: d7ngibb3\n---\n# 2026-07-05\n";
        let incoming = "---\nflowix_key: d7ngibb3\n---\n\n\n# 2026-07-05\n\n浣犲ソ";

        assert!(cas_content_matches(current, expected, incoming));
    }
}
