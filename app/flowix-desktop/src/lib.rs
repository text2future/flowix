mod agent;
mod app;
mod cli_link;
mod commands;
mod config;
mod device_registration;
mod external_runtime;
mod fs_watcher;
mod lock_utils;
mod memo_events;
mod open_target;
mod process_window;
mod prompt;
mod providers;
mod runtime_log;
mod session;
mod skills;
mod system_data;
mod watcher;
mod window_chrome;

pub use app::{get_app_data_path, get_user_config_dir, APP_DATA_DIR_NAME, USER_CONFIG_DIR_NAME};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    app::run();
}
