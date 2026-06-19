//! Notebook IPC — 增删改查 + 切换当前 notebook。
//!
//! `set_current_notebook` 走 `switch_notebook_and_rebuild` helper, 触发
//! watcher rebind + 磁盘对账 + 后台索引 rebuild。
//!
//! 增 / 改 / 删 / 清空 四个写操作都会同步更新 `agent_access` store
//! (`~/.flowix/agent_access.json`), 任何 entry 真改了之后 emit
//! `agent-access-changed` 事件, 其它窗口 React 树收到后从磁盘重新 load。

use crate::watcher::dispatcher;
use tauri::{AppHandle, Emitter, State};

use crate::lock_utils::{read_lock, write_lock};
use flowix_core::memo_file::{MemoIndexFile, Notebook, NotebookConfig};

use super::agent_access::AGENT_ACCESS_CHANGED_EVENT;
use super::helpers::{switch_notebook_and_rebuild, switch_notebook_trusting_index};
use super::AppState;

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
            id: c.id,
            name: c.name,
            icon: c.icon.unwrap_or_else(|| "📓".to_string()),
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
) -> Option<Notebook> {
    // 先把 config 写好, 再走 helper 同步切换 notebook、扫描根目录 .md 文件并触发索引 rebuild.
    let now = chrono::Utc::now().timestamp_millis();
    let id = format!("nb_{}", now);
    let normalized_path = if path.ends_with('/') || path.ends_with('\\') {
        path.clone()
    } else {
        format!("{}/", path)
    };

    let config = NotebookConfig {
        id: id.clone(),
        name: name.clone(),
        icon: icon.clone().or_else(|| Some("📓".to_string())),
        path: normalized_path.clone(),
        is_default: false,
        created_at: now,
        updated_at: now,
    };

    {
        let memo_file = write_lock(&state.memo_file, "memo_file");
        let mut configs = memo_file.read_notebook_configs().unwrap_or_default();
        configs.push(config.clone());
        memo_file.write_notebook_configs(&configs).ok()?;
    }

    // 同步往 agent_access 列表里加一条 (默认 enabled), 写盘后才算
    // 同步完成 ── store 内部走原子写, 失败会回滚内存。
    if state.agent_access.add_or_update_notebook(&config) {
        dispatcher::emit_to(&app, AGENT_ACCESS_CHANGED_EVENT, ());
    }

    // 触发同步磁盘对账 + 后台索引 rebuild:
    // - 只扫描 notebook 根目录下的 markdown 文件, 不递归子文件夹。
    // - 未带 `#xxxxxx` id 的文件会生成 memo id 并重命名为 `{filename}#id.md`。
    // - 对账完成后 index.json 是 memo 列表的唯一真源。
    switch_notebook_and_rebuild(state.inner(), &app, Some(id.clone()));

    // 空目录也写出空 index.json, 让"新建 notebook 已建立索引"这个状态可观察。
    {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        if memo_file.read_index().is_none() {
            memo_file.write_index(&MemoIndexFile::default()).ok()?;
        }
    }

    Some(Notebook {
        id,
        name,
        path: normalized_path,
        icon: icon.unwrap_or_else(|| "📓".to_string()),
        created_at: now,
        updated_at: now,
        is_default: false,
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
        configs[index].icon = Some(i);
    }
    configs[index].updated_at = chrono::Utc::now().timestamp_millis();

    memo_file.write_notebook_configs(&configs).ok()?;

    let updated = configs[index].clone();
    drop(memo_file);

    // 名字 / 路径变更都同步到 agent_access ── store 自己判定是否真改。
    if state.agent_access.add_or_update_notebook(&updated) {
        dispatcher::emit_to(&app, AGENT_ACCESS_CHANGED_EVENT, ());
    }

    Some(Notebook {
        id: updated.id,
        name: updated.name,
        path: updated.path,
        icon: updated.icon.unwrap_or_else(|| "📓".to_string()),
        created_at: updated.created_at,
        updated_at: updated.updated_at,
        is_default: updated.is_default,
    })
}

#[tauri::command]
pub fn delete_notebook(id: String, state: State<AppState>, app: AppHandle) -> bool {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let mut configs = memo_file.read_notebook_configs().unwrap_or_default();

    let index = match configs.iter().position(|c| c.id == id && !c.is_default) {
        Some(idx) => idx,
        None => return false,
    };
    configs.remove(index);

    let _ = memo_file.write_notebook_configs(&configs).is_ok();

    // 同步把对应的 agent_access entry 也删了, 状态栏的"文件权限"子菜单
    // 会少一行 ── 用户没主动去勾选, 不应该留个孤儿在那里。
    if state.agent_access.remove_notebook(&id) {
        dispatcher::emit_to(&app, AGENT_ACCESS_CHANGED_EVENT, ());
    }
    true
}

#[tauri::command]
pub fn clear_notebooks(state: State<AppState>, app: AppHandle) -> bool {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let mut configs = memo_file.read_notebook_configs().unwrap_or_default();

    let before_ids: std::collections::HashSet<String> = configs
        .iter()
        .filter(|c| !c.is_default)
        .map(|c| c.id.clone())
        .collect();
    configs.retain(|c| c.is_default);

    let ok = memo_file.write_notebook_configs(&configs).is_ok();
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
    ok
}

#[tauri::command]
pub fn set_current_notebook(notebook_id: Option<String>, state: State<AppState>, app: AppHandle) {
    // Fast path for ordinary switching: trust index.json and avoid synchronous
    // disk reconciliation. Search index rebuild is lazy, triggered by search.
    switch_notebook_trusting_index(state.inner(), &app, notebook_id);
}
