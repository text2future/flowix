//! 窗口原生层 chrome: Windows 边框色 + 跨平台主题背景色。
//!
//! 主题背景色走 Tauri 的 `set_background_color` (同时设原生窗口层 + webview 层),
//! 主要用于消除冷启动 / webview 重载时的白闪, 让窗口底色与前端主题
//! (`styles/theme/*.css` 的 `--background`) 对齐。可见背景仍由 webview CSS 主导,
//! 这里只兜底 webview 未绘制时段。
//!
//! 另按产品主题的 "os-theme" (dark / light) 调 `set_theme` 设原生窗口主题, 让标题栏 /
//! 顶部分隔线 / 红绿灯等原生 chrome 与 webview 内容明暗一致 (否则深色内容 + 浅色原生
//! chrome 会在窗口顶部露白线 ── 原生 chrome 默认跟随系统外观, 系统浅色时即使产品主题
//! 是 dark 也会画浅色分隔线)。
//!
//! 平台注意 (来自 Tauri 文档):
//! - Windows: 窗口层 alpha 被忽略, 故全部用 alpha=0xFF (不透明)。
//! - macOS:   需启用 `macos-private-api` (Cargo feature + `tauri.conf.json` 的
//!            `app.macOSPrivateApi`), 否则 wry 的 `set_background_color` 对 WKWebView
//!            是 no-op -- webview 保持默认不透明白色 (`drawsBackground=YES`), 盖住
//!            NSWindow 背景且 resize 时边缘露白。启用后 wry 会关掉 `drawsBackground`
//!            并设 `underPageBackgroundColor`, webview 层即随主题变色 (resize/冷启动
//!            均不露白)。Flowix 非 App Store 分发, 私有 API 不影响公证。
//! - Linux:   `window.theme()` 可能不支持 -> `Theme::System` 回退到 light (可接受降级)。

use tauri::Manager;

use crate::config::Theme;

#[cfg(target_os = "windows")]
pub fn apply_window_border_color<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    use std::ffi::c_void;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_BORDER_COLOR};

    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    // COLORREF is 0x00bbggrr. For neutral gray, #bcbcbc is the same value.
    let border_color: u32 = 0x00bcbcbc;

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
pub fn apply_window_border_color<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) {}

/// Flowix 主题 -> Tauri 窗口背景色。
///
/// 色值由前端 `styles/theme/*.css` 的 `--background` (oklch) 精确转换成 sRGB,
/// 与前端底色对齐避免闪色。`Theme::System` 用 `system` (当前解析的系统明暗,
/// 由 `window.theme()` 给出) 落到 light/dark; 取不到系统值时兜底 light。
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
        // mist   oklch(0.988 0.006 78)  -> #FDFBF7
        Theme::Mist => tauri::utils::config::Color(0xFD, 0xFB, 0xF7, A),
        // ember  oklch(0.985 0.005 50)  -> #FDF9F7
        Theme::Ember => tauri::utils::config::Color(0xFD, 0xF9, 0xF7, A),
        Theme::System => match system {
            Some(tauri::Theme::Dark) => tauri::utils::config::Color(0x0E, 0x10, 0x14, A),
            _ => tauri::utils::config::Color(0xF8, 0xFB, 0xFF, A),
        },
    }
}

/// Flowix 产品主题 -> 对应的 "os-theme" (原生窗口主题)。
///
/// 决定标题栏 / 顶部分隔线 / 红绿灯按钮等原生 chrome 的明暗, 与 webview 内容主题
/// 对齐。原生 chrome 默认跟随系统外观, 不显式设置时: 系统浅色 + 产品 dark 主题 ->
/// 顶部画浅色分隔线 (表现为深色模式下顶部白线)。
///
/// 分类 (按各主题 `--background` 明暗, 见 `theme_background_color`):
/// - `Dark` -> `Dark`
/// - `Light` / `Rock` / `Mist` / `Ember` -> `Light` (均为浅底主题)
/// - `System` -> `None` (跟随 OS 外观, 保留 `ThemeChanged` 实时跟随)
///
/// 注意: macOS 上 `set_theme` 是 app-wide (非单窗口), 任一窗口设置即全局生效。
pub fn os_theme_for(theme: Theme) -> Option<tauri::Theme> {
    match theme {
        Theme::Dark => Some(tauri::Theme::Dark),
        Theme::Light | Theme::Rock | Theme::Mist | Theme::Ember => Some(tauri::Theme::Light),
        Theme::System => None,
    }
}

/// 把主题应用到单个窗口的原生 chrome:
/// 1. `set_theme` - 原生窗口主题 (标题栏 / 分隔线等 chrome 明暗), 按 os-theme。
/// 2. `set_background_color` - 原生窗口层 + webview 层背景色, 兜底防闪。
///
/// 两者都是 AppKit / 原生 UI 调用, 必须在主线程执行。但调用方常在 IPC 命令 /
/// 事件回调线程 (非主线程: Tauri 2 命令走 async runtime, `app.emit` 又在调用线程
/// 同步触发 `app.listen` 回调), 直接调用会静默失效 —— 典型表现: 启动时 (setup
/// 在主线程) 主题生效, 运行时切换主题原生 chrome 不更新。故统一用
/// `run_on_main_thread` dispatch 到主线程, 并在主线程内读 `system` (避免离主线程
/// 读 NSApp appearance 拿到旧值)。
pub fn apply_theme_background(window: &tauri::WebviewWindow, theme: Theme) {
    let win = window.clone();
    if let Err(e) = window.run_on_main_thread(move || {
        let system = win.theme().ok();
        let os_theme = os_theme_for(theme);
        let color = theme_background_color(theme, system);
        if let Err(e) = win.set_theme(os_theme) {
            tracing::warn!("[window_chrome] set_theme failed: {e}");
        }
        if let Err(e) = win.set_background_color(Some(color)) {
            tracing::warn!("[window_chrome] set_background_color failed: {e}");
        }
    }) {
        tracing::warn!("[window_chrome] run_on_main_thread failed: {e}");
    }
}

/// 把主题背景色应用到当前所有窗口 (main / preferences / 动态 tab 窗口)。
pub fn apply_theme_background_all(app: &tauri::AppHandle, theme: Theme) {
    for window in app.webview_windows().values() {
        apply_theme_background(window, theme);
    }
}
