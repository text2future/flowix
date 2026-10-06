use crate::agent_external::claude::ClaudeCliManager;
use crate::agent_external::codex::CodexAppServerManager;
use crate::agent_external::deepseek_harness::DeepSeekHarnessManager;
use crate::agent_external::hermes::HermesAcpManager;
use crate::agent_external::opencode::OpenCodeAcpManager;
use crate::agent_external::pi::PiRpcManager;
use crate::agent_external::runtime_registry::ExternalRuntimeRegistry;
use crate::agent_external_config::AgentExternalConfig;
use crate::agent_session::ThreadManager;
use crate::app::panic::install_panic_log_hook;
use crate::app::paths::{get_app_data_path, get_user_config_dir};
use crate::app::state::AppState;
use crate::app::watchdog::spawn_external_agent_watchdog;
use crate::cli_link;
use crate::commands;
use crate::config::user as user_config;
use crate::config::AgentAccessStore;
use crate::config::SecurityBookmarkStore;
use crate::events as dispatcher;
use crate::memo_events::{self, MemoChangeSource, MemoDerivedChanged, MemoEvent};
use crate::plugin;
use crate::runtime_log;
use crate::system_data::SystemData;
use crate::watcher::MemoWatcher;
use flowix_core::search::{BigramTokenizer, MemoIndex};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Listener, Manager};

fn record_startup_stage(startup: &crate::app::startup::StartupCoordinator, stage: &str) {
    runtime_log::record_event(
        "info",
        "startup.stage",
        serde_json::json!({ "stage": stage, "source": "native", "elapsedMs": startup.elapsed_ms() }).to_string(),
    );
}

fn record_slow_notebook_stage(notebook_id: &str, stage: &str, elapsed: Duration) {
    if elapsed < Duration::from_millis(250) {
        return;
    }
    runtime_log::record_event(
        "info",
        "startup.notebook_stage",
        serde_json::json!({
            "notebookId": notebook_id,
            "stage": stage,
            "elapsedMs": elapsed.as_millis(),
        })
        .to_string(),
    );
}

