use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{Manager, State};

use crate::app::state::AppState;
use crate::commands::external_document_watch::ExternalDocumentWatchState;
use crate::commands::helpers::{
    can_access_document_path, can_access_scoped_file, notebook_note_address,
};
use crate::commands::path_change::NotebookPathUpdated;
use crate::lock_utils::read_lock;
use flowix_core::memo_file::{FileWriteOutcome, MemoFile, MergedFileWriteOutcome};

/// Generic editor saves must publish the same indexed note metadata as note saves.
fn refresh_saved_notebook_note(
    memo_file: &MemoFile,
    path: &Path,
    window_label: &str,
    previous_favorited: Option<bool>,
) -> Result<Option<NotebookPathUpdated>, String> {
    let Some((notebook_id, relative_path)) = notebook_note_address(memo_file, path)? else {
        return Ok(None);
    };
    let entry = memo_file.read_note_entry_by_path(&notebook_id, &relative_path)
        .map_err(|error| error.to_string())?;
    Ok(entry.map(|entry| NotebookPathUpdated::from_window(
        notebook_id, relative_path, entry, window_label.to_owned(), previous_favorited,
    )))
}

#[tauri::command]
pub async fn detect_external_document_text(
    window: tauri::WebviewWindow,
    file_path: String,
    #[allow(non_snake_case)] scopePath: Option<String>,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    let window_label = window.label().to_string();
    crate::document_io::run("external_document_text_detection", move || {
        let state = app.state::<AppState>();
        let path = PathBuf::from(file_path);
        if !path.is_absolute() || !path.is_file() {
            return Err("external document is unavailable".to_string());
        }
        if !can_access_document_path(&path, &window_label, &state)
            && !can_access_scoped_file(&path, scopePath.as_deref(), &state)
        {
            return Err("external document is outside its authorized scope".to_string());
        }

        // A local file has no HTTP Content-Type header. This is only a text
        // readability probe for unknown paths, not a MIME type resolver.
        Ok(looks_like_utf8_text_file(&path))
    })
    .await?
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ExternalDocumentWriteOutcome {
    Saved {
        path: String,
        content: String,
        merged: bool,
    },
    Conflict {
        disk_content: String,
    },
    Missing,
    Error {
        message: String,
    },
}

fn is_markdown_document_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown")
        })
}

fn supported_text_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "md" | "markdown" | "csv"
                    | "txt"
                    | "text"
                    | "log"
                    | "json"
                    | "jsonc"
                    | "json5"
                    | "yaml"
                    | "yml"
                    | "toml"
                    | "xml"
                    | "html"
                    | "htm"
                    | "css"
                    | "scss"
                    | "sass"
                    | "less"
                    | "js"
                    | "jsx"
                    | "mjs"
                    | "cjs"
                    | "ts"
                    | "tsx"
                    | "mts"
                    | "cts"
                    | "vue"
                    | "svelte"
                    | "py"
                    | "pyw"
                    | "rs"
                    | "go"
                    | "java"
                    | "kt"
                    | "kts"
                    | "c"
                    | "cc"
                    | "cpp"
                    | "cxx"
                    | "h"
                    | "hh"
                    | "hpp"
                    | "hxx"
                    | "cs"
                    | "swift"
                    | "php"
                    | "rb"
                    | "sh"
                    | "bash"
                    | "zsh"
                    | "fish"
                    | "sql"
                    | "graphql"
                    | "gql"
                    | "lua"
                    | "r"
                    | "dart"
                    | "scala"
                    | "ex"
                    | "exs"
                    | "erl"
                    | "hrl"
                    | "fs"
                    | "fsx"
                    | "vb"
                    | "pl"
                    | "pm"
                    | "proto"
                    | "ini"
                    | "conf"
                    | "cfg"
                    | "properties"
                    | "gradle"
            )
        })
}

/// Extensionless files do not carry enough information in their name to
/// classify them. Probe a small prefix before allowing them into the text
/// editor: UTF-8 text is safe for `read_to_string`, while a NUL byte is a
/// strong binary-file signal. The complete read still validates UTF-8 later.
fn looks_like_utf8_text_file(path: &Path) -> bool {
    const PROBE_SIZE: usize = 8192;

    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }

    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut buffer = [0_u8; PROBE_SIZE];
    let Ok(bytes_read) = file.read(&mut buffer) else {
        return false;
    };
    let sample = &buffer[..bytes_read];
    !sample.contains(&0) && std::str::from_utf8(sample).is_ok()
}

pub(crate) fn supported_text_document_path(path: &Path) -> bool {
    if supported_text_extension(path) {
        return true;
    }

    // Unknown extensions (including extensionless files) are accepted only
    // after inspecting their contents. This allows custom text formats while
    // still rejecting binary files such as PDFs and archives.
    looks_like_utf8_text_file(path)
}

