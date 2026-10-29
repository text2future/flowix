use crate::agent_external::claude::ClaudeCliManager;
use crate::agent_external::codex::CodexAppServerManager;
use crate::agent_external::deepseek_harness::DeepSeekHarnessManager;
use crate::agent_external::hermes::HermesAcpManager;
use crate::agent_external::opencode::OpenCodeAcpManager;
use crate::agent_external::pi::PiRpcManager;
use crate::agent_external::runtime_registry::ExternalRuntimeRegistry;
use crate::agent_external_config::AgentExternalConfig;
use crate::agent_session::ThreadManager;
use crate::app::open_targets;
use crate::app::panic::install_panic_log_hook;
use crate::app::paths::{get_app_data_path, get_user_config_dir};
use crate::app::state::AppState;
use crate::app::watchdog::spawn_external_agent_watchdog;
use crate::cli_link;
use crate::commands;
use crate::config::user as user_config;
use crate::memo_events::{self, MemoChangeSource, MemoDerivedChanged, MemoEvent};
use crate::runtime_log;
use crate::system_data::SystemData;
use crate::watcher::MemoWatcher;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
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

// Only the durable per-version completion record controls the first stage.
// Missing migration journals, old settings, and rebuilt databases must never
// move an initialized installation back into version initialization.
fn version_initialization_pending(
    device_registry: &crate::device_registration::DeviceRegistry,
) -> bool {
    !device_registry.is_version_initialization_complete()
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
    // Only choose the canonical location here. Path migration uses VACUUM INTO
    // and runs in the startup worker, where its progress can reach the WebView.
    let database_dir = user_config_dir.join("db");
    let thread_db_path = database_dir.join("thread.db");
    let user_config = Arc::new(user_config::UserConfigStore::new(home_dir.clone()));
    let security_bookmarks = Arc::new(crate::config::SecurityBookmarkStore::new(
        user_config_dir.clone(),
    ));

    // 笔记本注册表真源为 ~/.flowix/db/local.db (SQLite); MemoFile 按需建表
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
    // Supported external Agents use agent-external-config as their path source.
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
    let thread_manager = match ThreadManager::new_uninitialized(thread_db_path.clone()) {
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
    // Orphaned tool loading rows are cleared before native ready is published.
    let user_config_arc = user_config.clone();

    // Agent �??�?���?store ── 必须�?notebook registry �?`memo_file_arc`
    // 都就�?��后构�?(�?store 会�? notebook registry �?? + 对账)�?

    // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    // 监听 user-config-changed �?���?whitelist �? 也需�?user_config_arc,
    let user_config_for_watcher = user_config_arc.clone();

    // AppState �?`.setup()` �?��里构造。Tauri 2 �?`.manage(state)` �?    // "一次�?�?��, 所以所有共�?��赖都在进入闭包前准�?好�?    //
    // 这里把构�?AppState 需要的子结�?clone 出来 (�?�� `move` 捕获),
    // 同时把另一�?clone 喂给 sub-component 构造函数�?
    let user_config_for_state = user_config_arc.clone();
    let security_bookmarks_for_state = security_bookmarks.clone();
    let memo_file_for_state = memo_file_arc.clone();
    let thread_manager_for_state = thread_manager_arc.clone();
    let startup_for_state = startup_coordinator.clone();
    let notebook_transition_for_state = notebook_transition.clone();
    // �?��设�?登�?模块 ── 和上面同样的 prep 模式: clone �?setup �?���?
    let user_config_dir_for_device = user_config_dir.clone();
    // `system_data` 娌?
    // impl Clone ── 直接 move �?setup �?��, 那里
    // move 杩?AppState銆?
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
        .plugin(crate::local_html_preview::init())
        .manage(crate::app_update::AppUpdateState::default())
        .manage(open_targets::PendingOpenTargets::default())
        .manage(memo_watcher.clone())
        .on_window_event(commands::window_shutdown::on_window_event)
        .on_page_load(|webview, payload| {
            #[cfg(windows)]
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                commands::window_shutdown::clear_native_region(&webview.window());
            }
            #[cfg(not(windows))]
            let _ = (webview, payload);
        })
        .on_webview_event(|webview, event| {
            if let tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let state = webview.state::<AppState>();
                for path in paths {
                    state.document_access.grant(webview.label(), path);
                }
            }
        })
        .setup(move |app| {
            #[cfg(windows)]
            {
                let shutdown_app = app.handle().clone();
                flowix_installer_helper::listen_for_shutdown(move || shutdown_app.exit(0));
            }
            record_startup_stage(&startup_coordinator, "native-setup-start");
            // Registry import and notebook inspection run in the startup
            // initialization worker after AppState exists.
            // 鈹€鈹€ 0) 鍚姩璁惧鐧昏 / last_seen 鍒锋柊 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
            //   不阻�? spawn 一�?fire-and-forget tokio 任务, �?��内部
            //   �?sleep 10s �?POST, 与产品更�?7s 检查错开。远�?��
            //   `device_id` upsert, 首�?插入, 后续�?��刷新 last_seen_at�?
            let app_version = app.package_info().version.to_string();
            let device_registry = Arc::new(crate::device_registration::DeviceRegistry::load(
                &user_config_dir_for_device,
                app_version,
            ));
            if version_initialization_pending(&device_registry) {
                startup_coordinator.mark_running(
                    crate::app::startup::StartupStage::Initialization,
                    "versionInitialization",
                );
            } else {
                startup_coordinator.mark_running(
                    crate::app::startup::StartupStage::WorkspacePreparation,
                    "preparingData",
                );
            }
            device_registry.clone().spawn_startup_registration();
            app.manage(device_registry.clone());

            // 鈹€鈹€ 1) 鍚姩鎺㈡祴 external CLI 璺緞 鈹€鈹€
            //   �?source=auto/缺失�?agent 跑探测链 (env>PATH>候�?shell),
            // Cached paths are available immediately. Probing external CLIs
            // can spawn processes, so run it after the first workspace paint.
            agent_external_config.load_into_registry();

            let is_dev_build = option_env!("FLOWIX_DEV_MODE") == Some("1");
            // A saved Preferences selection is the source of truth. The build
            // target only supplies the initial/default environment.
            let cloud_environment = if is_dev_build {
                let saved_environment = user_config_for_state
                    .get_preference()
                    .cloud_environment;
                flowix_sync::CloudEnvironment::parse(&saved_environment)
                    .unwrap_or_else(flowix_sync::default_cloud_environment)
            } else {
                flowix_sync::CloudEnvironment::Prod
            };
            runtime_log::record_event(
                "info",
                "cloud.environment.selected",
                format!(
                    "environment={}, api_base={}",
                    cloud_environment.name(),
                    cloud_environment.api_base()
                ),
            );
            let cloud_sync_db_path = if is_dev_build {
                user_config_dir_for_device
                    .join("db")
                    .join(format!("sync-dev-{}.db", cloud_environment.name()))
            } else {
                user_config_dir_for_device.join("db").join("sync.db")
            };
            let cloud_refresh_token_store: Arc<dyn flowix_sync::RefreshTokenStore> =
                if is_dev_build {
                    Arc::new(crate::config::CloudDevRefreshTokenStore::new(
                        user_config_for_state.clone(),
                        cloud_environment,
                    ))
                } else {
                    user_config_for_state.clone()
                };

            let cloud_state_app = app.handle().clone();
            let cloud_state_notifier: Arc<dyn Fn(flowix_sync::CloudState) + Send + Sync> =
                Arc::new(move |state| {
                    if let Err(error) = cloud_state_app.emit("cloud-state-changed", state) {
                        tracing::warn!("failed to emit cloud state notification: {error}");
                    }
                });
            let cloud_sync_for_state = Arc::new(
                flowix_sync::SyncManager::new_with_session_dependencies_deferred(
                    cloud_environment.api_base(),
                    &cloud_sync_db_path,
                    cloud_refresh_token_store.clone(),
                    cloud_state_notifier.clone(),
                )
                .unwrap_or_else(|error| {
                    tracing::error!(
                        "failed to initialize cloud sync database: {error}; using a temporary database"
                    );
                    flowix_sync::SyncManager::new_with_session_dependencies_deferred(
                        cloud_environment.api_base(),
                        std::env::temp_dir().join(format!("flowix-sync-{}.db", std::process::id())),
                        cloud_refresh_token_store.clone(),
                        cloud_state_notifier.clone(),
                    )
                    .expect("failed to initialize temporary cloud sync database")
                }),
            );

            crate::dsh::set_user_selected_cli(
                user_config_for_state
                    .get_preference()
                    .dsh_cli_path
                    .map(std::path::PathBuf::from),
            );
            let app_state = AppState {
                upload_sessions: Default::default(),
                document_access: Default::default(),
                security_bookmarks: security_bookmarks_for_state.clone(),
                export_access: Default::default(),
                user_config: user_config_for_state.clone(),
                cloud_sync: cloud_sync_for_state.clone(),
                cloud_environment,
                system_data,
                agent_external_config,
                memo_file: memo_file_for_state.clone(),
                external_runtimes: external_runtimes.clone(),
                codex_app_server: codex_app_server.clone(),
                opencode: opencode_acp_manager.clone(),
                pi: pi_rpc_manager.clone(),
                deepseek_harness: deepseek_harness_manager.clone(),
                agent_history: agent_history.clone(),
                agent_lifecycle: agent_lifecycle.clone(),
                thread_manager: thread_manager_for_state.clone(),
                plugin_runs: crate::plugin::PluginRunCoordinator::default(),
                notebook_imports: Default::default(),
                notebook_background: Default::default(),
                notebook_template_initializations: Default::default(),
                notebook_transition: notebook_transition_for_state,
                startup: startup_for_state,
                watcher_retry_stop: Arc::new(AtomicBool::new(false)),
            };
            app_state.upload_sessions.start_cleanup();
            app.manage(app_state);
            external_runtimes.listen_for_terminal_events(app.handle());
            #[cfg(windows)]
            {
                if let Err(error) = crate::native_close_region::start() {
                    tracing::warn!("native close input retrying: {error}");
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                commands::window_shutdown::install_window(&window);
                // �?��即�?齐主题背�?��, 消除冷启动白�?(尤其深色主�?)�?
                let saved_theme = app.state::<AppState>().user_config.get_preference().theme;
                // Mist is account-gated. Keep native chrome on Rock until the
                // frontend has confirmed the signed-in account entitlement.
                let theme = if saved_theme == crate::config::Theme::Mist {
                    crate::config::Theme::Rock
                } else {
                    saved_theme
                };
                crate::window_chrome::apply_window_chrome_theme(&window, theme);

                // Theme::System 时跟�?OS 明暗实时切换窗口背景�? 仅当窗口�??显式
                // theme (�?��用所有窗口都�? �?Tauri 才派�?ThemeChanged, 故这�?                // 监听主窗口即�?��发一次全局刷新 (apply_window_chrome_theme_all 遍历所有窗�?�?
                let app_for_window_event = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::ThemeChanged(_) = event {
                        let current = app_for_window_event
                            .state::<AppState>()
                            .user_config
                            .get_preference()
                            .theme;
                        if current == crate::config::Theme::System {
                            crate::window_chrome::apply_window_chrome_theme_all(
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
            // �?��时把 preference.json::watcher 应用�?MemoWatcher;
            // 同时监听 user-config-changed，在偏好更新后热加载 watcher 规则。
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
                    // Tauri serializes the event payload as a JSON string.
                    let kind = serde_json::from_str::<String>(event.payload()).unwrap_or_default();
                    if kind == "preference" {
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
            spawn_workbench_startup(
                app.handle().clone(),
                memo_file_for_state.clone(),
                cloud_sync_for_state.clone(),
                memo_watcher.clone(),
                user_config_for_watcher.clone(),
                startup_coordinator.clone(),
                external_runtimes.clone(),
                user_config_dir_for_device.clone(),
                thread_manager_for_state.clone(),
                device_registry,
                app.state::<AppState>().watcher_retry_stop.clone(),
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
            commands::product::set_cloud_environment,
            commands::product::open_log_dir,
            commands::product::open_file_with_default_app,
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
            commands::artifact::artifact_resolve,
            commands::settings::get_preference,
            commands::settings::patch_preference,
            commands::settings::get_property_presets,
            commands::settings::patch_property_presets,
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
            commands::settings::get_pi_mcp_servers,
            commands::settings::save_pi_mcp_server,
            commands::settings::delete_pi_mcp_server,
            commands::settings::get_pi_features,
            commands::settings::save_pi_features,
            commands::settings::clear_pi_legacy_code_mode,
            commands::settings::get_pi_model_catalog,
            commands::settings::save_pi_model_config,
            commands::settings::delete_pi_model_config,
            commands::settings::test_pi_model_config,
            commands::settings::discover_pi_models,
            commands::dsh::dsh_status,
            commands::dsh::dsh_select_cli_path,
            commands::dsh::dsh_set_cli_path,
            commands::dsh::dsh_install_appserver_profile,
            commands::dsh::dsh_manage_profile_plugin,
            crate::app_update::install_app_update,
            crate::app_update::check_app_update,
            crate::app_update::download_app_update,
            crate::app_update::consume_app_update_result,
            crate::app_update::cancel_app_update,
            commands::boot::get_boot_features,
            commands::boot::set_boot_intro_displayed,
            commands::boot::get_version_initialization_completed,
            commands::boot::set_version_initialization_completed,
            commands::boot::get_startup_status,
            commands::boot::wait_for_startup_status_change,
            commands::boot::retry_startup,
            commands::boot::get_startup_notebook_id,
            commands::boot::notify_startup_interactive,
            commands::boot::record_startup_stage,
            commands::boot::record_frontend_error,
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
            commands::cloud::cloud_ai_credit_balance,
            commands::cloud::cloud_pi_model_availability,
            commands::cloud::cloud_connect_pi_model_provider,
            commands::cloud::cloud_refresh_pi_model_provider_at_startup,
            commands::cloud::cloud_refresh_pi_model_provider,
            commands::cloud::cloud_list_products,
            commands::cloud::cloud_list_billing_orders,
            commands::cloud::cloud_check_billing_order,
            commands::cloud::cloud_list_subscriptions,
            commands::cloud::cloud_cancel_subscription,
            commands::cloud::cloud_create_checkout,
            commands::cloud::cloud_submit_feedback,
            commands::cloud::cloud_sync_now,
            commands::cloud::list_local_path_archives,
            commands::cloud::restore_local_path_version,
            commands::cloud::cloud_list_conflicts,
            commands::cloud::cloud_resolve_markdown_conflict,
            commands::cloud::cloud_resolve_attachment_conflict,
            // Device-local notebook workspaces (local.db).
            commands::agent_workspace::get_agent_workspace,
            commands::agent_workspace::attach_notebook_directory,
            commands::agent_workspace::detach_notebook_directory,
            // System metadata (JSON, ~/.flowix/boot/system.json)
            commands::kv::get_tag_system_metadata,
            commands::kv::set_tag_system_layout,
            commands::kv::set_tag_system_pinned,
            // Notebook-scoped metadata (<notebook>/.flowix/system.json)
            commands::kv::get_featured_note_filter,
            commands::kv::set_featured_note_filter,
            commands::kv::get_custom_views,
            commands::kv::set_custom_views,
            commands::kv::get_notebook_file_tree_preferences,
            commands::kv::set_notebook_file_tree_section_order,
            commands::kv::set_notebook_pinned_folders,
            // 笔�? / Doc ── �?commands/memo/{reads,creates,versions,deletes}.rs
            // 瀛愭ā鍧楄矾寰勫彇, 涓嶈蛋 `commands::memo::xxx` 椤跺眰 re-export 鈹€鈹€
            // `#[tauri::command]` 宏生成的 `__cmd__xxx` wrapper �?��数所�?            // 模块的同�?macro, �?��在�?模块�?�� (`commands::memo::reads::xxx`)
            // 解析�? `commands::memo::xxx` 顶层�?��不传�?macro re-export.
            commands::memo::reads::list_notes_by_path,
            commands::memo::reads::get_indexed_note_by_path,
            commands::memo::reads::get_path_notes,
            commands::memo::reads::resolve_markdown_location,
            commands::media::get_media_resource,
            commands::media::list_media_resources_page,
            commands::media::update_media_resource,
            commands::media::delete_media_resource,
            commands::memo::reads::get_used_memo_tag_ids,
            commands::memo::reads::read_document,
            commands::memo::reads::note_path_status,
            commands::memo::reads::get_document_modified_at,
            commands::memo::reads::write_document,
            commands::document_operations::document_operation_status,
            commands::document_operations::acknowledge_document_operation,
            commands::window_shutdown::register_document_window,
            commands::window_shutdown::finish_document_shutdown,
            commands::window_shutdown::finish_document_close,
            commands::recovery::write_recovery_draft,
            commands::recovery::read_recovery_draft,
            commands::recovery::clear_recovery_draft_through,
            commands::recovery::list_recovery_drafts,
            commands::external_document::read_external_document,
            commands::external_document::detect_external_document_text,
            commands::external_document::write_external_document,
            open_targets::get_pending_open_targets,
            open_targets::acknowledge_open_targets,
            commands::memo::reads::search_path_notes,
            commands::memo::creates::add_path_document,
            commands::memo::creates::list_notebook_templates,
            commands::memo::creates::initialize_notebook_template,
            commands::notebook_setup::ensure_notebook_template_setup,
            commands::memo::creates::import_external_document_by_path,
            commands::memo::creates::rename_memo_title,
            commands::memo::creates::move_memo_to_directory,
            commands::memo::creates::list_memo_templates,
            commands::memo::creates::save_memo_template,
            commands::memo::creates::delete_memo_template,
            commands::memo::creates::create_path_from_template,
            commands::memo::versions::list_path_versions,
            commands::memo::versions::create_path_version,
            commands::memo::versions::restore_path_version,
            commands::memo::deletes::delete_memo,
            commands::memo::deletes::prune_missing_memo,
            // tag
            commands::tag::get_all_tags,
            commands::tag::move_memo_tag,
            commands::tag::delete_memo_tag,
            commands::tag::get_tag_prefix_counts,
            // notebook
            commands::notebook::get_notebooks,
            commands::notebook::set_notebook_pinned,
            commands::notebook::get_notebook_background_status,
            commands::notebook::get_notebook_media_maintenance_status,
            commands::notebook::request_notebook_media_maintenance,
            commands::notebook::request_notebook_refresh,
            commands::notebook::get_default_notebook_path,
            commands::notebook::confirm_notebook_preset_overwrite,
            commands::notebook::ensure_default_notebook_path,
            commands::notebook::create_notebook,
            commands::notebook::create_notebook_from_cloud,
            commands::notebook::start_notebook_import,
            commands::notebook_setup::get_notebook_template_setup_status,
            commands::notebook_setup::start_notebook_template_setup,
            commands::notebook_setup::start_or_resume_ready_notebook_template_setups,
            commands::notebook_setup::get_notebook_template_setup_snapshot,
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
            commands::document_list::list_work_documents_page,
            commands::collection::list_collections,
            commands::collection::resolve_collection,
            commands::collection::mutate_collection,
            commands::collection::set_collection_display_state,
            commands::collection::make_collection_identity_unique,
            commands::file::get_notebook_view_preferences,
            commands::file::get_file_management_candidates,
            commands::file::get_notebook_folder_options,
            commands::file::get_notebook_settings_tree,
            commands::file::set_notebook_view_preferences,
            commands::file::read_file,
            commands::file::read_docx_file,
            commands::file::create_docx_markdown,
            commands::file::read_image_file,
            commands::file::read_image_preview,
            commands::file::read_codex_generated_image_preview,
            commands::file::read_video_preview,
            commands::file::get_media_thumbnail,
            commands::file::cancel_media_thumbnail,
            commands::file::write_file,
            commands::file::create_file,
            commands::file::rename_file,
            commands::file::move_file,
            commands::file::move_folder,
            commands::file::import_file,
            commands::file::folder_import::import_folder,
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
            // web page metadata
            commands::web::parse_web_page,
            commands::web::resolve_bilibili_video,
            // dialog
            commands::dialog::select_directory,
            commands::dialog::select_import_directory,
            commands::dialog::select_files,
            commands::dialog::save_file_dialog,
            commands::dialog::write_export_file,
            commands::export::export_pdf,
            commands::dialog::save_notebook_asset,
            commands::dialog::upload_sessions::begin_attachment_upload,
            commands::dialog::upload_sessions::append_attachment_upload,
            commands::dialog::upload_sessions::finish_attachment_upload,
            commands::dialog::upload_sessions::cancel_attachment_upload,
            commands::dialog::copy_attachment_file,
            commands::dialog::open_attachment_file,
            commands::agent_workspace::pick_notebook_directory,
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
            commands::agent::chat::promote_pi_follow_up_to_steer,
            commands::agent::chat::delete_pi_queued_message,
            commands::agent::chat::queue_codex_follow_up,
            commands::agent::chat::list_codex_follow_ups,
            commands::agent::chat::restore_codex_follow_ups,
            commands::agent::chat::delete_codex_follow_up,
            commands::agent::chat::deliver_codex_follow_up_now,
            commands::agent::chat::stop_agent_stream,
            commands::agent::chat::agent_running_threads,
            commands::agent::chat::agent_background_terminals,
            commands::agent::chat::agent_background_jobs,
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
            commands::thread::agent_conversation_get_by_ids,
            commands::thread::agent_conversation_find_by_thread,
            commands::thread::agent_conversation_upsert,
            commands::thread::agent_conversation_delete,
            commands::thread::agent_conversation_delete_for_thread,
            commands::thread::local_agent_thread_list,
            commands::thread::pi_thread_list,
            commands::thread::pi_thread_get_messages,
            commands::thread::pi_thread_get_snapshot,
            commands::thread::pi_thread_get_page,
            commands::thread::pi_thread_session_id,
            commands::thread::pi_thread_fork,
            commands::thread::codex_thread_list,
            commands::thread::codex_thread_get,
            commands::thread::codex_thread_get_page,
            commands::thread::codex_thread_session_id,
            commands::thread::codex_thread_fork,
            commands::agent::model_catalog::codex_default_model,
            commands::agent::model_catalog::agent_supported_models,
            commands::agent::model_catalog::codex_supported_model_catalog,
            commands::agent::model_catalog::codex_runtime_info,
            commands::agent::codex_catalog::codex_project_capabilities,
            commands::agent::codex_catalog::codex_project_skills,
            commands::agent::codex_catalog::codex_project_config_write,
            commands::agent::codex_catalog::codex_skill_enabled_set,
            commands::agent::codex_catalog::codex_plugin_installed_set,
            commands::agent::codex_catalog::codex_mcp_reload,
            commands::agent::codex_catalog::codex_project_mcp_upsert,
            commands::agent::codex_catalog::codex_project_skill_write,
            commands::agent::codex_catalog::codex_project_skill_install_zip,
            commands::agent::notebook_agents::notebook_agent_workspace_read,
            commands::agent::notebook_agents::notebook_agent_skills_read,
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
            commands::window_input::set_window_close_region,
            commands::window_input::native_close_routing_ready,
            commands::window::apply_window_theme,
            commands::window::get_window_material,
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

fn spawn_workbench_startup(
    app: tauri::AppHandle,
    memo_file: Arc<RwLock<flowix_core::memo_file::MemoFile>>,
    cloud_sync: Arc<flowix_sync::SyncManager>,
    memo_watcher: Arc<RwLock<MemoWatcher>>,
    user_config_for_watcher: Arc<user_config::UserConfigStore>,
    startup: Arc<crate::app::startup::StartupCoordinator>,
    external_runtimes: Arc<ExternalRuntimeRegistry>,
    user_config_dir: PathBuf,
    thread_manager: Arc<ThreadManager>,
    device_registry: Arc<crate::device_registration::DeviceRegistry>,
    watcher_retry_stop: Arc<AtomicBool>,
) {
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            prepare_startup_storage(
                &device_registry,
                &memo_file,
                &thread_manager,
                &cloud_sync,
                &user_config_for_watcher,
                &user_config_dir,
                &startup,
            )?;
            Ok::<_, String>(())
        }));

        match &result {
            Ok(Err(error)) => tracing::warn!(%error, "startup preparation skipped"),
            Err(_) => tracing::warn!("startup preparation panicked; entering product"),
            _ => {}
        }
        // Stage 2 runs even if a migration returned an error or panicked.
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            prepare_runtime_storage(
                &memo_file,
                &thread_manager,
                &user_config_for_watcher,
                &startup,
            );
        }))
        .is_err()
        {
            tracing::warn!("runtime preparation panicked; entering product");
        }
        // Clean crash leftovers before any workspace can start a new run.
        match thread_manager.clear_all_loading() {
            Ok(0) => tracing::debug!("[Startup] no orphan is_loading=1 rows"),
            Ok(n) => tracing::info!("[Startup] cleared {n} orphan is_loading=1 rows"),
            Err(error) => tracing::warn!("[Startup] clear_all_loading failed: {error}"),
        }
        startup.mark_ready();
        record_startup_stage(&startup, "native-ready");
        tracing::info!(
            elapsed_ms = started.elapsed().as_millis(),
            "[startup] workspace ready"
        );
        open_targets::dispatch(
            &app,
            open_targets::command_line_targets(std::env::args()),
            "cold-start",
        );
        if !startup.wait_until_interactive(Duration::from_secs(120)) {
            tracing::warn!(
                "[startup] first workspace paint was not reported within 120 seconds; releasing independent services as a degraded liveness fallback"
            );
            record_startup_stage(&startup, "interactive-timeout-degraded-release");
        }
        record_startup_stage(&startup, "background-start");
        let app_for_cli_detection = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            app_for_cli_detection
                .state::<AppState>()
                .agent_external_config
                .run_startup_detect();
        });
        crate::maintenance::spawn_startup_maintenance(
            app.package_info().version.to_string(),
            user_config_dir,
            thread_manager,
        );
        // Cloud readiness/credentials are independent of local startup.
        let cloud_app = app.clone();
        let session_manager = cloud_sync.clone();
        tauri::async_runtime::spawn(async move {
            let mut delay = Duration::from_secs(2);
            loop {
                let manager = session_manager.clone();
                let initialized = tauri::async_runtime::spawn_blocking(move || {
                    manager.initialize_runtime_storage()
                })
                .await;
                match initialized {
                    Ok(Ok(())) => break,
                    Ok(Err(error)) => tracing::warn!(%error, retry_in_ms = delay.as_millis(),
                                "background cloud storage unavailable; retry scheduled"),
                    Err(error) => tracing::warn!(%error, retry_in_ms = delay.as_millis(),
                                "background cloud storage worker failed; retry scheduled"),
                }
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(Duration::from_secs(60));
            }
            if let Ok(state) = session_manager.state() {
                let _ = cloud_app.emit("cloud-state-changed", state);
            }
            commands::cloud::start_cloud_sync_polling(cloud_app);
            tauri::async_runtime::spawn(async move {
                session_manager.run_session_service().await;
            });
        });
        if let Err(error) = user_config_for_watcher.clear_legacy_watcher_exclusions() {
            tracing::warn!(%error, "background watcher defaults could not be persisted");
        }
        start_post_startup_services(app.clone(), external_runtimes);
        let background = app.state::<AppState>().notebook_background.clone();
        // Serialize selection + binding so the active root cannot
        // lag behind a concurrent notebook switch.
        let (current_notebook_id, initial_notebooks) = {
            let app_state = app.state::<AppState>();
            let app_state = app_state.inner();
            let _transition = app_state
                .notebook_transition
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let current_notebook_id =
                crate::lock_utils::read_lock(&memo_file, "memo_file").current_notebook_id_value();
            let mut watcher = memo_watcher.write().unwrap_or_else(|p| p.into_inner());
            let configs = crate::watcher::runtime::read_registered_notebooks(
                user_config_for_watcher.config_dir(),
            );
            watcher.set_whitelist(user_config_for_watcher.get_preference().watcher);
            match configs {
                Ok(configs) => {
                    watcher.rebind_current_notebook(
                        app.clone(),
                        current_notebook_id.as_deref(),
                        configs
                            .iter()
                            .find(|config| {
                                current_notebook_id.as_deref() == Some(config.id.as_str())
                            })
                            .cloned(),
                    );
                    (current_notebook_id, configs)
                }
                Err(error) => {
                    tracing::warn!(%error, "startup watcher snapshot unavailable; retry deferred");
                    watcher.rebind_current_notebook(
                        app.clone(),
                        current_notebook_id.as_deref(),
                        None,
                    );
                    (current_notebook_id, Vec::new())
                }
            }
        };
        if let Some(notebook) = initial_notebooks
            .iter()
            .find(|n| Some(n.id.as_str()) == current_notebook_id.as_deref())
        {
            background.prioritize(&notebook.id);
        }
        background.start(app.clone(), user_config_for_watcher.config_dir().clone());
        for notebook in &initial_notebooks {
            if current_notebook_id.as_deref() != Some(notebook.id.as_str()) {
                background.request(&notebook.id, false, false);
            }
        }
        spawn_notebook_watch_retry(
            app.clone(),
            memo_watcher.clone(),
            user_config_for_watcher.config_dir().clone(),
            background.clone(),
            watcher_retry_stop.clone(),
        );
        tracing::info!(
            elapsed_ms = started.elapsed().as_millis(),
            "[startup] background services admitted"
        );
        record_startup_stage(&startup, "background-services-admitted");
    });
}

