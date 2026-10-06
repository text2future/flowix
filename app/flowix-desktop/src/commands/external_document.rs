use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{Manager, State};

use crate::app::state::AppState;
use crate::commands::external_document_watch::ExternalDocumentWatchState;
use crate::commands::helpers::{
    can_access_document_path, can_access_scoped_file, refresh_notebook_note_index,
    start_security_bookmark_access,
};
use crate::lock_utils::read_lock;
use flowix_core::memo_file::{FileWriteOutcome, MergedFileWriteOutcome};

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
                "md" | "markdown"
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
    if !can_access_document_path(&requested, window, state)
        && !can_access_scoped_file(&requested, scope_path, state)
    {
        return Err("external document is outside its authorized scope".to_string());
    }
    start_security_bookmark_access(state.inner(), &requested);
    if !supported_text_document_path(&requested) {
        return Err("external document is not a supported text file".to_string());
    }
    dunce::canonicalize(&requested)
        .map_err(|error| format!("failed to resolve {}: {error}", requested.display()))
}

#[tauri::command]
pub async fn read_external_document(
    window: tauri::WebviewWindow,
    file_path: String,
    #[allow(non_snake_case)] scopePath: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::document_io::run("read_external", move || {
        let state = app.state::<AppState>();
        let path =
            exact_existing_external_path(&file_path, scopePath.as_deref(), window.label(), &state)?;
        fs::read_to_string(&path)
            .map_err(|error| format!("failed to read {}: {error}", path.display()))
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
                watches.begin_window_write(&path);
                let outcome = if is_markdown_document_path(&path) {
                    memo_file.write_markdown_merging(&path, &content, expectedContent.as_deref())
                } else {
                    memo_file.write_file_if_matches(&path, &content, expectedContent.as_deref())
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
                let (saved_content, merged) = match outcome {
                    Ok(MergedFileWriteOutcome::Saved { content, merged }) => {
                        refresh_notebook_note_index(&memo_file, &path);
                        crate::commands::document_list::refresh_view_document_path(&memo_file, &path);
                        if let Ok(notebooks) = memo_file.read_notebook_configs() {
                            for notebook in notebooks {
                                let root = Path::new(&notebook.path);
                                if let Ok(relative) = path.strip_prefix(root) {
                                    let relative_path = relative.to_string_lossy().replace('\\', "/");
                                    if let Err(error) = memo_file.maybe_create_auto_path_version(&notebook.id, &relative_path, &content) {
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
