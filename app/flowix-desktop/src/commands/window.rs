//! General application window commands.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

use crate::app::state::AppState;
use crate::config::Theme;

static MAIN_WINDOW_FOCUS_CONSUMED: AtomicBool = AtomicBool::new(false);

// Keep auxiliary macOS windows aligned with the position configured for the
// main window in tauri.conf*.json. The explicit decorations setting is
// required for Tauri to apply the traffic-light inset on overlay title bars.
#[cfg(target_os = "macos")]
const MACOS_TRAFFIC_LIGHT_POSITION: tauri::LogicalPosition<f64> =
    tauri::LogicalPosition::new(18.0, 25.0);

fn preferences_navigation_script(hash: &str) -> Result<String, String> {
    serde_json::to_string(hash)
        .map(|hash| format!("window.location.hash = {hash};"))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod navigation_tests {
    use super::*;

    #[test]
    fn untrusted_hash_is_encoded_as_a_single_string_literal() {
        let hash = "preferences/';alert(1);//\n\"\\";
        let script = preferences_navigation_script(hash).unwrap();
        let literal = script
            .strip_prefix("window.location.hash = ")
            .unwrap()
            .strip_suffix(';')
            .unwrap();
        assert_eq!(serde_json::from_str::<String>(literal).unwrap(), hash);
    }
}

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
            .eval(preferences_navigation_script(
                url.split_once('#').map(|(_, hash)| hash).unwrap_or(""),
            )?)
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
        .decorations(true)
        .hidden_title(true)
        .traffic_light_position(tauri::Position::Logical(MACOS_TRAFFIC_LIGHT_POSITION));

    #[cfg(target_os = "windows")]
    let builder = builder.decorations(false);

    let window = builder.build().map_err(|e| e.to_string())?;
    crate::window_chrome::apply_window_border_color(&window);
    // 新窗口即刻�?齐主题背�?�� (与主窗口�?��一�?, 避免冷启动白�?�?
    let theme = state.user_config.get_preference().theme;
    crate::window_chrome::apply_theme_background(&window, theme);
    Ok(())
}

/// 前�?切换主�?时立即调�? 把新主�?应用到所有窗口的原生 chrome (`set_theme` + 背景�?,
/// 不等 `set_preference` �?200ms 防抖落盘, 实现实时跟随。落盘仍�?debounced
/// `set_preference`, 与这里解�?-- 视�?更新与持久化分�?�?
#[tauri::command]
pub fn apply_window_theme(theme: Theme, app: tauri::AppHandle) -> Result<(), String> {
    crate::window_chrome::apply_theme_background_all(&app, theme);
    Ok(())
}