/// Retry the selected notebook root independently of index work. A newly
/// attached root gets one reconciliation pass to cover changes made while its
/// volume was offline. The process exit signal stops this loop.
fn spawn_notebook_watch_retry(
    app: tauri::AppHandle,
    memo_watcher: Arc<RwLock<MemoWatcher>>,
    config_dir: PathBuf,
    background: Arc<crate::app::notebook_background::NotebookBackground>,
    stop: Arc<AtomicBool>,
) {
    tauri::async_runtime::spawn_blocking(move || {
        loop {
            for _ in 0..15 {
                if stop.load(Ordering::Acquire) {
                    return;
                }
                std::thread::sleep(Duration::from_secs(1));
            }
            if stop.load(Ordering::Acquire) {
                return;
            }
            let state = app.state::<AppState>();
            let _transition = state
                .notebook_transition
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let active_notebook_id = crate::lock_utils::read_lock(&state.memo_file, "memo_file")
                .current_notebook_id_value();
            let active_config = match crate::watcher::runtime::read_registered_notebooks(&config_dir) {
                Ok(configs) => configs
                    .into_iter()
                    .find(|config| {
                        active_notebook_id.as_deref() == Some(config.id.as_str())
                    }),
                Err(error) => {
                    tracing::warn!(%error, "could not reload notebook roots for watcher retry");
                    continue;
                }
            };
            let Ok(mut watcher) = memo_watcher.write() else {
                tracing::warn!("notebook watcher lock unavailable during root retry");
                continue;
            };
            if !watcher.is_initialized() {
                watcher.rebind_current_notebook(
                    app.clone(),
                    active_notebook_id.as_deref(),
                    active_config.clone(),
                );
                // Binding alone cannot cover changes made while detached. Only
                // reconcile the active root if it attached. Inactive roots do
                // not receive filesystem watches until selected.
                let attached_id = active_config
                    .as_ref()
                    .filter(|config| watcher.is_watching(&config.id))
                    .map(|config| config.id.clone());
                drop(watcher);
                drop(_transition);
                if let Some(notebook_id) = attached_id {
                    background.request(&notebook_id, false, true);
                }
                continue;
            }
            let mut attached_id = None;
            if let Some(config) = active_config.as_ref() {
                if !watcher.is_watching(&config.id)
                    && !watcher.is_notebook_suspended(&config.id)
                    && Path::new(&config.path).is_dir()
                {
                    if watcher.add_notebook_root(config) {
                        tracing::info!(notebook_id = %config.id, root = %config.path,
                            "attached notebook watcher after root became available");
                        attached_id = Some(config.id.clone());
                    } else {
                        tracing::debug!(notebook_id = %config.id, root = %config.path,
                            "notebook watcher root retry is still unavailable");
                    }
                }
            }
            drop(watcher);
            drop(_transition);
            if let Some(notebook_id) = attached_id {
                background.request(&notebook_id, false, true);
            }
        }
    });
}

