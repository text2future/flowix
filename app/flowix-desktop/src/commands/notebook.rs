//! Notebook IPC —增删改查 + 切换当前 notebook�?//!
//! `set_current_notebook` �?`switch_notebook_and_rebuild` helper, 触发
//! watcher rebind + 磁盘对账 + 后台索引 rebuild�?//!
//! �?/ �?/ �?/ 清空 四个写操作都会同步更�?`agent_access` store
//! (`~/.flowix/agent-access.json`), 任何 entry 真改了之�?emit
//! `agent-access-changed` 事件, 其它窗口 React 树收到后从�?盘重�?load�?
use crate::events as dispatcher;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

use crate::lock_utils::{read_lock, write_lock};
use flowix_core::memo_file::{MemoFile, MemoIndexFile, Notebook, NotebookConfig};
use flowix_core::MemoService;
use flowix_sync::V2LocalNotebook;

use super::agent_access::AGENT_ACCESS_CHANGED_EVENT;
use super::helpers::{
    refresh_watcher_roots, switch_notebook_importing_disk_as_new, switch_notebook_trusting_index,
};
use crate::app::state::AppState;

const NOTEBOOK_IMPORT_COMPLETE_EVENT: &str = "notebook-import-complete";
/// 笔�?�?��表发生变�?(reorder / create / update / delete) �?emit, 其它窗口
/// store 监听�?reload。前�?TS 类型 `notebooks-changed` 事件 payload �?unit�?
pub(crate) const NOTEBOOKS_CHANGED_EVENT: &str = "notebooks-changed";
const NOTEBOOK_IMPORT_STATUS_EVENT: &str = "notebook-import-status";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
enum NotebookImportStatusKind {
    Started,
    Skipped,
    Completed,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotebookImportStatus {
    notebook_id: String,
    status: NotebookImportStatusKind,
    message: Option<String>,
}

fn emit_notebook_import_status(
    app: &AppHandle,
    notebook_id: &str,
    status: NotebookImportStatusKind,
    message: Option<String>,
) {
    dispatcher::emit_to(
        app,
        NOTEBOOK_IMPORT_STATUS_EVENT,
        NotebookImportStatus {
            notebook_id: notebook_id.to_string(),
            status,
            message,
        },
    );
}

fn notebook_path_missing(path: &str) -> bool {
    path.trim().is_empty() || !Path::new(path).is_dir()
}

fn normalize_notebook_icon(icon: Option<String>) -> Option<String> {
    icon.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn normalize_notebook_path(path: &str) -> String {
    if path.ends_with('/') || path.ends_with('\\') {
        path.to_string()
    } else {
        format!("{}/", path)
    }
}

fn record_notebook_metadata_change(state: &AppState, app: &AppHandle, config: &NotebookConfig) {
    let notebook = V2LocalNotebook {
        id: config.id.clone(),
        name: config.name.clone(),
        icon: config.icon.clone(),
        sort_order: config.sort,
    };
    match state.cloud_sync.record_v2_notebook_change(&notebook) {
        Ok(true) => crate::commands::cloud::schedule_notebook_sync(app.clone(), config.id.clone()),
        Ok(false) => {}
        Err(error) => tracing::warn!(
            "failed to persist cloud notebook metadata change {}: {error}",
            config.id
        ),
    }
}

fn comparable_notebook_path(path: &str) -> String {
    path.trim_end_matches(|c| c == '/' || c == '\\')
        .to_ascii_lowercase()
}

fn is_valid_notebook_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn generate_notebook_id() -> String {
    format!("nb_{}", uuid::Uuid::now_v7())
}

fn notebook_from_config(config: NotebookConfig) -> Notebook {
    Notebook {
        missing: notebook_path_missing(&config.path),
        id: config.id,
        name: config.name,
        icon: config.icon.unwrap_or_default(),
        path: config.path,
        created_at: config.created_at,
        updated_at: config.updated_at,
        is_default: config.is_default,
        sort: config.sort,
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookListItem {
    #[serde(flatten)]
    notebook: Notebook,
    memo_count: usize,
}

fn create_notebook_registry(
    name: &str,
    path: &str,
    icon: Option<String>,
    memo_file: &MemoFile,
) -> Result<NotebookConfig, String> {
    create_notebook_registry_with_id(name, path, icon, None, memo_file)
}

fn default_notebook_path(name: &str) -> Result<PathBuf, String> {
    let safe_name: String = name
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let safe_name = safe_name.trim().trim_matches('.');
    if safe_name.is_empty() {
        return Err("INVALID_NAME".to_string());
    }
    let documents = dirs::document_dir()
        .or_else(|| dirs::home_dir().map(|home| home.join("Documents")))
        .ok_or_else(|| "DOCUMENTS_DIR_UNAVAILABLE".to_string())?;
    let path = documents.join("flowix").join(safe_name);
    std::fs::create_dir_all(&path).map_err(|error| format!("PATH_CREATE_FAILED: {error}"))?;
    Ok(path)
}

fn create_notebook_registry_with_id(
    name: &str,
    path: &str,
    icon: Option<String>,
    requested_id: Option<&str>,
    memo_file: &MemoFile,
) -> Result<NotebookConfig, String> {
    let now = chrono::Utc::now().timestamp_millis();
    let normalized_path = normalize_notebook_path(path);
    let comparable_path = comparable_notebook_path(&normalized_path);
    let normalized_icon = normalize_notebook_icon(icon);

    tracing::info!(
        "[create_notebook] start name={} path={}",
        name,
        normalized_path
    );

    // 创建顺序: 1) 先�?现有 configs 验证�?��不冲�? 2) �?next sort;
    // 3) 组�? NotebookConfig 写盘。sort �?MAX(sort)+10 让新行落到末�?    // (ORDER BY sort ASC), 不取 len �?���?reorder �?sort �?��疏的�?
    let mut configs = memo_file.read_notebook_configs().unwrap_or_default();
    if configs
        .iter()
        .any(|notebook| comparable_notebook_path(&notebook.path) == comparable_path)
    {
        return Err("PATH_ALREADY_REGISTERED".to_string());
    }
    let manifest_id = MemoFile::read_notebook_manifest(Path::new(&normalized_path))
        .map_err(|error| format!("NOTEBOOK_MANIFEST_READ_FAILED: {error}"))?
        .map(|manifest| manifest.notebook_id);
    if let (Some(requested), Some(manifest)) = (requested_id, manifest_id.as_deref()) {
        if requested != manifest {
            return Err("NOTEBOOK_MANIFEST_ID_CONFLICT".to_string());
        }
    }
    let requested_id = requested_id.or(manifest_id.as_deref());
    let id = if let Some(id) = requested_id {
        if !is_valid_notebook_id(id) {
            return Err("INVALID_NOTEBOOK_ID".to_string());
        }
        if let Some(existing) = configs.iter_mut().find(|notebook| notebook.id == id) {
            if Path::new(&existing.path).is_dir() {
                return Err("NOTEBOOK_ID_ALREADY_REGISTERED".to_string());
            }
            existing.path = normalized_path.clone();
            existing.name = name.to_string();
            existing.icon = normalized_icon.clone();
            existing.updated_at = now;
            let relocated = existing.clone();
            memo_file
                .write_notebook_configs(&configs)
                .map_err(|error| format!("INDEX_WRITE_FAILED: {error}"))?;
            return Ok(relocated);
        }
        id.to_string()
    } else {
        loop {
            let candidate = generate_notebook_id();
            if configs.iter().all(|notebook| notebook.id != candidate) {
                break candidate;
            }
        }
    };
    let next_sort = memo_file
        .next_notebook_sort()
        .map_err(|e| format!("INDEX_READ_FAILED: {e}"))?;
    let config = NotebookConfig {
        id: id.clone(),
        name: name.to_string(),
        icon: normalized_icon,
        path: normalized_path,
        is_default: false,
        sort: next_sort,
        created_at: now,
        updated_at: now,
    };
    configs.push(config.clone());
    memo_file
        .write_notebook_configs(&configs)
        .map_err(|e| format!("INDEX_WRITE_FAILED: {e}"))?;

    tracing::info!("[create_notebook] registry written id={}", id);
    Ok(config)
}

fn cloud_restore_directory_is_empty(path: &Path) -> Result<bool, String> {
    let entries = std::fs::read_dir(path).map_err(|error| format!("PATH_READ_FAILED: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("PATH_READ_FAILED: {error}"))?;
        let name = entry.file_name();
        if matches!(name.to_str(), Some(".DS_Store" | ".localized")) {
            continue;
        }
        return Ok(false);
    }
    Ok(true)
}

fn sync_notebook_agent_access(config: &NotebookConfig, state: &AppState, app: &AppHandle) {
    // 同�?往 agent_access 列表里加一�?(默�? enabled), 写盘后才�?    // 同�?完成 ── store 内部走原子写, 失败会回滚内存�?
    if state.agent_access.add_or_update_notebook(config) {
        dispatcher::emit_to(app, AGENT_ACCESS_CHANGED_EVENT, ());
    }
}

fn activate_created_notebook(config: &NotebookConfig, state: &AppState, app: &AppHandle) {
    if let Err(e) = switch_notebook_trusting_index(state, app, Some(config.id.clone())) {
        tracing::warn!("[create_notebook] failed to select new notebook after registry write: {e}");
    } else {
        tracing::info!("[create_notebook] selected notebook id={}", config.id);
    }
}

fn run_notebook_import(app: AppHandle, notebook_id: String) {
    tracing::info!(
        "[create_notebook] background import start id={}",
        notebook_id
    );
    emit_notebook_import_status(&app, &notebook_id, NotebookImportStatusKind::Started, None);
    let app_state = app.state::<AppState>();
    let current_id = read_lock(&app_state.memo_file, "memo_file").current_notebook_id_value();
    if current_id.as_deref() != Some(notebook_id.as_str()) {
        tracing::info!(
            "[create_notebook] skip background import because current notebook changed: {}",
            notebook_id
        );
        emit_notebook_import_status(&app, &notebook_id, NotebookImportStatusKind::Skipped, None);
        return;
    }

    {
        let memo_file = read_lock(&app_state.memo_file, "memo_file");
        tracing::info!("[create_notebook] seed onboarding start id={}", notebook_id);
        match memo_file.seed_onboarding_docs() {
            Ok(true) => tracing::info!("[create_notebook] seeded onboarding documents"),
            Ok(false) => tracing::debug!(
                "[create_notebook] onboarding documents skipped (notebook already has memos)"
            ),
            Err(e) => {
                tracing::warn!("[create_notebook] failed to seed onboarding documents: {e}")
            }
        }
    }

    // 空目录也写出�?memo index, �?新建 notebook 已建立索�?这个状态可观察�?
    {
        let memo_file = read_lock(&app_state.memo_file, "memo_file");
        tracing::info!(
            "[create_notebook] empty index init check id={}",
            notebook_id
        );
        if memo_file.read_index().is_none() {
            if let Err(e) = memo_file.write_index(&MemoIndexFile::default()) {
                tracing::warn!("[create_notebook] failed to initialize empty memo index: {e}");
            } else {
                tracing::info!(
                    "[create_notebook] initialized empty memo index id={}",
                    notebook_id
                );
            }
        }
    }

    tracing::info!(
        "[create_notebook] import/reconcile start id={}",
        notebook_id
    );
    if let Err(e) =
        switch_notebook_importing_disk_as_new(app_state.inner(), &app, Some(notebook_id.clone()))
    {
        tracing::warn!("[create_notebook] background import failed: {e}");
        emit_notebook_import_status(
            &app,
            &notebook_id,
            NotebookImportStatusKind::Failed,
            Some(e),
        );
        return;
    } else {
        tracing::info!("[create_notebook] import/reconcile done id={}", notebook_id);
    }
    emit_notebook_import_status(
        &app,
        &notebook_id,
        NotebookImportStatusKind::Completed,
        None,
    );
    dispatcher::emit_to(&app, NOTEBOOK_IMPORT_COMPLETE_EVENT, notebook_id);
    tracing::info!("[create_notebook] import complete emitted");
}

fn spawn_notebook_import(app: AppHandle, notebook_id: String) {
    std::thread::spawn(move || run_notebook_import(app, notebook_id));
}

#[tauri::command]
pub fn get_notebooks(state: State<AppState>) -> Vec<NotebookListItem> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let configs = memo_file.read_notebook_configs().unwrap_or_default();
    let counts = MemoService::new(&memo_file)
        .notebook_note_counts(&configs)
        .unwrap_or_default();

    configs
        .into_iter()
        .map(|config| {
            let memo_count = counts.get(&config.id).copied().unwrap_or(0);
            NotebookListItem {
                notebook: notebook_from_config(config),
                memo_count,
            }
        })
        .collect()
}

#[tauri::command]
pub fn create_notebook(
    name: String,
    path: Option<String>,
    icon: Option<String>,
    state: State<AppState>,
    app: AppHandle,
) -> Result<Notebook, String> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err("INVALID_NAME".to_string());
    }
    let default_path;
    let trimmed_path = match path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        Some(path) => path,
        None => {
            default_path = default_notebook_path(trimmed_name)?;
            default_path
                .to_str()
                .ok_or_else(|| "PATH_INVALID_UTF8".to_string())?
        }
    };
    let has_bookmark_access = state
        .security_bookmarks
        .start_accessing_for_path(Path::new(trimmed_path));
    if !Path::new(trimmed_path).is_dir() {
        return Err("PATH_MISSING".to_string());
    }
    if !has_bookmark_access {
        state
            .security_bookmarks
            .record_directory(Path::new(trimmed_path))
            .map_err(|e| format!("BOOKMARK_WRITE_FAILED: {e}"))?;
    }

    let config = {
        let memo_file = write_lock(&state.memo_file, "memo_file");
        create_notebook_registry(trimmed_name, trimmed_path, icon, &memo_file)?
    };
    sync_notebook_agent_access(&config, state.inner(), &app);
    activate_created_notebook(&config, state.inner(), &app);
    spawn_notebook_import(app.clone(), config.id.clone());

    Ok(notebook_from_config(config))
}

/// Register an empty local mount for a Cloud notebook while preserving the
/// Cloud notebook's immutable identity. Unlike ordinary notebook creation,
/// this path intentionally skips onboarding seeding and background disk import
/// so the first synchronization starts from a clean local snapshot.
#[tauri::command]
pub fn create_notebook_from_cloud(
    id: String,
    name: String,
    path: String,
    icon: Option<String>,
    state: State<AppState>,
    app: AppHandle,
) -> Result<Notebook, String> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err("INVALID_NAME".to_string());
    }
    let trimmed_path = path.trim();
    if trimmed_path.is_empty() {
        return Err("INVALID_PATH".to_string());
    }
    if !is_valid_notebook_id(&id) {
        return Err("INVALID_NOTEBOOK_ID".to_string());
    }

    let directory = Path::new(trimmed_path);
    let has_bookmark_access = state.security_bookmarks.start_accessing_for_path(directory);
    if !directory.is_dir() {
        return Err("PATH_MISSING".to_string());
    }
    if !cloud_restore_directory_is_empty(directory)? {
        return Err("PATH_NOT_EMPTY".to_string());
    }
    if !has_bookmark_access {
        state
            .security_bookmarks
            .record_directory(directory)
            .map_err(|e| format!("BOOKMARK_WRITE_FAILED: {e}"))?;
    }

    let config = {
        let memo_file = write_lock(&state.memo_file, "memo_file");
        create_notebook_registry_with_id(trimmed_name, trimmed_path, icon, Some(&id), &memo_file)?
    };
    sync_notebook_agent_access(&config, state.inner(), &app);
    activate_created_notebook(&config, state.inner(), &app);
    dispatcher::emit_to(&app, NOTEBOOKS_CHANGED_EVENT, ());

    Ok(notebook_from_config(config))
}

