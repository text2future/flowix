//! General application window commands.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

use crate::app::state::AppState;
use crate::config::Theme;

static MAIN_WINDOW_FOCUS_CONSUMED: AtomicBool = AtomicBool::new(false);

// Keep auxiliary macOS windows aligned with the position configured for the
// main window in tauri.conf*.json. The explicit decorations setting is
// required for Tauri to apply the traffic-light inset on overlay title bars.
#[cfg(target_os = "macos")]
const MACOS_TRAFFIC_LIGHT_POSITION: tauri::LogicalPosition<f64> =
    tauri::LogicalPosition::new(15.0, 25.0);

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
    if crate::commands::window_shutdown::is_exiting() {
        return Ok(());
    }
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    window.show().map_err(|e| e.to_string())?;
    if !MAIN_WINDOW_FOCUS_CONSUMED.swap(true, Ordering::SeqCst) {
        window.set_focus().ok();
    }
    Ok(())
}

/// Returns the native backdrop successfully applied to the main window.
#[tauri::command]
pub fn get_window_material() -> &'static str {
    crate::window_material::active_material()
}

#[tauri::command]
pub async fn open_preferences_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    tab: Option<String>,
) -> Result<(), String> {
    open_preferences_window_inner(&app, &state, tab.as_deref())
}

#[tauri::command]
pub fn open_payment_dialog_in_main(app: tauri::AppHandle, tab: String) -> Result<(), String> {
    if tab != "membership" && tab != "credits" {
        return Err("Unsupported payment dialog tab".into());
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window is unavailable".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    app.emit_to("main", "billing:open-payment-dialog", tab)
        .map_err(|error| error.to_string())
}

pub(crate) fn open_preferences_window_inner(
    app: &tauri::AppHandle,
    state: &AppState,
    tab: Option<&str>,
) -> Result<(), String> {
    use tauri::WebviewWindowBuilder;
    if crate::commands::window_shutdown::is_exiting() {
        return Err("Application is closing".into());
    }

    let boot_theme = match state.user_config.get_preference().theme {
        Theme::System => None,
        Theme::Light => Some("light"),
        Theme::Dark => Some("dark"),
        Theme::Mist => Some("rock"),
        Theme::Rock => Some("rock"),
        Theme::Ember => Some("ember"),
    };
    let base = match boot_theme {
        Some(theme) => format!("index.html?bootTheme={theme}"),
        None => "index.html".to_string(),
    };
    let hash = match tab {
        Some(tab) => format!("preferences/{tab}"),
        None => "preferences".to_string(),
    };
    let url = format!("{base}#{hash}");

    if let Some(window) = app.get_webview_window("preferences") {
        window
            .eval(preferences_navigation_script(&hash)?)
            .map_err(|error| error.to_string())?;
        // 再次打开时窗口通常已可见; show 用于兜住"首次打开还没等到首帧信号"
        // 就又被触发一次的窄窗口, 幂等且不会导致闪烁。
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let builder = WebviewWindowBuilder::new(app, "preferences", tauri::WebviewUrl::App(url.into()))
        .title("Preferences")
        .visible(false)
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
    crate::commands::window_shutdown::install_window(&window);
    // 新窗口即刻对齐主题背景色 (与主窗口一致, 避免冷启动白闪)
    let mut theme = state.user_config.get_preference().theme;
    if theme == Theme::Mist {
        theme = Theme::Rock;
    }
    crate::window_chrome::apply_window_chrome_theme(&window, theme);
    // 立刻显示: 点击后必须马上有反馈。webview 冷启动期间窗口内先呈现主题底色与
    // index.html 自带的静态 loading, 界面由前端渲染完成后替换 (前端在设置界面
    // 首帧之后才摘掉那个 loading, 所以不会出现"空窗")。
    // 试过"等前端首帧再 show", dev 下等于点击后半分钟毫无反应, 比空窗更糟。
    window.show().map_err(|error| error.to_string())?;
    Ok(())
}

/// Apply the effective theme to this window. Other windows independently follow
/// shared preferences and account membership, without overwriting each other.
#[tauri::command]
pub async fn apply_window_theme(
    theme: Theme,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<&'static str, String> {
    let theme = if theme == Theme::Mist {
        let cloud = state.cloud_sync.account().state().map_err(|error| error.to_string())?;
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| error.to_string())?.as_millis() as i64;
        let has_membership = cloud.authenticated
            && cloud.membership.as_ref().is_some_and(|membership| {
                membership.is_active_at(now_ms)
            });
        if has_membership { Theme::Mist } else { Theme::Rock }
    } else {
        theme
    };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let target = window.clone();
    window.run_on_main_thread(move || {
        crate::window_chrome::apply_window_chrome_theme_on_main_thread(&target, theme);
        let material = if target.label() == "main" {
            crate::window_material::active_material()
        } else {
            "none"
        };
        let _ = sender.send(material);
    }).map_err(|error| error.to_string())?;
    receiver.await.map_err(|error| error.to_string())
}

/// Keep the native application menu in sync with the frontend language.
#[tauri::command]
pub fn apply_menu_language(language: String, app: tauri::AppHandle) -> Result<(), String> {
    crate::app::native_menu::set_language(&app, &language).map_err(|error| error.to_string())
}
