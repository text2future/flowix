/// Report embedded document interactions without intercepting page input.
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("frame-interaction")
        .js_init_script_on_all_frames(include_str!("web_frame_interaction.js"))
        .build()
}