fn skip_startup_error<T, E: std::fmt::Display>(step: &str, result: Result<T, E>) -> Option<T> {
    match result {
        Ok(value) => Some(value),
        Err(error) => {
            tracing::warn!(%step, %error, "startup operation skipped");
            None
        }
    }
}

fn prepare_runtime_storage(
    memo_file: &Arc<RwLock<flowix_core::memo_file::MemoFile>>,
    thread_manager: &ThreadManager,
    user_config: &crate::config::UserConfigStore,
    startup: &crate::app::startup::StartupCoordinator,
) {
    startup.mark_running(
        crate::app::startup::StartupStage::WorkspacePreparation,
        "preparingData",
    );
    skip_startup_error(
        "initialize thread runtime",
        thread_manager.initialize_runtime_storage(),
    );
    {
        let memo = crate::lock_utils::read_lock(memo_file, "memo_file");
        skip_startup_error(
            "initialize notebook runtime",
            memo.initialize_runtime_registry_storage(),
        );
        // Both stores share local.db: notebooks must exist before property presets.
        skip_startup_error(
            "initialize runtime configuration",
            user_config.initialize_current_runtime_storage(),
        );
    }
    let initial_notebooks = skip_startup_error(
        "read notebook registry",
        crate::lock_utils::read_lock(memo_file, "memo_file").read_notebook_configs(),
    )
    .unwrap_or_default();
    skip_startup_error(
        "select notebook",
        prepare_notebook_selection(&initial_notebooks, memo_file, startup),
    );
    user_config.prepare_initialized_runtime();
}

