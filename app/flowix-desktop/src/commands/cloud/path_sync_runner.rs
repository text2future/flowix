//! Desktop wiring for the path-keyed object-storage engine.
//!
//! Everything interesting lives elsewhere: the decision is
//! `flowix_sync::reconcile`, the transfers are `flowix_sync::v4_pass`, the disk
//! is [`MemoLocalStore`]. This module answers the three questions those layers
//! cannot: *which* notebooks take part, *what does the disk look like right
//! now*, and *when is it worth doing again*.
//!
//! ## What a scan is not
//!
//! The scan is `stat` only (`§4.1`). Reading contents to compare hashes would
//! turn every poll into a full notebook read, and it is not needed: a dirty path
//! is detected from size plus mtime, and the content hash is computed once by
//! the upload path. That is also why a file the scan cannot represent (a key
//! longer than the key space allows) is skipped for transfer but reported as a
//! visible partial-sync error — one unrepresentable name must not stop other
//! files from syncing or look like a clean pass.

mod directories;
mod manifest;

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use chrono::Utc;
use flowix_core::memo_file::{scan_syncable_notebook_tree, MemoFile};
use flowix_sync::v4::{normalize_key_path, PendingNotebookAction, ScannedLocalFile};
use flowix_sync::V4PassInput;
use tauri::{AppHandle, Emitter, Manager};

use crate::app::state::AppState;

use super::v4_adapter::MemoLocalStore;
use directories::sync_directories;
pub(super) use manifest::flush_deleted_notebook_manifests;
use manifest::sync_notebook_manifest;

/// A full recursive listing of `f/` is the safety net for a stamp write that
/// failed (`§9`); hourly is what the design budgets for it.
const SWEEP_INTERVAL_MS: i64 = 60 * 60 * 1_000;

/// Keep the per-notebook gate aligned with the coordinator's 10-second poll.
/// Scoped local and manual requests bypass this gate.
const MIN_INTERVAL_MS: i64 = super::coordinator::CLOUD_POLL_INTERVAL.as_millis() as i64;

/// One notebook's last pass, for the status payload.
#[derive(Debug, Clone)]
pub(crate) struct V4PassSummary {
    pub writable: bool,
    pub allows_deletes: bool,
    pub deletion_deferred: bool,
    /// When the pass finished, so a stale summary is not reported as this run's.
    pub at_millis: i64,
}

#[derive(Debug, Default, Clone)]
pub(crate) struct V4RunReport {
    pub notebooks: usize,
    pub uploaded: usize,
    pub downloaded: usize,
    pub deleted: usize,
    pub errors: Vec<String>,
}

struct NotebookScan {
    files: Vec<ScannedLocalFile>,
    directories: Vec<(String, String, i64)>,
    failures: Vec<flowix_sync::v4_apply::ApplyFailure>,
}

fn sweep_state() -> &'static Mutex<HashMap<String, i64>> {
    static SWEEPS: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
    SWEEPS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn summaries() -> &'static Mutex<HashMap<String, V4PassSummary>> {
    static SUMMARIES: OnceLock<Mutex<HashMap<String, V4PassSummary>>> = OnceLock::new();
    SUMMARIES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The last pass for this notebook, but only if it belongs to the run that
/// started at `started_at`.
pub(crate) fn summary_since(notebook_id: &str, started_at: i64) -> Option<V4PassSummary> {
    lock(summaries())
        .get(notebook_id)
        .filter(|summary| summary.at_millis >= started_at)
        .cloned()
}

/// `stat`-only view of one notebook, keyed the way the object store keys it.
///
/// Symlinks are skipped rather than followed: a link can point outside the
/// notebook (so uploading it would publish a file the user never put here) and
/// two links to one target would produce two keys for one file.
fn scan_notebook(root: &Path) -> std::io::Result<NotebookScan> {
    let (scanned, directories) = scan_syncable_notebook_tree(root)?;
    let mut files = Vec::new();
    let mut failures = Vec::new();
    for file in scanned {
        match ScannedLocalFile::new(file.display_path.clone(), file.size, file.mtime_millis) {
            Ok(file) => files.push(file),
            Err(error) => failures.push(flowix_sync::v4_apply::ApplyFailure {
                path: file.display_path,
                message: error.to_string(),
            }),
        }
    }
    files.sort_by(|left, right| left.key.cmp(&right.key));
    let mut normalized_directories = Vec::new();
    for directory in directories {
        match normalize_key_path(&directory.display_path) {
            Ok(path) => {
                normalized_directories.push((path, directory.display_path, directory.mtime_millis))
            }
            Err(error) => failures.push(flowix_sync::v4_apply::ApplyFailure {
                path: directory.display_path,
                message: error.to_string(),
            }),
        }
    }
    normalized_directories.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(NotebookScan {
        files,
        directories: normalized_directories,
        failures,
    })
}