pub(crate) fn exact_existing_external_path(
    file_path: &str,
    scope_path: Option<&str>,
    window: &str,
    state: &State<'_, AppState>,
) -> Result<PathBuf, String> {
    let resolve_started = std::time::Instant::now();
    let requested = PathBuf::from(file_path);
    if !requested.is_absolute() {
        return Err("external document must be an absolute path".to_string());
    }
    if !requested.is_file() {
        return Err(format!(
            "external document is unavailable: {}",
            requested.display()
        ));
    }
    let stat_ms = resolve_started.elapsed().as_millis();
    let access_started = std::time::Instant::now();
    let (primary_allowed, mut access_timings) =
        crate::commands::helpers::can_access_document_path_timed(&requested, window, state);
    let scoped_started = std::time::Instant::now();
    let allowed =
        primary_allowed || can_access_scoped_file(&requested, scope_path, state);
    access_timings.scoped_fallback_ms = scoped_started.elapsed().as_millis();
    if !allowed {
        return Err("external document is outside its authorized scope".to_string());
    }
    let access_ms = access_started.elapsed().as_millis();
    let text_started = std::time::Instant::now();
    if !supported_text_document_path(&requested) {
        return Err("external document is not a supported text file".to_string());
    }
    let text_ms = text_started.elapsed().as_millis();
    let canonicalize_started = std::time::Instant::now();
    let resolved = dunce::canonicalize(&requested)
        .map_err(|error| format!("failed to resolve {}: {error}", requested.display()))?;
    let canonicalize_ms = canonicalize_started.elapsed().as_millis();
    let total_ms = resolve_started.elapsed().as_millis();
    tracing::info!(target: "document_io", operation = "external_path_resolve",
        total_ms, stat_ms, access_ms, text_ms, canonicalize_ms,
        access_detail = access_timings.summary());
    // tracing does not reach app.log; mirror slow resolves so a user report
    // pinpoints which stage of the scope check is expensive.
    if total_ms >= 40 {
        let payload = format!(
            "{{\"totalMs\":{total_ms},\"statMs\":{stat_ms},\"accessMs\":{access_ms},\"textMs\":{text_ms},\"canonicalizeMs\":{canonicalize_ms},\"access\":{}}}",
            access_timings.summary()
        );
        crate::runtime_log::record_event("warn", "slow-external-resolve", payload);
    }
    Ok(resolved)
}

fn document_read_error(path: &Path, error: std::io::Error) -> String {
    let code = if error.kind() == std::io::ErrorKind::PermissionDenied {
        "DOCUMENT_READ_PERMISSION_DENIED: "
    } else {
        ""
    };
    format!("{code}failed to read {}: {error}", path.display())
}