fn prepare_startup_storage(
    device_registry: &crate::device_registration::DeviceRegistry,
    memo_file: &Arc<RwLock<flowix_core::memo_file::MemoFile>>,
    _thread_manager: &ThreadManager,
    _cloud_sync: &flowix_sync::SyncManager,
    user_config: &crate::config::UserConfigStore,
    user_config_dir: &Path,
    startup: &crate::app::startup::StartupCoordinator,
) -> Result<(), String> {
    let version_init_pending = version_initialization_pending(device_registry);
    if version_init_pending {
        startup.mark_running(
            crate::app::startup::StartupStage::Initialization,
            "versionInitialization",
        );
        startup.set_progress(0, 0, 2, "prepareDatabasePaths");
    } else {
        // Also reset retry state here: even a failed rebuild stays in stage 2.
        startup.mark_running(
            crate::app::startup::StartupStage::WorkspacePreparation,
            "preparingData",
        );
    }
    if version_init_pending {
        if let Err(error) = crate::storage_initialization::prepare_database_paths(user_config_dir) {
            tracing::warn!(%error, "database path migration skipped");
        }
    } else {
        skip_startup_error(
            "prepare database directory",
            flowix_core::memo_file::ensure_storage_directory(&user_config_dir.join("db")),
        );
    }
    // Thread and cloud databases are opened in stage 2 / background services.
    if version_init_pending {
        startup.set_progress(15, 1, 2, "prepareNotebookRegistry");
    }
    let registry_migrated = if version_init_pending {
        let memo = crate::lock_utils::read_lock(memo_file, "memo_file");
        memo.migrate_existing_registry_storage()
    } else {
        true
    };
    if version_init_pending {
        startup.set_progress(30, 2, 2, "prepareNotebookRegistry");
    }
    user_config.prepare_runtime_watcher_exclusions();
    if !version_init_pending {
        // Stage 2 only opens/rebuilds current runtime stores. Do not inspect or
        // replay legacy jobs, even if their completion records were lost or a
        // notebook was unavailable during the first initialization.
        user_config.prepare_initialized_runtime();
        tracing::info!("[startup] version initialization already completed for this app version");
        record_startup_stage(startup, "version-initialization-skipped");
        return Ok(());
    }

    if !registry_migrated {
        // No usable migration source. Leave registry creation to stage 2;
        // querying the migration journal here would create it prematurely.
        user_config.prepare_initialized_runtime();
        skip_startup_error(
            "record initialization completion",
            device_registry.complete_version_initialization(),
        );
        return Ok(());
    }

    if skip_startup_error(
        "read configuration migration progress",
        crate::lock_utils::read_lock(memo_file, "memo_file")
            .local_migration_completed(crate::storage_initialization::CONFIG_LOCAL_MIGRATIONS_JOB),
    )
    .unwrap_or(false)
    {
        user_config.prepare_initialized_runtime();
    }
    tracing::info!(
        previous_app_version = ?device_registry.last_successful_app_version(),
        "[startup] starting version initialization"
    );
    record_startup_stage(startup, "version-initialization-start");
    skip_startup_error(
        "record initialization start",
        device_registry.begin_version_initialization(),
    );

    let migrations_complete = skip_startup_error(
        "migrate legacy storage",
        crate::storage_initialization::initialize_legacy_storage_with_progress(
            device_registry,
            &crate::lock_utils::read_lock(memo_file, "memo_file"),
            user_config,
            user_config_dir,
            &get_app_data_path(),
            |completed, total, task| {
                let percent = 30 + (55 * completed / total.max(1)) as u8;
                startup.set_progress(percent, completed, total, task);
            },
        ),
    )
    .unwrap_or(false);

    startup.set_progress(88, 0, 2, "prepareRuntimeStorage");
    startup.set_progress(95, 1, 2, "activateRuntime");
    user_config.prepare_initialized_runtime();

    if migrations_complete {
        skip_startup_error(
            "record initialization completion",
            device_registry.complete_version_initialization(),
        );
    } else {
        tracing::warn!(
            "storage migrations remain pending; startup continues and retries next launch"
        );
    }
    startup.set_progress(100, 2, 2, "completeInitialization");

    record_startup_stage(
        startup,
        if migrations_complete {
            "version-initialization-complete"
        } else {
            "version-initialization-deferred"
        },
    );
    Ok(())
}

