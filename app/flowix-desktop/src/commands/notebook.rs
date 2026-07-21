//! Notebook IPC 鈥?澧炲垹鏀规煡 + 鍒囨崲褰撳墠 notebook銆?//!
//! `set_current_notebook` 璧?`switch_notebook_and_rebuild` helper, 瑙﹀彂
//! watcher rebind + 纾佺洏瀵硅处 + 鍚庡彴绱㈠紩 rebuild銆?//!
//! 澧?/ 鏀?/ 鍒?/ 娓呯┖ 鍥涗釜鍐欐搷浣滈兘浼氬悓姝ユ洿鏂?`agent_access` store
//! (`~/.flowix/agent-access.json`), 浠讳綍 entry 鐪熸敼浜嗕箣鍚?emit
//! `agent-access-changed` 浜嬩欢, 鍏跺畠绐楀彛 React 鏍戞敹鍒板悗浠庣鐩橀噸鏂?load銆?
use crate::events as dispatcher;
use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Manager, State};

use crate::lock_utils::{read_lock, write_lock};
use flowix_core::memo_file::{MemoFile, MemoIndexFile, Notebook, NotebookConfig};

use super::agent_access::AGENT_ACCESS_CHANGED_EVENT;
use super::helpers::{
    refresh_watcher_roots, switch_notebook_importing_disk_as_new, switch_notebook_trusting_index,
};
use crate::app::state::AppState;

const NOTEBOOK_IMPORT_COMPLETE_EVENT: &str = "notebook-import-complete";
/// 绗旇鏈垪琛ㄥ彂鐢熷彉鍖?(reorder / create / update / delete) 鏃?emit, 鍏跺畠绐楀彛
/// store 鐩戝惉鍚?reload銆傚墠绔?TS 绫诲瀷 `notebooks-changed` 浜嬩欢 payload 涓?unit銆?
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
    let _ = path;
    false
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

