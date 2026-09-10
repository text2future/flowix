//! Host-owned artifact identity and loading.
//!
//! A plugin may produce an artifact, but it does not own the artifact's
//! identity or its ability to be opened later. Pointer memos are the durable
//! reference; this module reads that reference and the backing file without
//! requiring the producing plugin to be installed.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use crate::config::path_is_inside;
use crate::lock_utils::read_lock;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArtifactPointer {
    pub(crate) path: String,
    pub(crate) format: String,
    pub(crate) parser: String,
    pub(crate) renderer: String,
    pub(crate) title: String,
    #[serde(alias = "content_hash")]
    pub(crate) content_hash: String,
    #[serde(alias = "created_at")]
    pub(crate) created_at: String,
    #[serde(default)]
    pub(crate) source_note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ArtifactPointerMemo {
    #[serde(alias = "flowixNoteType")]
    pub(crate) flowix_note_type: String,
    #[serde(alias = "flowixPlugin")]
    pub(crate) flowix_plugin: String,
    #[serde(alias = "flowixPluginVersion")]
    pub(crate) flowix_plugin_version: String,
    #[serde(alias = "flowixArtifact")]
    pub(crate) flowix_artifact: ArtifactPointer,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSession {
    pub pointer_memo_id: String,
    pub plugin_id: String,
    pub plugin_version: String,
    pub path: String,
    pub name: String,
    pub created_at: String,
    pub format: String,
    pub parser: String,
    pub renderer: String,
    pub content: Option<String>,
    pub note_id: Option<String>,
    pub status: String,
    pub plugin_available: bool,
    pub error: Option<String>,
}

fn sha256_hex(content: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

fn artifact_hash_matches(expected: &str, content: &str) -> bool {
    if expected.is_empty() || expected == format!("sha256:{}", sha256_hex(content)) {
        return true;
    }

    // Older writers appended one newline after hashing the canonical content.
    // Keep those artifacts readable without accepting arbitrary differences.
    content.strip_suffix('\n').is_some_and(|legacy| {
        expected == format!("sha256:{}", sha256_hex(legacy.trim_end_matches('\r')))
    })
}

fn is_valid_plugin_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().enumerate().all(|(index, ch)| {
            (ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' || ch == '_')
                && (index > 0 || ch.is_ascii_lowercase())
        })
}

fn is_safe_relative_path(path: &Path) -> bool {
    !path.is_absolute()
        && !path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| !matches!(component, std::path::Component::ParentDir))
}

fn is_allowed_artifact_path(relative: &Path, plugin_id: &str) -> bool {
    let new_prefix = Path::new(".flowix").join("plugin").join(plugin_id);
    let legacy_prefix = Path::new(".plugin-output").join(plugin_id);
    relative.starts_with(&new_prefix) || relative.starts_with(&legacy_prefix)
}

fn artifact_candidates(
    notebook: &Path,
    plugin_id: &str,
    relative: &str,
) -> Result<Vec<PathBuf>, String> {
    if !is_valid_plugin_id(plugin_id) {
        return Err("artifact plugin id is invalid".to_string());
    }
    let relative_path = Path::new(relative);
    if !is_safe_relative_path(relative_path) || !is_allowed_artifact_path(relative_path, plugin_id)
    {
        return Err("artifact path is outside the host-owned plugin output directory".to_string());
    }

    let mut relatives = vec![relative.to_string()];
    let legacy_prefix = format!(".plugin-output/{plugin_id}/");
    if let Some(suffix) = relative.strip_prefix(&legacy_prefix) {
        relatives.push(format!(".flowix/plugin/{plugin_id}/{suffix}"));
    }
    let new_prefix = format!(".flowix/plugin/{plugin_id}/");
    if let Some(suffix) = relative.strip_prefix(&new_prefix) {
        relatives.push(format!(".plugin-output/{plugin_id}/{suffix}"));
    }

    let mut candidates = Vec::new();
    for relative in relatives {
        let candidate = notebook.join(relative);
        if !path_is_inside(&candidate, notebook) {
            return Err("artifact path escaped notebook root".to_string());
        }
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    Ok(candidates)
}

fn pointer_from_note(raw_note: &str) -> Result<ArtifactPointerMemo, String> {
    let yaml = raw_note
        .strip_prefix("---\n")
        .and_then(|value| value.split_once("\n---"))
        .map(|(yaml, _)| yaml)
        .ok_or_else(|| "artifact pointer is missing YAML frontmatter".to_string())?;
    serde_yaml::from_str(yaml).map_err(|error| format!("invalid artifact pointer: {error}"))
}

/// Remove host metadata from a markdown/HTML/text artifact. JSON artifacts
/// normally have no host frontmatter, but applying this defensively keeps old
/// files readable if they were written through the markdown envelope.
fn artifact_body(raw: &str) -> String {
    raw.strip_prefix("---\n")
        .and_then(|value| value.split_once("\n---"))
        .map(|(_, body)| body.trim_start_matches(['\r', '\n']).to_string())
        .unwrap_or_else(|| raw.to_string())
}

/// Resolve a pointer memo without loading a plugin descriptor. The descriptor
/// is only probed to report availability; it is never required to read the
/// durable artifact file.
pub fn resolve(
    memo_id: &str,
    memo_file: &Arc<RwLock<flowix_core::memo_file::MemoFile>>,
) -> Result<ArtifactSession, String> {
    let memo_file_guard = read_lock(memo_file, "memo_file");
    let (entry, raw_note) = memo_file_guard
        .read_memo_with_body_global(memo_id)
        .ok_or_else(|| format!("artifact pointer not found: {memo_id}"))?;
    let notebook = memo_file_guard
        .resolve_memo_location(memo_id)
        .map_err(|error| format!("resolve artifact pointer: {error}"))?
        .map(|location| PathBuf::from(location.notebook.path))
        .ok_or_else(|| format!("artifact pointer not found: {memo_id}"))?;
    drop(memo_file_guard);

    let pointer_memo = pointer_from_note(&raw_note)?;
    let pointer = &pointer_memo.flowix_artifact;
    let candidates = artifact_candidates(&notebook, &pointer_memo.flowix_plugin, &pointer.path)?;
    let artifact_path = candidates.iter().find(|path| path.is_file()).cloned();
    let plugin_available = crate::plugin::get_plugin(&pointer_memo.flowix_plugin).is_ok();
    let path = artifact_path
        .clone()
        .unwrap_or_else(|| notebook.join(&pointer.path));

    let (content, status, error) = match artifact_path {
        Some(path) => match fs::read_to_string(&path) {
            Ok(raw_artifact) => {
                let content = artifact_body(&raw_artifact);
                let hash_matches = artifact_hash_matches(&pointer.content_hash, &content);
                if !hash_matches {
                    (
                        Some(content),
                        "invalid".to_string(),
                        Some("artifact content hash does not match its pointer".to_string()),
                    )
                } else if plugin_available {
                    (Some(content), "ready".to_string(), None)
                } else {
                    (
                        Some(content),
                        "unavailable".to_string(),
                        Some(
                            "the producing plugin is unavailable; showing the stored artifact"
                                .to_string(),
                        ),
                    )
                }
            }
            Err(error) => (
                None,
                "unavailable".to_string(),
                Some(format!("read artifact: {error}")),
            ),
        },
        None => (
            None,
            "missing".to_string(),
            Some("artifact file is missing; pointer metadata is still available".to_string()),
        ),
    };

    Ok(ArtifactSession {
        pointer_memo_id: memo_id.to_string(),
        plugin_id: pointer_memo.flowix_plugin,
        plugin_version: pointer_memo.flowix_plugin_version,
        path: path.to_string_lossy().to_string(),
        name: if pointer.title.trim().is_empty() {
            entry.filename.trim_end_matches(".md").to_string()
        } else {
            pointer.title.clone()
        },
        created_at: pointer.created_at.clone(),
        format: pointer.format.clone(),
        parser: pointer.parser.clone(),
        renderer: pointer.renderer.clone(),
        content,
        note_id: Some(entry.id),
        status,
        plugin_available,
        error,
    })
}

/// Return the backing file for pointer-memo deletion. This remains host-owned
/// so uninstalling a producer plugin does not strand its artifact forever.
pub fn path_for_memo(
    memo_id: &str,
    memo_file: &Arc<RwLock<flowix_core::memo_file::MemoFile>>,
) -> Result<Option<PathBuf>, String> {
    let memo_file_guard = read_lock(memo_file, "memo_file");
    let Some((_, raw_note)) = memo_file_guard.read_memo_with_body_global(memo_id) else {
        return Ok(None);
    };
    let notebook = memo_file_guard
        .resolve_memo_location(memo_id)
        .map_err(|error| format!("resolve artifact pointer for deletion: {error}"))?
        .map(|location| PathBuf::from(location.notebook.path));
    drop(memo_file_guard);
    let Some(notebook) = notebook else {
        return Ok(None);
    };
    let Ok(pointer_memo) = pointer_from_note(&raw_note) else {
        return Ok(None);
    };
    let candidates = artifact_candidates(
        &notebook,
        &pointer_memo.flowix_plugin,
        &pointer_memo.flowix_artifact.path,
    )?;
    Ok(candidates
        .iter()
        .find(|path| path.is_file())
        .cloned()
        .or_else(|| candidates.into_iter().next()))
}

pub fn remove_path(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("remove artifact: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{artifact_body, artifact_candidates, artifact_hash_matches, sha256_hex};
    use std::path::Path;

    #[test]
    fn strips_host_frontmatter_without_losing_artifact_content() {
        assert_eq!(
            artifact_body("---\nflowixPlugin: mindmap\n---\n\n# Root\n"),
            "# Root\n"
        );
        assert_eq!(
            artifact_body("{\"title\":\"Root\"}"),
            "{\"title\":\"Root\"}"
        );
    }

    #[test]
    fn accepts_only_plugin_output_paths() {
        let notebook = Path::new("/tmp/notebook");
        assert!(
            artifact_candidates(notebook, "mindmap", ".flowix/plugin/mindmap/output.md").is_ok()
        );
        assert!(artifact_candidates(notebook, "mindmap", "other/output.md").is_err());
        assert!(
            artifact_candidates(notebook, "mindmap", ".flowix/plugin/mindmap/../secret.md")
                .is_err()
        );
    }

    #[test]
    fn accepts_legacy_trailing_newline_but_rejects_content_changes() {
        let content = "# Root\n\n## Branch";
        let expected = format!("sha256:{}", sha256_hex(content));

        assert!(artifact_hash_matches(&expected, content));
        assert!(artifact_hash_matches(&expected, &format!("{content}\n")));
        assert!(!artifact_hash_matches(&expected, "# Changed"));
        assert!(!artifact_hash_matches(&expected, &format!("{content}\n\n")));
    }
}