pub fn run() {
    install_panic_log_hook();
    let startup_coordinator = Arc::new(crate::app::startup::StartupCoordinator::new());

    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    let app_data_path = get_app_data_path();
    std::fs::create_dir_all(&app_data_path).ok();

    let home_dir = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    runtime_log::record_event(
        "info",
        "app.start",
        format!(
            "{} {} started",
            runtime_log::PRODUCT_NAME,
            runtime_log::APP_VERSION
        ),
    );

    // �?��时在 `~/.local/bin/flowix-cli` 建一�?symlink。�?情�?
    // `cli_link` 模块: 幂等 (每�?�?��都跑, 已存在就不动), 失败�?warn
    // This is idempotent and failures do not block GUI startup.
    cli_link::ensure_cli_symlink();

    let user_config_dir = get_user_config_dir(&home_dir);
    std::fs::create_dir_all(&user_config_dir).ok();
    if let Err(error) = plugin::ensure_builtin_plugins() {
        tracing::warn!("[startup] failed to initialize plugins: {error}");
    }
    let thread_db_path = user_config_dir.join("thread.db");
    let user_config = Arc::new(user_config::UserConfigStore::new(home_dir.clone()));
    let cloud_sync = Arc::new(
        flowix_sync::SyncManager::new(
            flowix_sync::DEFAULT_CLOUD_API_BASE,
            user_config_dir.join("sync.db"),
        )
        .unwrap_or_else(|error| {
            tracing::error!(
                "failed to initialize cloud sync database: {error}; using a temporary database"
            );
            flowix_sync::SyncManager::new(
                flowix_sync::DEFAULT_CLOUD_API_BASE,
                std::env::temp_dir().join(format!("flowix-sync-{}.db", std::process::id())),
            )
            .expect("failed to initialize temporary cloud sync database")
        }),
    );

    // 笔�?�?��册表真源�?~/.flowix/index.db (SQLite); `MemoFile::open_index_db`
    // 首�?�??时建表�?这里不需要任何�?盘迁�?── �?`notebook.json` �?��已废�?
    let memo_file = flowix_core::memo_file::MemoFile::new(user_config_dir.clone());

    // Legacy system metadata remains available as a migration source; new
    // notebook tag state is persisted under each notebook's `.flowix/`.
    let system_data_path = user_config_dir.join("boot").join("system.json");
    let system_data = match SystemData::new(system_data_path.clone()) {
        Ok(store) => store,
        Err(err) => {
            tracing::error!(
                "failed to initialize system data at {}: {err}",
                system_data_path.display()
            );
            SystemData::transient(system_data_path)
        }
    };

    // External CLI 璺緞閰嶇疆 (~/.flowix/agent-external-config.json) 鈹€鈹€
    // 作为 codex/claude/gemini/hermes/openclaw 执�?�?��的唯一参照�?
    let agent_external_config_path = user_config_dir.join("agent-external-config.json");
    let agent_external_config = match AgentExternalConfig::new(agent_external_config_path.clone()) {
        Ok(store) => store,
        Err(err) => {
            tracing::error!(
                "failed to initialize agent external config at {}: {err}",
                agent_external_config_path.display()
            );
            AgentExternalConfig::transient(agent_external_config_path)
        }
    };

    let memo_file_arc = Arc::new(RwLock::new(memo_file));
    let notebook_transition = Arc::new(std::sync::Mutex::new(()));
    let thread_manager = match ThreadManager::new(thread_db_path.clone()) {
        Ok(manager) => manager,
        Err(err) => {
            tracing::error!(
                "failed to initialize thread database at {}: {err}; using in-memory thread store",
                thread_db_path.display()
            );
            ThreadManager::new_in_memory().unwrap_or_else(|fallback_err| {
                panic!("failed to initialize in-memory thread database: {fallback_err}")
            })
        }
    };
    let thread_manager_arc = Arc::new(thread_manager);
    // Orphaned tool loading rows are cleared after the first workspace paint.
    let user_config_arc = user_config.clone();

    // Agent �??�?���?store ── 必须�?notebook registry �?`memo_file_arc`
    // 都就�?��后构�?(�?store 会�? notebook registry �?? + 对账)�?
    let security_bookmarks_arc = Arc::new(SecurityBookmarkStore::new(user_config_dir.clone()));
    let agent_access_arc = Arc::new(AgentAccessStore::new(
        user_config_dir.clone(),
        &*crate::lock_utils::read_lock(&memo_file_arc, "memo_file"),
    ));

    // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    // 监听 user-config-changed �?���?whitelist �? 也需�?user_config_arc,
    let user_config_for_watcher = user_config_arc.clone();

    // AppState �?`.setup()` �?��里构造。Tauri 2 �?`.manage(state)` �?    // "一次�?�?��, 所以所有共�?��赖都在进入闭包前准�?好�?    //
    // 这里把构�?AppState 需要的子结�?clone 出来 (�?�� `move` 捕获),
    // 同时把另一�?clone 喂给 sub-component 构造函数�?
    let user_config_for_state = user_config_arc.clone();
    let cloud_sync_for_state = cloud_sync.clone();
    let memo_file_for_state = memo_file_arc.clone();
    let agent_access_for_state = agent_access_arc.clone();
    let security_bookmarks_for_state = security_bookmarks_arc.clone();
    let thread_manager_for_state = thread_manager_arc.clone();
    let startup_for_state = startup_coordinator.clone();
    let notebook_transition_for_state = notebook_transition.clone();
    // �?��设�?登�?模块 ── 和上面同样的 prep 模式: clone �?setup �?���?
    let user_config_dir_for_device = user_config_dir.clone();
    // `system_data` 娌?
    // impl Clone ── 直接 move �?setup �?��, 那里
    // move 杩?AppState銆?
    let search_init = RwLock::new(MemoIndex::new(Arc::new(BigramTokenizer)));
    let codex_app_server = Arc::new(CodexAppServerManager::new(thread_manager_arc.clone()));
    let claude_cli_manager = Arc::new(ClaudeCliManager::new(thread_manager_arc.clone()));
    let hermes_cli_manager = Arc::new(HermesAcpManager::new(thread_manager_arc.clone()));
    let opencode_acp_manager = Arc::new(OpenCodeAcpManager::new(thread_manager_arc.clone()));
    let pi_rpc_manager = Arc::new(PiRpcManager::new(thread_manager_arc.clone()));
    let deepseek_harness_manager = Arc::new(DeepSeekHarnessManager::new(
        thread_manager_arc.clone(),
        user_config.clone(),
        user_config.dsh_sessions_dir(),
    ));
    let external_runtimes = Arc::new(ExternalRuntimeRegistry::new(
        codex_app_server.clone(),
        claude_cli_manager,
        hermes_cli_manager.clone(),
        opencode_acp_manager.clone(),
        pi_rpc_manager.clone(),
        deepseek_harness_manager.clone(),
    ));
    let agent_history = Arc::new(crate::agent_history::AgentHistoryService::new(
        thread_manager_arc.clone(),
        codex_app_server.clone(),
        opencode_acp_manager.clone(),
        deepseek_harness_manager.clone(),
    ));
    let agent_lifecycle = Arc::new(crate::agent_lifecycle::AgentLifecycleService::new(
        thread_manager_arc.clone(),
        codex_app_server.clone(),
        opencode_acp_manager.clone(),
        hermes_cli_manager.clone(),
        pi_rpc_manager.clone(),
        deepseek_harness_manager.clone(),
    ));

    // 笔�?�?��录文件监�?�� —把�?部编辑器 / 其他 AI 对任意已注册 notebook
    // 的�?盘变更转�?`memo-event` 推前�?��`AppHandle` �?`run()` 阶�?拿不�?
    // 实际绑定�?.setup() �?��里完成�?
    let memo_watcher = Arc::new(RwLock::new(MemoWatcher::new(memo_file_arc.clone())));

    crate::app::native_menu::configure(tauri::Builder::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            handle_second_instance(app, args);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(crate::frame_scrollbar::init())
        .manage(crate::app_update::AppUpdateState::default())
        .manage(memo_watcher.clone())
        .on_webview_event(|webview, event| {
            if let tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let state = webview.state::<AppState>();
                for path in paths {
                    state.document_access.grant(webview.label(), path);
                }
            }
        })
        .setup(move |app| {
            record_startup_stage(&startup_coordinator, "native-setup-start");
            if let Err(error) = crate::template_store::initialize(&user_config_dir_for_device) {
                tracing::warn!("[startup] failed to initialize template directories: {error}");
            }

            // Read the notebook registry synchronously so AppState can be
            // created. Structural migrations themselves are scheduled after
            // AppState and IPC are available; the startup coordinator is the
            // gate for the WebView and notebook-dependent commands.
            let initial_notebooks = {
                let memo_file = crate::lock_utils::read_lock(&memo_file_arc, "memo_file");
                let notebooks = memo_file.read_notebook_configs()?;
                for notebook in &notebooks {
                    security_bookmarks_for_state
                        .start_accessing_for_path(std::path::Path::new(&notebook.path));
                }
                notebooks
            };

            // 鈹€鈹€ 0) 鍚姩璁惧鐧昏 / last_seen 鍒锋柊 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
            //   不阻�? spawn 一�?fire-and-forget tokio 任务, �?��内部
            //   �?sleep 10s �?POST, 与产品更�?7s 检查错开。远�?��
            //   `device_id` upsert, 首�?插入, 后续�?��刷新 last_seen_at�?
            let app_version = app.package_info().version.to_string();
            let device_registry = Arc::new(crate::device_registration::DeviceRegistry::load(
                &user_config_dir_for_device,
                app_version,
            ));
            device_registry.clone().spawn_startup_registration();
            app.manage(device_registry);

            // 鈹€鈹€ 1) 鍚姩鎺㈡祴 external CLI 璺緞 鈹€鈹€
            //   �?source=auto/缺失�?agent 跑探测链 (env>PATH>候�?shell),
            // Cached paths are available immediately. Probing external CLIs
            // can spawn processes, so run it after the first workspace paint.
            agent_external_config.load_into_registry();

            let app_state = AppState {
                upload_sessions: Default::default(),
                document_access: Default::default(),
                export_access: Default::default(),
                user_config: user_config_for_state.clone(),
                cloud_sync: cloud_sync_for_state.clone(),
                system_data,
                agent_external_config,
                memo_file: memo_file_for_state.clone(),
                search: search_init,
                search_rebuild: Default::default(),
                external_runtimes: external_runtimes.clone(),
                codex_app_server: codex_app_server.clone(),
                opencode: opencode_acp_manager.clone(),
                pi: pi_rpc_manager.clone(),
                deepseek_harness: deepseek_harness_manager.clone(),
                agent_history: agent_history.clone(),
                agent_lifecycle: agent_lifecycle.clone(),
                thread_manager: thread_manager_for_state.clone(),
                agent_access: agent_access_for_state.clone(),
                security_bookmarks: security_bookmarks_for_state.clone(),
                plugin_runs: crate::plugin::PluginRunCoordinator::default(),
                notebook_imports: Default::default(),
                notebook_template_initializations: Default::default(),
                notebook_transition: notebook_transition_for_state,
                startup: startup_for_state,
            };
            app_state.upload_sessions.start_cleanup();
            app.manage(app_state);
            if let Some(window) = app.get_webview_window("main") {
                crate::window_chrome::apply_window_border_color(&window);
                // �?��即�?齐主题背�?��, 消除冷启动白�?(尤其深色主�?)�?
                let theme = app.state::<AppState>().user_config.get_preference().theme;
                crate::window_chrome::apply_theme_background(&window, theme);

                // Theme::System 时跟�?OS 明暗实时切换窗口背景�? 仅当窗口�??显式
                // theme (�?��用所有窗口都�? �?Tauri 才派�?ThemeChanged, 故这�?                // 监听主窗口即�?��发一次全局刷新 (apply_theme_background_all 遍历所有窗�?�?
                let app_for_window_event = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::ThemeChanged(_) = event {
                        let current = app_for_window_event
                            .state::<AppState>()
                            .user_config
                            .get_preference()
                            .theme;
                        if current == crate::config::Theme::System {
                            crate::window_chrome::apply_theme_background_all(
                                &app_for_window_event,
                                current,
                            );
                        }
                    }
                });
            }

            // �?setup 阶�? manage dispatcher, 因为
            // TauriDispatcher::new 需�?AppHandle, builder chain 里拿不到�?
            let dispatcher: crate::events::SharedDispatcher =
                std::sync::Arc::new(crate::events::TauriDispatcher::new(app.handle().clone()));
            app.manage(dispatcher);
            app.manage(
                commands::external_document_watch::ExternalDocumentWatchState::new(
                    app.handle().clone(),
                ),
            );
            app.manage(commands::file_browser_watch::FileBrowserWatchState::new(
                app.handle().clone(),
            ));
            // Restore security-scoped access for user-selected reference
            // folders as well. External CLI children inherit the parent's
            // active extensions, so this must happen before any agent spawn.
            for entry in agent_access_for_state
                .get_config()
                .entries
                .into_iter()
                .filter(|entry| entry.enabled && !entry.missing)
            {
                security_bookmarks_for_state
                    .start_accessing_for_path(std::path::Path::new(&entry.path));
            }
            // �?��时把 preference.json::watcher 应用�?MemoWatcher;
            // 同时注册 user-config-changed 监听做热更新 (前�?�?            // update_watcher_config IPC �?settings::update_watcher_config
            // 写后 emit 该事�? 这里收到�?set_whitelist)�?
            {
                let watcher_cfg = user_config_for_watcher.get_preference().watcher.clone();
                memo_watcher
                    .write()
                    .unwrap_or_else(|poisoned| {
                        tracing::error!("memo_watcher write lock poisoned, recovering");
                        poisoned.into_inner()
                    })
                    .set_whitelist(watcher_cfg);

                let w_for_evt = memo_watcher.clone();
                let uc_for_evt = user_config_for_watcher.clone();
                app.listen("user-config-changed", move |event| {
                    // payload �?kind 字�?�?("preference" / "ai_config" / "watcher")
                    // event.payload() 返回 serde_json 序列化结�?(带引�? �?"\"preference\""),
                    // 直接 == 比�?会恒�?false, 这里反序列化还原成裸字�?串�?
                    let kind = serde_json::from_str::<String>(event.payload()).unwrap_or_default();
                    if kind == "preference" || kind == "watcher" {
                        let new_cfg = uc_for_evt.get_preference().watcher.clone();
                        w_for_evt
                            .write()
                            .unwrap_or_else(|poisoned| {
                                tracing::error!("memo_watcher write lock poisoned, recovering");
                                poisoned.into_inner()
                            })
                            .set_whitelist(new_cfg);
                        tracing::info!("[watcher] whitelist hot-updated");
                    }
                    // 主�?切换的原�?chrome 更新由前�?apply_window_theme IPC 实时驱动,
                    // 不在这里处理 (这里 200ms 防抖后才触发, 且与持久化耦合)�?
                });
            }

            register_deep_links(app);
            spawn_startup_reconciliation(
                app.handle().clone(),
                initial_notebooks.clone(),
                memo_file_for_state.clone(),
                memo_watcher.clone(),
                user_config_for_watcher.clone(),
                startup_coordinator.clone(),
                cloud_sync_for_state.clone(),
                user_config_for_state.clone(),
                external_runtimes.clone(),
                user_config_dir_for_device.clone(),
                thread_manager_for_state.clone(),
            );
            record_startup_stage(&startup_coordinator, "native-setup-complete");

            // release 构建不包�??分支�?用户随时�?�� F12 / Ctrl+Shift+I 切换�?
            // 鈹€鈹€ spawn flowix-cli sidecar 鈹€鈹€
            // 必须�?setup �?��, 此时 AppState 已经 manage, IPC 调用方可�?
            // 拿到 (虽然还没�?handle ── 失败时返 "not yet spawned" �?�?
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 偏好 (JSON, �?user_config)
            commands::product::get_product_info,
            commands::product::get_diagnostics,
            commands::product::open_log_dir,
            commands::product::reveal_in_file_manager,
            commands::plugin::plugin_list,
            commands::plugin::plugin_refresh,
            commands::plugin::plugin_diagnostics,
            commands::plugin::plugin_catalog,
            commands::plugin::plugin_validate,
            commands::plugin::plugin_set_enabled,
            commands::plugin::plugin_install,
            commands::plugin::plugin_uninstall,
            commands::plugin::plugin_get,
            commands::plugin::plugin_prepare_prompt,
            commands::plugin::plugin_run,
            commands::plugin::plugin_run_stop,
            commands::plugin::plugin_resolve_note,
            commands::artifact::artifact_resolve,
            commands::settings::get_preference,
            commands::settings::patch_preference,
            commands::settings::get_deepseek_harness_config,
            commands::settings::get_deepseek_harness_configs,
            commands::settings::set_deepseek_harness_config,
            commands::settings::add_deepseek_harness_model,
            commands::settings::test_deepseek_harness_connection,
            commands::settings::deepseek_harness_model_catalog,
            commands::settings::deepseek_harness_plugin_catalog,
            commands::settings::set_deepseek_harness_plugin_enabled,
            commands::settings::discover_deepseek_harness_models,
            commands::settings::get_pi_model_configs,
            commands::settings::get_pi_model_catalog,
            commands::settings::save_pi_model_config,
            commands::settings::delete_pi_model_config,
            commands::settings::test_pi_model_config,
            commands::settings::discover_pi_models,
            commands::dsh::dsh_status,
            commands::dsh::dsh_check_update,
            commands::dsh::dsh_archive_size,
            commands::dsh::dsh_download_status,
            commands::dsh::dsh_install_runtime,
            commands::dsh::dsh_update,
            commands::dsh::dsh_ensure_runtime,
            commands::dsh::dsh_cancel_update,
            commands::dsh::dsh_uninstall,
            commands::dsh::dsh_manage_profile_plugin,
            crate::app_update::install_app_update,
            crate::app_update::check_app_update,
            crate::app_update::cancel_app_update,
            commands::settings::get_watcher_config,
            commands::settings::update_watcher_config,
            commands::boot::get_boot_features,
            commands::boot::set_boot_intro_displayed,
            commands::boot::set_boot_onboarding_completed,
            commands::boot::get_startup_status,
            commands::boot::get_startup_notebook_id,
            commands::boot::notify_startup_interactive,
            commands::boot::record_startup_stage,
            commands::boot::wait_for_startup_ready,
            commands::cloud::cloud_get_state,
            commands::cloud::cloud_register,
            commands::cloud::cloud_login,
            commands::cloud::cloud_sign_in_with_apple,
            commands::cloud::cloud_start_google_sign_in,
            commands::cloud::cloud_link_apple,
            commands::cloud::cloud_logout,
            commands::cloud::cloud_get_notebook_state,
            commands::cloud::cloud_list_notebook_states,
            commands::cloud::cloud_list_pending_file_operation_counts,
            commands::cloud::cloud_list_notebooks,
            commands::cloud::cloud_link_notebook,
            commands::cloud::cloud_set_notebook_enabled,
            commands::cloud::cloud_refresh_membership,
            commands::cloud::cloud_list_products,
            commands::cloud::cloud_create_checkout,
            commands::cloud::cloud_sync_now,
            commands::cloud::cloud_note_history,
            commands::cloud::list_local_path_archives,
            commands::cloud::restore_local_path_version,
            commands::cloud::cloud_preview_note_revision,
            commands::cloud::cloud_list_conflicts,
            commands::cloud::cloud_resolve_markdown_conflict,
            commands::cloud::cloud_resolve_attachment_conflict,
            commands::cloud::cloud_restore_note_revision,
            // agent 鍙闂洰褰?(JSON, 璧?agent_access)
            commands::agent_access::get_agent_access,
            commands::agent_access::set_agent_access,
            commands::agent_access::get_notebook_agent_configs,
            commands::agent_access::set_notebook_agent_config,
            // System metadata (JSON, ~/.flowix/boot/system.json)
            commands::kv::get_tag_system_metadata,
            commands::kv::set_tag_system_layout,
            commands::kv::set_tag_system_hidden,
            commands::kv::set_tag_system_pinned,
            // Notebook-scoped metadata (<notebook>/.flowix/system.json)
            commands::kv::get_featured_note_filter,
            commands::kv::set_featured_note_filter,
            commands::kv::get_custom_views,
            commands::kv::set_custom_views,
            commands::kv::get_notebook_file_tree_preferences,
            commands::kv::set_notebook_file_tree_section_order,
            // 笔�? / Doc ── �?commands/memo/{reads,creates,versions,deletes}.rs
            // 瀛愭ā鍧楄矾寰勫彇, 涓嶈蛋 `commands::memo::xxx` 椤跺眰 re-export 鈹€鈹€
            // `#[tauri::command]` 宏生成的 `__cmd__xxx` wrapper �?��数所�?            // 模块的同�?macro, �?��在�?模块�?�� (`commands::memo::reads::xxx`)
            // 解析�? `commands::memo::xxx` 顶层�?��不传�?macro re-export.
            commands::memo::reads::get_memos,
            commands::memo::reads::list_notes_by_path,
            commands::memo::reads::get_indexed_note_by_path,
            commands::memo::reads::get_path_notes,
            commands::memo::reads::resolve_markdown_location,
            commands::memo::reads::search_mention_notes,
            commands::media::get_media_resource,
            commands::media::list_media_resources_page,
            commands::media::update_media_resource,
            commands::media::delete_media_resource,
            commands::memo::reads::get_used_memo_tag_ids,
            commands::memo::reads::get_memo_todo_metadata,
            commands::memo::reads::get_memo_todo_count,
            commands::memo::reads::read_memo,
            commands::memo::reads::open_memo_session,
            commands::memo::reads::read_document,
            commands::memo::reads::note_path_status,
            commands::memo::reads::get_document_modified_at,
            commands::memo::reads::write_document,
            commands::document_operations::document_operation_status,
            commands::document_operations::acknowledge_document_operation,
            commands::document_shutdown::register_document_window,
            commands::document_shutdown::finish_document_shutdown,
            commands::document_shutdown::flush_document_background,
            commands::recovery::write_recovery_draft,
            commands::recovery::read_recovery_draft,
            commands::recovery::clear_recovery_draft_through,
            commands::recovery::list_recovery_drafts,
            commands::external_document::read_external_document,
            commands::external_document::write_external_document,
            commands::memo::reads::get_launch_open_files,
            commands::memo::reads::search_memos,
            commands::memo::reads::search_path_notes,
            commands::memo::creates::add_path_document,
            commands::memo::creates::list_notebook_templates,
            commands::memo::creates::initialize_notebook_template,
            commands::memo::creates::ensure_notebook_template_setup,
            commands::memo::creates::import_external_document_by_path,
            commands::memo::creates::rename_memo_title,
            commands::memo::creates::move_memo_to_directory,
            commands::memo::creates::list_memo_templates,
            commands::memo::creates::save_memo_template,
            commands::memo::creates::delete_memo_template,
            commands::memo::creates::create_path_from_template,
            commands::memo::versions::list_memo_versions,
            commands::memo::versions::list_path_versions,
            commands::memo::versions::create_path_version,
            commands::memo::versions::restore_path_version,
            commands::memo::versions::read_memo_version,
            commands::memo::versions::create_memo_version,
            commands::memo::versions::restore_memo_version,
            commands::memo::deletes::delete_memo,
            commands::memo::deletes::prune_missing_memo,
            commands::memo::deletes::clear_memos,
            commands::memo::versions::delete_memo_version,
            // tag
            commands::tag::get_all_tags,
            commands::tag::create_notebook_tag,
            commands::tag::move_memo_tag,
            commands::tag::delete_memo_tag,
            commands::tag::get_tag_prefix_counts,
            // notebook
            commands::notebook::get_notebooks,
            commands::notebook::get_default_notebook_path,
            commands::notebook::ensure_default_notebook_path,
            commands::notebook::create_notebook,
            commands::notebook::create_notebook_from_cloud,
            commands::notebook::start_notebook_import,
            commands::notebook::get_notebook_template_setup_status,
            commands::notebook::start_notebook_template_setup,
            commands::notebook::get_notebook_import_status,
            commands::notebook::update_notebook,
            commands::notebook::delete_notebook,
            commands::notebook::clear_notebooks,
            commands::notebook::set_current_notebook,
            commands::notebook::reorder_notebooks,
            // file
            commands::file::get_file_tree,
            commands::file::get_dir_children,
            commands::document_list::list_document_page,
            commands::document_list::list_table_documents,
            commands::document_list::set_table_document_in_views,
            commands::document_list::list_media_libraries,
            commands::document_list::set_media_library_in_views,
            commands::document_list::make_view_document_identity_unique,
            commands::file::get_notebook_view_preferences,
            commands::file::get_file_management_candidates,
            commands::file::get_notebook_folder_options,
            commands::file::get_notebook_settings_tree,
            commands::file::set_notebook_view_preferences,
            commands::file::read_file,
            commands::file::read_image_file,
            commands::file::read_image_preview,
            commands::file::read_video_preview,
            commands::file::get_media_thumbnail,
            commands::file::cancel_media_thumbnail,
            commands::file::write_file,
            commands::file::rename_file,
            commands::file::move_file,
            commands::file::move_folder,
            commands::file::import_file,
            commands::file::rename_folder,
            commands::file::delete_file,
            commands::file::delete_folder,
            commands::file::create_folder,
            commands::file::create_document,
            // font cache
            commands::font::begin_font_selection,
            commands::font::commit_font_selection,
            commands::font::get_font_cache_status,
            commands::font::ensure_font_cached,
            commands::font::get_cached_font_bytes,
            commands::font::remove_cached_font,
            // web page metadata
            commands::web::parse_web_page,
            // dialog
            commands::dialog::select_directory,
            commands::dialog::select_files,
            commands::dialog::save_file_dialog,
            commands::dialog::write_export_file,
            commands::export::export_pdf,
            commands::dialog::save_attachment,
            commands::dialog::upload_journal::list_attachment_import_records,
            commands::dialog::attachment_audit::scan_attachment_references,
            commands::dialog::upload_sessions::begin_attachment_upload,
            commands::dialog::upload_sessions::append_attachment_upload,
            commands::dialog::upload_sessions::finish_attachment_upload,
            commands::dialog::upload_sessions::cancel_attachment_upload,
            commands::dialog::copy_attachment_file,
            commands::dialog::open_attachment_file,
            commands::agent_access::add_agent_access_folder_from_picker,
            // agent
            commands::agent::external_config::agent_runtime_status,
            commands::agent::external_config::get_agent_external_config,
            commands::agent::external_config::set_agent_external_path,
            commands::agent::external_config::redetect_agent_external,
            commands::agent::external_config::select_external_cli_path,
            commands::agent::terminal::open_codex_cli_install_terminal,
            commands::agent::terminal::open_codex_config,
            commands::agent::image_cache::cache_agent_image,
            commands::agent::image_cache::delete_cached_agent_image,
            commands::agent::image_cache::read_cached_agent_image,
            commands::agent::chat::chat_with_agent_stream,
            commands::agent::chat::steer_agent_stream,
            commands::agent::chat::stop_agent_stream,
            commands::agent::chat::agent_running_threads,
            commands::agent::chat::agent_background_terminals,
            commands::agent::chat::agent_background_jobs,
            commands::agent::chat::agent_external_events,
            commands::agent::chat::codex_approval_respond,
            commands::agent::chat::codex_approval_pending,
            commands::agent::chat::codex_thread_settings_update,
            commands::agent::chat::codex_slash_command,
            // thread
            commands::thread::thread_list,
            commands::thread::thread_create,
            commands::thread::thread_get,
            commands::thread::thread_get_page,
            commands::thread::agent_conversation_list,
            commands::thread::agent_conversation_list_page,
            commands::thread::agent_conversation_count_by_notebook,
            commands::thread::agent_conversation_type_counts_by_notebook,
            commands::thread::agent_conversation_get,
            commands::thread::agent_conversation_find_by_thread,
            commands::thread::agent_conversation_upsert,
            commands::thread::agent_conversation_delete,
            commands::thread::agent_conversation_delete_for_thread,
            commands::thread::local_agent_thread_list,
            commands::thread::pi_thread_list,
            commands::thread::pi_thread_get_messages,
            commands::thread::pi_thread_session_id,
            commands::thread::codex_thread_list,
            commands::thread::codex_thread_get,
            commands::thread::codex_thread_get_page,
            commands::thread::codex_thread_session_id,
            commands::thread::codex_thread_fork,
            commands::agent::model_catalog::codex_default_model,
            commands::agent::model_catalog::agent_supported_models,
            commands::agent::model_catalog::codex_runtime_info,
            commands::agent::codex_catalog::codex_project_capabilities,
            commands::agent::codex_catalog::codex_project_config_write,
            commands::agent::codex_catalog::codex_skill_enabled_set,
            commands::agent::codex_catalog::codex_plugin_installed_set,
            commands::agent::codex_catalog::codex_mcp_reload,
            commands::agent::codex_catalog::codex_project_mcp_upsert,
            commands::agent::codex_catalog::codex_project_skill_write,
            commands::agent::notebook_agents::notebook_agent_workspace_read,
            commands::agent::notebook_agents::notebook_agent_workspace_write,
            commands::thread::claude_thread_list,
            commands::thread::claude_thread_get,
            commands::thread::claude_thread_get_page,
            commands::thread::claude_thread_session_id,
            commands::thread::hermes_thread_list,
            commands::thread::hermes_thread_get,
            commands::thread::hermes_thread_get_page,
            commands::thread::hermes_thread_session_id,
            commands::thread::deepseek_harness_thread_list,
            commands::thread::deepseek_harness_thread_get,
            commands::thread::deepseek_harness_thread_get_page,
            commands::thread::deepseek_harness_thread_session_id,
            commands::thread::deepseek_harness_thread_fork,
            commands::thread::deepseek_harness_session_usage,
            commands::agent::chat::execute_deepseek_harness_command,
            commands::agent::chat::deepseek_harness_skill_catalog,
            commands::thread::opencode_thread_session_id,
            commands::thread::opencode_thread_list,
            commands::thread::opencode_thread_get_page,
            commands::thread::thread_delete,
            commands::thread::agent_thread_archive,
            commands::thread::agent_thread_delete,
            commands::thread::thread_update_title,
            // window
            commands::window::show_main_window,
            commands::window::open_preferences_window,
            commands::window::apply_window_theme,
            commands::window::apply_menu_language,
            commands::external_document_watch::watch_external_document,
            commands::external_document_watch::unwatch_external_document,
            commands::file_browser_watch::watch_file_browser_root,
            commands::file_browser_watch::unwatch_file_browser_root,
            // 鍏ㄥ眬"閫氳繃閾炬帴鎵撳紑绗旇"鍏ュ彛 鈹€鈹€ 鎺ユ敹 URL / 鐗╃悊璺緞, 瑙ｆ瀽 + emit
            commands::cli::cli_link_status,
            commands::cli::install_cli_path,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(handle_run_event);
}

