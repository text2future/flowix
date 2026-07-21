//! 绐楀彛鍘熺敓灞?chrome: Windows 杈规鑹?+ 璺ㄥ钩鍙颁富棰樿儗鏅壊銆?//!
//! 涓婚鑳屾櫙鑹茶蛋 Tauri 鐨?`set_background_color` (鍚屾椂璁惧師鐢熺獥鍙ｅ眰 + webview 灞?,
//! 涓昏鐢ㄤ簬娑堥櫎鍐峰惎鍔?/ webview 閲嶈浇鏃剁殑鐧介棯, 璁╃獥鍙ｅ簳鑹蹭笌鍓嶇涓婚
//! (`styles/theme/*.css` 鐨?`--background`) 瀵归綈銆傚彲瑙佽儗鏅粛鐢?webview CSS 涓诲,
//! 杩欓噷鍙厹搴?webview 鏈粯鍒舵椂娈点€?//!
//! 鍙︽寜浜у搧涓婚鐨?"os-theme" (dark / light) 璋?`set_theme` 璁惧師鐢熺獥鍙ｄ富棰? 璁╂爣棰樻爮 /
//! 椤堕儴鍒嗛殧绾?/ 绾㈢豢鐏瓑鍘熺敓 chrome 涓?webview 鍐呭鏄庢殫涓€鑷?(鍚﹀垯娣辫壊鍐呭 + 娴呰壊鍘熺敓
//! chrome 浼氬湪绐楀彛椤堕儴闇茬櫧绾?鈹€鈹€ 鍘熺敓 chrome 榛樿璺熼殢绯荤粺澶栬, 绯荤粺娴呰壊鏃跺嵆浣夸骇鍝佷富棰?//! 鏄?dark 涔熶細鐢绘祬鑹插垎闅旂嚎)銆?//!
//! 骞冲彴娉ㄦ剰 (鏉ヨ嚜 Tauri 鏂囨。):
//! - Windows: 绐楀彛灞?alpha 琚拷鐣? 鏁呭叏閮ㄧ敤 alpha=0xFF (涓嶉€忔槑)銆?//! - macOS:   闇€鍚敤 `macos-private-api` (Cargo feature + `tauri.conf.json` 鐨?//!            `app.macOSPrivateApi`), 鍚﹀垯 wry 鐨?`set_background_color` 瀵?WKWebView
//!            鏄?no-op -- webview 淇濇寔榛樿涓嶉€忔槑鐧借壊 (`drawsBackground=YES`), 鐩栦綇
//!            NSWindow 鑳屾櫙涓?resize 鏃惰竟缂橀湶鐧姐€傚惎鐢ㄥ悗 wry 浼氬叧鎺?`drawsBackground`
//!            骞惰 `underPageBackgroundColor`, webview 灞傚嵆闅忎富棰樺彉鑹?(resize/鍐峰惎鍔?//!            鍧囦笉闇茬櫧)銆侳lowix 闈?App Store 鍒嗗彂, 绉佹湁 API 涓嶅奖鍝嶅叕璇併€?//! - Linux:   `window.theme()` 鍙兘涓嶆敮鎸?-> `Theme::System` 鍥為€€鍒?light (鍙帴鍙楅檷绾?銆?
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

/// Flowix 涓婚 -> Tauri 绐楀彛鑳屾櫙鑹层€?///
/// 鑹插€肩敱鍓嶇 `styles/theme/*.css` 鐨?`--background` (oklch) 绮剧‘杞崲鎴?sRGB,
/// 涓庡墠绔簳鑹插榻愰伩鍏嶉棯鑹层€俙Theme::System` 鐢?`system` (褰撳墠瑙ｆ瀽鐨勭郴缁熸槑鏆?
/// 鐢?`window.theme()` 缁欏嚭) 钀藉埌 light/dark; 鍙栦笉鍒扮郴缁熷€兼椂鍏滃簳 light銆?
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

