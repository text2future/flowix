//! Read-only, paginated access to the existing link projection. Reads never
//! parse/reconcile notes; background extraction is merely requested.
use crate::app::state::AppState;
use flowix_core::memo_file::{MemoFile, NoteLinkPage, NoteLinkStatus};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn list_note_links(
    notebook_id: String,
    relative_path: String,
    backlinks: bool,
    cursor: Option<String>,
    limit: Option<usize>,
    app: AppHandle,
) -> Result<NoteLinkPage, String> {
    let state = app.state::<AppState>();
    state.notebook_background.request_links(&notebook_id);
    let config = state.user_config.config_dir().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let memo = MemoFile::new(config);
        if backlinks {
            memo.query_note_backlinks(
                &notebook_id,
                &relative_path,
                cursor.as_deref(),
                limit.unwrap_or(50),
            )
        } else {
            memo.query_note_outlinks(
                &notebook_id,
                &relative_path,
                cursor.as_deref(),
                limit.unwrap_or(50),
            )
        }
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_note_link_status(
    notebook_id: String,
    app: AppHandle,
) -> Result<NoteLinkStatus, String> {
    let state = app.state::<AppState>();
    state.notebook_background.request_links(&notebook_id);
    let config = state.user_config.config_dir().clone();
    tauri::async_runtime::spawn_blocking(move || {
        MemoFile::new(config)
            .note_link_status(&notebook_id)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