/// Count only completed actions; planned actions can fail or be interrupted.
fn completed_transfer_counts(
    plan: &flowix_sync::reconcile::ReconcilePlan,
    outcome: &flowix_sync::v4_apply::ApplyOutcome,
) -> (usize, usize, usize) {
    use flowix_sync::reconcile::SyncAction;
    let completed: BTreeSet<&str> = outcome
        .states
        .iter()
        .map(|state| state.path.as_str())
        .collect();
    let removed: BTreeSet<&str> = outcome.removed.iter().map(String::as_str).collect();
    let failed: BTreeSet<&str> = outcome
        .failures
        .iter()
        .map(|failure| failure.path.as_str())
        .collect();
    let mut counts = (0, 0, 0);
    for action in &plan.actions {
        match action {
            SyncAction::Upload(item)
                if completed.contains(item.path.as_str())
                    && !failed.contains(item.path.as_str()) =>
            {
                counts.0 += 1
            }
            SyncAction::Download(item)
                if completed.contains(item.path.as_str())
                    && !failed.contains(item.path.as_str()) =>
            {
                counts.1 += 1
            }
            SyncAction::DeleteLocal(item)
                if removed.contains(item.path.as_str()) && !failed.contains(item.path.as_str()) =>
            {
                counts.2 += 1
            }
            _ => {}
        }
    }
    counts
}