fn spawn_startup_reconciliation(
    app: tauri::AppHandle,
    initial_notebooks: Vec<flowix_core::memo_file::NotebookConfig>,
    memo_file: Arc<RwLock<flowix_core::memo_file::MemoFile>>,
    memo_watcher: Arc<RwLock<MemoWatcher>>,
    user_config_for_watcher: Arc<user_config::UserConfigStore>,
    startup: Arc<crate::app::startup::StartupCoordinator>,
    cloud_sync: Arc<flowix_sync::SyncManager>,
    user_config: Arc<user_config::UserConfigStore>,
    external_runtimes: Arc<ExternalRuntimeRegistry>,
    user_config_dir: PathBuf,
    thread_manager: Arc<ThreadManager>,
) {
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_startup_reconciliation(
                &app,
                &initial_notebooks,
                &memo_file,
                &memo_watcher,
                &user_config_for_watcher,
                &startup,
            )
        }));

        match result {
            Ok(Ok(())) => {
                startup.mark_ready();
                record_startup_stage(&startup, "native-ready");
                tracing::info!(
                    elapsed_ms = started.elapsed().as_millis(),
                    "[startup] workspace ready"
                );
                handle_cold_start_open_targets(&app);
                if !startup.wait_until_interactive(Duration::from_secs(120)) {
                    tracing::warn!(
                        "[startup] first workspace paint was not reported within 120 seconds"
                    );
                }
                record_startup_stage(&startup, "background-start");
                let app_for_cli_detection = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    app_for_cli_detection
                        .state::<AppState>()
                        .agent_external_config
                        .run_startup_detect();
                });
                match thread_manager.clear_all_loading() {
                    Ok(0) => tracing::debug!("[Startup] no orphan is_loading=1 rows"),
                    Ok(n) => tracing::info!("[Startup] cleared {n} orphan is_loading=1 rows"),
                    Err(error) => tracing::warn!("[Startup] clear_all_loading failed: {error}"),
                }
                crate::maintenance::spawn_startup_maintenance(
                    app.package_info().version.to_string(),
                    user_config_dir,
                    thread_manager,
                );
                start_post_startup_services(
                    app.clone(),
                    cloud_sync,
                    user_config,
                    external_runtimes,
                );
                let current_notebook_id = crate::lock_utils::read_lock(&memo_file, "memo_file")
                    .current_notebook_id_value();
                {
                    let mut watcher = memo_watcher
                        .write()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    for notebook in &initial_notebooks {
                        if current_notebook_id.as_deref() != Some(notebook.id.as_str())
                            && !watcher.add_notebook_root(notebook)
                        {
                            tracing::warn!(notebook = %notebook.id, "[startup] background notebook watch unavailable");
                        }
                    }
                }
                for notebook in &initial_notebooks {
                    if current_notebook_id.as_deref() != Some(notebook.id.as_str()) {
                        let _ = reconcile_startup_notebook(&app, notebook, &memo_file);
                    }
                    let media_started = Instant::now();
                    if let Err(error) = crate::lock_utils::read_lock(&memo_file, "memo_file")
                        .reconcile_media_resources(&notebook.id)
                    {
                        tracing::warn!(notebook = %notebook.id, "[startup] media maintenance failed: {error}");
                    }
                    tracing::info!(notebook = %notebook.id, elapsed_ms = media_started.elapsed().as_millis(), "[startup] media maintenance checked");
                    record_slow_notebook_stage(
                        &notebook.id,
                        "media-reconcile",
                        media_started.elapsed(),
                    );
                    maintain_startup_versions(notebook, &memo_file);
                    std::thread::yield_now();
                }
                tracing::info!(
                    elapsed_ms = started.elapsed().as_millis(),
                    "[startup] background maintenance completed"
                );
                record_startup_stage(&startup, "background-complete");
            }
            Ok(Err(error)) => {
                tracing::error!("[startup] migration gate failed: {error}");
                startup.mark_failed(error);
            }
            Err(_) => {
                tracing::error!("[startup] migration gate panicked");
                startup.mark_failed("startup migration panicked");
            }
        }
    });
}

