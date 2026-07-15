//! Notebook IPC — 增删改查 + 切换当前 notebook。
//!
//! `set_current_notebook` 走 `switch_notebook_and_rebuild` helper, 触发
//! watcher rebind + 磁盘对账 + 后台索引 rebuild。
//!
//! 增 / 改 / 删 / 清空 四个写操作都会同步更新 `agent_access` store
//! (`~/.flowix/agent-access.json`), 任何 entry 真改了之后 emit
//! `agent-access-changed` 事件, 其它窗口 React 树收到后从磁盘重新 load。

use crate::events as dispatcher;
use std::path::Path;
use tauri::{AppHandle, Manager, State};

use crate::lock_utils::{read_lock, write_lock};
use flowix_core::memo_file::{MemoIndexFile, Notebook, NotebookConfig};

use super::agent_access::AGENT_ACCESS_CHANGED_EVENT;
use super::helpers::{
    refresh_watcher_roots, switch_notebook_importing_disk_as_new, switch_notebook_trusting_index,
};
use crate::app::state::AppState;

const NOTEBOOK_IMPORT_COMPLETE_EVENT: &str = "notebook-import-complete";

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
        .map(|c| Notebook {
            missing: notebook_path_missing(&c.path),
            id: c.id,
            name: c.name,
            icon: c.icon.unwrap_or_default(),
            path: c.path,
            created_at: c.created_at,
            updated_at: c.updated_at,
            is_default: c.is_default,
        })
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
    let now = chrono::Utc::now().timestamp_millis();
    let id = format!("nb_{}", now);
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

    let normalized_path = normalize_notebook_path(trimmed_path);
    let comparable_path = comparable_notebook_path(&normalized_path);
    let normalized_icon = normalize_notebook_icon(icon.clone());

    let config = NotebookConfig {
        id: id.clone(),
        name: trimmed_name.to_string(),
        icon: normalized_icon.clone(),
        path: normalized_path.clone(),
        is_default: false,
        created_at: now,
        updated_at: now,
    };

    let config = {
        let memo_file = write_lock(&state.memo_file, "memo_file");
        let mut configs = memo_file.read_notebook_configs().unwrap_or_default();
        if configs
            .iter()
            .any(|notebook| comparable_notebook_path(&notebook.path) == comparable_path)
        {
            return Err("PATH_ALREADY_REGISTERED".to_string());
        }
        configs.push(config.clone());
        memo_file
            .write_notebook_configs(&configs)
            .map_err(|e| format!("INDEX_WRITE_FAILED: {e}"))?;
        config
    };

    // 同步往 agent_access 列表里加一条 (默认 enabled), 写盘后才算
    // 同步完成 ── store 内部走原子写, 失败会回滚内存。
    let agent_access_added = state.agent_access.add_or_update_notebook(&config);
    if agent_access_added {
        dispatcher::emit_to(&app, AGENT_ACCESS_CHANGED_EVENT, ());
    }

    if let Err(e) = switch_notebook_trusting_index(state.inner(), &app, Some(id.clone())) {
        tracing::warn!("[create_notebook] failed to select new notebook after registry write: {e}");
    }

    let import_app = app.clone();
    let import_notebook_id = id.clone();
    std::thread::spawn(move || {
        let app_state = import_app.state::<AppState>();
        let current_id = read_lock(&app_state.memo_file, "memo_file").current_notebook_id_value();
        if current_id.as_deref() != Some(import_notebook_id.as_str()) {
            tracing::info!(
                "[create_notebook] skip background import because current notebook changed: {}",
                import_notebook_id
            );
            return;
        }

        {
            let memo_file = read_lock(&app_state.memo_file, "memo_file");
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

        // 空目录也写出空 memo index, 让"新建 notebook 已建立索引"这个状态可观察。
        {
            let memo_file = read_lock(&app_state.memo_file, "memo_file");
            if memo_file.read_index().is_none() {
                if let Err(e) = memo_file.write_index(&MemoIndexFile::default()) {
                    tracing::warn!("[create_notebook] failed to initialize empty memo index: {e}");
                }
            }
        }

        if let Err(e) = switch_notebook_importing_disk_as_new(
            app_state.inner(),
            &import_app,
            Some(import_notebook_id.clone()),
        ) {
            tracing::warn!("[create_notebook] background import failed: {e}");
        }
        dispatcher::emit_to(
            &import_app,
            NOTEBOOK_IMPORT_COMPLETE_EVENT,
            import_notebook_id,
        );
    });

    Ok(Notebook {
        id,
        name: trimmed_name.to_string(),
        missing: notebook_path_missing(&normalized_path),
        path: normalized_path,
        icon: normalized_icon.unwrap_or_default(),
        created_at: now,
        updated_at: now,
        is_default: config.is_default,
    })
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

    // 名字 / 路径变更都同步到 agent_access ── store 自己判定是否真改。
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

    // 同步把对应的 agent_access entry 也删了, 状态栏的"文件权限"子菜单
    // 会少一行 ── 用户没主动去勾选, 不应该留个孤儿在那里。
    if state.agent_access.remove_notebook(&id) {
        dispatcher::emit_to(&app, AGENT_ACCESS_CHANGED_EVENT, ());
    }
    refresh_watcher_roots(state.inner(), &app);
    Ok(true)
}

#[tauri::command]
pub fn clear_notebooks(state: State<AppState>, app: AppHandle) -> bool {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let configs = memo_file.read_notebook_configs().unwrap_or_default();
    let before_ids: std::collections::HashSet<String> =
        configs.iter().map(|c| c.id.clone()).collect();

    let ok = memo_file.write_notebook_configs(&[]).is_ok();
    drop(memo_file);

    // 把被清掉的非默认 notebook 在 access 列表里也清掉, 然后 emit 一次。
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