/// Runs one path-keyed pass per notebook, in order.
pub(crate) async fn run_passes(
    state: &AppState,
    app: &AppHandle,
    notebook_ids: &[String],
    scoped: bool,
    on_transfer: &(dyn Fn(&str, Option<&str>) + Send + Sync),
    on_progress: &(dyn Fn(&str, usize, usize) + Send + Sync),
) -> Result<V4RunReport, String> {
    if notebook_ids.is_empty() {
        return Ok(V4RunReport::default());
    }
    let config_dir = state.user_config.config_dir().clone();
    let configs = match MemoFile::new(config_dir.clone()).read_notebook_configs() {
        Ok(configs) => configs,
        Err(error) => return Err(format!("CLOUD_NOTEBOOK_CONFIG_READ_FAILED: {error}")),
    };
    let pending_notebook_changes = state
        .cloud_sync
        .v4_pending_notebook_changes()
        .map_err(|error| format!("CLOUD_NOTEBOOK_METADATA_READ_FAILED: {error}"))?;
    let device_id = app
        .state::<Arc<crate::device_registration::DeviceRegistry>>()
        .device_id()
        .to_string();
    let device_label = device_id.get(..8).unwrap_or(&device_id).to_string();
    let now = Utc::now().timestamp_millis();
    let mut run_report = V4RunReport::default();
    let mut errors = Vec::new();

    for notebook_id in notebook_ids {
        let config = configs.iter().find(|config| &config.id == notebook_id);
        let pending_change = pending_notebook_changes
            .iter()
            .find(|change| change.notebook_id == *notebook_id);
        let queued_for_deletion =
            pending_change.is_some_and(|change| change.action == PendingNotebookAction::Delete);
        if config.is_none() && !queued_for_deletion {
            return Err(format!("NOTEBOOK_NOT_FOUND: {notebook_id}"));
        }
        let force = {
            let sweeps = lock(sweep_state());
            let last = sweeps.get(notebook_id).copied().unwrap_or(0);
            now.saturating_sub(last) >= SWEEP_INTERVAL_MS
        };
        if !force && !scoped {
            // A poll: the last pass is younger than the interval, and nothing
            // scheduled a notebook-scoped pass, so there is nothing to learn.
            let last = lock(summaries())
                .get(notebook_id)
                .map(|summary| summary.at_millis)
                .unwrap_or(0);
            if now.saturating_sub(last) < MIN_INTERVAL_MS {
                continue;
            }
        }
        let manifest_started = std::time::Instant::now();
        let manifest_result =
            sync_notebook_manifest(state, app, notebook_id, config, pending_change, &configs).await;
        crate::runtime_log::record_event(
            "info",
            "cloud.sync.manifest",
            format!(
                "notebook={notebook_id} elapsed_ms={} success={}",
                manifest_started.elapsed().as_millis(),
                manifest_result.is_ok()
            ),
        );
        let active = manifest_result?;
        if !active {
            continue;
        }
        let config = config.expect("missing configs are handled before manifest sync");
        let root = PathBuf::from(&config.path);
        if !root.is_dir() {
            return Err(format!(
                "CLOUD_NOTEBOOK_PATH_UNAVAILABLE: {}",
                root.display()
            ));
        }
        // Migrate before the first scan, even if no folder UI has been opened.
        let migration_config = config_dir.clone();
        let migration_notebook = notebook_id.clone();
        let migration = tokio::task::spawn_blocking(move || {
            MemoFile::new(migration_config).migrate_folder_index_to_json(&migration_notebook)
        })
        .await;
        match migration {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                tracing::warn!(%notebook_id, %error, "notebook settings migration failed")
            }
            Err(error) => {
                tracing::warn!(%notebook_id, %error, "notebook settings migration task failed")
            }
        }
        let scan_started = std::time::Instant::now();
        let scanned = {
            let root = root.clone();
            match tokio::task::spawn_blocking(move || scan_notebook(&root)).await {
                Ok(Ok(scanned)) => scanned,
                Ok(Err(error)) => {
                    return Err(format!(
                        "CLOUD_NOTEBOOK_SCAN_FAILED: {notebook_id}: {error}"
                    ));
                }
                Err(error) => {
                    return Err(format!(
                        "CLOUD_NOTEBOOK_SCAN_TASK_FAILED: {notebook_id}: {error}"
                    ));
                }
            }
        };
        tracing::info!(%notebook_id, files = scanned.files.len(), directories = scanned.directories.len(), elapsed_ms = scan_started.elapsed().as_millis() as u64, "cloud notebook scan completed");
        #[cfg(debug_assertions)]
        crate::runtime_log::record_event(
            "info",
            "cloud.sync.scan",
            format!(
                "notebook={} files={} directories={} elapsed_ms={}",
                notebook_id,
                scanned.files.len(),
                scanned.directories.len(),
                scan_started.elapsed().as_millis()
            ),
        );
        let pass_started = std::time::Instant::now();
        let local = MemoLocalStore::new(
            Arc::new(RwLock::new(MemoFile::new(config_dir.clone()))),
            notebook_id.clone(),
            root.clone(),
            Some(app.clone()),
        );
        let result = state
            .cloud_sync
            .v4_pass(V4PassInput {
                notebook_id,
                device_id: &device_label,
                scanned: &scanned.files,
                local: &local,
                on_transfer: Some(&|direction| on_transfer(notebook_id, direction)),
                on_progress: Some(&|done, total| on_progress(notebook_id, done, total)),
                force,
            })
            .await;
        tracing::info!(%notebook_id, elapsed_ms = pass_started.elapsed().as_millis() as u64, success = result.is_ok(), "cloud object sync pass completed");
        #[cfg(debug_assertions)]
        if let Ok(report) = &result {
            crate::runtime_log::record_event("info", "cloud.sync.path", format!(
                "notebook={} elapsed_ms={} listed_dirs={} planned_uploads={} planned_downloads={} planned_deletes={} transfer_failures={} list_failures={} stamp_failures={}",
                notebook_id, pass_started.elapsed().as_millis(), report.listed_dirs.len(),
                report.plan.stats.uploads, report.plan.stats.downloads, report.plan.stats.deletes,
                report.applied.failures.len(), report.list_failures.len(), report.stamp_failures.len()
            ));
        }
        #[cfg(debug_assertions)]
        if let Ok(report) = &result {
            for failure in report.applied.failures.iter().take(MAX_VISIBLE_FAILURES) {
                crate::runtime_log::record_event(
                    "info",
                    "cloud.sync.file_failure",
                    format!(
                        "notebook={} path={:?} error={:?}",
                        notebook_id,
                        bounded_error_text(&failure.path),
                        bounded_error_text(&failure.message)
                    ),
                );
            }
        }
        let report =
            result.map_err(|error| format!("CLOUD_PATH_SYNC_FAILED: {notebook_id}: {error}"))?;
        {
            let stats = &report.plan.stats;
            let (uploaded, downloaded, deleted) =
                completed_transfer_counts(&report.plan, &report.applied);
            run_report.notebooks += 1;
            run_report.uploaded = run_report.uploaded.saturating_add(uploaded);
            run_report.downloaded = run_report.downloaded.saturating_add(downloaded);
            run_report.deleted = run_report.deleted.saturating_add(deleted);
            if force
                && scanned.failures.is_empty()
                && report.list_failures.is_empty()
                && report.applied.failures.is_empty()
                && report.stamp_failures.is_empty()
            {
                lock(sweep_state()).insert(notebook_id.clone(), now);
            }
            // A download writes the file with the watcher's self-write
            // suppression in place, so nothing else tells the tree that a
            // note appeared. The indexed engine emits the same event after
            // its own remote apply; without it a synced note exists on disk
            // and is invisible until some unrelated refresh.
            if downloaded + deleted > 0 {
                // Remote writes bypass the local folder appearance event.
                let _ = app.emit(
                    "folder-index-invalidated",
                    serde_json::json!({ "notebookId": notebook_id }),
                );
                let _ = app.emit(
                    "file-management-changed",
                    serde_json::json!({
                        "notebookId": notebook_id,
                        "notebookPath": config.path,
                    }),
                );
            }
            if uploaded + downloaded + deleted > 0 {
                tracing::info!(
                    %notebook_id,
                    uploaded,
                    downloaded,
                    deleted,
                    tombstones = stats.tombstones,
                    "v4 pass moved data"
                );
            }
            if !report.writable || !report.allows_deletes {
                tracing::info!(
                    %notebook_id,
                    writable = report.writable,
                    allows_deletes = report.allows_deletes,
                    "v4 pass finished with publishing or deletions suppressed"
                );
            }
            lock(summaries()).insert(
                notebook_id.clone(),
                V4PassSummary {
                    writable: report.writable,
                    allows_deletes: report.allows_deletes,
                    deletion_deferred: report.plan.actions.iter().any(|action| {
                        matches!(
                            action,
                            flowix_sync::reconcile::SyncAction::Defer(defer)
                                if defer.reason == flowix_sync::reconcile::DeferReason::GracePeriod
                        )
                    }),
                    at_millis: Utc::now().timestamp_millis(),
                },
            );
        }
        let directory_started = std::time::Instant::now();
        #[cfg(debug_assertions)]
        crate::runtime_log::record_event(
            "info",
            "cloud.sync.directories.start",
            format!("notebook={notebook_id}"),
        );
        let directory_result =
            sync_directories(state, notebook_id, &local, &scanned.directories).await;
        tracing::info!(%notebook_id, elapsed_ms = directory_started.elapsed().as_millis() as u64, success = directory_result.is_ok(), "cloud directory sync completed");
        #[cfg(debug_assertions)]
        crate::runtime_log::record_event(
            "info",
            "cloud.sync.directories.complete",
            format!(
                "notebook={} elapsed_ms={} success={} failures={}",
                notebook_id,
                directory_started.elapsed().as_millis(),
                directory_result.is_ok(),
                directory_result
                    .as_ref()
                    .map(|(_, errors)| errors.len())
                    .unwrap_or(1)
            ),
        );
        match directory_result {
            Ok((changed, directory_errors)) => {
                if changed {
                    let _ = app.emit(
                        "file-management-changed",
                        serde_json::json!({
                            "notebookId": notebook_id,
                            "notebookPath": config.path,
                        }),
                    );
                }
                errors.extend(directory_errors);
            }
            Err(error) => errors.push(error),
        }
        if let Some(error) = summarize_pass_failures(notebook_id, &scanned.failures, &report) {
            errors.push(error);
        }
    }
    run_report.errors = errors;
    Ok(run_report)
}