fn prepare_notebook_selection(
    initial_notebooks: &[flowix_core::memo_file::NotebookConfig],
    memo_file: &Arc<RwLock<flowix_core::memo_file::MemoFile>>,
    startup: &crate::app::startup::StartupCoordinator,
) -> Result<(), String> {
    startup.mark_running(crate::app::startup::StartupStage::WorkspacePreparation, "preparingData");
    // Resolve identity solely from local metadata. Probing every external disk
    // or attached repository does not belong on the shell's critical path.
    let persisted = crate::lock_utils::read_lock(memo_file, "memo_file")
        .read_selected_notebook_id().map_err(|error| error.to_string())?;
    let selected = persisted.as_deref().and_then(|id| initial_notebooks.iter().find(|n| n.id == id))
        .or_else(|| initial_notebooks.first()).map(|n| n.id.clone());
    let mut memo = memo_file.write().unwrap_or_else(|p| p.into_inner());
    memo.set_current_notebook(selected.clone());
    if persisted != selected {
        memo.write_selected_notebook_id(selected.as_deref()).map_err(|error| error.to_string())?;
    }
    record_startup_stage(startup, "selected-notebook-resolved");
    Ok(())
}

fn start_post_startup_services(
    app: tauri::AppHandle,
    external_runtimes: Arc<ExternalRuntimeRegistry>,
) {
    spawn_external_agent_watchdog(app, external_runtimes);
}

