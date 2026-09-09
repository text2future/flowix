use std::collections::{HashMap, HashSet};
mod deletion;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use chrono::Utc;
use flowix_core::memo_file::{
    atomic_write_bytes, extract_frontmatter_key, merge_frontmatter, resolve_filename_conflict,
    notebook_path_from_relative, sanitize_filename_component, IsMd, MergeOverrides,
};
use flowix_sync::{
    collect_v2_attachments, v2_content_hash, v2_local_content_diverged, CloudCheckout,
    CloudMembership, CloudNotebook, CloudProduct, CloudState, SyncError, V2AccountSyncReport,
    V2LocalNote, V2LocalNotebook, V2RemoteApply, V2SyncedNotebook,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::app::state::AppState;
use crate::lock_utils::read_lock;
use crate::memo_events::{self, MemoChangeSource, MemoDerivedChanged, MemoEvent};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncResult {
    pub notebooks: usize,
    pub uploaded: usize,
    pub deleted: usize,
    pub downloaded: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncStatus {
    pub notebook_id: String,
    pub run_id: String,
    pub state: String,
    pub phase: String,
    pub uploaded: usize,
    pub deleted: usize,
    pub downloaded: usize,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub last_error: Option<String>,
}

impl CloudSyncStatus {
    fn new(notebook_id: &str, run_id: &str, state: &str, phase: &str, started_at: i64) -> Self {
        Self {
            notebook_id: notebook_id.to_string(),
            run_id: run_id.to_string(),
            state: state.to_string(),
            phase: phase.to_string(),
            uploaded: 0,
            deleted: 0,
            downloaded: 0,
            started_at,
            finished_at: None,
            last_error: None,
        }
    }
}

fn sync_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn cloud_error(error: SyncError) -> String {
    match error {
        SyncError::Api { code, details, .. }
            if code == "MEMBERSHIP_REQUIRED" || code == "STORAGE_QUOTA_EXCEEDED" =>
        {
            format!("{code}:{}", details.unwrap_or(serde_json::Value::Null))
        }
        other => other.to_string(),
    }
}

fn emit_sync_status(app: &AppHandle, status: &CloudSyncStatus) {
    let _ = app.emit("cloud-sync-status-changed", status);
}

fn emit_cloud_state(app: &AppHandle, state: &CloudState) {
    let _ = app.emit("cloud-state-changed", state);
}

fn persist_rotated_token(state: &AppState) -> Result<(), String> {
    state.cloud_sync.with_current_refresh_token(|token| {
        if let Some(token) = token {
            state
                .user_config
                .save_cloud_refresh_token(token)
                .map_err(sync_error)?;
        }
        Ok(())
    })
}

const FULL_LOCAL_SNAPSHOT_INTERVAL_MS: i64 = 5 * 60 * 1_000;
static LAST_FULL_LOCAL_SNAPSHOT_AT: AtomicI64 = AtomicI64::new(0);

fn should_run_full_local_snapshot(
    state: &AppState,
    notebook_scope: Option<&str>,
) -> Result<bool, String> {
    let enabled = state
        .cloud_sync
        .v2_enabled_notebooks()
        .map_err(sync_error)?;
    if let Some(scope) = notebook_scope {
        return Ok(enabled
            .iter()
            .find(|notebook| notebook.notebook_id == scope)
            .is_some_and(|notebook| notebook.bootstrap_required));
    }
    if enabled.is_empty() {
        return Ok(false);
    }
    if enabled.iter().any(|notebook| notebook.bootstrap_required) {
        return Ok(true);
    }
    let now = Utc::now().timestamp_millis();
    let last = LAST_FULL_LOCAL_SNAPSHOT_AT.load(Ordering::SeqCst);
    Ok(last == 0 || now.saturating_sub(last) >= FULL_LOCAL_SNAPSHOT_INTERVAL_MS)
}

fn v2_account_snapshot(
    state: &AppState,
    full_scan: bool,
    notebook_scope: Option<&str>,
) -> Result<(Vec<V2LocalNotebook>, Vec<V2LocalNote>), String> {
    let enabled: std::collections::HashSet<String> = state
        .cloud_sync
        .v2_enabled_notebooks()
        .map_err(sync_error)?
        .into_iter()
        .map(|notebook| notebook.notebook_id)
        .collect();
    let dirty_note_ids = if full_scan {
        None
    } else {
        Some(state.cloud_sync.v2_dirty_note_ids().map_err(sync_error)?)
    };
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let configs = memo_file.read_notebook_configs().map_err(sync_error)?;
    let mut notebooks = Vec::new();
    let mut notes = Vec::new();
    for config in configs
        .into_iter()
        .filter(|config| enabled.contains(&config.id))
        .filter(|config| notebook_scope.is_none_or(|scope| config.id == scope))
    {
        for memo in memo_file.read_all_memos_for_notebook_id(Some(&config.id)) {
            if dirty_note_ids
                .as_ref()
                .is_some_and(|ids| !ids.contains(&memo.id))
            {
                continue;
            }
            let path = notebook_path_from_relative(Path::new(&config.path), &memo.relative_path)
                .unwrap_or_else(|_| PathBuf::from(&config.path).join(&memo.filename));
            let content = std::fs::read(&path)
                .map_err(|error| format!("READ_NOTE_FAILED {}: {error}", path.display()))?;
            let attachments =
                collect_v2_attachments(&PathBuf::from(&config.path).join("attachments"), &content)?;
            notes.push(V2LocalNote {
                id: memo.id,
                notebook_id: config.id.clone(),
                filename: memo.filename,
                content,
                attachments,
            });
        }
        notebooks.push(V2LocalNotebook {
            id: config.id,
            name: config.name,
            icon: config.icon,
            sort_order: config.sort,
        });
    }
    Ok((notebooks, notes))
}

fn safe_cloud_note_path(base: &Path, filename: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(filename);
    if candidate.file_name().and_then(|value| value.to_str()) != Some(filename)
        || !candidate.is_md()
    {
        return Err("INVALID_CLOUD_FILENAME".to_string());
    }
    Ok(base.join(filename))
}

fn write_cloud_attachments(
    base: &Path,
    attachments: &[flowix_sync::V2RemoteAttachment],
) -> Result<(), String> {
    let directory = base.join("attachments");
    std::fs::create_dir_all(&directory).map_err(sync_error)?;
    for attachment in attachments {
        let filename = &attachment.metadata.filename;
        if Path::new(filename)
            .file_name()
            .and_then(|value| value.to_str())
            != Some(filename)
            || attachment.metadata.size_bytes
                != i64::try_from(attachment.content.len()).map_err(|_| "ATTACHMENT_TOO_LARGE")?
            || v2_content_hash(&attachment.content) != attachment.metadata.content_hash
        {
            return Err(format!("CLOUD_ATTACHMENT_INVALID: {filename}"));
        }
        let path = directory.join(filename);
        atomic_write_bytes(&path, &attachment.content).map_err(sync_error)?;
    }
    Ok(())
}

fn apply_v2_note_changes(
    state: &AppState,
    app: &AppHandle,
    notebook_id: &str,
    changes: &[&V2RemoteApply],
) -> Result<(), String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let _write_guard = memo_file
        .acquire_cross_process_write_lock()
        .map_err(sync_error)?;
    let notebook = memo_file
        .get_notebook_config_by_id(notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let base = PathBuf::from(&notebook.path);
    let mut occupied: Vec<String> = memo_file
        .read_all_memos_for_notebook_id(Some(notebook_id))
        .into_iter()
        .map(|memo| memo.filename)
        .collect();

    for change in changes {
        let V2RemoteApply::Note {
            note_id,
            filename,
            content_hash,
            content,
            deleted,
            attachments,
            ..
        } = change
        else {
            continue;
        };
        if *deleted {
            if let Some(memo) = deletion::delete_cloud_note_locked(
                &memo_file,
                &state.cloud_sync,
                notebook_id,
                note_id,
                |path| crate::watcher::runtime::mark_self_write_for(app, path),
            )? {
                let path = notebook_path_from_relative(&base, &memo.relative_path)
                    .unwrap_or_else(|_| base.join(&memo.filename));
                let derived_changed = MemoDerivedChanged::from_deleted(&memo);
                memo_events::emit(
                    app,
                    MemoEvent::Deleted {
                        id: note_id.clone(),
                        path: path.to_string_lossy().into_owned(),
                        notebook_id: notebook_id.to_string(),
                        derived_changed,
                        source: MemoChangeSource::CloudSync,
                    },
                );
            }
        } else {
            let bytes = content
                .as_ref()
                .ok_or_else(|| format!("CLOUD_NOTE_CONTENT_MISSING: {note_id}"))?;
            let expected_hash = content_hash
                .as_deref()
                .ok_or_else(|| format!("CLOUD_NOTE_HASH_MISSING: {note_id}"))?;
            let actual_hash = v2_content_hash(bytes);
            if actual_hash != expected_hash {
                return Err(format!(
                        "CLOUD_NOTE_HASH_MISMATCH: note {note_id} expected {expected_hash} got {actual_hash}"
                    ));
            }
            let markdown = std::str::from_utf8(bytes)
                .map_err(|_| format!("CLOUD_NOTE_NOT_UTF8: {note_id}"))?;
            write_cloud_attachments(&base, attachments)?;
            let current_memo = memo_file.read_memo_for_notebook_id(notebook_id, note_id);
            if current_memo.is_none() {
                if let Some(location) = memo_file
                    .resolve_memo_location(note_id)
                    .map_err(sync_error)?
                {
                    return Err(format!(
                        "CLOUD_NOTE_ID_COLLISION: note {} belongs to local notebook {}",
                        note_id, location.notebook.id
                    ));
                }
            }
            let old_path = current_memo.as_ref().map(|memo| {
                notebook_path_from_relative(&base, &memo.relative_path)
                    .unwrap_or_else(|_| base.join(&memo.filename))
            });
            let mut desired_path = safe_cloud_note_path(&base, filename)?;
            if desired_path.exists() && old_path.as_ref() != Some(&desired_path) {
                let title = Path::new(filename)
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or("Cloud note");
                let safe_title = sanitize_filename_component(&format!("{title} (Cloud)"));
                let safe_filename = resolve_filename_conflict(&base, &safe_title, &occupied);
                desired_path = base.join(&safe_filename);
                occupied.push(safe_filename);
            }
            // P0-2: 单端同步回声抑制。本端 push 后紧接的 pull 会用旧 cursor 把刚推上去
            // 的内容再拉回来（协议暂无 device 维度去重）。若此时本地磁盘正文与远端
            // content_hash 一致，说明是回声而非真实远端更新，跳过覆盖写与 Updated 事件
            // ——否则文件监听器会把这次“内容未变”的写盘误判为外部编辑，弹“文档已被外部
            // 修改”。附件已由上方 write_cloud_attachments 幂等落盘，filename/位置未变时
            // 无需重写正文。
            // 本地磁盘当前正文哈希：P0-2 回声判据与 P1-3 本地编辑判据共用。
            let disk_hash = std::fs::read(&desired_path)
                .ok()
                .map(|bytes| v2_content_hash(&bytes));

            // P0-2: 回声 / 内容已一致 → 跳过写盘与事件（避免监听器把“内容未变”的
            // 写盘误判为外部编辑）。
            if matches!(&old_path, Some(path) if path == &desired_path)
                && disk_hash.as_deref() == Some(expected_hash)
            {
                let memo = memo_file
                    .register_existing_file_for_notebook_id(notebook_id, &desired_path)
                    .map_err(sync_error)?;
                if memo.id != *note_id {
                    return Err(format!(
                        "CLOUD_NOTE_ID_MISMATCH: expected {}, registered {}",
                        note_id, memo.id
                    ));
                }
                continue;
            }

            // P1-3: 本地有未同步编辑时不接受远端覆盖（本地会在下次 push 以最新远端
            // revision 为 base 补推上去）。两条判据取或：
            //   ① has_pending_v2_note_change —— sync dirty 队列，但由 watcher 处理编辑器
            //     保存事件后才打标记，有 ~400ms settle 延迟；
            //   ② 磁盘正文偏离同步基线 note_state.content_hash —— 即时读盘+读同步状态，
            //     堵住 ① 的延迟窗口：快速编辑时编辑器刚保存、watcher 还没 mark dirty，
            //     但磁盘已领先于同步基线，据此判定本地已编辑、不覆盖。
            let baseline_hash = state
                .cloud_sync
                .v2_note_state(note_id)
                .ok()
                .flatten()
                .and_then(|stored| stored.content_hash);
            let has_pending_change = state
                .cloud_sync
                .has_pending_v2_note_change(note_id)
                .unwrap_or(false);
            let locally_edited = v2_local_content_diverged(
                disk_hash.as_deref(),
                baseline_hash.as_deref(),
                has_pending_change,
            );
            if locally_edited {
                continue;
            }
            if let Some(path) = &old_path {
                crate::watcher::runtime::mark_self_write_for(app, path);
            }
            let overrides: MergeOverrides =
                [("key".to_string(), note_id.clone())].into_iter().collect();
            let stamped_content = merge_frontmatter(markdown, &overrides);
            crate::watcher::runtime::write_note_atomic(
                app,
                &desired_path,
                stamped_content.as_bytes(),
            )
            .map_err(sync_error)?;
            let memo = memo_file
                .register_existing_file_for_notebook_id(notebook_id, &desired_path)
                .map_err(sync_error)?;
            if memo.id != *note_id {
                return Err(format!(
                    "CLOUD_NOTE_ID_MISMATCH: expected {}, registered {}",
                    note_id, memo.id
                ));
            }
            if let Some(path) = old_path.filter(|path| path != &desired_path) {
                if path.exists() {
                    std::fs::remove_file(&path).map_err(sync_error)?;
                }
            }
            memo_events::emit(
                app,
                MemoEvent::Updated {
                    id: memo.id.clone(),
                    path: desired_path.to_string_lossy().into_owned(),
                    notebook_id: notebook_id.to_string(),
                    derived_changed: MemoDerivedChanged {
                        tags: true,
                        todos: true,
                        agents: true,
                    },
                    memo,
                    source: MemoChangeSource::CloudSync,
                },
            );
        }
    }
    Ok(())
}

fn apply_v2_report(
    state: &AppState,
    app: &AppHandle,
    report: &V2AccountSyncReport,
) -> Result<(), String> {
    let mut note_changes = HashMap::<String, Vec<&V2RemoteApply>>::new();
    let mut notebook_metadata =
        HashMap::<String, (Option<String>, Option<String>, Option<i64>, bool)>::new();
    for change in &report.remote {
        match change {
            V2RemoteApply::Notebook {
                notebook_id,
                name,
                icon,
                sort_order,
                deleted,
                ..
            } => {
                notebook_metadata.insert(
                    notebook_id.clone(),
                    (name.clone(), icon.clone(), *sort_order, *deleted),
                );
            }
            V2RemoteApply::Note { notebook_id, .. } => {
                note_changes
                    .entry(notebook_id.clone())
                    .or_default()
                    .push(change);
            }
        }
    }

    for (notebook_id, changes) in note_changes {
        apply_v2_note_changes(state, app, &notebook_id, &changes)?;
    }

    if !notebook_metadata.is_empty() {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let mut configs = memo_file.read_notebook_configs().map_err(sync_error)?;
        let mut changed = false;
        configs.retain(|config| {
            let deleted = notebook_metadata
                .get(&config.id)
                .is_some_and(|(_, _, _, deleted)| *deleted);
            if deleted {
                changed = true;
                if state.agent_access.remove_notebook(&config.id) {
                    crate::events::emit_to(
                        app,
                        crate::commands::agent_access::AGENT_ACCESS_CHANGED_EVENT,
                        (),
                    );
                }
            }
            !deleted
        });
        for config in &mut configs {
            let Some((name, icon, sort_order, deleted)) = notebook_metadata.get(&config.id) else {
                continue;
            };
            if *deleted {
                continue;
            }
            if let Some(name) = name {
                if config.name != *name {
                    config.name.clone_from(name);
                    changed = true;
                }
            }
            if config.icon != *icon {
                config.icon.clone_from(icon);
                changed = true;
            }
            if let Some(sort_order) = sort_order {
                if config.sort != *sort_order {
                    config.sort = *sort_order;
                    changed = true;
                }
            }
        }
        if changed {
            memo_file
                .write_notebook_configs(&configs)
                .map_err(sync_error)?;
            drop(memo_file);
            crate::events::emit_to(app, crate::commands::notebook::NOTEBOOKS_CHANGED_EVENT, ());
            crate::commands::helpers::refresh_watcher_roots(state, app);
        }
    }
    Ok(())
}

fn canonicalize_local_keys(
    state: &AppState,
    app: &AppHandle,
    notebook_id: &str,
) -> Result<(), String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let _write_guard = memo_file
        .acquire_cross_process_write_lock()
        .map_err(sync_error)?;
    let notebook = memo_file
        .get_notebook_config_by_id(notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let base = PathBuf::from(&notebook.path);
    let memos = memo_file.read_all_memos_for_notebook_id(Some(notebook_id));
    let mut disk_keys = HashMap::<String, String>::new();

    for memo in memos {
        let path = notebook_path_from_relative(&base, &memo.relative_path)
            .unwrap_or_else(|_| base.join(&memo.filename));
        let content = std::fs::read_to_string(&path)
            .map_err(|error| format!("READ_NOTE_FAILED {}: {error}", path.display()))?;
        if let Some(disk_key) = extract_frontmatter_key(&content) {
            if let Some(existing_id) = disk_keys.insert(disk_key.clone(), memo.id.clone()) {
                if existing_id != memo.id {
                    return Err(format!(
                        "DUPLICATE_NOTE_KEY: key {disk_key} is used by {existing_id} and {}",
                        memo.id
                    ));
                }
            }
        }
        let overrides: MergeOverrides =
            [("key".to_string(), memo.id.clone())].into_iter().collect();
        let canonical = merge_frontmatter(&content, &overrides);
        if canonical != content {
            crate::watcher::runtime::write_note_atomic(app, &path, canonical.as_bytes())
                .map_err(sync_error)?;
        }
    }
    Ok(())
}

static ACCOUNT_SYNC_LOCK: OnceLock<Arc<tokio::sync::Mutex<()>>> = OnceLock::new();

fn account_sync_lock() -> Arc<tokio::sync::Mutex<()>> {
    ACCOUNT_SYNC_LOCK
        .get_or_init(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SyncTarget {
    Notebook(String),
    FullAccount,
}

impl SyncTarget {
    fn notebook_scope(&self) -> Option<&str> {
        match self {
            Self::Notebook(notebook_id) => Some(notebook_id),
            Self::FullAccount => None,
        }
    }

    fn merge(&mut self, other: Self) {
        if *self != other {
            *self = Self::FullAccount;
        }
    }

    fn label(&self) -> &str {
        match self {
            Self::Notebook(notebook_id) => notebook_id,
            Self::FullAccount => "full-account",
        }
    }
}

struct ManualSyncRequest {
    target: SyncTarget,
    responder: oneshot::Sender<Result<CloudSyncResult, String>>,
}

enum SyncCoordinatorRequest {
    Automatic {
        target: SyncTarget,
        generation_changed: bool,
    },
    Retry(SyncTarget),
    Poll,
    Manual(ManualSyncRequest),
}

#[derive(Clone)]
struct SyncCoordinatorHandle {
    sender: mpsc::UnboundedSender<SyncCoordinatorRequest>,
}

#[derive(Default)]
struct PendingSyncBatch {
    target: Option<SyncTarget>,
    responders: Vec<oneshot::Sender<Result<CloudSyncResult, String>>>,
    retry_on_failure: bool,
    debounce_required: bool,
}

impl PendingSyncBatch {
    fn merge_target(&mut self, target: SyncTarget) {
        match &mut self.target {
            Some(current) => current.merge(target),
            None => self.target = Some(target),
        }
    }
}

struct SyncActivity {
    run_id: String,
    started_at: i64,
    notebooks: HashSet<String>,
    result: CloudSyncResult,
}

impl SyncActivity {
    fn new() -> Self {
        Self {
            run_id: uuid::Uuid::new_v4().to_string(),
            started_at: Utc::now().timestamp_millis(),
            notebooks: HashSet::new(),
            result: CloudSyncResult {
                notebooks: 0,
                uploaded: 0,
                deleted: 0,
                downloaded: 0,
            },
        }
    }

    fn absorb_report(&mut self, report: &V2AccountSyncReport) {
        self.result.uploaded = self.result.uploaded.saturating_add(report.uploaded);
        self.result.deleted = self.result.deleted.saturating_add(report.deleted);
        self.result.downloaded = self.result.downloaded.saturating_add(report.remote.len());
        self.result.notebooks = self.notebooks.len();
    }
}

const AUTO_SYNC_DEBOUNCE: Duration = Duration::from_millis(1_200);
const AUTO_SYNC_MAX_WAIT: Duration = Duration::from_secs(5);
const CLOUD_POLL_INTERVAL: Duration = Duration::from_secs(30);

static SYNC_COORDINATOR: OnceLock<SyncCoordinatorHandle> = OnceLock::new();
static POLLING_STARTED: AtomicBool = AtomicBool::new(false);

fn sync_coordinator(app: &AppHandle) -> SyncCoordinatorHandle {
    SYNC_COORDINATOR
        .get_or_init(|| {
            let (sender, receiver) = mpsc::unbounded_channel();
            let handle = SyncCoordinatorHandle { sender };
            tauri::async_runtime::spawn(run_sync_coordinator(app.clone(), receiver));
            handle
        })
        .clone()
}

fn send_sync_request(app: &AppHandle, request: SyncCoordinatorRequest) -> Result<(), String> {
    sync_coordinator(app)
        .sender
        .send(request)
        .map_err(|_| "cloud sync coordinator is unavailable".to_string())
}

fn automatic_sync_available(app: &AppHandle, notebook_id: &str) -> bool {
    let state = app.state::<AppState>();
    state
        .cloud_sync
        .state()
        .map(|cloud| cloud.enabled && cloud.authenticated)
        .unwrap_or(false)
        && state
            .cloud_sync
            .v2_notebook(notebook_id)
            .ok()
            .flatten()
            .is_some_and(|notebook| notebook.enabled)
}

fn automatic_sync_target_available(app: &AppHandle, target: &SyncTarget) -> bool {
    match target {
        SyncTarget::Notebook(notebook_id) => automatic_sync_available(app, notebook_id),
        SyncTarget::FullAccount => {
            let state = app.state::<AppState>();
            state
                .cloud_sync
                .state()
                .map(|cloud| cloud.enabled && cloud.authenticated)
                .unwrap_or(false)
                && !state
                    .cloud_sync
                    .v2_enabled_notebooks()
                    .unwrap_or_default()
                    .is_empty()
        }
    }
}

fn enabled_notebooks_for_target(
    state: &AppState,
    target: &SyncTarget,
) -> Result<Vec<V2SyncedNotebook>, String> {
    Ok(state
        .cloud_sync
        .v2_enabled_notebooks()
        .map_err(sync_error)?
        .into_iter()
        .filter(|notebook| {
            target
                .notebook_scope()
                .is_none_or(|scope| notebook.notebook_id == scope)
        })
        .collect())
}

fn emit_activity_status(
    app: &AppHandle,
    activity: &SyncActivity,
    notebook_ids: impl IntoIterator<Item = String>,
    state: &str,
    phase: &str,
    error: Option<&str>,
) {
    let finished_at = matches!(state, "success" | "error").then(|| Utc::now().timestamp_millis());
    for notebook_id in notebook_ids {
        let mut status = CloudSyncStatus::new(
            &notebook_id,
            &activity.run_id,
            state,
            phase,
            activity.started_at,
        );
        status.uploaded = activity.result.uploaded;
        status.deleted = activity.result.deleted;
        status.downloaded = activity.result.downloaded;
        status.finished_at = finished_at;
        status.last_error = error.map(str::to_owned);
        emit_sync_status(app, &status);
    }
}

async fn sync_v2_account_pass(
    state: &AppState,
    app: &AppHandle,
    target: &SyncTarget,
    enabled: &[V2SyncedNotebook],
    activity: &SyncActivity,
) -> Result<V2AccountSyncReport, String> {
    let generation = state.cloud_sync.session_restore_generation();
    let notebook_scope = target.notebook_scope();
    let full_local_snapshot = should_run_full_local_snapshot(state, notebook_scope)?;
    let sync_lock = account_sync_lock();
    let _guard = sync_lock.lock().await;
    emit_activity_status(
        app,
        activity,
        enabled.iter().map(|notebook| notebook.notebook_id.clone()),
        "checking",
        "snapshot",
        None,
    );
    for notebook in enabled {
        let exists = read_lock(&state.memo_file, "memo_file")
            .get_notebook_config_by_id(&notebook.notebook_id)
            .is_some();
        if exists {
            canonicalize_local_keys(state, app, &notebook.notebook_id)?;
        }
    }
    let (notebooks, notes) = v2_account_snapshot(state, full_local_snapshot, notebook_scope)?;
    emit_activity_status(
        app,
        activity,
        enabled.iter().map(|notebook| notebook.notebook_id.clone()),
        "syncing",
        "transfer",
        None,
    );
    let report_result = state
        .cloud_sync
        .sync_v2_snapshot_at_generation(notebook_scope, notebooks, notes, generation)
        .await;
    persist_rotated_token(state)?;
    let report = report_result.map_err(cloud_error)?;
    emit_activity_status(
        app,
        activity,
        enabled.iter().map(|notebook| notebook.notebook_id.clone()),
        "finalizing",
        "apply",
        None,
    );
    state
        .cloud_sync
        .complete_v2_sync_with_apply(&report, notebook_scope, || {
            apply_v2_report(state, app, &report).map_err(SyncError::InvalidState)
        })
        .map_err(sync_error)?;
    if full_local_snapshot && notebook_scope.is_none() {
        LAST_FULL_LOCAL_SNAPSHOT_AT.store(Utc::now().timestamp_millis(), Ordering::SeqCst);
    }
    Ok(report)
}

fn merge_waiting_request(
    batch: &mut PendingSyncBatch,
    request: SyncCoordinatorRequest,
    poll_due: bool,
) -> bool {
    match request {
        SyncCoordinatorRequest::Automatic {
            target,
            generation_changed,
        } => {
            batch.merge_target(target);
            batch.retry_on_failure = true;
            batch.debounce_required |= generation_changed;
            false
        }
        SyncCoordinatorRequest::Retry(target) => {
            batch.merge_target(target);
            batch.retry_on_failure = true;
            batch.debounce_required = false;
            true
        }
        SyncCoordinatorRequest::Poll if poll_due => {
            batch.merge_target(SyncTarget::FullAccount);
            batch.retry_on_failure = true;
            batch.debounce_required = false;
            true
        }
        SyncCoordinatorRequest::Poll => false,
        SyncCoordinatorRequest::Manual(request) => {
            batch.merge_target(request.target);
            batch.responders.push(request.responder);
            batch.debounce_required = false;
            true
        }
    }
}

async fn collect_debounced_requests(
    receiver: &mut mpsc::UnboundedReceiver<SyncCoordinatorRequest>,
    batch: &mut PendingSyncBatch,
    poll_due: bool,
) {
    if !batch.debounce_required {
        return;
    }
    let max_deadline = Instant::now() + AUTO_SYNC_MAX_WAIT;
    let mut quiet_deadline = Instant::now() + AUTO_SYNC_DEBOUNCE;
    loop {
        let deadline = quiet_deadline.min(max_deadline);
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => break,
            request = receiver.recv() => {
                let Some(request) = request else { break };
                let resets_debounce = matches!(
                    request,
                    SyncCoordinatorRequest::Automatic {
                        generation_changed: true,
                        ..
                    }
                );
                if merge_waiting_request(batch, request, poll_due) {
                    break;
                }
                if resets_debounce {
                    quiet_deadline = (Instant::now() + AUTO_SYNC_DEBOUNCE).min(max_deadline);
                }
            }
        }
    }
    batch.debounce_required = false;
}

fn activity_covers(
    completed_full_account: bool,
    completed_notebooks: &HashSet<String>,
    target: &SyncTarget,
) -> bool {
    completed_full_account
        || matches!(target, SyncTarget::Notebook(notebook_id) if completed_notebooks.contains(notebook_id))
}

fn merge_request_after_pass(
    batch: &mut PendingSyncBatch,
    request: SyncCoordinatorRequest,
    completed_full_account: bool,
    completed_notebooks: &HashSet<String>,
) -> bool {
    match request {
        // An automatic request represents a possibly newer dirty generation,
        // even when the just-finished pass covered the same notebook.
        SyncCoordinatorRequest::Automatic {
            target,
            generation_changed: true,
        } => {
            batch.merge_target(target);
            batch.retry_on_failure = true;
            batch.debounce_required = true;
            false
        }
        // The pass already covers this persisted generation. An identical
        // editor/watcher observation must not create a trailing network pass.
        SyncCoordinatorRequest::Automatic {
            generation_changed: false,
            target,
        } => {
            if activity_covers(completed_full_account, completed_notebooks, &target) {
                false
            } else {
                batch.merge_target(target);
                batch.retry_on_failure = true;
                batch.debounce_required = false;
                true
            }
        }
        SyncCoordinatorRequest::Retry(target) => {
            batch.merge_target(target);
            batch.retry_on_failure = true;
            batch.debounce_required = false;
            true
        }
        // A successful pass makes an overlapping poll redundant. The next
        // periodic tick will be measured from this activity's success.
        SyncCoordinatorRequest::Poll => false,
        SyncCoordinatorRequest::Manual(request) => {
            let covered =
                activity_covers(completed_full_account, completed_notebooks, &request.target);
            if !covered {
                batch.merge_target(request.target);
                batch.debounce_required = false;
            }
            batch.responders.push(request.responder);
            !covered
        }
    }
}

async fn collect_trailing_requests(
    receiver: &mut mpsc::UnboundedReceiver<SyncCoordinatorRequest>,
    batch: &mut PendingSyncBatch,
    completed_full_account: bool,
    completed_notebooks: &HashSet<String>,
) {
    let mut start_immediately = false;
    while let Ok(request) = receiver.try_recv() {
        start_immediately |=
            merge_request_after_pass(batch, request, completed_full_account, completed_notebooks);
    }
    if start_immediately || !batch.debounce_required {
        return;
    }
    let max_deadline = Instant::now() + AUTO_SYNC_MAX_WAIT;
    let mut quiet_deadline = Instant::now() + AUTO_SYNC_DEBOUNCE;
    loop {
        let deadline = quiet_deadline.min(max_deadline);
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => break,
            request = receiver.recv() => {
                let Some(request) = request else { break };
                let resets_debounce = matches!(
                    request,
                    SyncCoordinatorRequest::Automatic {
                        generation_changed: true,
                        ..
                    }
                );
                let start_immediately = merge_request_after_pass(
                    batch,
                    request,
                    completed_full_account,
                    completed_notebooks,
                );
                if start_immediately {
                    break;
                }
                if resets_debounce {
                    quiet_deadline = (Instant::now() + AUTO_SYNC_DEBOUNCE).min(max_deadline);
                }
            }
        }
    }
    batch.debounce_required = false;
}

fn finish_responders(
    responders: Vec<oneshot::Sender<Result<CloudSyncResult, String>>>,
    result: Result<CloudSyncResult, String>,
) {
    for responder in responders {
        let _ = responder.send(result.clone());
    }
}

async fn run_sync_activity(
    app: &AppHandle,
    receiver: &mut mpsc::UnboundedReceiver<SyncCoordinatorRequest>,
    mut batch: PendingSyncBatch,
) -> Result<CloudSyncResult, String> {
    let mut activity = SyncActivity::new();
    let mut completed_full_account = false;
    let mut completed_notebooks = HashSet::new();

    loop {
        let Some(target) = batch.target.take() else {
            let result = activity.result.clone();
            finish_responders(batch.responders, Ok(result.clone()));
            return Ok(result);
        };
        let state = app.state::<AppState>();
        let enabled = match enabled_notebooks_for_target(state.inner(), &target) {
            Ok(enabled) => enabled,
            Err(error) => {
                let mut error_notebooks = activity.notebooks.clone();
                if let SyncTarget::Notebook(notebook_id) = &target {
                    error_notebooks.insert(notebook_id.clone());
                }
                emit_activity_status(
                    app,
                    &activity,
                    error_notebooks,
                    "error",
                    "failed",
                    Some(&error),
                );
                finish_responders(batch.responders, Err(error.clone()));
                if batch.retry_on_failure {
                    schedule_retry_after_failure(app, target);
                }
                return Err(error);
            }
        };
        activity
            .notebooks
            .extend(enabled.iter().map(|notebook| notebook.notebook_id.clone()));
        activity.result.notebooks = activity.notebooks.len();

        let report =
            match sync_v2_account_pass(state.inner(), app, &target, &enabled, &activity).await {
                Ok(report) => report,
                Err(error) => {
                    let mut error_notebooks = activity.notebooks.clone();
                    if let SyncTarget::Notebook(notebook_id) = &target {
                        error_notebooks.insert(notebook_id.clone());
                    }
                    emit_activity_status(
                        app,
                        &activity,
                        error_notebooks,
                        "error",
                        "failed",
                        Some(&error),
                    );
                    finish_responders(batch.responders, Err(error.clone()));
                    if batch.retry_on_failure {
                        schedule_retry_after_failure(app, target.clone());
                    }
                    return Err(error);
                }
            };
        activity.absorb_report(&report);
        match &target {
            SyncTarget::FullAccount => completed_full_account = true,
            SyncTarget::Notebook(notebook_id) => {
                completed_notebooks.insert(notebook_id.clone());
            }
        }

        collect_trailing_requests(
            receiver,
            &mut batch,
            completed_full_account,
            &completed_notebooks,
        )
        .await;
        if batch.target.is_none() {
            emit_activity_status(
                app,
                &activity,
                activity.notebooks.clone(),
                "success",
                "complete",
                None,
            );
            let result = activity.result.clone();
            finish_responders(batch.responders, Ok(result.clone()));
            return Ok(result);
        }
    }
}

async fn run_sync_coordinator(
    app: AppHandle,
    mut receiver: mpsc::UnboundedReceiver<SyncCoordinatorRequest>,
) {
    let mut last_success_at: Option<Instant> = None;
    while let Some(first_request) = receiver.recv().await {
        let poll_due = last_success_at
            .is_none_or(|last_success| last_success.elapsed() >= CLOUD_POLL_INTERVAL);
        let mut batch = PendingSyncBatch::default();
        merge_waiting_request(&mut batch, first_request, poll_due);
        if batch.target.is_none() {
            continue;
        }
        collect_debounced_requests(&mut receiver, &mut batch, poll_due).await;
        if batch.target.is_none() {
            continue;
        }
        match run_sync_activity(&app, &mut receiver, batch).await {
            Ok(_) => last_success_at = Some(Instant::now()),
            Err(error) => tracing::warn!("cloud sync activity failed: {error}"),
        }
    }
}

/// Debounce editor/watcher bursts and run synchronization off the write path.
pub(crate) fn schedule_notebook_sync(app: AppHandle, notebook_id: String) {
    schedule_notebook_sync_observation(app, notebook_id, true);
}

pub(crate) fn schedule_notebook_sync_observation(
    app: AppHandle,
    notebook_id: String,
    generation_changed: bool,
) {
    if !automatic_sync_available(&app, &notebook_id) {
        return;
    }
    if let Err(error) = send_sync_request(
        &app,
        SyncCoordinatorRequest::Automatic {
            target: SyncTarget::Notebook(notebook_id.clone()),
            generation_changed,
        },
    ) {
        tracing::warn!("failed to schedule cloud sync for {notebook_id}: {error}");
    }
}

fn schedule_retry_after_failure(app: &AppHandle, target: SyncTarget) {
    let state = app.state::<AppState>();
    match state
        .cloud_sync
        .v2_retry_delay(chrono::Utc::now().timestamp_millis())
    {
        Ok(Some(delay_ms)) => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(delay_ms.max(1) as u64)).await;
                if !automatic_sync_target_available(&app, &target) {
                    return;
                }
                let state = app.state::<AppState>();
                if state
                    .cloud_sync
                    .v2_retry_delay(Utc::now().timestamp_millis())
                    .ok()
                    .flatten()
                    .is_none()
                {
                    return;
                }
                if let Err(error) =
                    send_sync_request(&app, SyncCoordinatorRequest::Retry(target.clone()))
                {
                    tracing::warn!(
                        "failed to schedule cloud retry for {}: {error}",
                        target.label()
                    );
                }
            });
        }
        Ok(None) => {}
        Err(error) => {
            tracing::warn!(
                "failed to calculate cloud retry for {}: {error}",
                target.label()
            );
        }
    }
}