const MAX_VISIBLE_FAILURES: usize = 5;
const MAX_VISIBLE_FAILURE_TEXT_BYTES: usize = 240;

fn summarize_pass_failures(
    notebook_id: &str,
    scan_failures: &[flowix_sync::v4_apply::ApplyFailure],
    report: &flowix_sync::v4_pass::PassReport,
) -> Option<String> {
    let failures = scan_failures
        .iter()
        .map(|failure| ("path", failure))
        .chain(report.list_failures.iter().map(|failure| ("list", failure)))
        .chain(
            report
                .applied
                .failures
                .iter()
                .map(|failure| ("file", failure)),
        )
        .chain(
            report
                .stamp_failures
                .iter()
                .map(|failure| ("directory stamp", failure)),
        )
        .collect::<Vec<_>>();
    if failures.is_empty() {
        return None;
    }

    let details = failures
        .iter()
        .take(MAX_VISIBLE_FAILURES)
        .map(|(kind, failure)| {
            format!(
                "{kind} {}: {}",
                bounded_error_text(&failure.path),
                bounded_error_text(&failure.message)
            )
        })
        .collect::<Vec<_>>();
    let omitted = failures.len().saturating_sub(details.len());
    let suffix = if omitted == 0 {
        String::new()
    } else {
        format!("; {omitted} more omitted")
    };
    Some(format!(
        "CLOUD_PATH_SYNC_PARTIAL: {notebook_id}: {} item(s) failed: {}{suffix}",
        failures.len(),
        details.join("; ")
    ))
}

