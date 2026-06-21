mod agent;
mod agent_access;
mod cli_link;
mod codex_cli;
mod codex_history;
mod commands;
mod fs_watcher;
mod global_meta_data;
mod lock_utils;
mod memo_events;
mod open_target;
mod path_scope;
mod prompt;
mod providers;
mod runtime_log;
mod skills;
mod threads;
mod user_config;

mod watcher;
use crate::watcher::dispatcher;
use agent::AgentManager;
use agent_access::AgentAccessStore;
use codex_cli::CodexCliManager;
use commands::AppState;
use flowix_core::search::{BigramTokenizer, MemoIndex};
use global_meta_data::GlobalMetaData;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use tauri::{Emitter, Listener, Manager};
use threads::ThreadManager;

/// 用户配置目录名 (~/.<NAME>/ 下放 preference.json / flowix-ai-config.toml /
/// notebook.json / global_meta_data.json)。原 WoopMemo 时代叫 `.woop`,
/// 2026/06 品牌重塑后改为 `.flowix`。 旧目录由 `migrate_legacy_woop_dirs`
/// 一次性迁移, 见 `run()`。
pub const USER_CONFIG_DIR_NAME: &str = ".flowix";

/// 桌面应用数据目录名 (在 `dirs::data_dir()` 之下, macOS:
/// `~/Library/Application Support/<NAME>/`)。 旧 WoopMemo 时代叫
/// `woopmemo`, 现统一为 `flowix`。
pub const APP_DATA_DIR_NAME: &str = "flowix";

pub fn get_app_data_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(APP_DATA_DIR_NAME)
}

pub fn get_user_config_dir(home_dir: &PathBuf) -> PathBuf {
    home_dir.join(USER_CONFIG_DIR_NAME)
}

/// 把旧 SQLite `app.db` 里的 `app_state` 表一次性搬到
/// `~/.flowix/global_meta_data.json`。读得到就写, 然后删老文件; 读不到或
/// 新文件已存在则不动 (避免覆盖用户数据)。
fn migrate_legacy_app_db(app_data_path: &PathBuf, target: &PathBuf) {
    let legacy = app_data_path.join("app.db");
    if !legacy.exists() || target.exists() {
        return;
    }
    let conn = match rusqlite::Connection::open(&legacy) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("failed to open legacy app.db: {e}");
            return;
        }
    };
    let mut stmt = match conn.prepare("SELECT key, value FROM app_state") {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("failed to query app_state: {e}");
            return;
        }
    };
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)));
    let mut map = serde_json::Map::new();
    if let Ok(rows) = rows {
        for row in rows.flatten() {
            map.insert(row.0, serde_json::Value::String(row.1));
        }
    }
    if let Some(parent) = target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match serde_json::to_string_pretty(&map)
        .ok()
        .and_then(|c| std::fs::write(target, c).ok())
    {
        Some(_) => {
            let _ = std::fs::remove_file(&legacy);
            tracing::info!(
                "migrated app_state table from {} to {}",
                legacy.display(),
                target.display()
            );
        }
        None => {
            tracing::warn!("failed to write {}", target.display());
        }
    }
}

