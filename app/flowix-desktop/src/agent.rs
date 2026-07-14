mod context;
mod factory;
mod persistence;
// `pub(crate)` because `commands::settings::test_ai_connection` calls
// `agent::provider::probe_chat` directly — but we keep the module's
// internal items (`pub(super)`) only visible to the `agent` module so
// we don't expose chat-stream plumbing outside of agent.rs.
pub(crate) mod provider;
mod state;
mod stream;
mod tools;
mod wire;

#[allow(unused_imports)]
pub use wire::{
    default_agent_id, AgentChatResponse, AgentChunk, AgentError, AgentId, AgentRuntimeConfig,
    AgentUserMessage, RunInfo, RuntimePathConfig, StatusInfo, UsageInfo,
};

use std::collections::HashMap;
use std::sync::Arc;

use crate::config::AgentAccessStore;
use crate::config::SecurityBookmarkStore;
use crate::config::UserConfigStore;
use crate::session::ThreadManager;
use crate::skills::SkillStore;
use factory::CachedInstance;
use flowix_core::memo_file::MemoFile;
use state::{CallKey, InFlightChat};

/// AgentManager 现在只维护"当前生效的 provider 实例", 真正的配置真源是
/// `~/.flowix/agent-config.toml` (经 `UserConfigStore` 暴露)。每次 chat
/// 调用前读最新配置, 与构建缓存的配置对比, 不一致则重建 provider。
///
/// 这样 ai_config 变更 (例如用户在偏好里换了模型 / API key) 不再依赖前端重新
/// "init agent", 后端自己感知并热替换。
///
/// 三个 `Arc<...>` 依赖从 `lib.rs` 注入, 与 `AppState` 共享同一份引用 (refcount=2):
/// - `user_config`: 读 agent-config.toml
/// - `thread_manager`: 落盘 chat 历史
/// - `memo_file`: 工具读写的真实笔记
///
/// 这三个字段之前是 `chat_stream` 等方法的 `app_state: &crate::commands::AppState`
/// 参数 ── 模块反向依赖 commands。注入后 agent 不再依赖 commands 模块, 可以
/// 单独测试 (见 `for_tests` 构造器)。
pub struct AgentManager {
    instance: tokio::sync::RwLock<Option<CachedInstance>>,
    /// 每个 thread 的 read 工具快照。edit 工具需要 read 后的内容做漂移检测。
    read_snapshots: tokio::sync::RwLock<HashMap<String, HashMap<String, String>>>,
    /// 每个 thread 的 (tool_name, args_hash) → 累计调用次数。
    /// 超过 STUCK_THRESHOLD 视为 LLM 卡在循环里, 熔断。LLM 给最终回答
    /// (无 tool call) 或 chat 异常退出时由 chat_stream 入口清空。
    tool_call_attempts: tokio::sync::RwLock<HashMap<String, HashMap<CallKey, u32>>>,
    /// 每个 thread 当前正在跑的 chat_stream 状态。取消标志、开始时间、
    /// run_id 以前分散在 `cancel_flags` / `started_at` 两把锁里, 生命周期
    /// 需要两处同步维护；现在收敛成单个 registry, register / stop /
    /// unregister 都只改一个 entry。
    in_flight: tokio::sync::Mutex<HashMap<String, InFlightChat>>,
    /// ai_config 真源 (`~/.flowix/agent-config.toml`)
    user_config: Arc<UserConfigStore>,
    /// 线程表 (chat 历史的持久化)
    thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>,
    /// 笔记本文件 (工具读写的对象)
    memo_file: Arc<std::sync::RwLock<MemoFile>>,
    /// Agent 可访问目录真源 (`~/.flowix/agent-access.json`)。
    /// `execute_tool` 把它喂给 `ToolScope::from_memo_file_and_access`
    /// 决定 `allowed_roots`, 也用来过滤 `available_dirs` 工具的返回。
    // `agent-access.json` backs defaults and legacy/global fallback. For a
    // real agent-thread-card run, Flowix tool scope should use the message
    // runtime config workspace paths when present.
    agent_access: Arc<AgentAccessStore>,
    /// macOS security-scoped bookmarks for user-selected notebook / agent roots.
    security_bookmarks: Arc<SecurityBookmarkStore>,
    /// Skills registry (`~/.flowix/skills/.system/` + 用户自添加)。
    /// 系统 prompt builder 读 `summaries()` 注入 "# Skills" 段;
    /// `load_skill` 工具 handler 读 `get(name)` 拿 body。
    /// 启动后不可变 ── 无内部锁, `Arc` 共享给 prompt builder / tool handler。
    skill_store: Arc<SkillStore>,
}

