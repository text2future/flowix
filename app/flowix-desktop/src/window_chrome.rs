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