fn handle_second_instance(app: &tauri::AppHandle, args: Vec<String>) {
    // Normalize argv before routing native files and protocol callbacks.
    let app = app.clone();
    // Launch Services starts a short-lived second process for a protocol URL.
    // Bring the already-running window forward before waiting for app startup
    // or parsing the URL, so even a malformed/stale callback cannot leave the
    // browser's transient launch as the only visible activation.
    open_targets::focus_main_window(&app);
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = app.state::<AppState>().startup.wait_until_ready() {
            tracing::warn!("second-instance target deferred because startup failed: {error}");
            return;
        }
        let targets = open_targets::command_line_targets(args).into_iter()
            .filter(|arg| !dispatch_google_callback(&app, arg)).collect();
        open_targets::dispatch(&app, targets, "second-instance");
    });
}

#[cfg(desktop)]
fn dispatch_google_callback(app: &tauri::AppHandle, raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    let expected_scheme = if option_env!("FLOWIX_DEV_MODE") == Some("1") {
        "flowix-dev"
    } else {
        "flowix"
    };
    if url.scheme() != expected_scheme
        || url.host_str() != Some("auth")
        || url.path() != "/google/callback"
    {
        return false;
    }
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
    let callback = match (auth_error, code, oauth_state) {
        (Some(error), _, Some(state)) => {
            Some(commands::cloud::GoogleCallback::Failure { error, state })
        }
        (None, Some(code), Some(state)) => {
            Some(commands::cloud::GoogleCallback::Success { code, state })
        }
        _ => None,
    };
    if let Some(callback) = callback {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) =
                commands::cloud::complete_google_deep_link(app.clone(), callback).await
            {
                let _ = app.emit("cloud-google-auth-error", error);
            }
        });
    }
    true
}

#[cfg(desktop)]
fn register_deep_links(app: &mut tauri::App) {
    use tauri_plugin_deep_link::DeepLinkExt;

    let callback_scheme = if option_env!("FLOWIX_DEV_MODE") == Some("1") {
        "flowix-dev"
    } else {
        "flowix"
    };
    // Bundled app metadata owns registration on macOS; runtime registration
    // remains useful on platforms where the deep-link plugin supports it.
    let _ = app.deep_link().register(callback_scheme);

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
        open_targets::focus_main_window(&app);
        let startup = startup.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = startup.wait_until_ready() {
                tracing::warn!("deep-link target deferred because startup failed: {error}");
                return;
            }
            let targets = urls.into_iter()
                .filter(|url| !dispatch_google_callback(&app, url)).collect();
            open_targets::dispatch(&app, targets, "deep-link");
        });
    });
}

#[cfg(not(desktop))]
fn register_deep_links(_app: &mut tauri::App) {}

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
            commands::document_operations::forget_window(&label);
            app.state::<AppState>().export_access.revoke(&label);
            app.state::<AppState>().document_access.revoke(&label);
            app.state::<AppState>().upload_sessions.revoke(&label);
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Opened { urls } => {
            if commands::window_shutdown::is_exiting() { return; }
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(error) = app.state::<AppState>().startup.wait_until_ready() {
                    tracing::warn!("macOS open target deferred because startup failed: {error}");
                    return;
                }
                let paths = urls.into_iter().filter(|url| url.scheme() == "file")
                    .filter_map(|url| url.to_file_path().ok())
                    .map(|path| path.to_string_lossy().into_owned()).collect();
                open_targets::dispatch(&app, paths, "macos-opened");
            });
        }
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            if !commands::window_shutdown::request_exit(app, code.unwrap_or(0)) {
                api.prevent_exit();
                return;
            }
            static CLEANUP_STARTED: AtomicBool = AtomicBool::new(false);
            static CLEANUP_DONE: AtomicBool = AtomicBool::new(false);
            if !CLEANUP_DONE.load(Ordering::Acquire) {
                api.prevent_exit();
                if !CLEANUP_STARTED.swap(true, Ordering::AcqRel) {
                    let app = app.clone();
                    std::thread::spawn(move || {
                        // Run once off the UI thread. A blocked lock, panic or
                        // checkpoint cannot outlive the independent watchdog.
                        app.state::<AppState>().notebook_background.stop();
                        app.state::<AppState>().watcher_retry_stop.store(true, Ordering::Release);
                        stop_external_agent_children(&app, "exit");
                        checkpoint_thread_database(&app, "exit");
                        CLEANUP_DONE.store(true, Ordering::Release);
                        app.exit(code.unwrap_or(0));
                    });
                }
            }
        }
        _ => {}
    }
}

fn checkpoint_thread_database(app: &tauri::AppHandle, phase: &str) {
    let state = app.state::<AppState>();
    tracing::debug!("running shutdown maintenance: {phase}");
    crate::maintenance::run_shutdown_maintenance(&state.thread_manager);
}

/// Called on a blocking worker after the updater's document-save handshake.
/// The updater exits through std::process::exit and will not emit RunEvent::Exit.
#[cfg(windows)]
pub(crate) fn prepare_for_update(app: &tauri::AppHandle) -> UpdateRuntimeGuard {
    // Construct before cleanup so unwinding also restores admission. This guard
    // stays on the same worker through cleanup and installer launch.
    let state = app.state::<AppState>();
    state.notebook_background.pause();
    let guard = UpdateRuntimeGuard { pi: state.pi.clone(), background: state.notebook_background.clone() };
    stop_external_agent_children(app, "update");
    checkpoint_thread_database(app, "update");
    guard
}

#[cfg(windows)]
pub(crate) struct UpdateRuntimeGuard {
    pi: Arc<PiRpcManager>,
    background: Arc<crate::app::notebook_background::NotebookBackground>,
}

#[cfg(windows)]
impl Drop for UpdateRuntimeGuard {
    fn drop(&mut self) {
        self.pi.resume_after_failed_update();
        self.background.resume();
    }
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
                        .map(|result| format!("{}={}", result.runtime.id(), result.affected))
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

#[cfg(test)]
mod missing_dependency_tests {
    use super::*;
    use crate::app::startup::{StartupCoordinator, StartupStage};

    fn prepare_storage(
        config: &Path,
        user: Arc<user_config::UserConfigStore>,
        device: &crate::device_registration::DeviceRegistry,
        memo: &Arc<RwLock<flowix_core::memo_file::MemoFile>>,
        startup: &StartupCoordinator,
    ) -> Result<(), String> {
        let threads = ThreadManager::new_uninitialized(config.join("db/thread.db")).unwrap();
        let sync = flowix_sync::SyncManager::new_with_session_dependencies_deferred(
            flowix_sync::CloudEnvironment::Prod.api_base(),
            config.join("db/sync.db"),
            user.clone(),
            Arc::new(|_| {}),
        )
        .unwrap();
        prepare_startup_storage(device, memo, &threads, &sync, &user, config, startup)
    }

