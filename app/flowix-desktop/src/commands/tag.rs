//! Tag IPC — 从 index.json 派生 tag + 增删改(目前是 stub)。
//!
//! `rename_memo_tag` / `delete_memo_tag` 是占位实现, 一直返回 `None` / `false`。
//! 真实增删改需要批量重写所有 memo 的 .md 文件中的 `#tag` 行, 工作量较大, 未补全。

use serde::Serialize;
use tauri::State;

use crate::lock_utils::read_lock;

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
pub fn get_all_tags(state: State<AppState>) -> GetAllTagsResponse {
    let tags = read_lock(&state.memo_file, "memo_file").derived_tags();
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
