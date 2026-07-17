//! Window IPC — preferences 窗口打开 / 聚焦。
//!
//! 单个 IPC 命令, 因为 macOS / Windows 的 title bar 风格不同 (Overlay 跟无装饰),
//! 各放一个 `#[cfg(target_os = ...)]` 分支。

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

use crate::app::state::AppState;
use crate::config::Theme;
use crate::lock_utils::read_lock;

static MAIN_WINDOW_FOCUS_CONSUMED: AtomicBool = AtomicBool::new(false);
static NOTE_WINDOW_CASCADE_INDEX: AtomicUsize = AtomicUsize::new(0);
static NOTE_WINDOW_OPEN_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
const NOTE_WINDOW_CASCADE_OFFSET: i32 = 32;
const NOTE_WINDOW_CASCADE_SLOTS: usize = 8;

#[tauri::command]
pub fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    crate::window_chrome::apply_window_border_color(&window);
    window.show().map_err(|e| e.to_string())?;

    if !MAIN_WINDOW_FOCUS_CONSUMED.swap(true, Ordering::SeqCst) {
        window.set_focus().ok();
    }

    Ok(())
}

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
    state: tauri::State<'_, AppState>,
    tab: Option<String>,
) -> Result<(), String> {
    use tauri::WebviewWindowBuilder;

    let boot_theme = match state.user_config.get_preference().theme {
        Theme::System => None,
        Theme::Light => Some("light"),
        Theme::Dark => Some("dark"),
        Theme::Rock => Some("rock"),
        Theme::Mist => Some("mist"),
        Theme::Ember => Some("ember"),
    };
    let base = match boot_theme {
        Some(theme) => format!("index.html?bootTheme={theme}"),
        None => "index.html".to_string(),
    };
    let url = match tab {
        Some(t) => format!("{base}#preferences/{}", t),
        None => format!("{base}#preferences"),
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

fn cascaded_note_window_position(
    anchor: (i32, i32),
    window_size: (u32, u32),
    monitor_origin: (i32, i32),
    monitor_size: (u32, u32),
    cascade_index: usize,
) -> (i32, i32) {
    let monitor_width = monitor_size.0.min(i32::MAX as u32) as i32;
    let monitor_height = monitor_size.1.min(i32::MAX as u32) as i32;
    let window_width = window_size.0.min(i32::MAX as u32) as i32;
    let window_height = window_size.1.min(i32::MAX as u32) as i32;
    let max_x = monitor_origin
        .0
        .saturating_add(monitor_width)
        .saturating_sub(window_width)
        .max(monitor_origin.0);
    let max_y = monitor_origin
        .1
        .saturating_add(monitor_height)
        .saturating_sub(window_height)
        .max(monitor_origin.1);
    let base_x = anchor.0.saturating_add(64).clamp(monitor_origin.0, max_x);
    let base_y = anchor.1.saturating_add(64).clamp(monitor_origin.1, max_y);
    let cascade_offset = NOTE_WINDOW_CASCADE_OFFSET * cascade_index as i32;

    let cascade_axis = |base: i32, min: i32, max: i32| {
        let forward = base.saturating_add(cascade_offset);
        if forward <= max {
            forward
        } else {
            base.saturating_sub(cascade_offset).clamp(min, max)
        }
    };

    (
        cascade_axis(base_x, monitor_origin.0, max_x),
        cascade_axis(base_y, monitor_origin.1, max_y),
    )
}

fn cascade_note_window(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let Some(main_window) = app.get_webview_window("main") else {
        return;
    };
    let (Ok(anchor), Ok(window_size), Ok(Some(monitor))) = (
        main_window.outer_position(),
        window.outer_size(),
        main_window.current_monitor(),
    ) else {
        return;
    };
    let index =
        NOTE_WINDOW_CASCADE_INDEX.fetch_add(1, Ordering::Relaxed) % NOTE_WINDOW_CASCADE_SLOTS;
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let (x, y) = cascaded_note_window_position(
        (anchor.x, anchor.y),
        (window_size.width, window_size.height),
        (monitor_position.x, monitor_position.y),
        (monitor_size.width, monitor_size.height),
        index,
    );
    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            x, y,
        )))
        .ok();
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

    // Serialize the check-and-build section. Without this lock, concurrent
    // requests for the same memo can both observe a missing label and one build
    // fails with a duplicate-label error instead of behaving idempotently.
    let _open_guard = NOTE_WINDOW_OPEN_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "note window open lock poisoned".to_string())?;

    let payload = resolve_note_window_payload_inner(&memo_id, state.inner())?;
    let label = note_window_label(&payload.memo_id);

    if let Some(window) = app.get_webview_window(&label) {
        window.unminimize().ok();
        window.set_focus().ok();
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
    cascade_note_window(&app, &window);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::cascaded_note_window_position;

    #[test]
    fn note_windows_cascade_from_the_main_window() {
        assert_eq!(
            cascaded_note_window_position((100, 80), (900, 680), (0, 0), (1920, 1080), 0),
            (164, 144)
        );
        assert_eq!(
            cascaded_note_window_position((100, 80), (900, 680), (0, 0), (1920, 1080), 2),
            (228, 208)
        );
    }

    #[test]
    fn note_window_position_is_clamped_to_the_current_monitor() {
        assert_eq!(
            cascaded_note_window_position((1600, 900), (900, 680), (0, 0), (1920, 1080), 7,),
            (796, 176)
        );
    }

    #[test]
    fn note_window_position_supports_negative_monitor_origins() {
        assert_eq!(
            cascaded_note_window_position((-1800, 100), (900, 680), (-1920, 0), (1920, 1080), 1,),
            (-1704, 196)
        );
    }
}