fn run_startup_reconciliation(
    app: &tauri::AppHandle,
    initial_notebooks: &[flowix_core::memo_file::NotebookConfig],
    memo_file: &Arc<RwLock<flowix_core::memo_file::MemoFile>>,
    memo_watcher: &Arc<RwLock<MemoWatcher>>,
    user_config_for_watcher: &Arc<user_config::UserConfigStore>,
    startup: &crate::app::startup::StartupCoordinator,
) -> Result<(), String> {
    // MemoFile starts without an operation context. Resolve the persisted
    // selection before deciding which notebook is on the startup critical path.
    let current_notebook_id = {
        let persisted = crate::lock_utils::read_lock(memo_file, "memo_file")
            .read_selected_notebook_id()
            .map_err(|error| format!("read selected notebook failed: {error}"))?;
        let selected = persisted
            .as_deref()
            .and_then(|id| initial_notebooks.iter().find(|notebook| notebook.id == id))
            .filter(|notebook| Path::new(&notebook.path).is_dir())
            .or_else(|| {
                initial_notebooks
                    .iter()
                    .find(|notebook| Path::new(&notebook.path).is_dir())
            })
            .map(|notebook| notebook.id.clone());
        let mut memo_file = memo_file
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        memo_file.set_current_notebook(selected.clone());
        if persisted != selected {
            memo_file
                .write_selected_notebook_id(selected.as_deref())
                .map_err(|error| format!("persist selected notebook failed: {error}"))?;
        }
        selected
    };
    tracing::info!(notebook = ?current_notebook_id, "[startup] selected notebook resolved");
    let legacy_watcher = user_config_for_watcher.get_preference().watcher;
    for notebook in initial_notebooks {
        let root = Path::new(&notebook.path);
        if root.is_dir() {
            if let Err(error) =
                crate::commands::file::migrate_legacy_watcher_rules(root, &legacy_watcher)
            {
                tracing::warn!(notebook = %notebook.id, %error, "legacy watcher rule migration deferred");
            }
        }
    }
    runtime_log::record_event(
        "info",
        "startup.selection",
        serde_json::json!({ "notebookId": current_notebook_id.as_deref() }).to_string(),
    );
    record_startup_stage(startup, "selected-notebook-resolved");
    startup.mark_running("dataMigrations");
    let migration_started = Instant::now();
    {
        let memo_file = crate::lock_utils::read_lock(memo_file, "memo_file");
        let report = memo_file
            .run_pending_data_migrations()
            .map_err(|error| format!("startup data migration failed: {error}"))?;
        if report.applied > 0 {
            tracing::info!(
                from_version = report.from_version,
                to_version = report.to_version,
                applied = report.applied,
                "startup data migrations completed"
            );
        }
    }
    tracing::info!(
        elapsed_ms = migration_started.elapsed().as_millis(),
        "[startup] data migrations checked"
    );
    record_startup_stage(startup, "data-migrations-checked");

    startup.mark_running("migratingCurrentNotebook");
    if let Some(notebook_id) = current_notebook_id.as_deref() {
        {
            let memo_file = crate::lock_utils::read_lock(memo_file, "memo_file");
            let migration_started = Instant::now();
            let report = memo_file
                .ensure_notebook_migrations(notebook_id)
                .map_err(|error| format!("current notebook migration failed: {error}"))?;
            tracing::info!(notebook = %notebook_id, elapsed_ms = migration_started.elapsed().as_millis(), "[startup] current notebook migration completed");
            if report.moved_files > 0 || report.rebuilt_tags > 0 {
                tracing::info!(
                    notebook = %notebook_id,
                    moved_files = report.moved_files,
                    rebuilt_tags = report.rebuilt_tags,
                    "current notebook migrations completed"
                );
            }
        }
    }

    record_startup_stage(startup, "current-notebook-migrations-checked");
    startup.mark_running("reconcilingCurrentNotebook");
    if let Some(notebook) = initial_notebooks
        .iter()
        .find(|notebook| Some(notebook.id.as_str()) == current_notebook_id.as_deref())
    {
        let _ = reconcile_startup_notebook(app, notebook, memo_file);
    }
    record_startup_stage(startup, "current-notebook-reconciled");

    // Bind the watcher after structural migrations, before background scans.
    // Its index updates share the memo index lock with reconciliation.
    let watcher_started = Instant::now();
    let current_watch_configs = initial_notebooks
        .iter()
        .filter(|notebook| Some(notebook.id.as_str()) == current_notebook_id.as_deref())
        .cloned()
        .collect();
    memo_watcher
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .rebind_all(app.clone(), current_watch_configs);
    let watcher_cfg = user_config_for_watcher.get_preference().watcher.clone();
    memo_watcher
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .set_whitelist(watcher_cfg);
    tracing::info!(
        elapsed_ms = watcher_started.elapsed().as_millis(),
        "[startup] watcher bound"
    );
    record_startup_stage(startup, "current-notebook-watcher-bound");

    Ok(())
}

