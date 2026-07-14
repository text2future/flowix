use crate::agent::AgentManager;
use crate::app::panic::install_panic_log_hook;
use crate::app::paths::{get_app_data_path, get_user_config_dir};
use crate::app::watchdog::spawn_external_agent_watchdog;
use crate::cli_link;
use crate::commands;
use crate::config::user as user_config;
use crate::config::AgentAccessStore;
use crate::config::SecurityBookmarkStore;
use crate::external_runtime::claude::ClaudeCliManager;
use crate::external_runtime::codex::CodexCliManager;
use crate::external_runtime::hermes::HermesCliManager;
use crate::external_runtime::simple_cli;
use crate::fs_watcher;
use crate::open_target;
use crate::runtime_log;
use crate::session::ThreadManager;
use crate::system_data::SystemData;
use crate::watcher::dispatcher;
use flowix_core::search::{BigramTokenizer, MemoIndex};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use tauri::{Listener, Manager};

pub fn run() {
    install_panic_log_hook();

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

    // 启动时在 `~/.local/bin/flowix-cli` 建一个 symlink。详情见
    // `cli_link` 模块: 幂等 (每次启动都跑, 已存在就不动), 失败只 warn
    // 不阻塞 GUI 启动, 范围 macOS + Linux (cfg(unix))。
    cli_link::ensure_cli_symlink();

    let user_config_dir = get_user_config_dir(&home_dir);
    std::fs::create_dir_all(&user_config_dir).ok();
    let thread_db_path = user_config_dir.join("thread.db");
    let user_config = Arc::new(user_config::UserConfigStore::new(home_dir.clone()));

    // 笔记本注册表真源走 ~/.flowix/index.db (SQLite); `MemoFile::open_index_db`
    // 首次被读时建表。 这里不需要任何磁盘迁移 ── 旧 `notebook.json` 路径已废。
    let memo_file = flowix_core::memo_file::MemoFile::new(user_config_dir.clone());

    // System metadata goes under ~/.flowix/boot/system.json.
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

    // 三个需要与 AgentManager 共享的依赖, 提前建好 Arc 再 clone。
    // refcount 期望: user_config=2 (AppState + AgentManager), thread_manager=2,
    // memo_file=2 ── 见 `commands.rs::AppState` 注释。
    let memo_file_arc = Arc::new(RwLock::new(memo_file));
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
    let thread_manager_arc = Arc::new(tokio::sync::RwLock::new(thread_manager));
    // 启动时一次性清理孤儿 is_loading=1 行 ── 解决"上次进程在 tool_use
    // 落盘后被 SIGKILL / 强退, 下次启动看到转圈卡死工具行"的问题。 详见
    // `ThreadManager::clear_all_loading` 注释。`run()` 此时还在 tauri
    // runtime 起来之前, 不能 `.await`, 所以是同步方法 (内部单条
    // UPDATE, 没有真实异步工作)。读锁足够: clear 只走 UPDATE, 不会
    // 与正常 add_message / update_tool_result 冲突 (后者写同一行的 0,
    // 后到写后赢, 两条路径殊途同归)。
    {
        let manager = thread_manager_arc.blocking_read();
        match manager.clear_all_loading() {
            Ok(0) => tracing::debug!("[Startup] no orphan is_loading=1 rows"),
            Ok(n) => tracing::info!("[Startup] cleared {n} orphan is_loading=1 rows"),
            Err(e) => tracing::warn!("[Startup] clear_all_loading failed: {e}"),
        }
    }
    let user_config_arc = user_config.clone();
    crate::external_runtime::binary::configure_custom_agent_locations(
        &user_config_arc.get_preference().agents,
    );

    // Agent 可访问目录 store ── 必须在 notebook registry 与 `memo_file_arc`
    // 都就绪之后构造 (新 store 会读 notebook registry 播种 + 对账)。
    let security_bookmarks_arc = Arc::new(SecurityBookmarkStore::new(user_config_dir.clone()));
    let agent_access_arc = Arc::new(AgentAccessStore::new(
        user_config_dir.clone(),
        &*crate::lock_utils::read_lock(&memo_file_arc, "memo_file"),
    ));

    // ──────────────────────────────────────────────────────────────────
    // Skills ── `~/.flowix/skills/` 单根, 扫描两个区域:
    //   1. `.system/<name>/SKILL.md`  系统内置 (从 bundle 一次性 seed)
    //   2. `<name>/SKILL.md`          用户自添加
    //
    // 流程: 创建用户目录 → seed-once (从 bundle 拷一份到 .system/) → 默认
    // 给 agent-access.json 加一条 Folder entry (id=`fld_skills_auto`) →
    // 扫描整个根目录 → 构造 SkillStore → 与 AppState / AgentManager 共享
    // ── SkillStore 启动后不可变, Arc 共享, 无需 RwLock。
    // ──────────────────────────────────────────────────────────────────
    let skills_root = user_config_dir.join("skills");
    if let Err(e) = std::fs::create_dir_all(&skills_root) {
        tracing::warn!(
            "[startup] failed to create skills root {}: {e}",
            skills_root.display()
        );
    }

    // Seed-once: bundled `resources/skills/.system/*` → `~/.flowix/skills/.system/*`.
    // 三个候选路径, 命中第一个可用的就停 ── 见
    // `crate::skills::scanner::resolve_bundled_root`。
    if let Some(bundled) = crate::skills::scanner::resolve_bundled_root() {
        let report = crate::skills::seed_system_skills(&bundled, &skills_root);
        if !report.copied.is_empty() || !report.skipped.is_empty() {
            tracing::info!(
                "[startup] skills seed: copied {}, skipped {} (already present)",
                report.copied.len(),
                report.skipped.len()
            );
        }
    } else {
        tracing::debug!(
            "[startup] no bundled skills found; user can drop SKILL.md into ~/.flowix/skills/"
        );
    }

    // 默认给 Agent `~/.flowix/skills/` 的读权限 ── LLM 可以直接 `read` / `grep`
    // 任意 SKILL.md, 不必先调 `load_skill`。
    agent_access_arc.ensure_skill_folder(&skills_root);

    let skill_store = Arc::new(crate::skills::SkillStore::load(&skills_root));
    tracing::info!(
        "[startup] loaded {} skill(s) from {}",
        skill_store.len(),
        skill_store.root().display()
    );

    // PR2: 监听 user-config-changed 热更新 whitelist 时, 也需要 user_config_arc,
    // 单独 clone 一份 (后续会被 move 进 AgentManager::new)。
    let user_config_for_watcher = user_config_arc.clone();

    // AppState 在 `.setup()` 闭包里构造 ── 这样 spawn 完 sidecar 后能用
    // 真实 handle 填进 `flowix_cli` 字段, 而不是塞 placeholder。Tauri 2 的
    // `.manage(state)` 是"一次性"语义, 不能 mutate 已注册的状态。
    //
    // 这里把构造 AppState 需要的子结构 clone 出来 (闭包 `move` 捕获),
    // 同时把另一份 clone 喂给 sub-component 构造函数。
    let user_config_for_state = user_config_arc.clone();
    let memo_file_for_state = memo_file_arc.clone();
    let agent_access_for_state = agent_access_arc.clone();
    let security_bookmarks_for_state = security_bookmarks_arc.clone();
    let thread_manager_for_state = thread_manager_arc.clone();
    // 启动设备登记模块 ── 和上面同样的 prep 模式: clone 进 setup 闭包。
    let user_config_dir_for_device = user_config_dir.clone();
    // `system_data` 没 impl Clone ── 直接 move 进 setup 闭包, 那里
    // move 进 AppState。

    let search_init = RwLock::new(MemoIndex::new(Arc::new(BigramTokenizer)));
    let agent_manager = Arc::new(AgentManager::new(
        user_config_arc,
        thread_manager_arc.clone(),
        memo_file_arc.clone(),
        agent_access_arc.clone(),
        security_bookmarks_arc.clone(),
        skill_store,
    ));
    let codex_cli_manager = Arc::new(CodexCliManager::new(thread_manager_arc.clone()));
    let claude_cli_manager = Arc::new(ClaudeCliManager::new(thread_manager_arc.clone()));
    let gemini_cli_manager = Arc::new(simple_cli::SimpleCliManager::new(
        simple_cli::SimpleCliKind::Gemini,
        thread_manager_arc.clone(),
    ));
    let hermes_cli_manager = Arc::new(HermesCliManager::new(thread_manager_arc.clone()));
    let openclaw_cli_manager = Arc::new(simple_cli::SimpleCliManager::new(
        simple_cli::SimpleCliKind::OpenClaw,
        thread_manager_arc.clone(),
    ));

    // 笔记本目录文件监听器 — 把外部编辑器 / 其他 AI 对任意已注册 notebook
    // 的磁盘变更转成 `memo-event` 推前端。`AppHandle` 在 `run()` 阶段拿不到,
    // 实际绑定在 .setup() 闭包里完成。
    let memo_watcher = Arc::new(RwLock::new(fs_watcher::MemoWatcher::new(
        memo_file_arc.clone(),
    )));

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            handle_second_instance(app, args);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_process::init())
        .manage(memo_watcher.clone())
        .setup(move |app| {
            // ── 0) 启动设备登记 / last_seen 刷新 ─────────────────────
            //   不阻塞: spawn 一个 fire-and-forget tokio 任务, 自己内部
            //   先 sleep 10s 再 POST, 与产品更新 7s 检查错开。远端按
            //   `device_id` upsert, 首次插入, 后续启动刷新 last_seen_at。
            let app_version = app.package_info().version.to_string();
            let device_registry = Arc::new(crate::device_registration::DeviceRegistry::load(
                &user_config_dir_for_device,
                app_version,
            ));
            device_registry.clone().spawn_startup_registration();

            // ── 1) 构造 AppState (placeholder 状态) 并 manage ──
            //    `flowix_cli` 字段是 `RwLock<Option<Arc<SidecarHandle>>>`,
            //    spawn 完 sidecar 后在末尾 `write().await = Some(handle)` 升级。
            let app_state = commands::AppState {
                user_config: user_config_for_state.clone(),
                system_data,
                memo_file: memo_file_for_state.clone(),
                search: search_init,
                agent_manager: agent_manager.clone(),
                codex_cli_manager: codex_cli_manager.clone(),
                claude_cli_manager: claude_cli_manager.clone(),
                gemini_cli_manager: gemini_cli_manager.clone(),
                hermes_cli_manager: hermes_cli_manager.clone(),
                openclaw_cli_manager: openclaw_cli_manager.clone(),
                thread_manager: thread_manager_for_state.clone(),
                agent_access: agent_access_for_state.clone(),
                security_bookmarks: security_bookmarks_for_state.clone(),
                flowix_cli: Arc::new(tokio::sync::RwLock::new(None)),
            };
            app.manage(app_state);
            spawn_external_agent_watchdog(
                app.handle().clone(),
                codex_cli_manager.clone(),
                claude_cli_manager.clone(),
            );

            if let Some(window) = app.get_webview_window("main") {
                crate::window_chrome::apply_window_border_color(&window);
            }

            // PR3: 在 setup 阶段 manage dispatcher, 因为
            // TauriDispatcher::new 需要 AppHandle, builder chain 里拿不到。
            let dispatcher: crate::watcher::dispatcher::SharedDispatcher = std::sync::Arc::new(
                crate::watcher::dispatcher::TauriDispatcher::new(app.handle().clone()),
            );
            app.manage(dispatcher);
            // 启动时只监听当前 notebook。未选择 current notebook 时不绑定任何
            // 根目录, 避免后台 stat/watch macOS 受保护目录触发权限弹窗。
            let initial_notebooks = {
                let memo_file = crate::lock_utils::read_lock(&memo_file_arc, "memo_file");
                memo_file
                    .current_notebook_id_value()
                    .and_then(|id| memo_file.get_notebook_config_by_id(&id))
                    .into_iter()
                    .collect()
            };
            memo_watcher
                .write()
                .unwrap_or_else(|poisoned| {
                    tracing::error!("memo_watcher write lock poisoned, recovering");
                    poisoned.into_inner()
                })
                .rebind_all(app.handle().clone(), initial_notebooks);

            // 只在已有 current notebook 时做启动对账。 current=None 时
            // `MemoFile` 会回退到默认 notebook 路径, 在 macOS 上可能触发
            // Documents 权限弹窗。
            let should_reconcile = crate::lock_utils::read_lock(&memo_file_arc, "memo_file")
                .current_notebook_id_value()
                .is_some();
            if should_reconcile {
                match memo_file_arc
                    .read()
                    .unwrap_or_else(|poisoned| {
                        tracing::error!("memo_file read lock poisoned, recovering");
                        poisoned.into_inner()
                    })
                    .reconcile_with_disk_bidirectional()
                {
                    Ok(report) if report.added > 0 || report.removed > 0 => {
                        runtime_log::record_event(
                            "info",
                            "startup.reconcile",
                            format!(
                                "reconcile added={}, removed={}",
                                report.added, report.removed
                            ),
                        );
                        tracing::info!(
                            "[startup] reconcile: +{} added, -{} removed",
                            report.added,
                            report.removed
                        );
                    }
                    Ok(_) => tracing::debug!("[startup] reconcile: no-op"),
                    Err(e) => {
                        runtime_log::record_event(
                            "error",
                            "startup.reconcile_failed",
                            format!("startup reconcile failed: {e}"),
                        );
                        tracing::warn!("[startup] reconcile failed: {e}");
                    }
                }
            }

            // PR2: 启动时把 preference.json::watcher 应用到 MemoWatcher;
            // 同时注册 user-config-changed 监听做热更新 (前端调
            // update_watcher_config IPC 走 settings::update_watcher_config
            // 写后 emit 该事件, 这里收到就 set_whitelist)。
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
                    // payload 是 kind 字符串 ("preference" / "ai_config" / "watcher")
                    // ── ai_config 走 ~/.flowix/agent-config.toml (TOML), 其余走 JSON
                    let kind = event.payload();
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
                });
            }

            register_deep_links(app);
            handle_cold_start_open_targets(app.handle());

            // release 构建不包含此分支。 用户随时可用 F12 / Ctrl+Shift+I 切换。

            // ── spawn flowix-cli sidecar ──
            // 必须放 setup 末尾, 此时 AppState 已经 manage, IPC 调用方可以
            // 拿到 (虽然还没填 handle ── 失败时返 "not yet spawned" 错)。
            spawn_cli_sidecar(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 偏好 (JSON, 走 user_config)
            commands::product::get_product_info,
            commands::product::get_diagnostics,
            commands::product::check_product_update_notice,
            commands::product::open_log_dir,
            commands::settings::get_preference,
            commands::settings::set_preference,
            commands::settings::get_ai_config,
            commands::settings::set_ai_config,
            commands::settings::test_ai_connection,
            commands::settings::get_watcher_config,
            commands::settings::update_watcher_config,
            // agent 可访问目录 (JSON, 走 agent_access)
            commands::agent_access::get_agent_access,
            commands::agent_access::set_agent_access,
            // System metadata (JSON, ~/.flowix/boot/system.json)
            commands::kv::get_tag_system_metadata,
            commands::kv::set_tag_system_layout,
            commands::kv::set_tag_system_hidden,
            // 笔记 / Doc ── 按 commands/memo/{reads,creates,versions,deletes}.rs
            // 子模块路径取, 不走 `commands::memo::xxx` 顶层 re-export ──
            // `#[tauri::command]` 宏生成的 `__cmd__xxx` wrapper 是函数所在
            // 模块的同级 macro, 只能在该模块路径 (`commands::memo::reads::xxx`)
            // 解析到. `commands::memo::xxx` 顶层路径不传递 macro re-export.
            commands::memo::reads::get_memos,
            commands::memo::reads::search_mention_notes,
            commands::memo::reads::list_agent_role_memos,
            commands::memo::reads::get_used_memo_tag_ids,
            commands::memo::reads::get_memo_todo_metadata,
            commands::memo::reads::get_memo_todo_count,
            commands::memo::reads::read_memo,
            commands::memo::reads::read_document,
            commands::memo::reads::write_document,
            commands::memo::reads::get_launch_open_files,
            commands::memo::reads::search_memos,
            commands::memo::creates::add_document,
            commands::memo::creates::import_external_document_to_memo,
            commands::memo::creates::update_memo_db,
            commands::memo::creates::finalize_memo_filename,
            commands::memo::creates::favorite_memo,
            commands::memo::creates::unfavorite_memo,
            commands::memo::creates::set_memo_colors,
            commands::memo::creates::list_memo_templates,
            commands::memo::creates::save_memo_template,
            commands::memo::creates::delete_memo_template,
            commands::memo::creates::create_memo_from_template,
            commands::memo::versions::list_memo_versions,
            commands::memo::versions::read_memo_version,
            commands::memo::versions::create_memo_version,
            commands::memo::versions::restore_memo_version,
            commands::memo::deletes::delete_memo,
            commands::memo::deletes::clear_memos,
            commands::memo::versions::delete_memo_version,
            // tag
            commands::tag::get_all_tags,
            commands::tag::create_memo_tag,
            commands::tag::rename_memo_tag,
            commands::tag::delete_memo_tag,
            commands::tag::move_memo_tag,
            commands::tag::get_tag_prefix_counts,
            // notebook
            commands::notebook::get_notebooks,
            commands::notebook::create_notebook,
            commands::notebook::update_notebook,
            commands::notebook::delete_notebook,
            commands::notebook::clear_notebooks,
            commands::notebook::set_current_notebook,
            // file
            commands::file::get_file_tree,
            commands::file::get_dir_children,
            commands::file::read_file,
            commands::file::write_file,
            commands::file::delete_file,
            commands::file::create_folder,
            commands::file::create_document,
            // font cache
            commands::font::get_font_cache_status,
            commands::font::ensure_font_cached,
            commands::font::remove_cached_font,
            // web page metadata
            commands::web::parse_web_page,
            // dialog
            commands::dialog::select_directory,
            commands::dialog::select_agent_runtime_directory,
            commands::dialog::select_files,
            commands::dialog::save_file_dialog,
            commands::dialog::write_export_file,
            commands::dialog::save_attachment,
            commands::dialog::save_attachment_content,
            commands::dialog::copy_attachment_file,
            commands::agent_access::add_agent_access_folder_from_picker,
            // agent
            commands::agent::agent_runtime_status,
            commands::agent::open_codex_cli_install_terminal,
            commands::agent::open_codex_config,
            commands::agent::chat_with_agent_stream,
            commands::agent::stop_agent_stream,
            commands::agent::agent_running_threads,
            // thread
            commands::thread::thread_list,
            commands::thread::thread_create,
            commands::thread::thread_get,
            commands::thread::thread_get_page,
            commands::thread::agent_conversation_list,
            commands::thread::agent_conversation_get,
            commands::thread::agent_conversation_find_by_thread,
            commands::thread::agent_conversation_find_by_run,
            commands::thread::agent_conversation_upsert,
            commands::thread::agent_conversation_upsert_run_state,
            commands::thread::agent_conversation_delete,
            commands::thread::agent_conversation_delete_for_thread,
            commands::thread::local_agent_thread_list,
            commands::thread::codex_thread_list,
            commands::thread::codex_thread_get,
            commands::thread::codex_thread_get_page,
            commands::thread::codex_thread_session_id,
            commands::agent::codex_default_model,
            commands::agent::agent_supported_models,
            commands::thread::claude_thread_list,
            commands::thread::claude_thread_get,
            commands::thread::claude_thread_session_id,
            commands::thread::hermes_thread_list,
            commands::thread::hermes_thread_get,
            commands::thread::hermes_thread_get_page,
            commands::thread::hermes_thread_session_id,
            commands::thread::thread_delete,
            commands::thread::thread_update_title,
            // window
            commands::window::open_preferences_window,
            commands::window::open_note_window,
            commands::window::resolve_note_window_payload,
            // 全局"通过链接打开笔记"入口 ── 接收 URL / 物理路径, 解析 + emit
            open_target::handler::open_memo_by_target,
            // CLI sidecar JSON-RPC ── 前端通过 invoke('cli_invoke', { method, params }) 调
            commands::cli::cli_invoke,
            commands::cli::cli_link_status,
            commands::cli::install_cli_path,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(handle_run_event);
}

