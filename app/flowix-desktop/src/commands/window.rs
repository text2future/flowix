//! General application window commands.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

use crate::app::state::AppState;
use crate::config::Theme;

static MAIN_WINDOW_FOCUS_CONSUMED: AtomicBool = AtomicBool::new(false);

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
        Some(tab) => format!("{base}#preferences/{tab}"),
        None => format!("{base}#preferences"),
    };

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
    // 鏂扮獥鍙ｅ嵆鍒诲榻愪富棰樿儗鏅壊 (涓庝富绐楀彛鍚姩涓€鑷?, 閬垮厤鍐峰惎鍔ㄧ櫧闂€?
    let theme = state.user_config.get_preference().theme;
    crate::window_chrome::apply_theme_background(&window, theme);
    Ok(())
}

/// 鍓嶇鍒囨崲涓婚鏃剁珛鍗宠皟鐢? 鎶婃柊涓婚搴旂敤鍒版墍鏈夌獥鍙ｇ殑鍘熺敓 chrome (`set_theme` + 鑳屾櫙鑹?,
/// 涓嶇瓑 `set_preference` 鐨?200ms 闃叉姈钀界洏, 瀹炵幇瀹炴椂璺熼殢銆傝惤鐩樹粛璧?debounced
/// `set_preference`, 涓庤繖閲岃В鑰?-- 瑙嗚鏇存柊涓庢寔涔呭寲鍒嗙銆?
#[tauri::command]
pub fn apply_window_theme(theme: Theme, app: tauri::AppHandle) -> Result<(), String> {
    crate::window_chrome::apply_theme_background_all(&app, theme);
    Ok(())
}