/// 递归复制目录 (文件覆盖, 子目录递归创建)。 简单实现, 假设源都是
/// 普通文件 / 目录, 遇到 symlink 走 `fs::copy` 的跟随语义。
/// 仅用于一次性用户数据迁移, 不替代通用备份工具。
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// 把 WoopMemo 时代的用户数据目录一次性搬到 Flowix 位置。 三个目标:
///   1. `~/.woop/`                → `~/.flowix/`
///   2. `<data_dir>/woopmemo/`    → `<data_dir>/flowix/`
///   3. `~/Documents/woop notebook/` → `~/Documents/flowix/`
///
/// 触发条件: 旧目录存在 **且** 新目录不存在 (避免覆盖)。 任何步骤
/// 出错都 `tracing::warn!` 但不中断启动 — 用户数据在原位仍然可读。
/// **此操作不可逆**: 旧目录在 copy 成功后被 `remove_dir_all` 删除。
pub fn migrate_legacy_woop_dirs(home_dir: &PathBuf, app_data_path: &PathBuf) {
    // 1. ~/.woop/ → ~/.flowix/
    let old_cfg = home_dir.join(".woop");
    let new_cfg = home_dir.join(USER_CONFIG_DIR_NAME);
    if old_cfg.exists() && !new_cfg.exists() {
        match copy_dir_recursive(&old_cfg, &new_cfg) {
            Ok(()) => {
                if let Err(e) = std::fs::remove_dir_all(&old_cfg) {
                    tracing::warn!("failed to remove legacy ~/.woop after copy: {e}");
                } else {
                    tracing::info!("migrated ~/.woop → ~/.flowix");
                }
            }
            Err(e) => tracing::warn!("failed to copy ~/.woop → ~/.flowix: {e}"),
        }
    }

    // 2. <data_dir>/woopmemo/ → <app_data_path>
    //    app_data_path 此时已是 data_dir.join(APP_DATA_DIR_NAME) = data_dir/flowix。
    if let Some(parent) = app_data_path.parent() {
        let old_data = parent.join("woopmemo");
        if old_data.exists() && !app_data_path.exists() {
            match copy_dir_recursive(&old_data, app_data_path) {
                Ok(()) => {
                    if let Err(e) = std::fs::remove_dir_all(&old_data) {
                        tracing::warn!("failed to remove legacy app data dir: {e}");
                    } else {
                        tracing::info!(
                            "migrated {} → {}",
                            old_data.display(),
                            app_data_path.display()
                        );
                    }
                }
                Err(e) => tracing::warn!("failed to copy app data dir: {e}"),
            }
        }
    }

    // 3. ~/Documents/woop notebook/ → ~/Documents/flowix/
    if let Some(docs) = dirs::document_dir() {
        let old_nb = docs.join("woop notebook");
        let new_nb = docs.join("flowix");
        if old_nb.exists() && !new_nb.exists() {
            match copy_dir_recursive(&old_nb, &new_nb) {
                Ok(()) => {
                    if let Err(e) = std::fs::remove_dir_all(&old_nb) {
                        tracing::warn!("failed to remove legacy notebook dir: {e}");
                    } else {
                        tracing::info!("migrated ~/Documents/woop notebook → ~/Documents/flowix");
                    }
                }
                Err(e) => tracing::warn!("failed to copy notebook dir: {e}"),
            }
        }
    }

    // 4. notebook.json path rewrite. Step 3 moves the directory but
    //    notebook.json's `path` field still points at the old location,
    //    so the agent ends up trying to read from a deleted directory and
    //    `ToolScope` registers the wrong path as the only allowed root.
    rewrite_legacy_notebook_paths(home_dir);
}

