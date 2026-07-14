//! Tag IPC — 从 memo index 派生 tag + 移动 / 增删改。
//!
//! `get_all_tags` 从 `memo.tags` 派生去重 tag 列表; `move_memo_tag` 实现
//! 路径式 tag 的整棵子树重命名 (Step 3)。`rename_memo_tag` /
//! `delete_memo_tag` / `create_memo_tag` 仍是占位实现 ── 完整支持需要
//! 改写 .md body, 等同于 move_memo_tag 的特殊形式, 暂不补全。

use serde::Serialize;
use tauri::State;

use crate::lock_utils::read_lock;
use flowix_core::memo_file::types::MoveTagReport;

use super::AppState;

#[derive(Serialize)]
pub struct GetAllTagsResponse {
    pub tags: Vec<TagWithId>,
}

#[derive(Serialize)]
pub struct TagWithId {
    pub id: String,
    pub name: String,
}

#[tauri::command]
pub fn get_all_tags(notebook_id: Option<String>, state: State<AppState>) -> GetAllTagsResponse {
    let tags = read_lock(&state.memo_file, "memo_file")
        .derived_tags_for_notebook_id(notebook_id.as_deref());
    GetAllTagsResponse {
        tags: tags
            .into_iter()
            .map(|t| TagWithId {
                id: t.id,
                name: t.name,
            })
            .collect(),
    }
}

/// 移动 subtag: 把 `old_path` 整棵子树重命名 (含 prefix 替换),
/// 批量改写所有受影响 memo 的 `.md` body + 同步 memo index。
///
/// 返回 `MoveTagReport { affectedMemos, renamedTags }` — 前端拿到
/// `renamedTags` 后可精确刷新 dropdown / 标签面板缓存, 避免重新拉全表。
#[tauri::command]
pub fn move_memo_tag(
    notebook_id: Option<String>,
    old_path: String,
    new_path: String,
    state: State<AppState>,
) -> Result<MoveTagReport, String> {
    let memo_file = state
        .memo_file
        .read()
        .map_err(|e| format!("memo_file read lock poisoned: {e}"))?;
    memo_file
        .move_memo_tag_locked(notebook_id.as_deref(), &old_path, &new_path)
        .map_err(|e| e.to_string())
}

/// 路径式 tag 树前缀计数: 每个 prefix (e.g. `中国`, `中国/湖南`) 对应
/// 挂了"以该 prefix 起始的 tag"的去重 memo 数。用于侧栏树节点上
/// 显示的数字 — 必须按 memo 数, 不能按 tag 数累加 (同一 memo 多个
/// 子 tag 在父 prefix 下只算 1)。
#[tauri::command]
pub fn get_tag_prefix_counts(
    notebook_id: Option<String>,
    state: State<AppState>,
) -> std::collections::HashMap<String, usize> {
    let memo_file = state.memo_file.read().unwrap_or_else(|poisoned| {
        tracing::error!("memo_file read lock poisoned, recovering");
        poisoned.into_inner()
    });
    memo_file
        .read_tag_prefix_counts_for_notebook_id(notebook_id.as_deref())
        .unwrap_or_default()
}

#[tauri::command]
pub fn create_memo_tag(name: String, state: State<AppState>) -> Option<TagWithId> {
    let exists = state
        .memo_file
        .read()
        .unwrap()
        .derived_tags()
        .into_iter()
        .any(|tag| tag.name.eq_ignore_ascii_case(&name));

    exists.then(|| TagWithId {
        id: name.clone(),
        name,
    })
}

#[tauri::command]
pub fn rename_memo_tag(_id: String, _name: String, _state: State<AppState>) -> Option<TagWithId> {
    None
}

#[tauri::command]
pub fn delete_memo_tag(_id: String, _state: State<AppState>) -> bool {
    false
}
