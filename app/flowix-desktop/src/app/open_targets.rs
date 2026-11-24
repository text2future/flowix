//! Trusted OS file-open ingress and pending requests for the main window.
//! Events only notify consumers; requests remain available until acknowledged.

use crate::app::document_access::DocumentAccess;
use crate::app::state::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

const CHANGED_EVENT: &str = "flowix:open-targets-changed";

/// Both process startup and the single-instance plugin supply argv including argv[0].
pub fn command_line_targets(args: impl IntoIterator<Item = String>) -> Vec<String> {
    args.into_iter().skip(1).collect()
}

#[derive(Clone, Copy, serde::Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum OpenTargetConsumer {
    Path,
    ExternalDocuments,
}

#[derive(Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum OpenTarget {
    Path { path: String },
    ExternalDocuments { file_paths: Vec<String> },
    Error { message: String },
}

impl OpenTarget {
    fn consumer(&self) -> OpenTargetConsumer {
        match self {
            Self::ExternalDocuments { .. } => OpenTargetConsumer::ExternalDocuments,
            _ => OpenTargetConsumer::Path,
        }
    }
}

#[derive(Clone, Serialize)]
pub struct OpenTargetRequest {
    id: String,
    target: OpenTarget,
}

#[derive(Default)]
pub struct PendingOpenTargets(Mutex<Vec<OpenTargetRequest>>);

impl PendingOpenTargets {
    fn push(&self, target: OpenTarget) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(OpenTargetRequest {
                id: uuid::Uuid::new_v4().to_string(),
                target,
            });
    }

    fn snapshot(&self, consumer: OpenTargetConsumer) -> Vec<OpenTargetRequest> {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .filter(|request| request.target.consumer() == consumer)
            .cloned()
            .collect()
    }

    fn acknowledge(&self, ids: &[String]) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|request| !ids.contains(&request.id));
    }
}

#[tauri::command]
pub fn get_pending_open_targets(
    window: tauri::WebviewWindow,
    consumer: OpenTargetConsumer,
    pending: tauri::State<PendingOpenTargets>,
) -> Vec<OpenTargetRequest> {
    if window.label() != "main" {
        return Vec::new();
    }
    pending.snapshot(consumer)
}

#[tauri::command]
pub fn acknowledge_open_targets(
    window: tauri::WebviewWindow,
    ids: Vec<String>,
    pending: tauri::State<PendingOpenTargets>,
) {
    if window.label() == "main" {
        pending.acknowledge(&ids);
    }
}

/// All platform adapters hand raw targets to this boundary. Only native file
/// paths confer access; a deep link never grants access to an arbitrary file.
pub fn dispatch(app: &tauri::AppHandle, targets: Vec<String>, source: &str) {
    if crate::commands::window_shutdown::is_exiting() {
        return;
    }
    let state = app.state::<AppState>();
    let pending = app.state::<PendingOpenTargets>();
    let changed = enqueue_targets(&pending, targets, &state.document_access, source);
    if changed {
        focus_main_window(app);
        // Failure to notify is recoverable: consumers reconcile on listener readiness.
        if let Err(error) = app.emit(CHANGED_EVENT, ()) {
            tracing::warn!(%error, "Could not notify pending file-open requests");
        }
    }
}

/// Keep all native file paths in one request, regardless of notebook ownership or type.
fn enqueue_targets(
    pending: &PendingOpenTargets,
    targets: Vec<String>,
    access: &DocumentAccess,
    source: &str,
) -> bool {
    let mut files = Vec::new();
    let mut changed = false;
    for raw in targets {
        let lower = raw.to_ascii_lowercase();
        if lower.starts_with("flowix://open?") || lower.starts_with("flowix://memo/") {
            pending.push(OpenTarget::Path { path: raw });
            changed = true;
            continue;
        }
        let requested = Path::new(&raw);
        // Flags and unrelated protocol URLs do not confer file access.
        if !requested.is_absolute() && !requested.exists() {
            continue;
        }
        match authorize_file(requested, access) {
            Ok(path) => {
                let path = path.to_string_lossy().into_owned();
                if !files.contains(&path) {
                    files.push(path);
                }
            }
            Err(error) => {
                tracing::warn!(source, path = %raw, %error, "OS file-open authorization failed");
                pending.push(OpenTarget::Error {
                    message: format!("{error}: {raw}"),
                });
            }
        }
        changed = true;
    }
    if !files.is_empty() {
        pending.push(OpenTarget::ExternalDocuments { file_paths: files });
    }
    changed
}

fn authorize_file(requested: &Path, access: &DocumentAccess) -> Result<PathBuf, String> {
    let path =
        dunce::canonicalize(requested).map_err(|error| format!("Cannot resolve file: {error}"))?;
    if !access.grant("main", &path) {
        return Err("Cannot authorize file access".to_string());
    }
    Ok(path)
}