fn bounded_error_text(value: &str) -> String {
    if value.len() <= MAX_VISIBLE_FAILURE_TEXT_BYTES {
        return value.to_string();
    }
    let mut end = MAX_VISIBLE_FAILURE_TEXT_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_completed_transfers_instead_of_the_plan() {
        use flowix_sync::reconcile::{
            DeleteLocal, Download, DownloadReason, ReconcilePlan, SyncAction, Upload, UploadReason,
        };
        use flowix_sync::v4::state_after_transfer;
        use flowix_sync::v4_apply::{ApplyFailure, ApplyOutcome};
        let plan = ReconcilePlan {
            actions: vec![
                SyncAction::Upload(Upload {
                    path: "ok.md".into(),
                    reason: UploadReason::New,
                }),
                SyncAction::Upload(Upload {
                    path: "failed.md".into(),
                    reason: UploadReason::New,
                }),
                SyncAction::Download(Download {
                    path: "download.md".into(),
                    reason: DownloadReason::NewToDevice,
                    backup: None,
                }),
                SyncAction::DeleteLocal(DeleteLocal {
                    path: "deleted.md".into(),
                }),
            ],
            ..Default::default()
        };
        let outcome = ApplyOutcome {
            states: vec![
                state_after_transfer("ok.md", "ok.md", "sha256:a", 1, 1, 1, None),
                state_after_transfer("failed.md", "failed.md", "sha256:b", 1, 1, 1, None),
                state_after_transfer("download.md", "download.md", "sha256:c", 1, 1, 1, None),
            ],
            removed: vec!["deleted.md".into()],
            failures: vec![ApplyFailure {
                path: "failed.md".into(),
                message: "checkpoint failed".into(),
            }],
            ..Default::default()
        };
        assert_eq!(completed_transfer_counts(&plan, &outcome), (1, 1, 1));
    }

    fn notebook(files: &[(&str, &str)]) -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        for (path, content) in files {
            let full = root.path().join(path);
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(full, content).unwrap();
        }
        root
    }

    /// Keys are what the bucket sees: separators are `/` on every platform and
    /// the path is notebook-relative, because an absolute path would leak the
    /// user's home directory into the cloud.
    #[test]
    fn scans_relative_keys_with_forward_slashes() {
        let root = notebook(&[
            ("notes/a.md", "# a"),
            ("notes/deep/b.md", "# b"),
            ("attachments/x.png", "png"),
            ("attachments-cache/local.bin", "cache"),
        ]);
        let scan = scan_notebook(root.path()).unwrap();
        let keys: Vec<&str> = scan.files.iter().map(|file| file.key.as_str()).collect();
        assert_eq!(keys, ["attachments/x.png", "notes/a.md", "notes/deep/b.md"]);
        assert!(scan.files.iter().all(|file| file.mtime_millis > 0));
        assert_eq!(scan.files[1].size, 3);
    }

    /// Private application directories remain local while hidden user files sync.
    #[test]
    fn skips_private_directories() {
        let root = notebook(&[
            ("visible.md", "x"),
            (".flowix/view-preferences.json", "{}"),
            (".hidden.md", "x"),
            (".agents/skills/SKILL.md", "skill"),
            (".git/config", "private"),
        ]);
        let keys: Vec<String> = scan_notebook(root.path())
            .unwrap()
            .files
            .into_iter()
            .map(|file| file.key)
            .collect();
        assert_eq!(
            keys,
            [".agents/skills/SKILL.md", ".hidden.md", "visible.md"]
        );
    }

    #[test]
    fn scans_empty_directories_and_index_configuration() {
        let root = notebook(&[
            (".index.yaml", "root descriptor"),
            ("projects/.index.yaml", "folder descriptor"),
            ("projects/Tasks.table.yaml", "view definition"),
            (".flowix/view-preferences.json", "{}"),
            (".flowix/database/user-data.md", "# user data"),
            ("visible.md", "# visible"),
        ]);
        std::fs::create_dir_all(root.path().join("empty/nested")).unwrap();

        let scan = scan_notebook(root.path()).unwrap();
        let files: Vec<&str> = scan.files.iter().map(|file| file.key.as_str()).collect();
        let directories: Vec<&str> = scan
            .directories
            .iter()
            .map(|(path, _, _)| path.as_str())
            .collect();

        assert_eq!(
            files,
            [
                ".flowix/database/user-data.md",
                ".index.yaml",
                "projects/.index.yaml",
                "projects/Tasks.table.yaml",
                "visible.md"
            ]
        );
        assert_eq!(
            directories,
            [".flowix/database", "empty", "empty/nested", "projects"]
        );
    }

    #[test]
    fn reports_paths_that_exceed_the_object_key_limit() {
        let root = tempfile::tempdir().unwrap();
        let mut directory = root.path().to_path_buf();
        for _ in 0..9 {
            directory.push("a".repeat(100));
            std::fs::create_dir(&directory).unwrap();
        }
        std::fs::write(directory.join("too-long.md"), "content").unwrap();

        let scan = scan_notebook(root.path()).unwrap();
        assert!(scan.files.is_empty());
        assert!(scan.failures.iter().any(|failure| {
            failure.path.len() > flowix_sync::v4::MAX_NOTEBOOK_PATH_BYTES
                && failure.message.contains("exceeds 900 bytes")
        }));
    }

    #[test]
    fn bounds_visible_failure_text_without_splitting_utf8() {
        let text = "界".repeat(MAX_VISIBLE_FAILURE_TEXT_BYTES);
        let bounded = bounded_error_text(&text);
        assert!(bounded.len() <= MAX_VISIBLE_FAILURE_TEXT_BYTES + "…".len());
        assert!(bounded.ends_with('…'));
    }

    #[test]
    fn summarizes_scan_transfer_listing_and_stamp_failures() {
        use flowix_sync::v4_apply::{ApplyFailure, ApplyOutcome};
        use flowix_sync::v4_pass::PassReport;

        let failure = |path: &str| ApplyFailure {
            path: path.to_string(),
            message: "request failed".to_string(),
        };
        let report = PassReport {
            server_now_millis: 0,
            listed_dirs: Vec::new(),
            plan: flowix_sync::reconcile::ReconcilePlan::default(),
            applied: ApplyOutcome {
                failures: vec![failure("write.md")],
                ..ApplyOutcome::default()
            },
            stamped_dirs: Vec::new(),
            list_failures: vec![failure("folder")],
            stamp_failures: vec![failure("folder")],
            rebound: false,
            allows_deletes: true,
            writable: true,
        };
        let scan_failures = vec![failure("unrepresentable/a")];

        let summary = summarize_pass_failures("notebook-id", &scan_failures, &report).unwrap();
        assert!(summary.contains("4 item(s) failed"));
        assert!(summary.contains("list folder: request failed"));
        assert!(summary.contains("directory stamp folder: request failed"));
        assert!(summary.contains("file write.md: request failed"));

        let many_scan_failures = (0..6)
            .map(|index| failure(&format!("unrepresentable/{index}")))
            .collect::<Vec<_>>();
        let capped = summarize_pass_failures("notebook-id", &many_scan_failures, &report).unwrap();
        assert!(capped.contains("9 item(s) failed"));
        assert!(capped.contains("4 more omitted"));
    }

    /// A stale summary must never be reported as the current run's outcome; the
    /// status bar would otherwise claim a pass happened when it did not.
    #[test]
    fn summaries_are_scoped_to_the_run_that_produced_them() {
        lock(summaries()).insert(
            "nb_scope".to_string(),
            V4PassSummary {
                writable: true,
                allows_deletes: true,
                deletion_deferred: false,
                at_millis: 1_700_000_000_500,
            },
        );
        assert!(summary_since("nb_scope", 1_700_000_000_000).is_some());
        assert!(summary_since("nb_scope", 1_700_000_001_000).is_none());
        assert!(summary_since("nb_other", 0).is_none());
    }
}