fn reconcile_startup_notebook(
    _app: &tauri::AppHandle,
    notebook: &flowix_core::memo_file::NotebookConfig,
    memo_file: &Arc<RwLock<flowix_core::memo_file::MemoFile>>,
) -> Result<(), String> {
    let started = Instant::now();
    let memo_file = crate::lock_utils::read_lock(memo_file, "memo_file");
    match memo_file.migrate_note_properties_for_notebook(&notebook.id) {
        Ok(report) if report.notes_written > 0 => {
            tracing::info!(notebook = %notebook.id, notes = report.notes_written, "[startup] note properties migrated")
        }
        Err(error) => {
            tracing::warn!(notebook = %notebook.id, %error, "[startup] note property migration will retry")
        }
        _ => {}
    }
    match memo_file.migrate_note_todo_metadata_for_notebook(&notebook.id) {
        Ok(report) if report.notes_written > 0 => {
            tracing::info!(notebook = %notebook.id, notes = report.notes_written, "[startup] task metadata migrated")
        }
        Err(error) => {
            tracing::warn!(notebook = %notebook.id, %error, "[startup] task migration will retry")
        }
        _ => {}
    }
    let report = memo_file
        .reconcile_note_index(&notebook.id)
        .map_err(|error| {
            format!(
                "notebook {} path reconciliation failed: {error}",
                notebook.id
            )
        })?;
    tracing::info!(
        notebook = %notebook.id,
        added = report.added,
        updated = report.updated,
        removed = report.removed,
        unchanged = report.unchanged,
        elapsed_ms = started.elapsed().as_millis(),
        "[startup] path index reconciled"
    );
    record_slow_notebook_stage(&notebook.id, "markdown-reconcile", started.elapsed());
    Ok(())
}
fn maintain_startup_versions(
    notebook: &flowix_core::memo_file::NotebookConfig,
    memo_file: &Arc<RwLock<flowix_core::memo_file::MemoFile>>,
) {
    let root = Path::new(&notebook.path);
    if !root.is_dir() {
        return;
    }
    let marker = root
        .join(".flowix")
        .join("maintenance")
        .join("version-cleanup.done");
    if std::fs::metadata(&marker)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|elapsed| elapsed < Duration::from_secs(24 * 60 * 60))
    {
        return;
    }
    let started = Instant::now();
    let succeeded = match crate::lock_utils::read_lock(memo_file, "memo_file")
        .cleanup_orphan_memo_versions(&notebook.id, std::time::SystemTime::now())
    {
        Ok(report) if report.moved > 0 || report.removed > 0 || report.failed > 0 => {
            tracing::info!(
                notebook = %notebook.id,
                moved = report.moved,
                removed = report.removed,
                retained_recent = report.retained_recent,
                failed = report.failed,
                "[startup] version maintenance"
            );
            report.failed == 0
        }
        Ok(_) => true,
        Err(error) => {
            tracing::warn!(notebook = %notebook.id, "[startup] version maintenance failed: {error}");
            false
        }
    };
    if succeeded {
        if let Some(parent) = marker.parent() {
            if let Err(error) = std::fs::create_dir_all(parent)
                .and_then(|_| std::fs::write(&marker, b"completed\n"))
            {
                tracing::warn!(notebook = %notebook.id, "[startup] version maintenance marker failed: {error}");
            }
        }
    }
    tracing::info!(notebook = %notebook.id, elapsed_ms = started.elapsed().as_millis(), "[startup] version maintenance checked");
    record_slow_notebook_stage(&notebook.id, "version-maintenance", started.elapsed());
}

