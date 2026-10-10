//! 窗口原生�?chrome: Windows 边�?�?+ 跨平台主题背�?���?//!
//! 主�?背景色走 Tauri �?`set_background_color` (同时设原生窗口层 + webview �?,
//! 主�?用于消除冷启�?/ webview 重载时的白闪, 让窗口底色与前�?主�?
//! (`styles/theme/*.css` �?`--background`) 对齐。可见背�?���?webview CSS 主�?,
//! 这里�?���?webview �?��制时段�?//!
//! 另按产品主�?�?"os-theme" (dark / light) �?`set_theme` 设原生窗口主�? 让标题栏 /
//! 顶部分隔�?/ 红绿�?��原生 chrome �?webview 内�?明暗一�?(否则深色内�? + 浅色原生
//! chrome 会在窗口顶部露白�?── 原生 chrome 默�?跟随系统外�?, 系统浅色时即使产品主�?//! �?dark 也会画浅色分隔线)�?//!
//! 骞冲彴娉ㄦ剰 (鏉ヨ嚜 Tauri 鏂囨。):
//! - Windows: 窗口�?alpha �?���? 故全部用 alpha=0xFF (不透明)�?//! - macOS:   需�?�� `macos-private-api` (Cargo feature + `tauri.conf.json` �?//!            `app.macOSPrivateApi`), 否则 wry �?`set_background_color` �?WKWebView
//!            �?no-op -- webview 保持默�?不透明白色 (`drawsBackground=YES`), 盖住
//!            NSWindow 背景�?resize 时边缘露白。启用后 wry 会关�?`drawsBackground`
//!            并�? `underPageBackgroundColor`, webview 层即随主题变�?(resize/冷启�?//!            均不露白)。Flowix �?App Store 分发, 私有 API 不影响公证�?//! - Linux:   `window.theme()` �?��不支�?-> `Theme::System` 回退�?light (�?��受降�?�?
use tauri::Manager;

use crate::config::Theme;

#[cfg(target_os = "windows")]
const DARK_BORDER_COLOR: u32 = 0x00463D39; // COLORREF for #393D46
#[cfg(target_os = "windows")]
const LIGHT_BORDER_COLOR: u32 = 0x00BCBCBC; // COLORREF for #BCBCBC

#[cfg(target_os = "windows")]
fn border_color_for_theme(theme: Theme, system: Option<tauri::Theme>) -> u32 {
    let is_dark = match theme {
        Theme::Dark => true,
        Theme::System => system == Some(tauri::Theme::Dark),
        Theme::Light | Theme::Rock | Theme::Ember => false,
    };
    if is_dark {
        DARK_BORDER_COLOR
    } else {
        LIGHT_BORDER_COLOR
    }
}

#[cfg(target_os = "windows")]
fn apply_window_border_color<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    theme: Theme,
    system: Option<tauri::Theme>,
) {
    use std::ffi::c_void;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_BORDER_COLOR};

    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    let border_color = border_color_for_theme(theme, system);

    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR,
            &border_color as *const _ as *const c_void,
            std::mem::size_of_val(&border_color) as u32,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn apply_window_border_color<R: tauri::Runtime>(
    _window: &tauri::WebviewWindow<R>,
    _theme: Theme,
    _system: Option<tauri::Theme>,
) {
}

/// Flowix 涓婚 -> Tauri 绐楀彛鑳屾櫙鑹层€?///
/// 色值由前�? `styles/theme/*.css` �?`--background` (oklch) 精��?���?sRGB,
/// 与前�?��色�?齐避免闪色。`Theme::System` �?`system` (当前解析的系统明�?
/// �?`window.theme()` 给出) 落到 light/dark; 取不到系统值时兜底 light�?
pub fn theme_background_color(
    theme: Theme,
    system: Option<tauri::Theme>,
) -> tauri::utils::config::Color {
    const A: u8 = 0xFF;
    match theme {
        // light  oklch(0.988 0.006 255) -> #F8FBFF
        Theme::Light => tauri::utils::config::Color(0xF8, 0xFB, 0xFF, A),
        // dark   oklch(0.173 0.009 265) -> #0E1014
        Theme::Dark => tauri::utils::config::Color(0x0E, 0x10, 0x14, A),
        // rock   oklch(0.988 0.006 92)  -> #FCFBF7
        Theme::Rock => tauri::utils::config::Color(0xFC, 0xFB, 0xF7, A),
        // ember  oklch(0.985 0.005 50)  -> #FDF9F7
        Theme::Ember => tauri::utils::config::Color(0xFD, 0xF9, 0xF7, A),
        Theme::System => match system {
            Some(tauri::Theme::Dark) => tauri::utils::config::Color(0x0E, 0x10, 0x14, A),
            _ => tauri::utils::config::Color(0xF8, 0xFB, 0xFF, A),
        },
    }
}

