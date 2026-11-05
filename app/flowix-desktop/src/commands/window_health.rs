//! Thin IPC adapter for the renderer liveness probe.
//! The decision logic and the native probe live in `window_responsiveness`.
#[tauri::command]
pub fn report_ui_heartbeat(window: tauri::WebviewWindow, hidden: bool) {
    // Auxiliary windows render the same frontend bundle. Without this guard a
    // preferences window would keep reporting while the main renderer is dead,
    // turning the only signal we have into a false negative.
    if !crate::window_responsiveness::is_monitored(window.label()) {
        return;
    }
    crate::window_responsiveness::record_heartbeat(hidden);
}