async fn restore_cloud_session_until_ready(
    app: tauri::AppHandle,
    cloud_sync: Arc<flowix_sync::SyncManager>,
    user_config: Arc<user_config::UserConfigStore>,
    refresh_token: String,
    restore_generation: u64,
) {
    let mut retry_delay = Duration::from_secs(2);
    loop {
        // An explicit login or logout supersedes startup restoration. Keeping
        // this generation fixed prevents a delayed retry from winning a race
        // against a user-initiated authentication attempt.
        if cloud_sync.session_restore_generation() != restore_generation {
            break;
        }
        if cloud_sync.state().is_ok_and(|state| state.authenticated) {
            break;
        }
        match user_config.load_cloud_refresh_token() {
            Ok(Some(stored)) if stored == refresh_token => {}
            Ok(_) => break,
            Err(error) => {
                tracing::warn!("failed to read Flowix Cloud refresh token during restore: {error}");
                tokio::time::sleep(retry_delay).await;
                retry_delay = (retry_delay * 2).min(Duration::from_secs(60));
                continue;
            }
        }

        match cloud_sync
            .restore_at_generation(&refresh_token, restore_generation)
            .await
        {
            Ok(_) => {
                if let Err(error) = cloud_sync.with_current_refresh_token(|token| match token {
                    Some(token) => user_config.save_cloud_refresh_token(token),
                    None => Ok(()),
                }) {
                    tracing::warn!("failed to persist rotated cloud refresh token: {error}");
                }
                break;
            }
            Err(error) if error.is_invalid_refresh_token() => {
                tracing::warn!("stored Flowix Cloud refresh token is invalid or expired");
                cloud_sync.with_current_refresh_token(|current| {
                    if current.is_none()
                        && user_config
                            .load_cloud_refresh_token()
                            .ok()
                            .flatten()
                            .as_deref()
                            == Some(refresh_token.as_str())
                    {
                        let _ = user_config.delete_cloud_refresh_token();
                    }
                });
                break;
            }
            Err(error) if cloud_restore_error_is_retryable(&error) => {
                tracing::warn!("failed to restore Flowix Cloud session; retrying: {error}");
                if let Ok(state) = cloud_sync.state() {
                    let _ = app.emit("cloud-state-changed", state);
                }
                if cloud_sync.session_restore_generation() != restore_generation {
                    break;
                }
                tokio::time::sleep(retry_delay).await;
                retry_delay = (retry_delay * 2).min(Duration::from_secs(60));
            }
            Err(error) => {
                tracing::warn!("Flowix Cloud session restore cannot be retried: {error}");
                break;
            }
        }
    }

    if let Ok(state) = cloud_sync.state() {
        let _ = app.emit("cloud-state-changed", state);
    }
}