/// One-shot rewrite of `~/.flowix/notebook.json` rows whose `path` still
/// contains the legacy `Documents/woop notebook` prefix. Idempotent —
/// only rows that mention `woop notebook` are touched. A no-op when the
/// file is absent or not deserializable as `Vec<NotebookConfig>`.
fn rewrite_legacy_notebook_paths(home_dir: &Path) {
    let Some(docs) = dirs::document_dir() else {
        return;
    };
    let old_prefix = docs.join("woop notebook");
    let new_prefix = docs.join("flowix");
    let notebook_path = home_dir.join(USER_CONFIG_DIR_NAME).join("notebook.json");
    let Ok(content) = std::fs::read_to_string(&notebook_path) else {
        return;
    };
    let Ok(mut configs) =
        serde_json::from_str::<Vec<flowix_core::memo_file::NotebookConfig>>(&content)
    else {
        tracing::debug!("notebook.json present but not deserializable as Vec<NotebookConfig>");
        return;
    };
    let old_segment = old_prefix.to_string_lossy().to_string();
    let new_segment = new_prefix.to_string_lossy().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let rewritten = configs
        .iter_mut()
        .filter(|cfg| cfg.path.contains(&old_segment) || cfg.path.contains("woop notebook"))
        .map(|cfg| {
            cfg.path = cfg
                .path
                .replace(&old_segment, &new_segment)
                .replace("woop notebook", "flowix");
            cfg.updated_at = now;
        })
        .count();
    if rewritten == 0 {
        return;
    }
    let serialized = match serde_json::to_string_pretty(&configs) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("failed to serialize notebook.json for rewrite: {e}");
            return;
        }
    };
    if let Err(e) = std::fs::write(&notebook_path, serialized) {
        tracing::warn!("failed to rewrite notebook.json paths: {e}");
    } else {
        tracing::info!(
            "rewrote {} legacy 'woop notebook' path(s) in notebook.json",
            rewritten
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    let app_data_path = get_app_data_path();
    std::fs::create_dir_all(&app_data_path).ok();

    let thread_db_path = app_data_path.join("thread.db");

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

    // 启动时一次性迁移 WoopMemo → Flowix 数据目录。 必须早于 user_config_dir
    // / user_config 初始化, 否则 UserConfigStore 会建一个空的 ~/.flowix/,
    // migrate 检测到新目录已存在就跳过, 旧 ~/.woop/ 数据被遗漏。
    migrate_legacy_woop_dirs(&home_dir, &app_data_path);

    // 启动时在 `~/.local/bin/flowix-cli` 建一个 symlink ── 跟 migrate
    // 同类的"一次性启动 hook", 跟 user_config_dir 初始化解耦。 详情见
    // `cli_link` 模块: 幂等 (每次启动都跑, 已存在就不动), 失败只 warn
    // 不阻塞 GUI 启动, 范围 macOS + Linux (cfg(unix))。
    cli_link::ensure_cli_symlink();

    let user_config_dir = get_user_config_dir(&home_dir);
    let user_config = Arc::new(user_config::UserConfigStore::new(home_dir.clone()));

    // 笔记本配置走 ~/.flowix/notebook.json, 与 preference.json / flowix-ai-config.toml 同目录。
    // 旧版本写在 app_data_path/notebook.json, 这里做一次性迁移。
    let legacy_notebook_path = app_data_path.join("notebook.json");
    let notebook_file_path = user_config_dir.join("notebook.json");
    if legacy_notebook_path.exists() && !notebook_file_path.exists() {
        if let Err(e) = std::fs::create_dir_all(notebook_file_path.parent().unwrap()) {
            tracing::warn!("failed to create ~/.flowix dir for notebook migration: {e}");
        } else if let Err(e) = std::fs::copy(&legacy_notebook_path, &notebook_file_path) {
            tracing::warn!("failed to migrate notebook.json: {e}");
        } else {
            let _ = std::fs::remove_file(&legacy_notebook_path);
            tracing::info!(
                "migrated notebook.json from {} to {}",
                legacy_notebook_path.display(),
                notebook_file_path.display()
            );
        }
    }

    let memo_file =
        flowix_core::memo_file::MemoFile::new(app_data_path.clone(), notebook_file_path);
    flowix_core::memo_file::MemoFile::init_default_notebook(&memo_file);

    // 全局元数据走 ~/.flowix/global_meta_data.json, 旧版 SQLite app.db 一次性迁移。
    let global_meta_path = user_config_dir.join("global_meta_data.json");
    migrate_legacy_app_db(&app_data_path, &global_meta_path);
    let global_meta_data = match GlobalMetaData::new(global_meta_path.clone()) {
        Ok(store) => store,
        Err(err) => {
            tracing::error!(
                "failed to initialize global meta data at {}: {err}",
                global_meta_path.display()
            );
            GlobalMetaData::transient(global_meta_path)
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

    // Agent 可访问目录 store ── 必须在 `notebook_file_path` 与 `memo_file_arc`
    // 都就绪之后构造 (新 store 会读 `notebook.json` 播种 + 对账)。
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
    // 给 agent_access.json 加一条 Folder entry (id=`fld_skills_auto`) →
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
    let thread_manager_for_state = thread_manager_arc.clone();
    // `global_meta_data` 没 impl Clone ── 直接 move 进 setup 闭包, 那里
    // move 进 AppState。

    let search_init = RwLock::new(MemoIndex::new(Arc::new(BigramTokenizer)));
    let agent_manager = Arc::new(AgentManager::new(
        user_config_arc,
        thread_manager_arc.clone(),
        memo_file_arc.clone(),
        agent_access_arc.clone(),
        skill_store,
    ));
    let codex_cli_manager = Arc::new(CodexCliManager::new(thread_manager_arc.clone()));

    // 笔记本目录文件监听器 — 把外部编辑器 / 其他 AI 的磁盘变更转成
    // `memo-event` 推前端。绑定到启动时的当前 notebook 目录, 切换 notebook
    // 时由 commands::switch_notebook_and_rebuild 负责 rebind。`AppHandle` 在
    // `run()` 阶段拿不到, 实际 rebind 在 .setup() 闭包里完成。
    let memo_watcher = Arc::new(RwLock::new(fs_watcher::MemoWatcher::new(
        memo_file_arc.clone(),
    )));

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // 二次启动: 区分 markdown 文件路径与 flowix:// 深链
            //   1. 走 markdown 路径 (跟原行为一致, 用 external-markdown-opened)
            //   2. 走 flowix:// 深链 (用 open_memo_by_target 解析后 emit flowix:open-target)
            // 两个通道可以同时触发 (用户用 `xdg-open foo.md flowix://memo/abc123` 启动)。
            let paths = commands::markdown_paths_from_args(args.clone());
            if !paths.is_empty() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_focus();
                }
                dispatcher::emit_to(app, "external-markdown-opened", paths);
            }
            let state = app.state::<commands::AppState>();
            for arg in args {
                if let Ok(target) = open_target::parse_open_target(&arg) {
                    if let Ok(resolved) = open_target::resolve_open_target(target, state.inner()) {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.set_focus();
                            let _ = window.unminimize();
                        }
                        dispatcher::emit_to(app, "flowix:open-target", resolved);
                    }
                }
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(memo_watcher.clone())
        .setup(move |app| {
            // ── 1) 构造 AppState (placeholder 状态) 并 manage ──
            //    `flowix_cli` 字段是 `RwLock<Option<Arc<SidecarHandle>>>`,
            //    spawn 完 sidecar 后在末尾 `write().await = Some(handle)` 升级。
            let app_state = commands::AppState {
                user_config: user_config_for_state.clone(),
                global_meta_data,
                memo_file: memo_file_for_state.clone(),
                search: search_init,
                agent_manager: agent_manager.clone(),
                codex_cli_manager: codex_cli_manager.clone(),
                thread_manager: thread_manager_for_state.clone(),
                agent_access: agent_access_for_state.clone(),
                flowix_cli: Arc::new(tokio::sync::RwLock::new(None)),
            };
            app.manage(app_state);

            // PR3: 在 setup 阶段 manage dispatcher, 因为
            // TauriDispatcher::new 需要 AppHandle, builder chain 里拿不到。
            let dispatcher: crate::watcher::dispatcher::SharedDispatcher = std::sync::Arc::new(
                crate::watcher::dispatcher::TauriDispatcher::new(app.handle().clone()),
            );
            app.manage(dispatcher);
            // 启动时绑定到当前 notebook 目录。后续切 notebook 由
            // commands::switch_notebook_and_rebuild 触发 rebind。
            let initial_dir =
                crate::lock_utils::read_lock(&memo_file_arc, "memo_file").get_memo_base();
            memo_watcher
                .write()
                .unwrap_or_else(|poisoned| {
                    tracing::error!("memo_watcher write lock poisoned, recovering");
                    poisoned.into_inner()
                })
                .rebind(app.handle().clone(), Some(initial_dir));

            // 启动不变量: 双向对账 index.json ↔ 磁盘, 跟
            // switch_notebook_and_rebuild 走同一函数。 让 index.json 反映
            // 应用关闭期间发生的外部新建 / 删除, 不依赖首次 `get_memos` IPC
            // 触发。 同步执行 (~500ms @ 10K memos), 在 watcher rebind 之后、
            // 首屏 IPC 之前完成。 幂等: 多次调用零成本。
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
                    // ── ai_config 走 ~/.flowix/flowix-ai-config.toml (TOML), 其余走 JSON
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

            // 注册 flowix:// scheme 到当前用户 (开发期, 每次启动都注册一次幂等)。
            // 正式打包后, `tauri.conf.json` 的 `bundle.deepLink.desktop.schemes`
            // 会由 OS installer 接管, 这条 register 仍然能补漏 (e.g. 解包 app
            // 后双击, scheme 还没在 LaunchServices 注册)。
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register("flowix");
            }

            // macOS / Windows: OS 把深链投到 running app, 通过 deep-link 插件
            // 提供的 on_open_url 回调派发。 Linux 上由 argv 路径承担, 见上。
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let app_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    let state = app_handle.state::<commands::AppState>();
                    for url in event.urls() {
                        let raw = url.as_str();
                        if let Ok(target) = open_target::parse_open_target(raw) {
                            if let Ok(resolved) =
                                open_target::resolve_open_target(target, state.inner())
                            {
                                if let Some(window) = app_handle.get_webview_window("main") {
                                    let _ = window.set_focus();
                                    let _ = window.unminimize();
                                }
                                dispatcher::emit_to(&app_handle, "flowix:open-target", resolved);
                            }
                        }
                    }
                });
            }

            // 冷启动: 深链也可能经由 argv 走到 (Linux 上标准做法, macOS 上偶发)。
            let state = app.state::<commands::AppState>();
            for arg in std::env::args().skip(1) {
                if let Ok(target) = open_target::parse_open_target(&arg) {
                    if let Ok(resolved) = open_target::resolve_open_target(target, state.inner()) {
                        dispatcher::emit_to(app.handle(), "flowix:open-target", resolved);
                    }
                }
            }

            // release 构建不包含此分支。 用户随时可用 F12 / Ctrl+Shift+I 切换。

            // ── spawn flowix-cli sidecar ──
            // 必须放 setup 末尾, 此时 AppState 已经 manage, IPC 调用方可以
            // 拿到 (虽然还没填 handle ── 失败时返 "not yet spawned" 错)。
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
                        *cli_lock.write().await =
                            Some(commands::cli::SidecarHandle::dead(e.clone()));
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 偏好 (JSON, 走 user_config)
            commands::product::get_product_info,
            commands::product::get_diagnostics,
            commands::product::open_log_dir,
            commands::settings::get_preference,
            commands::settings::set_preference,
            commands::settings::get_ai_config,
            commands::settings::set_ai_config,
            commands::settings::get_watcher_config,
            commands::settings::update_watcher_config,
            // agent 可访问目录 (JSON, 走 agent_access)
            commands::agent_access::get_agent_access,
            commands::agent_access::set_agent_access,
            // 全局元数据 (JSON, 走 global_meta_data) — 仅用于 memo-list 等
            commands::kv::get_setting,
            commands::kv::get_all_settings,
            commands::kv::set_setting,
            commands::kv::set_multiple_settings,
            commands::kv::delete_setting,
            // 笔记 / Doc (13 个, 合并 section 3+4+5+Doc)
            commands::memo::get_memos,
            commands::memo::search_mention_notes,
            commands::memo::read_memo,
            commands::memo::read_document,
            commands::memo::write_document,
            commands::memo::get_launch_open_files,
            commands::memo::add_document,
            commands::memo::import_external_document_to_memo,
            commands::memo::update_memo_db,
            commands::memo::finalize_memo_filename,
            commands::memo::delete_memo,
            commands::memo::clear_memos,
            commands::memo::favorite_memo,
            commands::memo::unfavorite_memo,
            commands::memo::set_memo_colors,
            commands::memo::list_memo_versions,
            commands::memo::read_memo_version,
            commands::memo::create_memo_version,
            commands::memo::restore_memo_version,
            commands::memo::delete_memo_version,
            commands::memo::search_memos,
            commands::memo::get_index_filename,
            // tag
            commands::tag::get_all_tags,
            commands::tag::create_memo_tag,
            commands::tag::rename_memo_tag,
            commands::tag::delete_memo_tag,
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
            // dialog
            commands::dialog::select_directory,
            commands::dialog::select_files,
            commands::dialog::save_file_dialog,
            commands::dialog::write_export_file,
            commands::dialog::save_attachment,
            commands::dialog::save_attachment_content,
            commands::dialog::copy_attachment_file,
            // agent
            commands::agent::chat_with_agent_stream,
            commands::agent::stop_agent_stream,
            commands::agent::agent_running_threads,
            // thread
            commands::thread::thread_list,
            commands::thread::thread_create,
            commands::thread::thread_get,
            commands::thread::thread_get_page,
            commands::thread::codex_thread_list,
            commands::thread::codex_thread_get,
            commands::thread::codex_thread_session_id,
            commands::thread::codex_default_model,
            commands::thread::thread_delete,
            commands::thread::thread_update_title,
            // window
            commands::window::open_preferences_window,
            // 全局"通过链接打开笔记"入口 ── 接收 URL / 物理路径, 解析 + emit
            open_target::handler::open_memo_by_target,
            // CLI sidecar JSON-RPC ── 前端通过 invoke('cli_invoke', { method, params }) 调
            commands::cli::cli_invoke,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            // 关窗时先发 graceful shutdown, 200ms 后兜底 kill ── 见
            // `SidecarHandle::try_shutdown`。
            tauri::RunEvent::ExitRequested { .. } => {
                let state = app_handle.state::<commands::AppState>();
                let cli_lock = state.flowix_cli.clone();
                tauri::async_runtime::block_on(async move {
                    let guard = cli_lock.read().await;
                    if let Some(cli) = guard.as_ref() {
                        let _ = cli
                            .try_shutdown(std::time::Duration::from_millis(200))
                            .await;
                    }
                });
            }
            // 兜底: 任何进程退出路径都把 child 杀掉, 避免僵尸。
            tauri::RunEvent::Exit => {
                let state = app_handle.state::<commands::AppState>();
                let cli_lock = state.flowix_cli.clone();
                tauri::async_runtime::block_on(async move {
                    let guard = cli_lock.read().await;
                    if let Some(cli) = guard.as_ref() {
                        cli.kill().await;
                    }
                });
            }
            _ => {}
        });
}