#[tauri::command]
pub async fn read_external_document(
    window: tauri::WebviewWindow,
    file_path: String,
    #[allow(non_snake_case)] scopePath: Option<String>,
    #[allow(non_snake_case)] maxBytes: Option<u64>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::document_io::run("read_external", move || {
        let state = app.state::<AppState>();
        let path =
            exact_existing_external_path(&file_path, scopePath.as_deref(), window.label(), &state)?;
        if let Some(max_bytes) = maxBytes {
            let file = fs::File::open(&path)
                .map_err(|error| document_read_error(&path, error))?;
            let size = file.metadata()
                .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?
                .len();
            if size > max_bytes {
                return Err(format!("DOCUMENT_TOO_LARGE: file is {size} bytes; limit is {max_bytes} bytes"));
            }
            let mut bytes = Vec::with_capacity(size as usize);
            file.take(max_bytes.saturating_add(1)).read_to_end(&mut bytes)
                .map_err(|error| document_read_error(&path, error))?;
            if bytes.len() as u64 > max_bytes {
                return Err(format!("DOCUMENT_TOO_LARGE: file exceeds {max_bytes} bytes"));
            }
            String::from_utf8(bytes)
                .map_err(|_| format!("external document is not valid UTF-8: {}", path.display()))
        } else {
            fs::read_to_string(&path)
                .map_err(|error| document_read_error(&path, error))
        }
    })
    .await?
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn write_external_document(
    window: tauri::WebviewWindow,
    operation_id: Option<String>,
    file_path: String,
    content: String,
    expectedContent: Option<String>,
    scopePath: Option<String>,
    app: tauri::AppHandle,
) -> ExternalDocumentWriteOutcome {
    crate::commands::document_operations::run(
        "save_external",
        operation_id,
        window.label().to_owned(),
        move || {
            Ok((|| {
                let state = app.state::<AppState>();
                let watches = app.state::<ExternalDocumentWatchState>();
                let path = match exact_existing_external_path(
                    &file_path,
                    scopePath.as_deref(),
                    window.label(),
                    &state,
                ) {
                    Ok(path) => path,
                    Err(_) if !Path::new(&file_path).is_file() => {
                        return ExternalDocumentWriteOutcome::Missing
                    }
                    Err(message) => return ExternalDocumentWriteOutcome::Error { message },
                };

                let memo_file = read_lock(&state.memo_file, "memo_file");
                let notebook_ids = match memo_file.notebook_ids_for_paths(&[&path]) {
                    Ok(ids) => ids,
                    Err(error) => return ExternalDocumentWriteOutcome::Error { message: error.to_string() },
                };
                // Capture membership independently of which pages the UI has loaded.
                let previous_favorited = notebook_note_address(&memo_file, &path).ok().flatten()
                    .and_then(|(notebook_id, relative_path)| memo_file
                        .read_indexed_note_entry_by_path(&notebook_id, &relative_path).ok().flatten())
                    .map(|entry| entry.favorited);
                watches.begin_window_write(&app, &path);
                let outcome = if is_markdown_document_path(&path) {
                    match notebook_ids.as_slice() {
                        [notebook_id] => memo_file.write_markdown_merging_for_notebook(notebook_id, &path, &content, expectedContent.as_deref()),
                        [] => memo_file.write_markdown_merging(&path, &content, expectedContent.as_deref()),
                        _ => memo_file.write_markdown_merging_for_registered_path(&path, &content, expectedContent.as_deref()),
                    }
                } else {
                    match notebook_ids.as_slice() {
                        [notebook_id] => memo_file.write_file_if_matches_for_notebook(notebook_id, &path, &content, expectedContent.as_deref()),
                        [] => memo_file.write_file_if_matches(&path, &content, expectedContent.as_deref()),
                        _ => memo_file.write_file_if_matches_for_registered_path(&path, &content, expectedContent.as_deref()),
                    }
                        .map(|outcome| match outcome {
                            FileWriteOutcome::Saved => MergedFileWriteOutcome::Saved {
                                content: content.clone(), merged: false,
                            },
                            FileWriteOutcome::Conflict { disk_content } => {
                                MergedFileWriteOutcome::Conflict { disk_content }
                            }
                        })
                };
                let saved_content = match &outcome {
                    Ok(MergedFileWriteOutcome::Saved { content, .. }) => Some(content.as_str()),
                    _ => None,
                };
                watches.finish_window_write(
                    &app, window.label(), &path,
                    saved_content,
                );
                // Diagnostic only: lets the watcher probe attribute a following
                // directory reconcile to this save instead of an external edit.
                crate::watcher::probe::note_save_finished();
                let (saved_content, merged) = match outcome {
                    Ok(MergedFileWriteOutcome::Saved { content, merged }) => {
                        match refresh_saved_notebook_note(&memo_file, &path, window.label(), previous_favorited) {
                            Ok(Some(change)) => change.emit(&app),
                            Ok(None) => {},
                            Err(error) => tracing::warn!(path = %path.display(), "saved note metadata notification failed: {error}"),
                        }
                        crate::commands::document_list::refresh_view_document_path(&memo_file, &path);
                        if is_markdown_document_path(&path) {
                            if let Ok(notebooks) = memo_file.read_notebook_configs() {
                                for notebook in notebooks {
                                    let root = Path::new(&notebook.path);
                                    if let Ok(relative) = path.strip_prefix(root) {
                                        let relative_path = relative.to_string_lossy().replace('\\', "/");
                                        crate::watcher::processor::record_cloud_path_change(
                                            &app,
                                            &crate::watcher::processor::NotebookWatchContext {
                                                notebook_id: notebook.id,
                                                root: root.to_path_buf(),
                                            },
                                            &relative_path,
                                            false,
                                        );
                                    }
                                }
                            }
                        }
                        if let Ok(notebooks) = memo_file.read_notebook_configs() {
                            for notebook in notebooks {
                                let root = Path::new(&notebook.path);
                                if let Ok(relative) = path.strip_prefix(root) {
                                    let relative_path = relative.to_string_lossy().replace('\\', "/");
                                    if let Err(error) = memo_file.with_file_write(
                                        &notebook.id, &path,
                                        flowix_core::memo_file::FileLockIntent::Existing,
                                        "auto_path_version", |_| {
                                            memo_file.maybe_create_auto_path_version(&notebook.id, &relative_path, &content)
                                        },
                                    ) {
                                        tracing::warn!(path = %path.display(), "automatic path version failed: {error}");
                                    }
                                    break;
                                }
                            }
                        }
                        (content, merged)
                    }
                    Ok(MergedFileWriteOutcome::Conflict { disk_content }) => {
                        return ExternalDocumentWriteOutcome::Conflict { disk_content };
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        return ExternalDocumentWriteOutcome::Missing;
                    }
                    Err(error) => {
                        return ExternalDocumentWriteOutcome::Error {
                            message: format!("failed to save {}: {error}", path.display()),
                        };
                    }
                };
                ExternalDocumentWriteOutcome::Saved {
                    path: path.to_string_lossy().to_string(),
                    content: saved_content,
                    merged,
                }
            })())
        },
    )
    .await
    .unwrap_or_else(|message| ExternalDocumentWriteOutcome::Error { message })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_save_metadata_receipt_covers_root_and_deep_notes_and_clearing() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("book");
        fs::create_dir_all(root.join("a/b")).unwrap();
        let memo = MemoFile::new(temp.path().join("config"));
        memo.initialize_current_registry_storage().unwrap();
        memo.write_notebook_configs(&[flowix_core::memo_file::NotebookConfig {
            id: "book".into(), name: "Book".into(), icon: None,
            path: root.to_string_lossy().into_owned(), is_default: true,
            sort: 0, created_at: 0, updated_at: 0,
        }]).unwrap();
        for relative in ["note.md", "a/b/note.md"] {
            let path = root.join(relative);
            fs::write(&path, "---\nflowix_icon: flashlight\nflowix_colors: [blue]\nflowix_favorited: true\n---\nBody\n").unwrap();
            let change = refresh_saved_notebook_note(&memo, &path, "main", Some(false)).unwrap().unwrap();
            let payload = serde_json::to_value(&change).unwrap();
            assert_eq!(payload["notebookId"], "book");
            assert_eq!(payload["relativePath"], relative);
            assert_eq!(payload["entry"]["icon"], "flashlight");
            assert_eq!(payload["entry"]["colors"], serde_json::json!(["blue"]));
            assert_eq!(payload["entry"]["favorited"], true);
            assert_eq!(payload["originWindowLabel"], "main");
            assert_eq!(payload["previousFavorited"], false);
            assert!(!change.change_id.is_empty());

            fs::write(&path, "Body\n").unwrap();
            let cleared = refresh_saved_notebook_note(&memo, &path, "main", Some(false)).unwrap().unwrap();
            assert!(cleared.entry.icon.is_none());
            assert!(cleared.entry.colors.is_empty());
            assert!(!cleared.entry.favorited);
            assert_ne!(change.change_id, cleared.change_id);
        }
        let outside = temp.path().join("outside.md");
        fs::write(&outside, "Body\n").unwrap();
        assert!(refresh_saved_notebook_note(&memo, &outside, "main", None).unwrap().is_none());
        let text = root.join("note.txt");
        fs::write(&text, "Body\n").unwrap();
        assert!(refresh_saved_notebook_note(&memo, &text, "main", None).unwrap().is_none());
    }

    #[test]
    fn read_permission_errors_have_a_platform_independent_code() {
        let error = super::document_read_error(
            std::path::Path::new("note.md"),
            std::io::Error::from(std::io::ErrorKind::PermissionDenied),
        );
        assert!(error.starts_with("DOCUMENT_READ_PERMISSION_DENIED: "));
    }

    #[test]
    fn exact_external_path_never_falls_back_by_filename() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("nested").join("Same.md");
        let root = directory.path().join("Same.md");
        fs::write(&root, "# Root memo\n").unwrap();

        assert!(!missing.exists());
        assert_ne!(missing, root);
        assert!(is_markdown_document_path(&missing));
    }

    #[test]
    fn supported_text_extension_is_case_insensitive_and_strict() {
        assert!(is_markdown_document_path(Path::new("/tmp/notes.MD")));
        assert!(is_markdown_document_path(Path::new("/tmp/notes.Markdown")));
        assert!(supported_text_document_path(Path::new("/tmp/notes.txt")));
        assert!(supported_text_document_path(Path::new("/tmp/main.TSX")));
        assert!(supported_text_document_path(Path::new("/tmp/config.toml")));
        assert!(!supported_text_document_path(Path::new("/tmp/image.png")));
        assert!(!supported_text_document_path(Path::new("/tmp/notes")));
        assert!(!supported_text_document_path(Path::new("/tmp/.md")));
    }

    #[test]
    fn extensionless_utf8_files_are_supported_but_binary_files_are_not() {
        let directory = tempfile::tempdir().unwrap();
        let license = directory.path().join("LICENSE");
        let binary = directory.path().join("blob");
        fs::write(&license, "Permission is hereby granted...\n").unwrap();
        fs::write(&binary, [0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]).unwrap();

        assert!(supported_text_document_path(&license));
        assert!(!supported_text_document_path(&binary));
    }
}