/// Flowix 浜у搧涓婚 -> 瀵瑰簲鐨?"os-theme" (鍘熺敓绐楀彛涓婚)銆?///
/// 鍐冲畾鏍囬鏍?/ 椤堕儴鍒嗛殧绾?/ 绾㈢豢鐏寜閽瓑鍘熺敓 chrome 鐨勬槑鏆? 涓?webview 鍐呭涓婚
/// 瀵归綈銆傚師鐢?chrome 榛樿璺熼殢绯荤粺澶栬, 涓嶆樉寮忚缃椂: 绯荤粺娴呰壊 + 浜у搧 dark 涓婚 ->
/// 椤堕儴鐢绘祬鑹插垎闅旂嚎 (琛ㄧ幇涓烘繁鑹叉ā寮忎笅椤堕儴鐧界嚎)銆?///
/// 鍒嗙被 (鎸夊悇涓婚 `--background` 鏄庢殫, 瑙?`theme_background_color`):
/// - `Dark` -> `Dark`
/// - `Light` / `Rock` / `Mist` / `Ember` -> `Light` (鍧囦负娴呭簳涓婚)
/// - `System` -> `None` (璺熼殢 OS 澶栬, 淇濈暀 `ThemeChanged` 瀹炴椂璺熼殢)
///
/// 娉ㄦ剰: macOS 涓?`set_theme` 鏄?app-wide (闈炲崟绐楀彛), 浠讳竴绐楀彛璁剧疆鍗冲叏灞€鐢熸晥銆?
pub fn os_theme_for(theme: Theme) -> Option<tauri::Theme> {
    match theme {
        Theme::Dark => Some(tauri::Theme::Dark),
        Theme::Light | Theme::Rock | Theme::Mist | Theme::Ember => Some(tauri::Theme::Light),
        Theme::System => None,
    }
}

/// 鎶婁富棰樺簲鐢ㄥ埌鍗曚釜绐楀彛鐨勫師鐢?chrome:
/// 1. `set_theme` - 鍘熺敓绐楀彛涓婚 (鏍囬鏍?/ 鍒嗛殧绾跨瓑 chrome 鏄庢殫), 鎸?os-theme銆?/// 2. `set_background_color` - 鍘熺敓绐楀彛灞?+ webview 灞傝儗鏅壊, 鍏滃簳闃查棯銆?///
/// 涓よ€呴兘鏄?AppKit / 鍘熺敓 UI 璋冪敤, 蹇呴』鍦ㄤ富绾跨▼鎵ц銆備絾璋冪敤鏂瑰父鍦?IPC 鍛戒护 /
/// 浜嬩欢鍥炶皟绾跨▼ (闈炰富绾跨▼: Tauri 2 鍛戒护璧?async runtime, `app.emit` 鍙堝湪璋冪敤绾跨▼
/// 鍚屾瑙﹀彂 `app.listen` 鍥炶皟), 鐩存帴璋冪敤浼氶潤榛樺け鏁?鈥斺€?鍏稿瀷琛ㄧ幇: 鍚姩鏃?(setup
/// 鍦ㄤ富绾跨▼) 涓婚鐢熸晥, 杩愯鏃跺垏鎹富棰樺師鐢?chrome 涓嶆洿鏂般€傛晠缁熶竴鐢?/// `run_on_main_thread` dispatch 鍒颁富绾跨▼, 骞跺湪涓荤嚎绋嬪唴璇?`system` (閬垮厤绂讳富绾跨▼
/// 璇?NSApp appearance 鎷垮埌鏃у€?銆?
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

/// 鎶婁富棰樿儗鏅壊搴旂敤鍒板綋鍓嶆墍鏈夌獥鍙?(main / preferences / 鍔ㄦ€?tab 绐楀彛)銆?
pub fn apply_theme_background_all(app: &tauri::AppHandle, theme: Theme) {
    for window in app.webview_windows().values() {
        apply_theme_background(window, theme);
    }
}