/// 在 `AgentManager` drop 时清掉与每个 thread 关联的 in-memory 状态 ──
/// 解决 #3.5: Tauri 进程退出时 `instance: tokio::sync::RwLock<Option<CachedInstance>>`
/// 里的 `CachedInstance` (含 rllm client / reqwest HTTP client) 不
/// graceful shutdown, 可能造成:
/// - 在飞请求被截断 (用户看到一半的响应)
/// - 连接池未 flush (操作系统层面 close, 但我们没法等)
///
/// 不在 drop 里 spawn 额外 task 强 cancel 活跃 stream ── 留给 reqwest 自销毁。
/// `instance` / `read_snapshots` / `tool_call_attempts` / `in_flight` 都是
/// `Arc<...>`, 单个 owner drop 时 refcount 减一, 不阻塞真正的 I/O 关停。
/// 只负责把"我们维护的"状态显式打 log, 便于排障时区分"我 drop 了" vs
/// "进程被 SIGKILL"。
impl Drop for AgentManager {
    fn drop(&mut self) {
        tracing::info!("[AgentManager] dropping; flushing in-memory state");
        // 锁取不到不阻塞 ── 锁中毒或活跃写锁都不会让 Drop 失败, 这条
        // 路径是进程退出最后的清理, 不该 panic。
        if let Ok(snapshots) = self.read_snapshots.try_read() {
            if !snapshots.is_empty() {
                tracing::info!(
                    "[AgentManager] dropping with {} read_snapshots entries",
                    snapshots.len()
                );
            }
        }
        if let Ok(attempts) = self.tool_call_attempts.try_read() {
            if !attempts.is_empty() {
                tracing::info!(
                    "[AgentManager] dropping with {} tool_call_attempts entries",
                    attempts.len()
                );
            }
        }
        if let Ok(in_flight) = self.in_flight.try_lock() {
            if !in_flight.is_empty() {
                tracing::info!(
                    "[AgentManager] dropping with {} active in-flight chats",
                    in_flight.len()
                );
            }
        }
    }
}

impl AgentManager {
    /// 构造时必须传入共享依赖 ── 与 `AppState` 持有同一份 Arc 引用。
    /// 这样 `agent` 模块不再依赖 `commands::AppState` (历史 P2-#2 反向依赖)。
    pub fn new(
        user_config: Arc<UserConfigStore>,
        thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>,
        memo_file: Arc<std::sync::RwLock<MemoFile>>,
        agent_access: Arc<AgentAccessStore>,
        security_bookmarks: Arc<SecurityBookmarkStore>,
        skill_store: Arc<SkillStore>,
    ) -> Self {
        Self {
            instance: tokio::sync::RwLock::new(None),
            read_snapshots: tokio::sync::RwLock::new(HashMap::new()),
            tool_call_attempts: tokio::sync::RwLock::new(HashMap::new()),
            in_flight: tokio::sync::Mutex::new(HashMap::new()),
            user_config,
            thread_manager,
            memo_file,
            agent_access,
            security_bookmarks,
            skill_store,
        }
    }

    /// 测试用 fixture ── 用空 / 临时路径构造依赖, 不真正读写业务磁盘。
    /// 现存的单元测试只验证 `record_tool_call` / `clear_tool_call_attempts` /
    /// `cleanup_thread` 的 HashMap 状态, 不触碰 `user_config` / `thread_manager` /
    /// `memo_file` / `agent_access` (参见 `cleanup_thread_removes_read_snapshot`
    /// 注释: "can't call `execute_tool_for_thread` because it lacks `memo_file`")。
    /// skill_store 用空目录构造 (没有 SKILL.md 时返回空 store, 不影响既有断言)。
    #[cfg(test)]
    pub fn for_tests() -> Self {
        let home = std::env::temp_dir().join(format!("agent_mgr_test_{}", std::process::id()));
        std::fs::create_dir_all(&home).ok();
        let skills_root = home.join("skills");
        std::fs::create_dir_all(&skills_root).ok();
        Self::new(
            Arc::new(UserConfigStore::new(home.clone())),
            Arc::new(tokio::sync::RwLock::new(
                crate::session::ThreadManager::for_tests(),
            )),
            Arc::new(std::sync::RwLock::new(MemoFile::default())),
            Arc::new(AgentAccessStore::new(
                home.join(".flowix"),
                &MemoFile::default(),
            )),
            Arc::new(SecurityBookmarkStore::new(home.join(".flowix"))),
            Arc::new(SkillStore::load(&skills_root)),
        )
    }
}

#[cfg(test)]
mod tests;
