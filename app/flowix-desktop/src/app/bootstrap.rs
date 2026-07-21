use crate::agent_external::claude::ClaudeCliManager;
use crate::agent_external::codex::CodexCliManager;
use crate::agent_external::hermes::HermesCliManager;
use crate::agent_external::simple_cli;
use crate::agent_external_config::AgentExternalConfig;
use crate::agent_flowix::AgentManager;
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
use crate::open_target;
use crate::runtime_log;
use crate::system_data::SystemData;
use crate::watcher::MemoWatcher;
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

    // 鍚姩鏃跺湪 `~/.local/bin/flowix-cli` 寤轰竴涓?symlink銆傝鎯呰
    // `cli_link` 妯″潡: 骞傜瓑 (姣忔鍚姩閮借窇, 宸插瓨鍦ㄥ氨涓嶅姩), 澶辫触鍙?warn
    // 涓嶉樆濉?GUI 鍚姩, 鑼冨洿 macOS + Linux (cfg(unix))銆?    cli_link::ensure_cli_symlink();

    let user_config_dir = get_user_config_dir(&home_dir);
    std::fs::create_dir_all(&user_config_dir).ok();
    let thread_db_path = user_config_dir.join("thread.db");
    let user_config = Arc::new(user_config::UserConfigStore::new(home_dir.clone()));

    // 绗旇鏈敞鍐岃〃鐪熸簮璧?~/.flowix/index.db (SQLite); `MemoFile::open_index_db`
    // 棣栨琚鏃跺缓琛ㄣ€?杩欓噷涓嶉渶瑕佷换浣曠鐩樿縼绉?鈹€鈹€ 鏃?`notebook.json` 璺緞宸插簾銆?
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

    // External CLI 璺緞閰嶇疆 (~/.flowix/agent-external-config.json) 鈹€鈹€
    // 浣滀负 codex/claude/gemini/hermes/openclaw 鎵ц璺緞鐨勫敮涓€鍙傜収銆?
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

    // 涓変釜闇€瑕佷笌 AgentManager 鍏变韩鐨勪緷璧? 鎻愬墠寤哄ソ Arc 鍐?clone銆?    // refcount 鏈熸湜: user_config=2 (AppState + AgentManager), thread_manager=2,
    // memo_file=2 鈹€鈹€ 瑙?`commands.rs::AppState` 娉ㄩ噴銆?
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
    // 鍚姩鏃朵竴娆℃€ф竻鐞嗗鍎?is_loading=1 琛?鈹€鈹€ 瑙ｅ喅"涓婃杩涚▼鍦?tool_use
    // 钀界洏鍚庤 SIGKILL / 寮洪€€, 涓嬫鍚姩鐪嬪埌杞湀鍗℃宸ュ叿琛?鐨勯棶棰樸€?璇﹁
    // `ThreadManager::clear_all_loading` 娉ㄩ噴銆俙run()` 姝ゆ椂杩樺湪 tauri
    // runtime 璧锋潵涔嬪墠, 涓嶈兘 `.await`, 鎵€浠ユ槸鍚屾鏂规硶 (鍐呴儴鍗曟潯
    // UPDATE, 娌℃湁鐪熷疄寮傛宸ヤ綔)銆傝閿佽冻澶? clear 鍙蛋 UPDATE, 涓嶄細
    // 涓庢甯?add_message / update_tool_result 鍐茬獊 (鍚庤€呭啓鍚屼竴琛岀殑 0,
    // 鍚庡埌鍐欏悗璧? 涓ゆ潯璺緞娈婇€斿悓褰?銆?
    {
        let manager = thread_manager_arc.blocking_read();
        match manager.clear_all_loading() {
            Ok(0) => tracing::debug!("[Startup] no orphan is_loading=1 rows"),
            Ok(n) => tracing::info!("[Startup] cleared {n} orphan is_loading=1 rows"),
            Err(e) => tracing::warn!("[Startup] clear_all_loading failed: {e}"),
        }
    }
    let user_config_arc = user_config.clone();

    // Agent 鍙闂洰褰?store 鈹€鈹€ 蹇呴』鍦?notebook registry 涓?`memo_file_arc`
    // 閮藉氨缁箣鍚庢瀯閫?(鏂?store 浼氳 notebook registry 鎾 + 瀵硅处)銆?
    let security_bookmarks_arc = Arc::new(SecurityBookmarkStore::new(user_config_dir.clone()));
    let agent_access_arc = Arc::new(AgentAccessStore::new(
        user_config_dir.clone(),
        &*crate::lock_utils::read_lock(&memo_file_arc, "memo_file"),
    ));

    // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    // Skills 鈹€鈹€ `~/.flowix/skills/` 鍗曟牴, 鎵弿涓や釜鍖哄煙:
    //   1. `.system/<name>/SKILL.md`  绯荤粺鍐呯疆 (浠?bundle 涓€娆℃€?seed)
    //   2. `<name>/SKILL.md`          鐢ㄦ埛鑷坊鍔?    //
    // 娴佺▼: 鍒涘缓鐢ㄦ埛鐩綍 鈫?seed-once (浠?bundle 鎷蜂竴浠藉埌 .system/) 鈫?榛樿
    // 缁?agent-access.json 鍔犱竴鏉?Folder entry (id=`fld_skills_auto`) 鈫?    // 鎵弿鏁翠釜鏍圭洰褰?鈫?鏋勯€?SkillStore 鈫?涓?AppState / AgentManager 鍏变韩
    // 鈹€鈹€ SkillStore 鍚姩鍚庝笉鍙彉, Arc 鍏变韩, 鏃犻渶 RwLock銆?    // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    let skills_root = user_config_dir.join("skills");
    if let Err(e) = std::fs::create_dir_all(&skills_root) {
        tracing::warn!(
            "[startup] failed to create skills root {}: {e}",
            skills_root.display()
        );
    }

    // Seed-once: bundled `resources/skills/.system/*` 鈫?`~/.flowix/skills/.system/*`.
    // 涓変釜鍊欓€夎矾寰? 鍛戒腑绗竴涓彲鐢ㄧ殑灏卞仠 鈹€鈹€ 瑙?    // `crate::agent_flowix::skills::scanner::resolve_bundled_root`銆?
    if let Some(bundled) = crate::agent_flowix::skills::scanner::resolve_bundled_root() {
        let report = crate::agent_flowix::skills::seed_system_skills(&bundled, &skills_root);
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

    // 榛樿缁?Agent `~/.flowix/skills/` 鐨勮鏉冮檺 鈹€鈹€ LLM 鍙互鐩存帴 `read` / `grep`
    // 浠绘剰 SKILL.md, 涓嶅繀鍏堣皟 `load_skill`銆?    agent_access_arc.ensure_skill_folder(&skills_root);

    let skill_store = Arc::new(crate::agent_flowix::skills::SkillStore::load(&skills_root));
    tracing::info!(
        "[startup] loaded {} skill(s) from {}",
        skill_store.len(),
        skill_store.root().display()
    );

    // 鐩戝惉 user-config-changed 鐑洿鏂?whitelist 鏃? 涔熼渶瑕?user_config_arc,
    // 鍗曠嫭 clone 涓€浠?(鍚庣画浼氳 move 杩?AgentManager::new)銆?
    let user_config_for_watcher = user_config_arc.clone();

    // AppState 鍦?`.setup()` 闂寘閲屾瀯閫犮€俆auri 2 鐨?`.manage(state)` 鏄?    // "涓€娆℃€?璇箟, 鎵€浠ユ墍鏈夊叡浜緷璧栭兘鍦ㄨ繘鍏ラ棴鍖呭墠鍑嗗濂姐€?    //
    // 杩欓噷鎶婃瀯閫?AppState 闇€瑕佺殑瀛愮粨鏋?clone 鍑烘潵 (闂寘 `move` 鎹曡幏),
    // 鍚屾椂鎶婂彟涓€浠?clone 鍠傜粰 sub-component 鏋勯€犲嚱鏁般€?
    let user_config_for_state = user_config_arc.clone();
    let memo_file_for_state = memo_file_arc.clone();
    let agent_access_for_state = agent_access_arc.clone();
    let security_bookmarks_for_state = security_bookmarks_arc.clone();
    let thread_manager_for_state = thread_manager_arc.clone();
    // 鍚姩璁惧鐧昏妯″潡 鈹€鈹€ 鍜屼笂闈㈠悓鏍风殑 prep 妯″紡: clone 杩?setup 闂寘銆?
    let user_config_dir_for_device = user_config_dir.clone();
    // `system_data` 娌?
    // impl Clone 鈹€鈹€ 鐩存帴 move 杩?setup 闂寘, 閭ｉ噷
    // move 杩?AppState銆?
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

    // 绗旇鏈洰褰曟枃浠剁洃鍚櫒 鈥?鎶婂閮ㄧ紪杈戝櫒 / 鍏朵粬 AI 瀵逛换鎰忓凡娉ㄥ唽 notebook
    // 鐨勭鐩樺彉鏇磋浆鎴?`memo-event` 鎺ㄥ墠绔€俙AppHandle` 鍦?`run()` 闃舵鎷夸笉鍒?
    // 瀹為檯缁戝畾鍦?.setup() 闂寘閲屽畬鎴愩€?
    let memo_watcher = Arc::new(RwLock::new(MemoWatcher::new(memo_file_arc.clone())));

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            handle_second_instance(app, args);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_process::init())
        .manage(memo_watcher.clone())
        .manage(commands::tab_window::TabWindowCoordinator::default())
        .setup(move |app| {
            // 鈹€鈹€ 0) 鍚姩璁惧鐧昏 / last_seen 鍒锋柊 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
            //   涓嶉樆濉? spawn 涓€涓?fire-and-forget tokio 浠诲姟, 鑷繁鍐呴儴
            //   鍏?sleep 10s 鍐?POST, 涓庝骇鍝佹洿鏂?7s 妫€鏌ラ敊寮€銆傝繙绔寜
            //   `device_id` upsert, 棣栨鎻掑叆, 鍚庣画鍚姩鍒锋柊 last_seen_at銆?
            let app_version = app.package_info().version.to_string();
            let device_registry = Arc::new(crate::device_registration::DeviceRegistry::load(
                &user_config_dir_for_device,
                app_version,
            ));
            device_registry.clone().spawn_startup_registration();

            // 鈹€鈹€ 1) 鍚姩鎺㈡祴 external CLI 璺緞 鈹€鈹€
            //   瀵?source=auto/缂哄け鐨?agent 璺戞帰娴嬮摼 (env>PATH>鍊欓€?shell),
            //   鍐欏叆 ~/.flowix/agent-external-config.json 骞剁亴杩?            //   cli_resolver::REGISTRY; source=user 鐨勮烦杩?(灏婇噸鐢ㄦ埛鎵嬫敼)銆?            //   姝ゅ悗 resolve_external_cli 鍛戒腑鍗崇敤, 涓嶅啀姣忔潯娑堟伅鎺㈡祴銆?            agent_external_config.run_startup_detect();

            // 鈹€鈹€ 2) 鏋勯€?AppState 骞?manage 鈹€鈹€
            let app_state = AppState {
                user_config: user_config_for_state.clone(),
                system_data,
                agent_external_config,
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
            };
            app.manage(app_state);
            spawn_external_agent_watchdog(
                app.handle().clone(),
                codex_cli_manager.clone(),
                claude_cli_manager.clone(),
                hermes_cli_manager.clone(),
                gemini_cli_manager.clone(),
                openclaw_cli_manager.clone(),
            );

            if let Some(window) = app.get_webview_window("main") {
                crate::window_chrome::apply_window_border_color(&window);
                // 鍚姩鍗冲榻愪富棰樿儗鏅壊, 娑堥櫎鍐峰惎鍔ㄧ櫧闂?(灏ゅ叾娣辫壊涓婚)銆?
                let theme = app.state::<AppState>().user_config.get_preference().theme;
                crate::window_chrome::apply_theme_background(&window, theme);

                // Theme::System 鏃惰窡闅?OS 鏄庢殫瀹炴椂鍒囨崲绐楀彛鑳屾櫙鑹? 浠呭綋绐楀彛鏈鏄惧紡
                // theme (鏈簲鐢ㄦ墍鏈夌獥鍙ｉ兘鏄? 鏃?Tauri 鎵嶆淳鍙?ThemeChanged, 鏁呰繖閲?                // 鐩戝惉涓荤獥鍙ｅ嵆鍙Е鍙戜竴娆″叏灞€鍒锋柊 (apply_theme_background_all 閬嶅巻鎵€鏈夌獥鍙?銆?
                let app_for_theme = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::ThemeChanged(_) = event {
                        let current = app_for_theme
                            .state::<AppState>()
                            .user_config
                            .get_preference()
                            .theme;
                        if current == crate::config::Theme::System {
                            crate::window_chrome::apply_theme_background_all(
                                &app_for_theme,
                                current,
                            );
                        }
                    }
                });
            }

            // 鍦?setup 闃舵 manage dispatcher, 鍥犱负
            // TauriDispatcher::new 闇€瑕?AppHandle, builder chain 閲屾嬁涓嶅埌銆?
            let dispatcher: crate::events::SharedDispatcher =
                std::sync::Arc::new(crate::events::TauriDispatcher::new(app.handle().clone()));
            app.manage(dispatcher);
            app.manage(
                commands::external_document_watch::ExternalDocumentWatchState::new(
                    app.handle().clone(),
                ),
            );
            // Watch every configured notebook. MCP/external tools may write to
            // a background notebook, and those creates must still reach the
            // main Webview so it can route the note into a tab window.
            let initial_notebooks = {
                let memo_file = crate::lock_utils::read_lock(&memo_file_arc, "memo_file");
                memo_file.read_notebook_configs().unwrap_or_default()
            };
            for notebook in &initial_notebooks {
                security_bookmarks_for_state
                    .start_accessing_for_path(std::path::Path::new(&notebook.path));
            }
            memo_watcher
                .write()
                .unwrap_or_else(|poisoned| {
                    tracing::error!("memo_watcher write lock poisoned, recovering");
                    poisoned.into_inner()
                })
                .rebind_all(app.handle().clone(), initial_notebooks);

            // 鍙湪宸叉湁 current notebook 鏃跺仛鍚姩瀵硅处銆?current=None 鏃?            // `MemoFile` 浼氬洖閫€鍒伴粯璁?notebook 璺緞, 鍦?macOS 涓婂彲鑳借Е鍙?            // Documents 鏉冮檺寮圭獥銆?
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

            // 鍚姩鏃舵妸 preference.json::watcher 搴旂敤鍒?MemoWatcher;
            // 鍚屾椂娉ㄥ唽 user-config-changed 鐩戝惉鍋氱儹鏇存柊 (鍓嶇璋?            // update_watcher_config IPC 璧?settings::update_watcher_config
            // 鍐欏悗 emit 璇ヤ簨浠? 杩欓噷鏀跺埌灏?set_whitelist)銆?
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
                    // payload 鏄?kind 瀛楃涓?("preference" / "ai_config" / "watcher")
                    // 鈹€鈹€ ai_config 璧?~/.flowix/agent-config.toml (TOML), 鍏朵綑璧?JSON
                    // event.payload() 杩斿洖 serde_json 搴忓垪鍖栫粨鏋?(甯﹀紩鍙? 濡?"\"preference\""),
                    // 鐩存帴 == 姣斿浼氭亽涓?false, 杩欓噷鍙嶅簭鍒楀寲杩樺師鎴愯８瀛楃涓层€?
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
                    // 涓婚鍒囨崲鐨勫師鐢?chrome 鏇存柊鐢卞墠绔?apply_window_theme IPC 瀹炴椂椹卞姩,
                    // 涓嶅湪杩欓噷澶勭悊 (杩欓噷 200ms 闃叉姈鍚庢墠瑙﹀彂, 涓斾笌鎸佷箙鍖栬€﹀悎)銆?
                });
            }

            register_deep_links(app);
            handle_cold_start_open_targets(app.handle());

            // release 鏋勫缓涓嶅寘鍚鍒嗘敮銆?鐢ㄦ埛闅忔椂鍙敤 F12 / Ctrl+Shift+I 鍒囨崲銆?
            // 鈹€鈹€ spawn flowix-cli sidecar 鈹€鈹€
            // 蹇呴』鏀?setup 鏈熬, 姝ゆ椂 AppState 宸茬粡 manage, IPC 璋冪敤鏂瑰彲浠?
            // 鎷垮埌 (铏界劧杩樻病濉?handle 鈹€鈹€ 澶辫触鏃惰繑 "not yet spawned" 閿?銆?
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 鍋忓ソ (JSON, 璧?user_config)
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
            // agent 鍙闂洰褰?(JSON, 璧?agent_access)
            commands::agent_access::get_agent_access,
            commands::agent_access::set_agent_access,
            // System metadata (JSON, ~/.flowix/boot/system.json)
            commands::kv::get_tag_system_metadata,
            commands::kv::set_tag_system_layout,
            commands::kv::set_tag_system_hidden,
            // 绗旇 / Doc 鈹€鈹€ 鎸?commands/memo/{reads,creates,versions,deletes}.rs
            // 瀛愭ā鍧楄矾寰勫彇, 涓嶈蛋 `commands::memo::xxx` 椤跺眰 re-export 鈹€鈹€
            // `#[tauri::command]` 瀹忕敓鎴愮殑 `__cmd__xxx` wrapper 鏄嚱鏁版墍鍦?            // 妯″潡鐨勫悓绾?macro, 鍙兘鍦ㄨ妯″潡璺緞 (`commands::memo::reads::xxx`)
            // 瑙ｆ瀽鍒? `commands::memo::xxx` 椤跺眰璺緞涓嶄紶閫?macro re-export.
            commands::memo::reads::get_memos,
            commands::memo::reads::search_mention_notes,
            commands::memo::reads::list_agent_role_memos,
            commands::memo::reads::get_used_memo_tag_ids,
            commands::memo::reads::get_memo_todo_metadata,
            commands::memo::reads::get_memo_todo_count,
            commands::memo::reads::read_memo,
            commands::memo::reads::open_memo_session,
            commands::memo::reads::read_document,
            commands::memo::reads::write_document,
            commands::external_document::read_external_document,
            commands::external_document::write_external_document,
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
            commands::tag::move_memo_tag,
            commands::tag::get_tag_prefix_counts,
            // notebook
            commands::notebook::get_notebooks,
            commands::notebook::create_notebook,
            commands::notebook::update_notebook,
            commands::notebook::delete_notebook,
            commands::notebook::clear_notebooks,
            commands::notebook::set_current_notebook,
            commands::notebook::reorder_notebooks,
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
            commands::dialog::select_files,
            commands::dialog::save_file_dialog,
            commands::dialog::write_export_file,
            commands::dialog::save_attachment,
            commands::dialog::save_attachment_content,
            commands::dialog::copy_attachment_file,
            commands::dialog::open_attachment_file,
            commands::agent_access::add_agent_access_folder_from_picker,
            // agent
            commands::agent::agent_runtime_status,
            commands::agent::get_agent_external_config,
            commands::agent::set_agent_external_path,
            commands::agent::redetect_agent_external,
            commands::agent::select_external_cli_path,
            commands::agent::open_codex_cli_install_terminal,
            commands::agent::open_codex_config,
            commands::agent::cache_agent_image,
            commands::agent::delete_cached_agent_image,
            commands::agent::read_cached_agent_image,
            commands::agent::chat_with_agent_stream,
            commands::agent::stop_agent_stream,
            commands::agent::agent_running_threads,
            commands::agent::agent_external_events,
            // thread
            commands::thread::thread_list,
            commands::thread::thread_create,
            commands::thread::thread_get,
            commands::thread::thread_get_page,
            commands::thread::agent_conversation_list,
            commands::thread::agent_conversation_get,
            commands::thread::agent_conversation_find_by_thread,
            commands::thread::agent_conversation_upsert,
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
            commands::window::show_main_window,
            commands::window::open_preferences_window,
            commands::window::apply_window_theme,
            commands::tab_window::open_note_window,
            commands::tab_window::open_note_tab,
            commands::tab_window::open_external_markdown_window,
            commands::tab_window::open_external_markdown_tab,
            commands::tab_window::open_markdown_path_tab,
            commands::tab_window::tab_window_ready,
            commands::tab_window::tab_window_ack_transfer,
            commands::tab_window::tab_window_set_tab_region,
            commands::tab_window::tab_window_close_tab,
            commands::tab_window::tab_window_reorder_tab,
            commands::tab_window::tab_window_detach_tab,
            commands::tab_window::tab_window_begin_tab_item_drag,
            commands::tab_window::tab_window_cancel_tab_item_drag,
            commands::external_document_watch::watch_external_document,
            commands::external_document_watch::unwatch_external_document,
            // 鍏ㄥ眬"閫氳繃閾炬帴鎵撳紑绗旇"鍏ュ彛 鈹€鈹€ 鎺ユ敹 URL / 鐗╃悊璺緞, 瑙ｆ瀽 + emit
            open_target::handler::open_memo_by_target,
            commands::cli::cli_link_status,
            commands::cli::install_cli_path,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(handle_run_event);
}