fn cloud_restore_error_is_retryable(error: &flowix_sync::SyncError) -> bool {
    matches!(
        error,
        flowix_sync::SyncError::Http(_)
            | flowix_sync::SyncError::Api {
                status: 408 | 429 | 500..=599,
                ..
            }
    )
}

fn start_post_startup_services(
    app: tauri::AppHandle,
    cloud_sync: Arc<flowix_sync::SyncManager>,
    user_config: Arc<user_config::UserConfigStore>,
    external_runtimes: Arc<ExternalRuntimeRegistry>,
) {
    commands::cloud::start_cloud_sync_polling(app.clone());
    spawn_external_agent_watchdog(app.clone(), external_runtimes);

    if let Ok(Some(refresh_token)) = user_config.load_cloud_refresh_token() {
        let app_handle = app.clone();
        let restore_generation = cloud_sync.session_restore_generation();
        tauri::async_runtime::spawn(async move {
            restore_cloud_session_until_ready(
                app_handle,
                cloud_sync,
                user_config,
                refresh_token,
                restore_generation,
            )
            .await;
        });
    }
}

fn handle_second_instance(app: &tauri::AppHandle, args: Vec<String>) {
    // 二�?�?��: 区分 markdown 文件�?���?flowix:// 深链�?    // 两个通道�?��同时触发 (用户�?`xdg-open foo.md flowix://memo/abc123` �?��)�?
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = app.state::<AppState>().startup.wait_until_ready() {
            tracing::warn!("second-instance target deferred because startup failed: {error}");
            return;
        }
        let paths = commands::markdown_paths_from_args(args.clone());
        emit_open_target_batch_if_needed(&app, &paths);

        for arg in args {
            if !paths.contains(&arg) {
                emit_open_target_if_resolved(&app, &arg);
            }
        }
    });
}