#[tauri::command]
pub fn update_notebook(
    id: String,
    name: Option<String>,
    icon: Option<String>,
    state: State<AppState>,
    app: AppHandle,
) -> Option<Notebook> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let mut configs = memo_file.read_notebook_configs().ok()?;

    let index = configs.iter().position(|c| c.id == id)?;

    if let Some(n) = name {
        configs[index].name = n;
    }
    if let Some(i) = icon {
        configs[index].icon = normalize_notebook_icon(Some(i));
    }
    configs[index].updated_at = chrono::Utc::now().timestamp_millis();

    memo_file.write_notebook_configs(&configs).ok()?;

    let updated = configs[index].clone();
    drop(memo_file);

    // 名字 / �?��变更都同步到 agent_access ── store �?��判定�?��真改�?
    if state.agent_access.add_or_update_notebook(&updated) {
        dispatcher::emit_to(&app, AGENT_ACCESS_CHANGED_EVENT, ());
    }
    refresh_watcher_roots(state.inner(), &app);
    record_notebook_metadata_change(state.inner(), &app, &updated);

    Some(Notebook {
        id: updated.id,
        name: updated.name,
        missing: notebook_path_missing(&updated.path),
        path: updated.path,
        icon: updated.icon.unwrap_or_default(),
        created_at: updated.created_at,
        updated_at: updated.updated_at,
        is_default: updated.is_default,
        sort: updated.sort,
    })
}

