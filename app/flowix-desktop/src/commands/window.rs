//! Window IPC — preferences 窗口打开 / 聚焦。
//!
//! 单个 IPC 命令, 因为 macOS / Windows 的 title bar 风格不同 (Overlay 跟无装饰),
//! 各放一个 `#[cfg(target_os = ...)]` 分支。

use serde::Serialize;
use tauri::Manager;

use crate::commands::AppState;
use crate::lock_utils::read_lock;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteWindowPayload {
    pub memo_id: String,
    pub notebook_id: String,
    pub notebook_path: String,
    pub file_path: String,
}

#[tauri::command]
pub async fn open_preferences_window(
    app: tauri::AppHandle,
    tab: Option<String>,
) -> Result<(), String> {
    use tauri::WebviewWindowBuilder;

    let url = match tab {
        Some(t) => format!("index.html#preferences/{}", t),
        None => "index.html#preferences".to_string(),
    };

    // Check if window already exists
    if let Some(window) = app.get_webview_window("preferences") {
        window.set_focus().ok();
        window
            .eval(format!(
                "window.location.hash = '{}';",
                url.split('#').next_back().unwrap_or("")
            ))
            .ok();
        return Ok(());
    }

    let builder =
        WebviewWindowBuilder::new(&app, "preferences", tauri::WebviewUrl::App(url.into()))
            .title("Preferences")
            .inner_size(800.0, 600.0)
            .center()
            // Keep DevTools available in debug builds for manual inspection;
            // release builds keep it disabled.
            .devtools(cfg!(debug_assertions));

    // macOS: use the same overlay title bar style as the main window so the
    // app-rendered drag region is contiguous with the system-rendered traffic
    // lights, instead of stacking a second native title strip on top. The
    // traffic light cluster is positioned at x=18, y=25 — mirroring the main
    // window (`app/flowix-desktop/tauri.conf.json`) so both windows visually share
    // the same origin and stay centered within the 48px (`h-12`) drag bar.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::Position::Logical(tauri::LogicalPosition::new(
            18.0, 25.0,
        )));

    #[cfg(target_os = "windows")]
    let builder = builder.decorations(false);

    let window = builder.build().map_err(|e| e.to_string())?;
    crate::window_chrome::apply_window_border_color(&window);

    Ok(())
}

fn note_window_label(memo_id: &str) -> String {
    let safe_id: String = memo_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect();
    format!("note-{}", safe_id)
}

fn resolve_note_window_payload_inner(
    memo_id: &str,
    state: &AppState,
) -> Result<NoteWindowPayload, String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let location = memo_file
        .resolve_memo_location(memo_id)
        .map_err(|e| format!("resolve memo location failed: {e}"))?
        .ok_or_else(|| format!("memo not found: {memo_id}"))?;
    let file_path = std::path::PathBuf::from(&location.notebook.path)
        .join(&location.memo.filename)
        .to_string_lossy()
        .to_string();

    Ok(NoteWindowPayload {
        memo_id: memo_id.to_string(),
        notebook_id: location.notebook.id,
        notebook_path: location.notebook.path,
        file_path,
    })
}

#[tauri::command]
pub async fn resolve_note_window_payload(
    memo_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<NoteWindowPayload, String> {
    resolve_note_window_payload_inner(&memo_id, state.inner())
}

#[tauri::command]
pub async fn open_note_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    memo_id: String,
) -> Result<(), String> {
    use tauri::WebviewWindowBuilder;

    let payload = resolve_note_window_payload_inner(&memo_id, state.inner())?;
    let label = note_window_label(&payload.memo_id);

    if let Some(window) = app.get_webview_window(&label) {
        window.set_focus().ok();
        window.unminimize().ok();
        return Ok(());
    }

    let builder = WebviewWindowBuilder::new(
        &app,
        label.clone(),
        tauri::WebviewUrl::App(format!("index.html#note-window/{}", payload.memo_id).into()),
    )
    .title("Flowix")
    .inner_size(900.0, 680.0)
    .min_inner_size(420.0, 520.0)
    .center()
    .devtools(cfg!(debug_assertions));

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::Position::Logical(tauri::LogicalPosition::new(
            18.0, 25.0,
        )));

    #[cfg(target_os = "windows")]
    let builder = builder.decorations(false);

    let window = builder.build().map_err(|e| e.to_string())?;
    crate::window_chrome::apply_window_border_color(&window);

    Ok(())
}
