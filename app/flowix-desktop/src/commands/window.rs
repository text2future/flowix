//! Window IPC — preferences 窗口打开 / 聚焦。
//!
//! 单个 IPC 命令, 因为 macOS / Windows 的 title bar 风格不同 (Overlay 跟无装饰),
//! 各放一个 `#[cfg(target_os = ...)]` 分支。

use tauri::Manager;

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

    let _window = builder.build().map_err(|e| e.to_string())?;

    Ok(())
}
