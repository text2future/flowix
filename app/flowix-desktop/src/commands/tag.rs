//! Tag IPC：从 memo index 的 YAML/正文标签并集派生标签列表，并在用户
//! 显式重命名或删除标签时同时改写两个真实来源。
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::app::search_index::try_index_upsert;
use crate::lock_utils::read_lock;
use crate::memo_events::{self, MemoEvent};
use crate::watcher::runtime::mark_self_write_for;
use flowix_core::memo_file::types::{DeleteTagReport, MoveTagReport};

use crate::app::state::AppState;

fn mark_tagged_memos_cloud_dirty(state: &AppState, notebook_id: &str, memo_ids: &[String]) {
    for memo_id in memo_ids {
        if let Err(error) = state.cloud_sync.record_v2_local_change(
            notebook_id,
            memo_id,
            flowix_sync::LocalChangeKind::Put,
            "unobserved",
        ) {
            tracing::warn!(
                "failed to persist cloud dirty tag change for {notebook_id}/{memo_id}: {error}"
            );
        }
    }
}

#[derive(Serialize)]
pub struct GetAllTagsResponse {
    pub tags: Vec<TagWithId>,
}

#[derive(Serialize)]
pub struct TagWithId {
    pub id: String,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTagReport {
    pub path: String,
}

#[tauri::command]
pub async fn get_all_tags(
    notebook_id: Option<String>,
    app: AppHandle,
) -> Result<GetAllTagsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
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
    })
    .await
    .map_err(|error| format!("tag list task failed: {error}"))
}

#[tauri::command]
pub fn create_notebook_tag(
    notebook_id: String,
    path: String,
    state: State<AppState>,
) -> Result<CreateTagReport, String> {
    let path = read_lock(&state.memo_file, "memo_file")
        .create_notebook_tag(&notebook_id, &path)
        .map_err(|error| error.to_string())?;
    Ok(CreateTagReport { path })
}

/// 移动 subtag: �?`old_path` 整棵子树重命�?(�?prefix 替换),
/// 批量改写所有受影响 memo �?`.md` body + 同�? memo index�?///
/// 返回 `MoveTagReport { affectedMemos, renamedTags }` —前�?拿到
/// `renamedTags` 鍚庡彲绮剧‘鍒锋柊 dropdown / 鏍囩闈㈡澘缂撳瓨, 閬垮厤閲嶆柊鎷夊叏琛ㄣ€?
#[tauri::command]
pub fn move_memo_tag(
    notebook_id: Option<String>,
    old_path: String,
    new_path: String,
    state: State<AppState>,
    app: AppHandle,
) -> Result<MoveTagReport, String> {
    // 收集每个被改写 memo 的 (id, before): 持锁期间由 core 回调 push,
    // 释放 read lock 后再 emit。不能在回调里直接 emit ── emit_updated_after_write
    // 内部会 read_lock(memo_file), 而 move_memo_tag 已持 read lock,
    // std RwLock 不支持同线程递归 read, 会死锁。
    let mut affected_memo_ids: Vec<String> = Vec::new();
    let report = {
        let memo_file = state
            .memo_file
            .read()
            .map_err(|e| format!("memo_file read lock poisoned: {e}"))?;
        memo_file
            .move_memo_tag_locked_with_hooks(
                notebook_id.as_deref(),
                &old_path,
                &new_path,
                |path| mark_self_write_for(&app, path),
                |id, _before| affected_memo_ids.push(id.to_string()),
            )
            .map_err(|e| e.to_string())?
    };

    // read lock 已释放: 逐条 emit MemoEvent::Updated, 让前端 memo 卡片 /
    // 标签树刷新 (derived_changed.tags -> refreshSelectedNotebookMetadata)。
    for id in &affected_memo_ids {
        try_index_upsert(state.inner(), id);
    }
    let sync_notebook_id = notebook_id.as_deref().unwrap_or("nb_default");
    mark_tagged_memos_cloud_dirty(state.inner(), sync_notebook_id, &affected_memo_ids);
    if !affected_memo_ids.is_empty() {
        crate::commands::cloud::schedule_notebook_sync(app.clone(), sync_notebook_id.to_string());
    }
    memo_events::emit(
        &app,
        MemoEvent::TagsRenamed {
            notebook_id: notebook_id.unwrap_or_else(|| "nb_default".to_string()),
            renamed_tags: report.renamed_tags.clone(),
            affected_memo_ids,
        },
    );
    Ok(report)
}

// Delete tag: remove `tag_path` itself + all subtree tags (any depth)
// from memo index + frontmatter/body tag sources. Event strategy is
// symmetric -- one-shot emit `MemoEvent::TagsDeleted` (instead of
// per-memo Updated).
#[tauri::command]
pub fn delete_memo_tag(
    notebook_id: Option<String>,
    tag_path: String,
    state: State<AppState>,
    app: AppHandle,
) -> Result<DeleteTagReport, String> {
    let mut affected_memo_ids: Vec<String> = Vec::new();
    let report = {
        let memo_file = state
            .memo_file
            .read()
            .map_err(|e| format!("memo_file read lock poisoned: {e}"))?;
        memo_file
            .delete_memo_tag_locked_with_hooks(
                notebook_id.as_deref(),
                &tag_path,
                |path| mark_self_write_for(&app, path),
                |id, _before| affected_memo_ids.push(id.to_string()),
            )
            .map_err(|e| e.to_string())?
    };

    // read lock released:
    // 1) refresh search index per affected memo (tag removed from body,
    //    search index must follow -- otherwise stale hits leak through).
    for id in &affected_memo_ids {
        try_index_upsert(state.inner(), id);
    }
    let sync_notebook_id = notebook_id.as_deref().unwrap_or("nb_default");
    mark_tagged_memos_cloud_dirty(state.inner(), sync_notebook_id, &affected_memo_ids);
    if !affected_memo_ids.is_empty() {
        crate::commands::cloud::schedule_notebook_sync(app.clone(), sync_notebook_id.to_string());
    }
    // 2) one-shot emit TagsDeleted to the frontend.
    memo_events::emit(
        &app,
        MemoEvent::TagsDeleted {
            notebook_id: notebook_id.unwrap_or_else(|| "nb_default".to_string()),
            deleted_tags: report.deleted_tags.clone(),
            affected_memo_ids,
        },
    );
    Ok(report)
}

/// �?���?tag 树前缀计数: 每个 prefix (e.g. `�?��`, `�?��/湖南`) 对应
/// 挂了"以�? prefix 起�?�?tag"的去�?memo 数。用于侧栏树节点�?/// 显示的数�?—必须�?memo �? 不能�?tag 数累�?(同一 memo 多个
/// �?tag 在父 prefix 下只�?1)�?
#[tauri::command]
pub async fn get_tag_prefix_counts(
    notebook_id: Option<String>,
    app: AppHandle,
) -> Result<std::collections::HashMap<String, usize>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let memo_file = state.memo_file.read().unwrap_or_else(|poisoned| {
            tracing::error!("memo_file read lock poisoned, recovering");
            poisoned.into_inner()
        });
        memo_file
            .read_tag_prefix_counts_for_notebook_id(notebook_id.as_deref())
            .unwrap_or_default()
    })
    .await
    .map_err(|error| format!("tag count task failed: {error}"))
}
