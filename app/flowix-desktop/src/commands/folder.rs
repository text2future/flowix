//! 文件夹外观（`folder_index`）IPC 命令。
//!
//! 存储和读写都在 `flowix_core::memo_file::folder_index`；这一层只负责锁、事件与
//! 参数适配。文件夹没有集合那样的 `col_` 身份，主键就是笔记本相对路径，所以
//! 命令按**笔记本路径**寻址 —— 与 `get_notebook_view_preferences` 同一套口径，
//! 调用点（文件树的每一行）手上只有 `notebookPath`，不该为了拿 id 再套一层查表。
//!
//! `folder-index-changed` 是文件树、面包屑、文件列表图标与当前文件夹表面的共同
//! 刷新信号：改一次图标要同时更新侧边栏那一行和标题旁那一枚，靠各自重读太浪费。
use crate::{app::state::AppState, lock_utils::read_lock};
use flowix_core::{
    collection::CollectionProperty, memo_file::FolderIndexEntry, memo_file::MemoFile,
};
use std::{collections::BTreeMap, path::Path};
use tauri::{Emitter, State};

/// 存储层按 id 寻址；前端只有路径，所以在这里换算一次。
fn notebook_id_for_path(memo: &MemoFile, notebook_path: &str) -> Result<String, String> {
    let root =
        dunce::canonicalize(notebook_path).map_err(|_| "NOTEBOOK_NOT_REGISTERED".to_string())?;
    memo.read_notebook_configs()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|config| dunce::canonicalize(Path::new(&config.path)).is_ok_and(|path| path == root))
        .map(|config| config.id)
        .ok_or_else(|| "NOTEBOOK_NOT_REGISTERED".to_string())
}

#[tauri::command]
pub async fn list_folder_index(
    notebook_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<FolderIndexEntry>, String> {
    let memo = state.memo_file.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let memo = read_lock(&memo, "memo_file");
        let notebook_id = notebook_id_for_path(&memo, &notebook_path)?;
        memo.list_folder_index(&notebook_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 合并写入：`null` 删除该属性键，其余覆盖。返回写入后的完整外观，调用方据此
/// 就地刷新，不必再读一次。
#[tauri::command]
pub async fn set_folder_index(
    notebook_path: String,
    relative_path: String,
    properties: BTreeMap<String, Option<CollectionProperty>>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<FolderIndexEntry, String> {
    let memo = state.memo_file.clone();
    let event_notebook_path = notebook_path.clone();
    let (notebook_id, entry) = tauri::async_runtime::spawn_blocking(move || {
        let memo = read_lock(&memo, "memo_file");
        let notebook_id = notebook_id_for_path(&memo, &notebook_path)?;
        let entry = memo.set_folder_index_properties(&notebook_id, &relative_path, properties)?;
        Ok::<_, String>((notebook_id, entry))
    })
    .await
    .map_err(|error| error.to_string())??;
    crate::watcher::host_port::schedule_cloud_sync(&app, &notebook_id, true);
    let _ = app.emit(
        "folder-index-changed",
        serde_json::json!({
            "notebookId": notebook_id,
            "notebookPath": event_notebook_path,
            "relativePath": entry.relative_path,
            "properties": entry.properties,
        }),
    );
    Ok(entry)
}
