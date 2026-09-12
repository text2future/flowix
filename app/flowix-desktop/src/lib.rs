// `deepseek_harness_e2e` 集成测试需要真实 Wry AppHandle（主线程）+ 仓内类型,
// 因此这几个模块对外可见。app crate 无外部消费者, 可见性放宽无成本。
pub mod agent_external;
mod agent_external_config;
pub mod agent_history;
pub mod agent_lifecycle;
pub mod agent_session;
mod agent_types;
pub mod agent_wire;
mod app;
mod app_update;
mod apple_sign_in;
mod artifact;
mod browser_column;
mod cli_link;
mod commands;
pub mod config;
mod connection_probe;
mod device_registration;
mod document_mutation;
mod dsh;
mod events;
mod lock_utils;
mod maintenance;
mod memo_events;
mod open_target;
mod plugin;
mod process_window;
mod runtime_log;
mod system_data;
mod update_security;
mod watcher;
mod window_chrome;

pub use app::{get_app_data_path, get_user_config_dir, APP_DATA_DIR_NAME, USER_CONFIG_DIR_NAME};

pub fn run() {
    app::run();
}