#[tauri::command]
pub fn delete_notebook(id: String, state: State<AppState>, app: AppHandle) -> Result<bool, String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let mut configs = memo_file.read_notebook_configs().unwrap_or_default();

    let index = match configs.iter().position(|c| c.id == id) {
        Some(idx) => idx,
        None => return Err("NOTEBOOK_NOT_FOUND".to_string()),
    };
    configs.remove(index);

    memo_file
        .write_notebook_configs(&configs)
        .map_err(|e| format!("INDEX_WRITE_FAILED: {e}"))?;
    if let Err(error) = state.cloud_sync.record_v2_notebook_delete(&id) {
        tracing::warn!("failed to persist cloud notebook deletion {id}: {error}");
    } else {
        crate::commands::cloud::schedule_notebook_sync(app.clone(), id.clone());
    }

    // 同�?把�?应的 agent_access entry 也删�? 状态栏�?文件权限"子菜�?    // 会少一�?── 用户没主动去勾�? 不应该留�??儿在那里�?
    if state.agent_access.remove_notebook(&id) {
        dispatcher::emit_to(&app, AGENT_ACCESS_CHANGED_EVENT, ());
    }
    refresh_watcher_roots(state.inner(), &app);
    Ok(true)
}

/// Reorder 客户�?��来的 sort 列表�?///
/// - 前�?�?`Vec<NotebookSortEntry>` 表达 "新顺�? 这个 id �?sort 应是这个�?�?/// - 不在该列表中�?notebook id 保留�?sort 不动 (后�?不擅�?��排未参与 reorder 的�?)�?/// - 写入事务; 失败回滚并返�?`Err(String)`, �?IPC 约定错�?�?String�?/// - 写完返回最�?`Vec<Notebook>`, 前�? store 直接 setState 即可�?/// - 跨窗口事�? `NOTEBOOKS_CHANGED_EVENT` 让其它窗�?reload�?
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookSortEntry {
    pub id: String,
    pub sort: i64,
}