pub(crate) fn start_cloud_sync_polling(app: AppHandle) {
    if POLLING_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(CLOUD_POLL_INTERVAL).await;
            let should_poll = {
                let state = app.state::<AppState>();
                let cloud_state = state.cloud_sync.state().ok();
                matches!(
                    cloud_state,
                    Some(CloudState {
                        enabled: true,
                        authenticated: true,
                        ..
                    })
                ) && !state
                    .cloud_sync
                    .v2_enabled_notebooks()
                    .unwrap_or_default()
                    .is_empty()
            };
            if should_poll {
                if let Err(error) = send_sync_request(&app, SyncCoordinatorRequest::Poll) {
                    tracing::warn!("failed to request periodic cloud sync: {error}");
                }
            }
        }
    });
}

#[tauri::command]
pub fn cloud_get_state(state: State<AppState>) -> Result<CloudState, String> {
    state.cloud_sync.state().map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_register(
    email: String,
    password: String,
    display_name: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<CloudState, String> {
    state
        .cloud_sync
        .register(email.trim(), &password, display_name.trim())
        .await
        .map_err(sync_error)?;
    persist_rotated_token(state.inner())?;
    let next_state = state.cloud_sync.state().map_err(sync_error)?;
    emit_cloud_state(&app, &next_state);
    Ok(next_state)
}

#[tauri::command]
pub async fn cloud_login(
    email: String,
    password: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<CloudState, String> {
    state
        .cloud_sync
        .login(email.trim(), &password)
        .await
        .map_err(sync_error)?;
    persist_rotated_token(state.inner())?;
    let next_state = state.cloud_sync.state().map_err(sync_error)?;
    emit_cloud_state(&app, &next_state);
    Ok(next_state)
}

#[tauri::command]
pub async fn cloud_sign_in_with_apple(
    window: WebviewWindow,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<CloudState, String> {
    let challenge = state
        .cloud_sync
        .apple_challenge()
        .await
        .map_err(sync_error)?;
    let authorization = crate::apple_sign_in::authorize(window, challenge).await?;
    state
        .cloud_sync
        .sign_in_with_apple(&authorization)
        .await
        .map_err(sync_error)?;
    persist_rotated_token(state.inner())?;
    let next_state = state.cloud_sync.state().map_err(sync_error)?;
    emit_cloud_state(&app, &next_state);
    Ok(next_state)
}

#[tauri::command]
pub async fn cloud_link_apple(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<CloudState, String> {
    let challenge = state
        .cloud_sync
        .apple_challenge()
        .await
        .map_err(sync_error)?;
    let authorization = crate::apple_sign_in::authorize(window, challenge).await?;
    let next_state = state
        .cloud_sync
        .link_apple(&authorization)
        .await
        .map_err(sync_error)?;
    persist_rotated_token(state.inner())?;
    Ok(next_state)
}

#[tauri::command]
pub async fn cloud_logout(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<CloudState, String> {
    let logout_result = state
        .cloud_sync
        .logout_with_cleanup(|| {
            state
                .user_config
                .delete_cloud_refresh_token()
                .map_err(|error| SyncError::InvalidState(error.to_string()))
        })
        .await
        .map_err(sync_error);
    let next_state = state.cloud_sync.state().map_err(sync_error)?;
    emit_cloud_state(&app, &next_state);
    logout_result?;
    Ok(next_state)
}

#[tauri::command]
pub fn cloud_set_enabled(
    enabled: bool,
    state: State<AppState>,
    app: AppHandle,
) -> Result<CloudState, String> {
    let next_state = state.cloud_sync.set_enabled(enabled).map_err(sync_error)?;
    emit_cloud_state(&app, &next_state);
    Ok(next_state)
}

#[tauri::command]
pub fn cloud_get_notebook_state(
    notebook_id: String,
    state: State<AppState>,
) -> Result<Option<V2SyncedNotebook>, String> {
    state
        .cloud_sync
        .v2_notebook(&notebook_id)
        .map_err(sync_error)
}

#[tauri::command]
pub fn cloud_list_notebook_states(state: State<AppState>) -> Result<Vec<V2SyncedNotebook>, String> {
    state.cloud_sync.v2_enabled_notebooks().map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_list_notebooks(
    state: State<'_, AppState>,
) -> Result<Vec<CloudNotebook>, String> {
    let notebooks_result = state.cloud_sync.v2_remote_notebooks().await;
    persist_rotated_token(state.inner())?;
    notebooks_result.map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_link_notebook(
    notebook_id: String,
    cloud_notebook_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<V2SyncedNotebook, String> {
    if notebook_id != cloud_notebook_id {
        return Err("CLOUD_NOTEBOOK_ID_MISMATCH".to_string());
    }
    let config = read_lock(&state.memo_file, "memo_file")
        .get_notebook_config_by_id(&notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let link_result = state.cloud_sync.set_v2_notebook_enabled(
        &V2LocalNotebook {
            id: config.id,
            name: config.name,
            icon: config.icon,
            sort_order: config.sort,
        },
        true,
    );
    persist_rotated_token(state.inner())?;
    let link = link_result.map_err(cloud_error)?;
    if let Ok(next_state) = state.cloud_sync.state() {
        emit_cloud_state(&app, &next_state);
    }
    Ok(link)
}

#[tauri::command]
pub async fn cloud_set_notebook_enabled(
    notebook_id: String,
    enabled: bool,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<V2SyncedNotebook, String> {
    let config = read_lock(&state.memo_file, "memo_file")
        .get_notebook_config_by_id(&notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let link_result = state.cloud_sync.set_v2_notebook_enabled(
        &V2LocalNotebook {
            id: config.id,
            name: config.name,
            icon: config.icon,
            sort_order: config.sort,
        },
        enabled,
    );
    persist_rotated_token(state.inner())?;
    let link = link_result.map_err(cloud_error)?;
    if let Ok(next_state) = state.cloud_sync.state() {
        emit_cloud_state(&app, &next_state);
    }
    Ok(link)
}

#[tauri::command]
pub async fn cloud_refresh_membership(
    state: State<'_, AppState>,
) -> Result<CloudMembership, String> {
    let membership_result = state.cloud_sync.refresh_membership().await;
    persist_rotated_token(state.inner())?;
    membership_result.map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_list_products(state: State<'_, AppState>) -> Result<Vec<CloudProduct>, String> {
    state.cloud_sync.products().await.map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_create_checkout(
    product_id: String,
    state: State<'_, AppState>,
) -> Result<CloudCheckout, String> {
    let idempotency_key = format!("desktop-{}", uuid::Uuid::new_v4());
    let checkout_result = state
        .cloud_sync
        .create_checkout(&product_id, &idempotency_key)
        .await;
    persist_rotated_token(state.inner())?;
    checkout_result.map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_sync_now(
    notebook_id: Option<String>,
    app: AppHandle,
) -> Result<CloudSyncResult, String> {
    let target = match notebook_id {
        Some(notebook_id) => SyncTarget::Notebook(notebook_id),
        None => SyncTarget::FullAccount,
    };
    let (responder, response) = oneshot::channel();
    send_sync_request(
        &app,
        SyncCoordinatorRequest::Manual(ManualSyncRequest { target, responder }),
    )?;
    response
        .await
        .map_err(|_| "cloud sync coordinator stopped before completing the request".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_target_merge_keeps_one_scope_and_promotes_distinct_notebooks() {
        let mut target = SyncTarget::Notebook("nb_1".into());
        target.merge(SyncTarget::Notebook("nb_1".into()));
        assert_eq!(target, SyncTarget::Notebook("nb_1".into()));

        target.merge(SyncTarget::Notebook("nb_2".into()));
        assert_eq!(target, SyncTarget::FullAccount);

        target.merge(SyncTarget::Notebook("nb_3".into()));
        assert_eq!(target, SyncTarget::FullAccount);
    }

    #[test]
    fn automatic_requests_debounce_and_manual_requests_start_immediately() {
        let mut batch = PendingSyncBatch::default();
        assert!(!merge_waiting_request(
            &mut batch,
            SyncCoordinatorRequest::Automatic {
                target: SyncTarget::Notebook("nb_1".into()),
                generation_changed: true,
            },
            true,
        ));
        assert!(batch.debounce_required);

        let (responder, _response) = oneshot::channel();
        assert!(merge_waiting_request(
            &mut batch,
            SyncCoordinatorRequest::Manual(ManualSyncRequest {
                target: SyncTarget::Notebook("nb_1".into()),
                responder,
            }),
            true,
        ));
        assert!(!batch.debounce_required);
        assert_eq!(batch.responders.len(), 1);
        assert_eq!(batch.target, Some(SyncTarget::Notebook("nb_1".into())));
    }

    #[test]
    fn new_dirty_generation_after_pass_requests_one_trailing_pass() {
        let mut batch = PendingSyncBatch::default();
        let completed = HashSet::from(["nb_1".to_string()]);
        assert!(!merge_request_after_pass(
            &mut batch,
            SyncCoordinatorRequest::Automatic {
                target: SyncTarget::Notebook("nb_1".into()),
                generation_changed: true,
            },
            false,
            &completed,
        ));
        assert_eq!(batch.target, Some(SyncTarget::Notebook("nb_1".into())));
        assert!(batch.debounce_required);
    }

    #[test]
    fn repeated_generation_does_not_request_a_trailing_pass() {
        let mut batch = PendingSyncBatch::default();
        let completed = HashSet::from(["nb_1".to_string()]);
        assert!(!merge_request_after_pass(
            &mut batch,
            SyncCoordinatorRequest::Automatic {
                target: SyncTarget::Notebook("nb_1".into()),
                generation_changed: false,
            },
            false,
            &completed,
        ));
        assert!(batch.target.is_none());
        assert!(!batch.debounce_required);
    }

    #[test]
    fn persisted_generation_for_an_uncovered_notebook_still_wakes_the_worker() {
        let mut batch = PendingSyncBatch::default();
        let completed = HashSet::from(["nb_1".to_string()]);
        assert!(merge_request_after_pass(
            &mut batch,
            SyncCoordinatorRequest::Automatic {
                target: SyncTarget::Notebook("nb_2".into()),
                generation_changed: false,
            },
            false,
            &completed,
        ));
        assert_eq!(batch.target, Some(SyncTarget::Notebook("nb_2".into())));
    }

    #[test]
    fn covered_manual_request_joins_current_activity_without_another_pass() {
        let mut batch = PendingSyncBatch::default();
        let completed = HashSet::from(["nb_1".to_string()]);
        let (responder, _response) = oneshot::channel();
        assert!(!merge_request_after_pass(
            &mut batch,
            SyncCoordinatorRequest::Manual(ManualSyncRequest {
                target: SyncTarget::Notebook("nb_1".into()),
                responder,
            }),
            false,
            &completed,
        ));
        assert!(batch.target.is_none());
        assert_eq!(batch.responders.len(), 1);
    }

    #[test]
    fn full_account_pass_covers_later_notebook_manual_request() {
        assert!(activity_covers(
            true,
            &HashSet::new(),
            &SyncTarget::Notebook("nb_1".into()),
        ));
    }

    #[test]
    fn cloud_sync_status_uses_camel_case_wire_format() {
        let mut status =
            CloudSyncStatus::new("nb_1", "run_1", "error", "failed", 1_700_000_000_000);
        status.finished_at = Some(1_700_000_000_100);
        status.last_error = Some("network unavailable".to_string());

        let value = serde_json::to_value(status).expect("serialize cloud sync status");
        assert_eq!(value["notebookId"], "nb_1");
        assert_eq!(value["runId"], "run_1");
        assert_eq!(value["startedAt"], 1_700_000_000_000_i64);
        assert_eq!(value["finishedAt"], 1_700_000_000_100_i64);
        assert_eq!(value["lastError"], "network unavailable");
    }

    #[test]
    fn cloud_error_preserves_actionable_membership_code() {
        let message = cloud_error(SyncError::Api {
            status: 402,
            code: "MEMBERSHIP_REQUIRED".to_string(),
            message: "membership required".to_string(),
            details: Some(serde_json::json!({
                "usedBytes": 128,
                "quotaBytes": 0,
                "membershipExpiresAt": null,
            })),
        });

        assert!(message.starts_with("MEMBERSHIP_REQUIRED:"));
        let details: serde_json::Value = serde_json::from_str(
            message
                .strip_prefix("MEMBERSHIP_REQUIRED:")
                .expect("membership error prefix"),
        )
        .expect("membership error details");
        assert_eq!(details["usedBytes"], 128);
        assert_eq!(details["quotaBytes"], 0);
    }

    #[test]
    fn cloud_error_preserves_quota_details_for_the_ui() {
        let message = cloud_error(SyncError::Api {
            status: 402,
            code: "STORAGE_QUOTA_EXCEEDED".to_string(),
            message: "quota exceeded".to_string(),
            details: Some(serde_json::json!({
                "usedBytes": 52_428_800,
                "quotaBytes": 52_428_800,
                "requestedDeltaBytes": 1_024,
            })),
        });

        assert!(message.starts_with("STORAGE_QUOTA_EXCEEDED:"));
        let details: serde_json::Value = serde_json::from_str(
            message
                .strip_prefix("STORAGE_QUOTA_EXCEEDED:")
                .expect("quota error prefix"),
        )
        .expect("quota error details");
        assert_eq!(details["usedBytes"], 52_428_800);
        assert_eq!(details["quotaBytes"], 52_428_800);
        assert_eq!(details["requestedDeltaBytes"], 1_024);
    }
}