fn handle_second_instance(app: &tauri::AppHandle, args: Vec<String>) {
    // 二次启动: 区分 markdown 文件路径与 flowix:// 深链。
    // 两个通道可以同时触发 (用户用 `xdg-open foo.md flowix://memo/abc123` 启动)。
    let paths = commands::markdown_paths_from_args(args.clone());
    if !paths.is_empty() {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_focus();
        }
        dispatcher::emit_to(app, "external-markdown-opened", paths);
    }

    for arg in args {
        emit_open_target_if_resolved(app, &arg);
    }
}

#[cfg(desktop)]
fn register_deep_links(app: &mut tauri::App) {
    use tauri_plugin_deep_link::DeepLinkExt;

    // 开发期每次启动都注册一次幂等；正式打包后 installer 会接管，运行时注册仍可补漏。
    let _ = app.deep_link().register("flowix");

    // macOS / Windows: OS 把深链投到 running app, 通过 deep-link 插件回调派发。
    let app_handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            emit_open_target_if_resolved(&app_handle, url.as_str());
        }
    });
}

#[cfg(not(desktop))]
fn register_deep_links(_app: &mut tauri::App) {}

fn handle_cold_start_open_targets(app: &tauri::AppHandle) {
    // 冷启动: 深链也可能经由 argv 走到 (Linux 上标准做法, macOS 上偶发)。
    for arg in std::env::args().skip(1) {
        emit_open_target_if_resolved(app, &arg);
    }
}