fn handle_second_instance(app: &tauri::AppHandle, args: Vec<String>) {
    // 浜屾鍚姩: 鍖哄垎 markdown 鏂囦欢璺緞涓?flowix:// 娣遍摼銆?    // 涓や釜閫氶亾鍙互鍚屾椂瑙﹀彂 (鐢ㄦ埛鐢?`xdg-open foo.md flowix://memo/abc123` 鍚姩)銆?
    let paths = commands::markdown_paths_from_args(args.clone());
    for path in &paths {
        route_markdown_path_to_tab(app, path);
    }

    for arg in args {
        if !paths.contains(&arg) {
            emit_open_target_if_resolved(app, &arg);
        }
    }
}

#[cfg(desktop)]
fn register_deep_links(app: &mut tauri::App) {
    use tauri_plugin_deep_link::DeepLinkExt;

    // 寮€鍙戞湡姣忔鍚姩閮芥敞鍐屼竴娆″箓绛夛紱姝ｅ紡鎵撳寘鍚?installer 浼氭帴绠★紝杩愯鏃舵敞鍐屼粛鍙ˉ婕忋€?
    let _ = app.deep_link().register("flowix");

    // macOS / Windows: OS 鎶婃繁閾炬姇鍒?running app, 閫氳繃 deep-link 鎻掍欢鍥炶皟娲惧彂銆?
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
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let paths = commands::markdown_paths_from_args(args.clone());
    if !paths.is_empty() {
        if let Some(main_window) = app.get_webview_window("main") {
            main_window.hide().ok();
        }
        for path in &paths {
            route_markdown_path_to_tab(app, path);
        }
    }
    for arg in args {
        if !paths.contains(&arg) {
            emit_open_target_if_resolved(app, &arg);
        }
    }
}