#[tauri::command]
pub fn reorder_notebooks(
    order: Vec<NotebookSortEntry>,
    state: State<AppState>,
    app: AppHandle,
) -> Result<Vec<Notebook>, String> {
    let memo_file = write_lock(&state.memo_file, "memo_file");

    // 防御: order 为空直接 no-op (前�?�?��空数组时保留�?��一�? 不动磁盘)�?
    if order.is_empty() {
        let configs = memo_file
            .read_notebook_configs()
            .map_err(|e| format!("INDEX_READ_FAILED: {e}"))?;
        return Ok(configs.into_iter().map(notebook_from_config).collect());
    }

    // 把�?户�?发来�?(id, sort) 合并到现�?NotebookConfig: 保留每个 notebook
    // �?name / icon / path / is_default / created_at / updated_at, 仅�?�?sort�?    // �?��现在 order 里的 notebook 保持�?sort (后�?不擅�?���?�?
    let mut configs = memo_file
        .read_notebook_configs()
        .map_err(|e| format!("INDEX_READ_FAILED: {e}"))?;
    let sort_map: std::collections::HashMap<&str, i64> = order
        .iter()
        .map(|entry| (entry.id.as_str(), entry.sort))
        .collect();
    for config in configs.iter_mut() {
        if let Some(new_sort) = sort_map.get(config.id.as_str()) {
            config.sort = *new_sort;
            config.updated_at = chrono::Utc::now().timestamp_millis();
        }
    }
    memo_file
        .write_notebook_configs(&configs)
        .map_err(|e| format!("INDEX_WRITE_FAILED: {e}"))?;

    // read_notebook_configs 内部会回�?memo_file 缓存; 再�?一次拿�?ORDER BY sort 的最新顺序�?
    let updated = memo_file
        .read_notebook_configs()
        .map_err(|e| format!("INDEX_READ_FAILED: {e}"))?;
    drop(memo_file);

    for config in &updated {
        if sort_map.contains_key(config.id.as_str()) {
            record_notebook_metadata_change(state.inner(), &app, config);
        }
    }
    let notebooks: Vec<Notebook> = updated.into_iter().map(notebook_from_config).collect();

    // 跨窗口同�? 让其它窗�?reload。NOTEBOOKS_CHANGED_EVENT �?dispatcher::emit_to
    // Notify other windows; the caller updates its own store from the IPC result.
    dispatcher::emit_to(&app, NOTEBOOKS_CHANGED_EVENT, ());
    Ok(notebooks)
}