fn comparable_notebook_path(path: &str) -> String {
    path.trim_end_matches(|c| c == '/' || c == '\\')
        .to_ascii_lowercase()
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

fn create_notebook_registry(
    name: &str,
    path: &str,
    icon: Option<String>,
    memo_file: &MemoFile,
) -> Result<NotebookConfig, String> {
    let now = chrono::Utc::now().timestamp_millis();
    let id = format!("nb_{}", now);
    let normalized_path = normalize_notebook_path(path);
    let comparable_path = comparable_notebook_path(&normalized_path);
    let normalized_icon = normalize_notebook_icon(icon);

    tracing::info!(
        "[create_notebook] start name={} path={}",
        name,
        normalized_path
    );

    // 鍒涘缓椤哄簭: 1) 鍏堣鐜版湁 configs 楠岃瘉璺緞涓嶅啿绐? 2) 绠?next sort;
    // 3) 缁勮 NotebookConfig 鍐欑洏銆俿ort 鍙?MAX(sort)+10 璁╂柊琛岃惤鍒版湯灏?    // (ORDER BY sort ASC), 涓嶅彇 len 鏄洜涓?reorder 鍚?sort 鏄█鐤忕殑銆?
    let mut configs = memo_file.read_notebook_configs().unwrap_or_default();
    if configs
        .iter()
        .any(|notebook| comparable_notebook_path(&notebook.path) == comparable_path)
    {
        return Err("PATH_ALREADY_REGISTERED".to_string());
    }
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

fn sync_notebook_agent_access(config: &NotebookConfig, state: &AppState, app: &AppHandle) {
    // 鍚屾寰€ agent_access 鍒楄〃閲屽姞涓€鏉?(榛樿 enabled), 鍐欑洏鍚庢墠绠?    // 鍚屾瀹屾垚 鈹€鈹€ store 鍐呴儴璧板師瀛愬啓, 澶辫触浼氬洖婊氬唴瀛樸€?
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

    // 绌虹洰褰曚篃鍐欏嚭绌?memo index, 璁?鏂板缓 notebook 宸插缓绔嬬储寮?杩欎釜鐘舵€佸彲瑙傚療銆?
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
pub fn get_notebooks(state: State<AppState>) -> Vec<Notebook> {
    state
        .memo_file
        .read()
        .unwrap_or_else(|poisoned| {
            tracing::error!("memo_file read lock poisoned, recovering");
            poisoned.into_inner()
        })
        .read_notebook_configs()
        .unwrap_or_default()
        .into_iter()
        .map(notebook_from_config)
        .collect()
}

#[tauri::command]
pub fn create_notebook(
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

    // 鍚嶅瓧 / 璺緞鍙樻洿閮藉悓姝ュ埌 agent_access 鈹€鈹€ store 鑷繁鍒ゅ畾鏄惁鐪熸敼銆?
    if state.agent_access.add_or_update_notebook(&updated) {
        dispatcher::emit_to(&app, AGENT_ACCESS_CHANGED_EVENT, ());
    }
    refresh_watcher_roots(state.inner(), &app);

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

    // 鍚屾鎶婂搴旂殑 agent_access entry 涔熷垹浜? 鐘舵€佹爮鐨?鏂囦欢鏉冮檺"瀛愯彍鍗?    // 浼氬皯涓€琛?鈹€鈹€ 鐢ㄦ埛娌′富鍔ㄥ幓鍕鹃€? 涓嶅簲璇ョ暀涓鍎垮湪閭ｉ噷銆?
    if state.agent_access.remove_notebook(&id) {
        dispatcher::emit_to(&app, AGENT_ACCESS_CHANGED_EVENT, ());
    }
    refresh_watcher_roots(state.inner(), &app);
    Ok(true)
}

/// Reorder 瀹㈡埛绔紶鏉ョ殑 sort 鍒楄〃銆?///
/// - 鍓嶇鍙?`Vec<NotebookSortEntry>` 琛ㄨ揪 "鏂伴『搴? 杩欎釜 id 鐨?sort 搴旀槸杩欎釜鍊?銆?/// - 涓嶅湪璇ュ垪琛ㄤ腑鐨?notebook id 淇濈暀鍘?sort 涓嶅姩 (鍚庣涓嶆搮鑷噸鎺掓湭鍙備笌 reorder 鐨勮)銆?/// - 鍐欏叆浜嬪姟; 澶辫触鍥炴粴骞惰繑鍥?`Err(String)`, 璺?IPC 绾﹀畾閿欒璧?String銆?/// - 鍐欏畬杩斿洖鏈€鏂?`Vec<Notebook>`, 鍓嶇 store 鐩存帴 setState 鍗冲彲銆?/// - 璺ㄧ獥鍙ｄ簨浠? `NOTEBOOKS_CHANGED_EVENT` 璁╁叾瀹冪獥鍙?reload銆?
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

    // 闃插尽: order 涓虹┖鐩存帴 no-op (鍓嶇璇紶绌烘暟缁勬椂淇濈暀璇箟涓€鑷? 涓嶅姩纾佺洏)銆?
    if order.is_empty() {
        let configs = memo_file
            .read_notebook_configs()
            .map_err(|e| format!("INDEX_READ_FAILED: {e}"))?;
        return Ok(configs.into_iter().map(notebook_from_config).collect());
    }

    // 鎶婂鎴风鍙戞潵鐨?(id, sort) 鍚堝苟鍒扮幇鏈?NotebookConfig: 淇濈暀姣忎釜 notebook
    // 鐨?name / icon / path / is_default / created_at / updated_at, 浠呰鍐?sort銆?    // 鏈嚭鐜板湪 order 閲岀殑 notebook 淇濇寔鍘?sort (鍚庣涓嶆搮鑷噸鎺?銆?
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

    // read_notebook_configs 鍐呴儴浼氬洖濉?memo_file 缂撳瓨; 鍐嶈涓€娆℃嬁鍒?ORDER BY sort 鐨勬渶鏂伴『搴忋€?
    let updated = memo_file
        .read_notebook_configs()
        .map_err(|e| format!("INDEX_READ_FAILED: {e}"))?;
    drop(memo_file);

    let notebooks: Vec<Notebook> = updated.into_iter().map(notebook_from_config).collect();

    // 璺ㄧ獥鍙ｅ悓姝? 璁╁叾瀹冪獥鍙?reload銆侼OTEBOOKS_CHANGED_EVENT 璧?dispatcher::emit_to
    // (璺?AGENT_ACCESS_CHANGED_EVENT / tag-system-changed 鍚屾)銆傛湰绐楀彛鍓嶇 store 涔?    // 閫氳繃 IPC 杩斿洖鍊兼洿鏂? 杩欓噷鍙彂浜嬩欢缁欏叾瀹冪獥鍙ｅ嵆鍙€?    dispatcher::emit_to(&app, NOTEBOOKS_CHANGED_EVENT, ());
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

    // 鎶婅娓呮帀鐨勯潪榛樿 notebook 鍦?access 鍒楄〃閲屼篃娓呮帀, 鐒跺悗 emit 涓€娆°€?
    let mut any_removed = false;
    for id in before_ids {
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
    if let Err(e) = switch_notebook_trusting_index(state.inner(), &app, notebook_id) {
        tracing::warn!("[set_current_notebook] switch failed: {e}");
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
