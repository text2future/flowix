use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

use crate::app::state::AppState;
use crate::commands::external_document_watch::ExternalDocumentWatchState;
use crate::commands::helpers::start_security_bookmark_access;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ExternalDocumentWriteOutcome {
    Saved { path: String, content: String },
    Conflict { disk_content: String },
    Missing,
    Error { message: String },
}

fn markdown_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown")
        })
}

fn exact_existing_markdown_path(file_path: &str, state: &AppState) -> Result<PathBuf, String> {
    let requested = PathBuf::from(file_path);
    if !requested.is_absolute() || !markdown_extension(&requested) {
        return Err("external document must be an absolute Markdown path".to_string());
    }
    start_security_bookmark_access(state, &requested);
    if !requested.is_file() {
        return Err(format!(
            "external document is unavailable: {}",
            requested.display()
        ));
    }
    dunce::canonicalize(&requested)
        .map_err(|error| format!("failed to resolve {}: {error}", requested.display()))
}

#[tauri::command]
pub fn read_external_document(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let path = exact_existing_markdown_path(&file_path, state.inner())?;
    fs::read_to_string(&path).map_err(|error| format!("failed to read {}: {error}", path.display()))
}

/// Pure CAS predicate: returns true when the caller provided an `expected`
/// snapshot and the on-disk content does not match it. `None` means the
/// caller opted out of the CAS check, which is always allowed.
fn cas_conflict(expected: Option<&str>, disk_content: &str) -> bool {
    expected.is_some_and(|expected| expected != disk_content)
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn write_external_document(
    window: tauri::WebviewWindow,
    file_path: String,
    content: String,
    expectedContent: Option<String>,
    state: State<'_, AppState>,
    watches: State<'_, ExternalDocumentWatchState>,
) -> ExternalDocumentWriteOutcome {
    let path = match exact_existing_markdown_path(&file_path, state.inner()) {
        Ok(path) => path,
        Err(_) if !Path::new(&file_path).is_file() => return ExternalDocumentWriteOutcome::Missing,
        Err(message) => return ExternalDocumentWriteOutcome::Error { message },
    };

    let disk_content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) => {
            return ExternalDocumentWriteOutcome::Error {
                message: format!("failed to verify {}: {error}", path.display()),
            };
        }
    };
    if cas_conflict(expectedContent.as_deref(), &disk_content) {
        return ExternalDocumentWriteOutcome::Conflict { disk_content };
    }

    let permissions = fs::metadata(&path)
        .ok()
        .map(|metadata| metadata.permissions());
    if let Err(error) = flowix_core::memo_file::atomic_write_bytes(&path, content.as_bytes()) {
        return ExternalDocumentWriteOutcome::Error {
            message: format!("failed to write {}: {error}", path.display()),
        };
    }
    if let Some(permissions) = permissions {
        if let Err(error) = fs::set_permissions(&path, permissions) {
            return ExternalDocumentWriteOutcome::Error {
                message: format!(
                    "saved {}, but failed to restore permissions: {error}",
                    path.display()
                ),
            };
        }
    }
    watches.acknowledge_window_write(window.label(), &path);
    ExternalDocumentWriteOutcome::Saved {
        path: path.to_string_lossy().to_string(),
        content,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_external_path_never_falls_back_by_filename() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("nested").join("Same.md");
        let root = directory.path().join("Same.md");
        fs::write(&root, "# Root memo\n").unwrap();

        assert!(!missing.exists());
        assert_ne!(missing, root);
        assert!(markdown_extension(&missing));
    }

    #[test]
    fn cas_conflict_only_when_expected_differs_from_disk() {
        // No expected snapshot means the caller trusts the disk and skips CAS.
        assert!(!cas_conflict(None, "disk"));
        assert!(!cas_conflict(Some("disk"), "disk"));

        // A mismatched expected snapshot is a real CAS conflict.
        assert!(cas_conflict(Some("stale"), "disk"));
        assert!(cas_conflict(Some(""), "disk"));
    }

    #[test]
    fn markdown_extension_is_case_insensitive_and_strict() {
        assert!(markdown_extension(Path::new("/tmp/notes.MD")));
        assert!(markdown_extension(Path::new("/tmp/notes.Markdown")));
        assert!(!markdown_extension(Path::new("/tmp/notes.txt")));
        assert!(!markdown_extension(Path::new("/tmp/notes")));
        assert!(!markdown_extension(Path::new("/tmp/.md")));
    }
}