fn route_markdown_path_to_tab(app: &tauri::AppHandle, path: &str) {
    let state = app.state::<AppState>();
    let coordinator = app.state::<commands::tab_window::TabWindowCoordinator>();
    if let Err(error) =
        commands::tab_window::route_markdown_path_tab(app, state.inner(), coordinator.inner(), path)
    {
        tracing::warn!("[open-markdown] failed to route {path}: {error}");
    }
}

fn emit_open_target_if_resolved(app: &tauri::AppHandle, raw: &str) {
    let state = app.state::<AppState>();
    if let Ok(target) = open_target::parse_open_target(raw) {
        if let Ok(resolved) = open_target::resolve_open_target(target, state.memo_file.as_ref()) {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
            dispatcher::emit_to(app, "flowix:open-target", resolved);
        }
    }
}

fn handle_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Opened { urls } => {
            for url in urls {
                if url.scheme() == "file" {
                    if let Ok(path) = url.to_file_path() {
                        let path = path.to_string_lossy().to_string();
                        if !commands::markdown_paths_from_args([path.clone()]).is_empty() {
                            route_markdown_path_to_tab(app, &path);
                        }
                    }
                }
            }
        }
        tauri::RunEvent::ExitRequested { .. } => {
            stop_external_agent_children(app, "exit");
        }
        tauri::RunEvent::Exit => {
            stop_external_agent_children(app, "final exit");
        }
        _ => {}
    }
}

fn stop_external_agent_children(app: &tauri::AppHandle, phase: &str) {
    let state = app.state::<AppState>();
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