/// Flowix 产品主�? -> 对应�?"os-theme" (原生窗口主�?)�?///
/// 决定标�?�?/ 顶部分隔�?/ 红绿�?���?��原生 chrome 的明�? �?webview 内�?主�?
/// 对齐。原�?chrome 默�?跟随系统外�?, 不显式�?�?��: 系统浅色 + 产品 dark 主�? ->
/// 顶部画浅色分隔线 (表现为深色模式下顶部白线)�?///
/// 分类 (按各主�? `--background` 明暗, �?`theme_background_color`):
/// - `Dark` -> `Dark`
/// - `Light` / `Rock` / `Ember` -> `Light` (鍧囦负娴呭簳涓婚)
/// - `System` -> `None` (璺熼殢 OS 澶栬, 淇濈暀 `ThemeChanged` 瀹炴椂璺熼殢)
///
/// 注意: macOS �?`set_theme` �?app-wide (非单窗口), 任一窗口设置即全局生效�?
pub fn os_theme_for(theme: Theme) -> Option<tauri::Theme> {
    match theme {
        Theme::Dark => Some(tauri::Theme::Dark),
        Theme::Light | Theme::Rock | Theme::Ember => Some(tauri::Theme::Light),
        Theme::System => None,
    }
}

/// 把主题应用到单个窗口的原�?chrome:
/// 1. `set_theme` - 原生窗口主�? (标�?�?/ 分隔线等 chrome 明暗), �?os-theme�?/// 2. `set_background_color` - 原生窗口�?+ webview 层背�?��, 兜底防闪�?///
/// 两者都�?AppKit / 原生 UI 调用, 必须在主线程执�?。但调用方常�?IPC 命令 /
/// 事件回调线程 (非主线程: Tauri 2 命令�?async runtime, `app.emit` 又在调用线程
/// 同�?触发 `app.listen` 回调), 直接调用会静默失�?—�?典型表现: �?���?(setup
/// 在主线程) 主�?生效, 运�?时切�?��题原�?chrome 不更新。故统一�?/// `run_on_main_thread` dispatch 到主线程, 并在主线程内�?`system` (避免离主线程
/// �?NSApp appearance 拿到旧�?�?
pub fn apply_window_chrome_theme(window: &tauri::WebviewWindow, theme: Theme) {
    let win = window.clone();
    if let Err(e) = window.run_on_main_thread(move || {
        let os_theme = os_theme_for(theme);
        if let Err(e) = win.set_theme(os_theme) {
            tracing::warn!("[window_chrome] set_theme failed: {e}");
        }
        // Resolve System after clearing any explicit per-window theme override.
        let system = win.theme().ok();
        let color = theme_background_color(theme, system);
        apply_window_border_color(&win, theme, system);
        if let Err(e) = win.set_background_color(Some(color)) {
            tracing::warn!("[window_chrome] set_background_color failed: {e}");
        }
    }) {
        tracing::warn!("[window_chrome] run_on_main_thread failed: {e}");
    }
}

/// 把主题背�?��应用到当前所有窗�?(main / preferences / 动�?tab 窗口)�?
pub fn apply_window_chrome_theme_all(app: &tauri::AppHandle, theme: Theme) {
    for window in app.webview_windows().values() {
        apply_window_chrome_theme(window, theme);
    }
}
