mod context;
mod factory;
mod persistence;
mod prompt;
pub(crate) mod providers;
pub(crate) mod skills;
// `pub(crate)` because `commands::settings::test_ai_connection` calls
// `agent::provider::probe_chat` directly 鈥?but we keep the module's
// internal items (`pub(super)`) only visible to the `agent` module so
// we don't expose chat-stream plumbing outside of agent.rs.
pub(crate) mod provider;
mod state;
mod stream;
mod tool_runtime;
pub(crate) mod tools;
mod wire;

pub use crate::agent_types::{default_agent_id, AgentId, StatusInfo, UsageInfo};
#[allow(unused_imports)]
pub use wire::{
    AgentChatResponse, AgentChunk, AgentError, AgentRuntimeConfig, AgentUserMessage, RunInfo,
    RuntimePathConfig,
};

use std::collections::HashMap;
use std::sync::Arc;

use crate::agent_flowix::skills::SkillStore;
use crate::agent_session::ThreadManager;
use crate::config::AgentAccessStore;
use crate::config::SecurityBookmarkStore;
use crate::config::UserConfigStore;
use factory::CachedInstance;
use flowix_core::memo_file::MemoFile;
use state::{CallKey, InFlightChat};

/// AgentManager 鐜板湪鍙淮鎶?褰撳墠鐢熸晥鐨?provider 瀹炰緥", 鐪熸鐨勯厤缃湡婧愭槸
/// `~/.flowix/agent-config.toml` (缁?`UserConfigStore` 鏆撮湶)銆傛瘡娆?chat
/// 璋冪敤鍓嶈鏈€鏂伴厤缃? 涓庢瀯寤虹紦瀛樼殑閰嶇疆瀵规瘮, 涓嶄竴鑷村垯閲嶅缓 provider銆?///
/// 杩欐牱 ai_config 鍙樻洿 (渚嬪鐢ㄦ埛鍦ㄥ亸濂介噷鎹簡妯″瀷 / API key) 涓嶅啀渚濊禆鍓嶇閲嶆柊
/// "init agent", 鍚庣鑷繁鎰熺煡骞剁儹鏇挎崲銆?///
/// 涓変釜 `Arc<...>` 渚濊禆浠?`lib.rs` 娉ㄥ叆, 涓?`AppState` 鍏变韩鍚屼竴浠藉紩鐢?(refcount=2):
/// - `user_config`: 璇?agent-config.toml
/// - `thread_manager`: 钀界洏 chat 鍘嗗彶
/// - `memo_file`: 宸ュ叿璇诲啓鐨勭湡瀹炵瑪璁?///
/// 杩欎笁涓瓧娈典箣鍓嶆槸 `chat_stream` 绛夋柟娉曠殑 `app_state: &crate::app::state::AppState`
/// 鍙傛暟 鈹€鈹€ 妯″潡鍙嶅悜渚濊禆 commands銆傛敞鍏ュ悗 agent 涓嶅啀渚濊禆 commands 妯″潡, 鍙互
/// 鍗曠嫭娴嬭瘯 (瑙?`for_tests` 鏋勯€犲櫒)銆?
pub struct AgentManager {
    instance: tokio::sync::RwLock<Option<CachedInstance>>,
    /// 姣忎釜 thread 鐨?read 宸ュ叿蹇収銆俥dit 宸ュ叿闇€瑕?read 鍚庣殑鍐呭鍋氭紓绉绘娴嬨€?
    read_snapshots: tokio::sync::RwLock<HashMap<String, HashMap<String, String>>>,
    /// 姣忎釜 thread 鐨?(tool_name, args_hash) 鈫?绱璋冪敤娆℃暟銆?
    /// 瓒呰繃 STUCK_THRESHOLD 瑙嗕负 LLM 鍗″湪寰幆閲? 鐔旀柇銆侺LM 缁欐渶缁堝洖绛?
    /// (鏃?tool call) 鎴?chat 寮傚父閫€鍑烘椂鐢?chat_stream 鍏ュ彛娓呯┖銆?
    tool_call_attempts: tokio::sync::RwLock<HashMap<String, HashMap<CallKey, u32>>>,
    /// 姣忎釜 thread 褰撳墠姝ｅ湪璺戠殑 chat_stream 鐘舵€併€傚彇娑堟爣蹇椼€佸紑濮嬫椂闂淬€?    /// run_id 浠ュ墠鍒嗘暎鍦?`cancel_flags` / `started_at` 涓ゆ妸閿侀噷, 鐢熷懡鍛ㄦ湡
    /// 闇€瑕佷袱澶勫悓姝ョ淮鎶わ紱鐜板湪鏀舵暃鎴愬崟涓?registry, register / stop /
    /// unregister 閮藉彧鏀逛竴涓?entry銆?
    in_flight: tokio::sync::Mutex<HashMap<String, InFlightChat>>,
    /// ai_config 鐪熸簮 (`~/.flowix/agent-config.toml`)
    user_config: Arc<UserConfigStore>,
    /// 绾跨▼琛?(chat 鍘嗗彶鐨勬寔涔呭寲)
    thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>,
    /// 绗旇鏈枃浠?(宸ュ叿璇诲啓鐨勫璞?
    memo_file: Arc<std::sync::RwLock<MemoFile>>,
    /// Agent 鍙闂洰褰曠湡婧?(`~/.flowix/agent-access.json`)銆?
    /// `execute_tool` 鎶婂畠鍠傜粰 `ToolScope::from_memo_file_and_access`
    /// 鍐冲畾 `allowed_roots`, 涔熺敤鏉ヨ繃婊?`available_dirs` 宸ュ叿鐨勮繑鍥炪€?    // `agent-access.json` backs defaults and legacy/global fallback. For a
    // real agent-thread-card run, Flowix tool scope should use the message
    // runtime config workspace paths when present.
    agent_access: Arc<AgentAccessStore>,
    /// macOS security-scoped bookmarks for user-selected notebook / agent roots.
    security_bookmarks: Arc<SecurityBookmarkStore>,
    /// Skills registry (`~/.flowix/skills/.system/` + 鐢ㄦ埛鑷坊鍔?銆?
    /// 绯荤粺 prompt builder 璇?`summaries()` 娉ㄥ叆 "# Skills" 娈?
    /// `load_skill` 宸ュ叿 handler 璇?`get(name)` 鎷?body銆?
    /// 鍚姩鍚庝笉鍙彉 鈹€鈹€ 鏃犲唴閮ㄩ攣, `Arc` 鍏变韩缁?prompt builder / tool handler銆?
    skill_store: Arc<SkillStore>,
}

