mod agent;
mod commands;
mod db;
mod memo_file;
mod prompt;
mod providers;
mod threads;

use agent::AgentManager;
use commands::AppState;
use std::path::PathBuf;
use std::sync::RwLock;
use tauri::{Emitter, Manager};
use threads::ThreadManager;

fn get_app_data_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("woopmemo")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_data_path = get_app_data_path();
    std::fs::create_dir_all(&app_data_path).ok();

    let db_path = app_data_path.join("app.db");
    let thread_db_path = app_data_path.join("thread.db");
    let db = db::Database::new(db_path).expect("Failed to initialize database");

    let memo_file = memo_file::MemoFile::new(app_data_path.clone());
    memo_file.init_default_notebook();

    let app_state = AppState {
        db,
        memo_file: RwLock::new(memo_file),
        agent_manager: tokio::sync::RwLock::new(AgentManager::new()),
        thread_manager: tokio::sync::RwLock::new(
            ThreadManager::new(thread_db_path).expect("Failed to initialize thread database"),
        ),
    };

    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let paths = commands::markdown_paths_from_args(args);
            if paths.is_empty() {
                return;
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
            let _ = app.emit("external-markdown-opened", paths);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::get_setting,
            commands::get_all_settings,
            commands::set_setting,
            commands::set_multiple_settings,
            commands::delete_setting,
            commands::get_memos,
            commands::read_memo,
            commands::read_document,
            commands::write_document,
            commands::get_launch_open_files,
            commands::add_document,
            commands::import_external_document_to_memo,
            commands::update_memo_db,
            commands::delete_memo,
            commands::clear_memos,
            commands::favorite_memo,
            commands::unfavorite_memo,
            commands::get_all_tags,
            commands::create_memo_tag,
            commands::rename_memo_tag,
            commands::delete_memo_tag,
            commands::get_notebooks,
            commands::create_notebook,
            commands::update_notebook,
            commands::delete_notebook,
            commands::clear_notebooks,
            commands::set_current_notebook,
            commands::get_file_tree,
            commands::get_dir_children,
            commands::read_file,
            commands::write_file,
            commands::delete_file,
            commands::create_folder,
            commands::create_document,
            commands::select_directory,
            commands::select_files,
            commands::save_file_dialog,
            commands::write_export_file,
            commands::save_attachment,
            commands::save_attachment_content,
            commands::init_agent,
            commands::chat_with_agent,
            commands::chat_with_agent_stream,
            commands::list_agents,
            commands::thread_list,
            commands::thread_create,
            commands::thread_get,
            commands::thread_delete,
            commands::open_preferences_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