#[cfg(desktop)]
fn register_deep_links(app: &mut tauri::App) {
    use tauri_plugin_deep_link::DeepLinkExt;

    // 开发期每�?�?��都注册一次幂等；正式打包�?installer 会接管，运�?时注册仍�?��漏�?
    let _ = app.deep_link().register("flowix");

    // macOS / Windows: OS 把深链投�?running app, 通过 deep-link 插件回调派发�?
    let app_handle = app.handle().clone();
    let startup = app.state::<AppState>().startup.clone();
    app.deep_link().on_open_url(move |event| {
        let urls = event
            .urls()
            .into_iter()
            .map(|url| url.to_string())
            .collect::<Vec<_>>();
        let app = app_handle.clone();
        let startup = startup.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = startup.wait_until_ready() {
                tracing::warn!("deep-link target deferred because startup failed: {error}");
                return;
            }
            for url in urls {
                let Ok(url) = url::Url::parse(&url) else {
                    continue;
                };
                if url.scheme() == "flowix"
                    && url.host_str() == Some("auth")
                    && url.path() == "/google/callback"
                {
                    let mut code = None;
                    let mut oauth_state = None;
                    let mut auth_error = None;
                    for (key, value) in url.query_pairs() {
                        match key.as_ref() {
                            "code" => code = Some(value.into_owned()),
                            "state" => oauth_state = Some(value.into_owned()),
                            "error" => auth_error = Some(value.into_owned()),
                            _ => {}
                        }
                    }
                    if let Some(error) = auth_error {
                        let _ = app.emit("cloud-google-auth-error", error);
                    } else if let (Some(code), Some(oauth_state)) = (code, oauth_state) {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(error) = commands::cloud::complete_google_deep_link(
                                app.clone(),
                                code,
                                oauth_state,
                            )
                            .await
                            {
                                let _ = app.emit("cloud-google-auth-error", error);
                            }
                        });
                    }
                } else {
                    emit_open_target_if_resolved(&app, url.as_str());
                }
            }
        });
    });
}

#[cfg(not(desktop))]
fn register_deep_links(_app: &mut tauri::App) {}

fn handle_cold_start_open_targets(app: &tauri::AppHandle) {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let paths = commands::markdown_paths_from_args(args.clone());
    if !paths.is_empty() {
        if let Some(main_window) = app.get_webview_window("main") {
            main_window.hide().ok();
        }
        emit_open_target_batch_if_needed(app, &paths);
    }
    for arg in args {
        if !paths.contains(&arg) {
            emit_open_target_if_resolved(app, &arg);
        }
    }
}

fn emit_open_target_batch_if_needed(app: &tauri::AppHandle, paths: &[String]) {
    let mut external_paths = Vec::new();
    let state = app.state::<AppState>();
    let configs = crate::lock_utils::read_lock(&state.memo_file, "memo_file")
        .read_notebook_configs()
        .unwrap_or_default();
    for path in paths {
        if path.to_ascii_lowercase().starts_with("flowix://memo/")
            || path.to_ascii_lowercase().starts_with("flowix://open?")
        {
            emit_open_target_if_resolved(app, path);
            continue;
        }
        if commands::markdown_paths_from_args([path.clone()]).is_empty() {
            continue;
        }
        {
            let canonical = dunce::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
            let inside_notebook = configs.iter().any(|config| {
                let root = dunce::canonicalize(&config.path)
                    .unwrap_or_else(|_| PathBuf::from(&config.path));
                canonical == root || canonical.starts_with(root.join(""))
            });
            if !inside_notebook {
                state.document_access.grant("main", &canonical);
                external_paths.push(path.clone());
            } else {
                emit_open_target_if_resolved(app, path);
            }
        }
    }
    if !external_paths.is_empty() {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
            let _ = window.unminimize();
        }
        emit_external_markdown_open(app, external_paths);
    }
}

fn emit_open_target_if_resolved(app: &tauri::AppHandle, raw: &str) {
    let state = app.state::<AppState>();
    let markdown_paths = commands::markdown_paths_from_args([raw.to_string()]);
    for path in &markdown_paths {
        if let Ok(path) = dunce::canonicalize(path) {
            state.document_access.grant("main", &path);
        }
    }
    if raw.to_ascii_lowercase().starts_with("flowix://open?")
        || raw.to_ascii_lowercase().starts_with("flowix://memo/")
        || !markdown_paths.is_empty()
    {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
            let _ = window.unminimize();
        }
        dispatcher::emit_to(app, "flowix:open-path", raw.to_string());
    }
}

fn emit_external_markdown_open(app: &tauri::AppHandle, paths: Vec<String>) {
    dispatcher::emit_to(
        app,
        "flowix:external-markdown-open",
        serde_json::json!({ "filePaths": paths }),
    );
}

fn handle_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    match event {
        tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }),
            label,
            ..
        } => {
            let state = app.state::<AppState>();
            for path in paths {
                state.document_access.grant(&label, &path);
            }
        }
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } => {
            commands::document_shutdown::forget_window(&label);
            commands::document_operations::forget_window(&label);
            app.state::<AppState>().export_access.revoke(&label);
            app.state::<AppState>().document_access.revoke(&label);
            app.state::<AppState>().upload_sessions.revoke(&label);
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Opened { urls } => {
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(error) = app.state::<AppState>().startup.wait_until_ready() {
                    tracing::warn!("macOS open target deferred because startup failed: {error}");
                    return;
                }
                let mut markdown_paths = Vec::new();
                for url in urls {
                    if url.scheme() == "file" {
                        if let Ok(path) = url.to_file_path() {
                            let path = path.to_string_lossy().to_string();
                            if !commands::markdown_paths_from_args([path.clone()]).is_empty() {
                                markdown_paths.push(path);
                            }
                        }
                    }
                }
                emit_open_target_batch_if_needed(&app, &markdown_paths);
            });
        }
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            if !commands::document_shutdown::request_exit(app, code.unwrap_or(0)) {
                api.prevent_exit();
                return;
            }
            stop_external_agent_children(app, "exit");
            checkpoint_thread_database(app, "exit");
        }
        tauri::RunEvent::Exit => {
            stop_external_agent_children(app, "final exit");
            checkpoint_thread_database(app, "final exit");
        }
        _ => {}
    }
}

fn checkpoint_thread_database(app: &tauri::AppHandle, phase: &str) {
    let state = app.state::<AppState>();
    tracing::debug!("running shutdown maintenance: {phase}");
    crate::maintenance::run_shutdown_maintenance(&state.thread_manager);
}

/// 退出路径上等待 5 个 CLI manager `stop_all` 的总时长上界。
///
/// 超时会取消尚未完成的清理，因此只能承诺尽力停止；运行时本身持有
/// `kill_on_drop` 的子进程句柄，但进程树清理仍需 manager 完成显式终止。
const EXTERNAL_AGENT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

fn stop_external_agent_children(app: &tauri::AppHandle, phase: &str) {
    let state = app.state::<AppState>();
    tauri::async_runtime::block_on(async {
        // ExternalRuntimeRegistry 并发停止所有 manager。Pi manager 也并发清理
        // 各会话，避免多个 500ms graceful-exit 等待串行累加。若总超时触发，
        // 尚未完成的清理会被取消，日志需如实说明为尽力清理。
        let stopped = tokio::time::timeout(
            EXTERNAL_AGENT_SHUTDOWN_TIMEOUT,
            state.external_runtimes.stop_all(),
        )
        .await;

        match stopped {
            Ok(stopped) => {
                let total = stopped.iter().map(|result| result.affected).sum::<usize>();
                if total > 0 {
                    let summary = stopped
                        .iter()
                        .map(|result| format!("{}={}", result.runtime.key(), result.affected))
                        .collect::<Vec<_>>()
                        .join(", ");
                    tracing::info!("stopped external agent children on {phase}: {summary}");
                }
            }
            Err(_) => {
                tracing::warn!(
                    "external agent shutdown on {phase} exceeded {EXTERNAL_AGENT_SHUTDOWN_TIMEOUT:?}; cleanup may be incomplete, proceeding with exit"
                );
            }
        }
    });
}