#[cfg(desktop)]
pub fn focus_main_window(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        // A protocol launch briefly activates its own helper process. Focusing
        // the existing NSWindow alone does not reactivate the already-running
        // app on macOS, so explicitly activate NSApp on the main thread first.
        let app = app.clone();
        let app_for_main_thread = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(mtm) = objc2::MainThreadMarker::new() {
                objc2_app_kit::NSApp(mtm).activate();
            }
            if let Some(window) = app_for_main_thread.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        });
    }

    #[cfg(not(target_os = "macos"))]
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_survive_notifications_until_acknowledged() {
        let pending = PendingOpenTargets::default();
        pending.push(OpenTarget::Path {
            path: "note.md".into(),
        });
        let first = pending.snapshot(OpenTargetConsumer::Path);
        assert_eq!(first.len(), 1);
        assert_eq!(
            pending.snapshot(OpenTargetConsumer::Path)[0].id,
            first[0].id
        );
        pending.push(OpenTarget::Path {
            path: "later.md".into(),
        });
        pending.acknowledge(&[first[0].id.clone()]);
        let remaining = pending.snapshot(OpenTargetConsumer::Path);
        assert_eq!(remaining.len(), 1);
        assert!(matches!(&remaining[0].target, OpenTarget::Path { path } if path == "later.md"));
    }

    #[test]
    fn consumers_receive_only_their_requests_and_external_payload_is_camel_case() {
        let pending = PendingOpenTargets::default();
        pending.push(OpenTarget::ExternalDocuments {
            file_paths: vec!["outside.md".into()],
        });
        pending.push(OpenTarget::Error {
            message: "authorization failed".into(),
        });
        assert_eq!(pending.snapshot(OpenTargetConsumer::Path).len(), 1);
        let external = pending.snapshot(OpenTargetConsumer::ExternalDocuments);
        assert_eq!(external.len(), 1);
        assert_eq!(
            serde_json::to_value(&external[0]).unwrap()["target"]["filePaths"][0],
            "outside.md"
        );
    }

    #[test]
    fn process_arguments_exclude_the_executable_but_keep_all_user_targets() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("Flowix");
        let document = directory.path().join("report.pdf");
        std::fs::write(&executable, b"executable").unwrap();
        std::fs::write(&document, b"document").unwrap();
        let argv = vec![
            executable.to_string_lossy().into_owned(),
            document.to_string_lossy().into_owned(),
            "flowix://memo/example".into(),
        ];
        let pending = PendingOpenTargets::default();
        let access = DocumentAccess::default();
        assert!(enqueue_targets(
            &pending,
            command_line_targets(argv),
            &access,
            "test"
        ));
        assert!(!access.contains("main", &executable));
        assert!(access.contains("main", &document));
        let documents = pending.snapshot(OpenTargetConsumer::ExternalDocuments);
        assert_eq!(documents.len(), 1);
        let OpenTarget::ExternalDocuments { file_paths } = &documents[0].target else {
            panic!("expected file batch");
        };
        assert_eq!(
            file_paths,
            &vec![dunce::canonicalize(&document)
                .unwrap()
                .to_string_lossy()
                .into_owned()]
        );
        assert_eq!(pending.snapshot(OpenTargetConsumer::Path).len(), 1);

        let pending = PendingOpenTargets::default();
        assert!(!enqueue_targets(
            &pending,
            command_line_targets(vec![executable.to_string_lossy().into_owned()]),
            &access,
            "test"
        ));
        assert!(pending
            .snapshot(OpenTargetConsumer::ExternalDocuments)
            .is_empty());
        assert!(command_line_targets(Vec::<String>::new()).is_empty());
    }

    #[test]
    fn native_file_batches_accept_binary_and_extensionless_files_without_partitioning() {
        let directory = tempfile::tempdir().unwrap();
        let notebook = directory.path().join("notebook");
        std::fs::create_dir(&notebook).unwrap();
        let paths = [
            notebook.join("note.md"),
            directory.path().join("document.pdf"),
            directory.path().join("no-extension"),
        ];
        for path in &paths {
            std::fs::write(path, [0_u8, 255, 1]).unwrap();
        }
        let access = DocumentAccess::default();
        let pending = PendingOpenTargets::default();
        let mut targets: Vec<String> = paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        targets.push(targets[0].clone());
        targets.push("--flag".into());
        targets.push("https://example.com/document.md".into());
        assert!(enqueue_targets(&pending, targets, &access, "test"));
        assert!(pending.snapshot(OpenTargetConsumer::Path).is_empty());
        let batches = pending.snapshot(OpenTargetConsumer::ExternalDocuments);
        assert_eq!(batches.len(), 1);
        let OpenTarget::ExternalDocuments { file_paths } = &batches[0].target else {
            panic!("expected file batch");
        };
        assert_eq!(file_paths.len(), 3);
        for (path, result) in paths.iter().zip(file_paths) {
            assert_eq!(
                dunce::canonicalize(path).unwrap().to_string_lossy(),
                result.as_str()
            );
            assert!(access.contains("main", path));
        }
        assert!(!access.contains("other-window", &paths[0]));
    }

    #[test]
    fn native_authorization_grants_only_the_selected_file_in_main_window() {
        let directory = tempfile::tempdir().unwrap();
        let selected = directory.path().join("selected.md");
        let sibling = directory.path().join("sibling.md");
        std::fs::write(&selected, "selected").unwrap();
        std::fs::write(&sibling, "sibling").unwrap();
        let access = DocumentAccess::default();
        let canonical = authorize_file(&selected, &access).unwrap();
        assert!(canonical.is_absolute());
        assert!(access.contains("main", &selected));
        assert!(!access.contains("other-window", &selected));
        assert!(!access.contains("main", &sibling));
        assert!(authorize_file(directory.path(), &access).is_err());
        assert!(authorize_file(&directory.path().join("missing.md"), &access).is_err());
    }
}