fn emit_open_target_if_resolved(app: &tauri::AppHandle, raw: &str) {
    let state = app.state::<commands::AppState>();
    if let Ok(target) = open_target::parse_open_target(raw) {
        if let Ok(resolved) = open_target::resolve_open_target(target, state.inner()) {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
            dispatcher::emit_to(app, "flowix:open-target", resolved);
        }
    }
}

fn spawn_cli_sidecar(app: &tauri::AppHandle) {
    let cli_lock = app.state::<commands::AppState>().flowix_cli.clone();
    match tauri::async_runtime::block_on(commands::cli::SidecarHandle::spawn()) {
        Ok(handle) => {
            tracing::info!(
                "flowix-cli sidecar spawned at {}",
                handle.bin_path().display()
            );
            tauri::async_runtime::block_on(async move {
                *cli_lock.write().await = Some(handle);
            });
        }
        Err(e) => {
            tracing::warn!(
                "flowix-cli sidecar spawn failed: {e} (CLI methods will be unavailable)"
            );
            // 让 cli_invoke 返清晰错误, 不静默吞掉。
            tauri::async_runtime::block_on(async move {
                *cli_lock.write().await = Some(commands::cli::SidecarHandle::dead(e.clone()));
            });
        }
    }
}

fn handle_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    match event {
        // 关窗时先发 graceful shutdown, 200ms 后兜底 kill ── 见 `SidecarHandle::try_shutdown`。
        tauri::RunEvent::ExitRequested { .. } => {
            stop_sidecar(app, true);
            stop_external_agent_children(app, "exit");
        }
        // 兜底: 任何进程退出路径都把 child 杀掉, 避免僵尸。
        tauri::RunEvent::Exit => {
            stop_sidecar(app, false);
            stop_external_agent_children(app, "final exit");
        }
        _ => {}
    }
}

fn stop_sidecar(app: &tauri::AppHandle, graceful: bool) {
    let cli_lock = app.state::<commands::AppState>().flowix_cli.clone();
    tauri::async_runtime::block_on(async move {
        let guard = cli_lock.read().await;
        if let Some(cli) = guard.as_ref() {
            if graceful {
                let _ = cli
                    .try_shutdown(std::time::Duration::from_millis(200))
                    .await;
            } else {
                cli.kill().await;
            }
        }
    });
}

fn stop_external_agent_children(app: &tauri::AppHandle, phase: &str) {
    let state = app.state::<commands::AppState>();
    tauri::async_runtime::block_on(async {
        let codex = state.codex_cli_manager.stop_all().await;
        let claude = state.claude_cli_manager.stop_all().await;
        let gemini = state.gemini_cli_manager.stop_all().await;
        let hermes = state.hermes_cli_manager.stop_all().await;
        let openclaw = state.openclaw_cli_manager.stop_all().await;
        if codex + claude + gemini + hermes + openclaw > 0 {
            tracing::info!(
                "stopped external agent children on {phase}: codex={codex}, claude={claude}, gemini={gemini}, hermes={hermes}, openclaw={openclaw}"
            );
        }
    });
}