    #[test]
    fn initialization_marker_write_failure_does_not_block_fresh_runtime() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().to_path_buf();
        let config = get_user_config_dir(&home);
        let user = Arc::new(user_config::UserConfigStore::new(home));
        let device = crate::device_registration::DeviceRegistry::load(&config, "test");
        let marker = config.join("boot/boot.json");
        if marker.is_file() {
            std::fs::remove_file(&marker).unwrap();
        }
        std::fs::create_dir_all(&marker).unwrap();
        let memo = Arc::new(RwLock::new(flowix_core::memo_file::MemoFile::new(
            config.clone(),
        )));
        let threads = ThreadManager::new_uninitialized(config.join("db/thread.db")).unwrap();
        let startup = StartupCoordinator::new();
        prepare_storage(&config, user.clone(), &device, &memo, &startup).unwrap();
        assert!(!config.join("db/local.db").exists());
        prepare_runtime_storage(&memo, &threads, &user, &startup);
        assert!(memo
            .read()
            .unwrap()
            .read_notebook_configs()
            .unwrap()
            .is_empty());
        user.initialize_current_runtime_storage().unwrap();
    }

    #[test]
    fn unavailable_property_data_uses_defaults_without_deleting_shared_rows() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().to_path_buf();
        let config = get_user_config_dir(&home);
        let user = user_config::UserConfigStore::new(home);
        let memo = Arc::new(RwLock::new(flowix_core::memo_file::MemoFile::new(config.clone())));
        memo.read().unwrap().initialize_registry_storage().unwrap();
        user.initialize_current_runtime_storage().unwrap();
        let connection = rusqlite::Connection::open(config.join("db/local.db")).unwrap();
        connection.execute_batch("INSERT INTO notebooks(id,name,path,is_default,created_at,updated_at) VALUES ('keep','Keep','/tmp/keep',1,1,1); INSERT INTO property_presets(scope,id,property_key,property_type,revision,updated_at) VALUES ('user','fld_bad','custom','Text','invalid',1);").unwrap();
        let threads = ThreadManager::new_uninitialized(config.join("db/thread.db")).unwrap();
        prepare_runtime_storage(&memo, &threads, &user, &StartupCoordinator::new());
        assert_eq!(memo.read().unwrap().read_notebook_configs().unwrap()[0].id,"keep");
        let defaults = user.get_property_presets().unwrap();
        assert!(defaults.system_fields.iter().any(|field| field.key == "status"));
        assert_eq!(connection.query_row("SELECT revision FROM property_presets WHERE id='fld_bad'",[],|row|row.get::<_,String>(0)).unwrap(),"invalid");
        assert!(!config.join("db/rebuild-backups").exists());
    }

    #[test]
    fn broken_property_schema_preserves_existing_notebook_registry() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().to_path_buf();
        let config = get_user_config_dir(&home);
        let user = user_config::UserConfigStore::new(home);
        let memo = Arc::new(RwLock::new(flowix_core::memo_file::MemoFile::new(
            config.clone(),
        )));
        memo.read().unwrap().initialize_registry_storage().unwrap();
        let connection = rusqlite::Connection::open(config.join("db/local.db")).unwrap();
        connection.execute_batch("INSERT INTO notebooks(id,name,path,is_default,created_at,updated_at) VALUES ('keep','Keep','/tmp/keep',1,11,22);").unwrap();
        let before = serde_json::to_value(memo.read().unwrap().read_notebook_configs().unwrap()).unwrap();
        connection
            .execute_batch("CREATE TABLE property_presets (bad TEXT);")
            .unwrap();
        drop(connection);
        let threads = ThreadManager::new_uninitialized(config.join("db/thread.db")).unwrap();
        let startup = StartupCoordinator::new();
        prepare_runtime_storage(&memo, &threads, &user, &startup);
        assert_eq!(serde_json::to_value(memo.read().unwrap().read_notebook_configs().unwrap()).unwrap(), before);
        user.initialize_current_runtime_storage().unwrap();
        assert!(!config.join("db/rebuild-backups").exists());
    }

    #[test]
    fn completed_version_skips_legacy_jobs_despite_old_settings_and_offline_notebooks() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().to_path_buf();
        let config = get_user_config_dir(&home);
        let user = user_config::UserConfigStore::new(home.clone());
        let mut preference = user.get_preference();
        preference.watcher.skip_dirs.push("legacy".into());
        preference.watcher.skip_files.push("*.tmp".into());
        user.set_preference(preference).unwrap();
        let device = crate::device_registration::DeviceRegistry::load(&config, "test");
        device.set_version_initialization_completed(true).unwrap();
        // An older installation can have a completed version but no reset flag.
        assert_eq!(device.notebook_storage_reset_version(), 0);
        let boot_before = std::fs::read(config.join("boot/boot.json")).unwrap();
        let memo = flowix_core::memo_file::MemoFile::new(config.clone());
        memo.initialize_registry_storage().unwrap();
        memo.mark_local_migration_completed("config_watcher_exclusions_v1")
            .unwrap();
        let root = home.join("notebook");
        std::fs::create_dir_all(root.join(".flowix")).unwrap();
        let preferences_path = root.join(".flowix/view-preferences.json");
        let custom_preferences = b"{\"default_create_folder\":\"custom\"}";
        std::fs::write(&preferences_path, custom_preferences).unwrap();
        let notebooks: Vec<_> = [("online", root), ("offline", home.join("unavailable"))]
            .into_iter()
            .map(|(id, path)| flowix_core::memo_file::NotebookConfig {
                id: id.into(),
                name: id.into(),
                icon: None,
                path: path.to_string_lossy().into_owned(),
                is_default: false,
                sort: 0,
                created_at: 0,
                updated_at: 0,
            })
            .collect();
        memo.write_notebook_configs(&notebooks).unwrap();
        assert!(memo.has_pending_notebook_storage_initialization().unwrap());
        drop(memo);

        // Reload all state as two independent launches would do.
        for _ in 0..2 {
            let user = Arc::new(user_config::UserConfigStore::new(home.clone()));
            let device = crate::device_registration::DeviceRegistry::load(&config, "test");
            let memo = Arc::new(RwLock::new(flowix_core::memo_file::MemoFile::new(
                config.clone(),
            )));
            let startup = StartupCoordinator::new();
            prepare_storage(&config, user.clone(), &device, &memo, &startup).unwrap();
            assert_eq!(startup.status().stage, StartupStage::WorkspacePreparation);
            assert!(startup.status().progress.is_none());
            assert!(!user.has_legacy_watcher_exclusions());
            assert!(device.is_version_initialization_complete());
            assert_eq!(
                std::fs::read(config.join("boot/boot.json")).unwrap(),
                boot_before
            );
            // Stage 2 must not replay resets or fabricate legacy job completion.
            assert!(memo
                .read()
                .unwrap()
                .has_pending_notebook_storage_initialization()
                .unwrap());
            assert_eq!(
                std::fs::read(&preferences_path).unwrap(),
                custom_preferences
            );
        }
    }

    #[test]
    fn stage_two_uses_watcher_defaults_without_persisting_configuration() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().to_path_buf();
        let config = get_user_config_dir(&home);
        let user = Arc::new(user_config::UserConfigStore::new(home));
        let mut preference = user.get_preference();
        preference.watcher.skip_files.push("*.tmp".into());
        user.set_preference(preference).unwrap();
        // A directory at the file path gives a deterministic I/O failure on
        // Windows, macOS and Linux, without relying on Unix permission bits.
        let path = config.join("boot/preference.json");
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        let device = crate::device_registration::DeviceRegistry::load(&config, "test");
        device.set_version_initialization_completed(true).unwrap();
        let memo = Arc::new(RwLock::new(flowix_core::memo_file::MemoFile::new(
            config.clone(),
        )));
        memo.read().unwrap().initialize_registry_storage().unwrap();
        let startup = StartupCoordinator::new();
        for _ in 0..2 {
            prepare_storage(&config, user.clone(), &device, &memo, &startup).unwrap();
            assert_eq!(startup.status().stage, StartupStage::WorkspacePreparation);
            assert!(startup.status().progress.is_none());
            assert!(!user.has_legacy_watcher_exclusions());
            assert!(path.is_dir());
            assert!(
                crate::device_registration::DeviceRegistry::load(&config, "test")
                    .is_version_initialization_complete()
            );
        }
    }

    #[test]
    fn new_version_initializes_once_then_prepares_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().to_path_buf();
        let config = get_user_config_dir(&home);
        let user = Arc::new(user_config::UserConfigStore::new(home));
        let old = crate::device_registration::DeviceRegistry::load(&config, "old");
        old.set_version_initialization_completed(true).unwrap();
        let current = crate::device_registration::DeviceRegistry::load(&config, "current");
        let memo = Arc::new(RwLock::new(flowix_core::memo_file::MemoFile::new(
            config.clone(),
        )));
        memo.read().unwrap().initialize_registry_storage().unwrap();
        std::fs::write(config.join("index.db"), b"retired root database").unwrap();
        std::fs::create_dir_all(config.join("db")).unwrap();
        std::fs::write(config.join("db/index.db"), b"retired canonical database").unwrap();
        let startup = StartupCoordinator::new();
        prepare_storage(&config, user.clone(), &current, &memo, &startup).unwrap();
        assert_eq!(
            std::fs::read(config.join("index.db")).unwrap(),
            b"retired root database"
        );
        assert_eq!(
            std::fs::read(config.join("db/index.db")).unwrap(),
            b"retired canonical database"
        );
        assert_eq!(startup.status().stage, StartupStage::Initialization);
        assert_eq!(startup.status().progress.unwrap().percent, 100);
        let reloaded = crate::device_registration::DeviceRegistry::load(&config, "current");
        assert!(reloaded.is_version_initialization_complete());
        let startup = StartupCoordinator::new();
        prepare_storage(&config, user, &reloaded, &memo, &startup).unwrap();
        assert_eq!(startup.status().stage, StartupStage::WorkspacePreparation);
        assert!(startup.status().progress.is_none());
    }

    #[test]
    fn optional_notebook_migration_failure_allows_startup_and_retries_next_launch() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().to_path_buf();
        let config = get_user_config_dir(&home);
        let user = Arc::new(user_config::UserConfigStore::new(home.clone()));
        let device = crate::device_registration::DeviceRegistry::load(&config, "test");
        let memo = Arc::new(RwLock::new(flowix_core::memo_file::MemoFile::new(
            config.clone(),
        )));
        memo.read().unwrap().initialize_registry_storage().unwrap();
        let root = home.join("notes");
        let unknown = root.join(".flowix/artifacts/unknown");
        std::fs::create_dir_all(&unknown).unwrap();
        std::fs::write(unknown.join("retained.bin"), b"unknown artifact").unwrap();
        let notebook = flowix_core::memo_file::NotebookConfig {
            id: "keep".into(),
            name: "Original".into(),
            path: root.to_string_lossy().into_owned(),
            icon: Some("icon".into()),
            is_default: true,
            sort: 30,
            created_at: 123,
            updated_at: 456,
        };
        memo.read()
            .unwrap()
            .write_notebook_configs(&[notebook.clone()])
            .unwrap();
        for _ in 0..2 {
            let startup = StartupCoordinator::new();
            prepare_storage(&config, user.clone(), &device, &memo, &startup).unwrap();
            assert!(!device.is_version_initialization_complete());
            let key =
                flowix_core::memo_file::NotebookInitializationJob::ResetLegacyStorage.key("keep");
            assert!(!memo
                .read()
                .unwrap()
                .local_migration_completed(&key)
                .unwrap());
            let rows = memo.read().unwrap().read_notebook_configs().unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].id, "keep");
            assert_eq!(rows[0].name, "Original");
            assert_eq!(rows[0].path, notebook.path);
            assert_eq!(rows[0].sort, 30);
            assert!(unknown.join("retained.bin").exists());
        }
        // Resolve the source conflict; the deferred job can finish on the next launch.
        std::fs::remove_dir_all(&unknown).unwrap();
        let startup = StartupCoordinator::new();
        prepare_storage(&config, user, &device, &memo, &startup).unwrap();
        assert!(device.is_version_initialization_complete());
        assert_eq!(
            memo.read().unwrap().read_notebook_configs().unwrap()[0].id,
            "keep"
        );
    }

    #[test]
    fn corrupt_registry_is_preserved_and_startup_continues() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().to_path_buf();
        let config = get_user_config_dir(&home);
        let user = Arc::new(user_config::UserConfigStore::new(home));
        let device = crate::device_registration::DeviceRegistry::load(&config, "test");
        device.set_version_initialization_completed(true).unwrap();
        device.complete_notebook_storage_reset_version(1).unwrap();
        std::fs::create_dir_all(config.join("db")).unwrap();
        for name in ["local.db", "thread.db", "sync.db"] {
            std::fs::write(config.join("db").join(name), b"invalid database").unwrap();
        }
        let threads = ThreadManager::new_uninitialized(config.join("db/thread.db")).unwrap();
        let sync = flowix_sync::SyncManager::new_with_session_dependencies_deferred(
            flowix_sync::CloudEnvironment::Prod.api_base(),
            config.join("db/sync.db"),
            user.clone(),
            Arc::new(|_| {}),
        )
        .unwrap();
        let memo = Arc::new(RwLock::new(flowix_core::memo_file::MemoFile::new(
            config.clone(),
        )));
        let startup = StartupCoordinator::new();
        assert!(
            prepare_startup_storage(&device, &memo, &threads, &sync, &user, &config, &startup)
                .is_ok()
        );
        assert_eq!(std::fs::read(config.join("db/local.db")).unwrap(), b"invalid database");
        prepare_runtime_storage(&memo, &threads, &user, &startup);
        assert!(config.join("db/rebuild-backups").is_dir());
        assert!(memo.read().unwrap().read_notebook_configs().unwrap().is_empty());
        assert_eq!(
            std::fs::read(config.join("db/sync.db")).unwrap(),
            b"invalid database"
        );
    }

    #[test]
    fn missing_registry_is_created_on_demand_with_completed_boot_marker() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().to_path_buf();
        let config_dir = get_user_config_dir(&home);
        let user_config = Arc::new(user_config::UserConfigStore::new(home));
        let device = crate::device_registration::DeviceRegistry::load(&config_dir, "test");
        device.set_version_initialization_completed(true).unwrap();
        device.complete_notebook_storage_reset_version(1).unwrap();
        let memo = Arc::new(RwLock::new(flowix_core::memo_file::MemoFile::new(
            config_dir.clone(),
        )));
        memo.read().unwrap().initialize_registry_storage().unwrap();
        user_config.ensure_runtime_storage().unwrap();
        std::fs::remove_dir_all(config_dir.join("db")).unwrap();
        let threads = ThreadManager::new_in_memory().unwrap();
        let sync = flowix_sync::SyncManager::new_with_session_dependencies_deferred(
            flowix_sync::CloudEnvironment::Prod.api_base(),
            temp.path().join("sync.db"),
            user_config.clone(),
            Arc::new(|_| {}),
        )
        .unwrap();
        let startup = crate::app::startup::StartupCoordinator::new();
        assert!(prepare_startup_storage(
            &device,
            &memo,
            &threads,
            &sync,
            &user_config,
            &config_dir,
            &startup,
        )
        .is_ok());
        assert!(device.is_version_initialization_complete());
        assert!(!config_dir.join("db/local.db").exists());
        prepare_runtime_storage(&memo, &threads, &user_config, &startup);
        assert!(memo.read().unwrap().read_notebook_configs().unwrap().is_empty());
    }
}