/// 鍦?`AgentManager` drop 鏃舵竻鎺変笌姣忎釜 thread 鍏宠仈鐨?in-memory 鐘舵€?鈹€鈹€
/// 瑙ｅ喅 #3.5: Tauri 杩涚▼閫€鍑烘椂 `instance: tokio::sync::RwLock<Option<CachedInstance>>`
/// 閲岀殑 `CachedInstance` (鍚?rllm client / reqwest HTTP client) 涓?/// graceful shutdown, 鍙兘閫犳垚:
/// - 鍦ㄩ璇锋眰琚埅鏂?(鐢ㄦ埛鐪嬪埌涓€鍗婄殑鍝嶅簲)
/// - 杩炴帴姹犳湭 flush (鎿嶄綔绯荤粺灞傞潰 close, 浣嗘垜浠病娉曠瓑)
///
/// 涓嶅湪 drop 閲?spawn 棰濆 task 寮?cancel 娲昏穬 stream 鈹€鈹€ 鐣欑粰 reqwest 鑷攢姣併€?/// `instance` / `read_snapshots` / `tool_call_attempts` / `in_flight` 閮芥槸
/// `Arc<...>`, 鍗曚釜 owner drop 鏃?refcount 鍑忎竴, 涓嶉樆濉炵湡姝ｇ殑 I/O 鍏冲仠銆?/// 鍙礋璐ｆ妸"鎴戜滑缁存姢鐨?鐘舵€佹樉寮忔墦 log, 渚夸簬鎺掗殰鏃跺尯鍒?鎴?drop 浜? vs
/// "杩涚▼琚?SIGKILL"銆?
impl Drop for AgentManager {
    fn drop(&mut self) {
        tracing::info!("[AgentManager] dropping; flushing in-memory state");
        // 閿佸彇涓嶅埌涓嶉樆濉?鈹€鈹€ 閿佷腑姣掓垨娲昏穬鍐欓攣閮戒笉浼氳 Drop 澶辫触, 杩欐潯
        // 璺緞鏄繘绋嬮€€鍑烘渶鍚庣殑娓呯悊, 涓嶈 panic銆?
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
    /// 鏋勯€犳椂蹇呴』浼犲叆鍏变韩渚濊禆 鈹€鈹€ 涓?`AppState` 鎸佹湁鍚屼竴浠?Arc 寮曠敤銆?    /// 杩欐牱 `agent` 妯″潡涓嶅啀渚濊禆 `AppState` (鍘嗗彶 P2-#2 鍙嶅悜渚濊禆)銆?
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

    /// 娴嬭瘯鐢?fixture 鈹€鈹€ 鐢ㄧ┖ / 涓存椂璺緞鏋勯€犱緷璧? 涓嶇湡姝ｈ鍐欎笟鍔＄鐩樸€?    /// 鐜板瓨鐨勫崟鍏冩祴璇曞彧楠岃瘉 `record_tool_call` / `clear_tool_call_attempts` /
    /// `cleanup_thread` 鐨?HashMap 鐘舵€? 涓嶈Е纰?`user_config` / `thread_manager` /
    /// `memo_file` / `agent_access` (鍙傝 `cleanup_thread_removes_read_snapshot`
    /// 娉ㄩ噴: "can't call `execute_tool_for_thread` because it lacks `memo_file`")銆?    /// skill_store 鐢ㄧ┖鐩綍鏋勯€?(娌℃湁 SKILL.md 鏃惰繑鍥炵┖ store, 涓嶅奖鍝嶆棦鏈夋柇瑷€)銆?
    #[cfg(test)]
    pub fn for_tests() -> Self {
        let home = std::env::temp_dir().join(format!("agent_mgr_test_{}", std::process::id()));
        std::fs::create_dir_all(&home).ok();
        let skills_root = home.join("skills");
        std::fs::create_dir_all(&skills_root).ok();
        Self::new(
            Arc::new(UserConfigStore::new(home.clone())),
            Arc::new(tokio::sync::RwLock::new(
                crate::agent_session::ThreadManager::for_tests(),
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