#[tauri::command]
pub fn clear_notebooks(state: State<AppState>, app: AppHandle) -> bool {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let configs = memo_file.read_notebook_configs().unwrap_or_default();
    let before_ids: std::collections::HashSet<String> =
        configs.iter().map(|c| c.id.clone()).collect();

    let ok = memo_file.write_notebook_configs(&[]).is_ok();
    drop(memo_file);

    // 把�?清掉的非默�? notebook �?access 列表里也清掉, 然后 emit 一欰�?
    let mut any_removed = false;
    for id in before_ids {
        if let Err(error) = state.cloud_sync.record_v2_notebook_delete(&id) {
            tracing::warn!("failed to persist cleared cloud notebook {id}: {error}");
        } else {
            crate::commands::cloud::schedule_notebook_sync(app.clone(), id.clone());
        }
        if state.agent_access.remove_notebook(&id) {
            any_removed = true;
        }
    }
    if any_removed {
        dispatcher::emit_to(&app, AGENT_ACCESS_CHANGED_EVENT, ());
    }
    refresh_watcher_roots(state.inner(), &app);
    ok
}

#[tauri::command]
pub fn set_current_notebook(notebook_id: Option<String>, state: State<AppState>, app: AppHandle) {
    // Fast path for ordinary switching: trust memo index and avoid synchronous
    // disk reconciliation. Search index rebuild is lazy, triggered by search.
    if let Err(e) = switch_notebook_trusting_index(state.inner(), &app, notebook_id.clone()) {
        tracing::warn!("[set_current_notebook] switch failed: {e}");
        return;
    }
    if let Err(e) =
        read_lock(&state.memo_file, "memo_file").write_selected_notebook_id(notebook_id.as_deref())
    {
        tracing::warn!("[set_current_notebook] persist selection failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp_root() -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!(
            "flowix-notebook-command-test-{}-{}-{}",
            std::process::id(),
            n,
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create temp root");
        root
    }

    fn memo_file_for_test(root: &std::path::Path) -> MemoFile {
        let config_dir = root.join("config");
        fs::create_dir_all(&config_dir).expect("create config dir");
        MemoFile::new(config_dir)
    }

    #[test]
    fn notebook_import_status_serializes_as_frontend_contract() {
        let value = serde_json::to_value(NotebookImportStatus {
            notebook_id: "nb_test".to_string(),
            status: NotebookImportStatusKind::Completed,
            message: None,
        })
        .expect("status payload serializes");

        assert_eq!(
            value,
            serde_json::json!({
                "notebookId": "nb_test",
                "status": "completed",
                "message": null,
            })
        );
    }

    #[test]
    fn notebook_import_failed_status_includes_message() {
        let value = serde_json::to_value(NotebookImportStatus {
            notebook_id: "nb_test".to_string(),
            status: NotebookImportStatusKind::Failed,
            message: Some("disk import failed".to_string()),
        })
        .expect("status payload serializes");

        assert_eq!(value["status"], "failed");
        assert_eq!(value["message"], "disk import failed");
    }

    #[test]
    fn notebook_path_missing_reflects_directory_presence() {
        let root = temp_root();
        let missing_path = root.join("missing");
        let file_path = root.join("notebook.md");
        fs::write(&file_path, "# not a notebook directory").expect("write file");

        assert!(!notebook_path_missing(root.to_str().expect("utf8 root")));
        assert!(notebook_path_missing(
            missing_path.to_str().expect("utf8 missing path")
        ));
        assert!(notebook_path_missing(
            file_path.to_str().expect("utf8 file path")
        ));
        assert!(notebook_path_missing("  "));
    }

    #[test]
    fn create_notebook_registry_normalizes_path_and_icon_then_persists() {
        let root = temp_root();
        let notebook_dir = root.join("My Notebook");
        fs::create_dir_all(&notebook_dir).expect("create notebook dir");
        let memo_file = memo_file_for_test(&root);

        let config = create_notebook_registry(
            "Research",
            notebook_dir.to_str().expect("utf8 path"),
            Some("  ".to_string()),
            &memo_file,
        )
        .expect("create registry");

        assert_eq!(config.name, "Research");
        assert_eq!(config.icon, None);
        assert!(config.path.ends_with('/'));
        assert_eq!(config.is_default, false);

        let configs = memo_file.read_notebook_configs().expect("read configs");
        assert_eq!(configs.len(), 1);
        assert_eq!(configs[0].id, config.id);
        assert_eq!(configs[0].path, config.path);
    }

    #[test]
    fn new_notebook_ids_use_uuid_v7() {
        let id = generate_notebook_id();
        let uuid = uuid::Uuid::parse_str(id.strip_prefix("nb_").expect("notebook prefix"))
            .expect("valid UUID");

        assert_eq!(uuid.get_version_num(), 7);
        assert!(is_valid_notebook_id(&id));
    }

    #[test]
    fn cloud_notebook_registry_preserves_remote_id() {
        let root = temp_root();
        let notebook_dir = root.join("Cloud Notebook");
        fs::create_dir_all(&notebook_dir).expect("create notebook dir");
        let memo_file = memo_file_for_test(&root);

        let config = create_notebook_registry_with_id(
            "Cloud",
            notebook_dir.to_str().expect("utf8 path"),
            None,
            Some("nb_legacy_123"),
            &memo_file,
        )
        .expect("create cloud notebook registry");

        assert_eq!(config.id, "nb_legacy_123");
    }

    #[test]
    fn cloud_restore_requires_an_empty_directory() {
        let root = temp_root();
        let notebook_dir = root.join("Restore");
        fs::create_dir_all(&notebook_dir).expect("create notebook dir");
        assert!(cloud_restore_directory_is_empty(&notebook_dir).unwrap());

        fs::write(notebook_dir.join(".DS_Store"), []).expect("write Finder metadata");
        assert!(cloud_restore_directory_is_empty(&notebook_dir).unwrap());

        fs::write(notebook_dir.join("Existing.md"), "# Existing").expect("write note");
        assert!(!cloud_restore_directory_is_empty(&notebook_dir).unwrap());
    }

    #[test]
    fn create_notebook_registry_rejects_duplicate_path_without_changing_registry() {
        let root = temp_root();
        let notebook_dir = root.join("Duplicate");
        fs::create_dir_all(&notebook_dir).expect("create notebook dir");
        let memo_file = memo_file_for_test(&root);
        let path_without_slash = notebook_dir.to_str().expect("utf8 path");
        let path_with_slash = format!("{}/", path_without_slash);

        let first = create_notebook_registry(
            "First",
            path_without_slash,
            Some("book".to_string()),
            &memo_file,
        )
        .expect("first registry");
        let second = create_notebook_registry("Second", &path_with_slash, None, &memo_file);

        assert!(matches!(
            second,
            Err(error) if error == "PATH_ALREADY_REGISTERED"
        ));
        let configs = memo_file.read_notebook_configs().expect("read configs");
        assert_eq!(configs.len(), 1);
        assert_eq!(configs[0].id, first.id);
        assert_eq!(configs[0].name, "First");
    }
}
