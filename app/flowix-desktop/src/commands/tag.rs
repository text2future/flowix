//! Tag IPC：从 memo index 的 YAML/正文标签并集派生标签列表，并在用户
//! 显式重命名或删除标签时同时改写两个真实来源。
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::app::search_index::try_index_upsert;
use crate::lock_utils::read_lock;
use crate::memo_events::{self, MemoEvent};
use crate::watcher::runtime::mark_self_write_for;
use flowix_core::memo_file::types::{DeleteTagReport, MoveTagReport};

use crate::app::state::AppState;

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

/// 绉诲姩 subtag: 鎶?`old_path` 鏁存５瀛愭爲閲嶅懡鍚?(鍚?prefix 鏇挎崲),
/// 鎵归噺鏀瑰啓鎵€鏈夊彈褰卞搷 memo 鐨?`.md` body + 鍚屾 memo index銆?///
/// 杩斿洖 `MoveTagReport { affectedMemos, renamedTags }` 鈥?鍓嶇鎷垮埌
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


/// 璺緞寮?tag 鏍戝墠缂€璁℃暟: 姣忎釜 prefix (e.g. `涓浗`, `涓浗/婀栧崡`) 瀵瑰簲
/// 鎸備簡"浠ヨ prefix 璧峰鐨?tag"鐨勫幓閲?memo 鏁般€傜敤浜庝晶鏍忔爲鑺傜偣涓?/// 鏄剧ず鐨勬暟瀛?鈥?蹇呴』鎸?memo 鏁? 涓嶈兘鎸?tag 鏁扮疮鍔?(鍚屼竴 memo 澶氫釜
/// 瀛?tag 鍦ㄧ埗 prefix 涓嬪彧绠?1)銆?
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
