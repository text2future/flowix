use std::sync::{Arc, RwLock};

use crate::agent_external::claude::ClaudeCliManager;
use crate::agent_external::codex::CodexCliManager;
use crate::agent_external::hermes::HermesCliManager;
use crate::agent_external::simple_cli;
use crate::agent_external_config::AgentExternalConfig;
use crate::agent_flowix::AgentManager;
use crate::agent_session::ThreadManager;
use crate::config::{AgentAccessStore, SecurityBookmarkStore, UserConfigStore};
use crate::system_data::SystemData;
use flowix_core::memo_file::MemoFile;
use flowix_core::search::MemoIndex;

/// 搴旂敤鐘舵€?鈥?閫氳繃 `tauri::State<AppState>` 娉ㄥ叆鍒?Tauri 鍛戒护鍜岃繍琛屾椂鏈嶅姟銆?///
/// `user_config` / `memo_file` / `thread_manager` 涓?`agent_manager` 涔嬮棿浼氬叡浜?/// 寮曠敤 (渚嬪 `AgentManager` 闇€瑕佽鍐?thread_manager / memo_file), 鍏变韩褰㈡€佹槸
/// `Arc<...>`, 涓嶆槸 `Arc<RwLock<...>>` 濂楀▋銆傞攣鐨勪綅缃湪鍏蜂綋瀛楁鍐呴儴銆?///
/// `search` / `system_data` 娌℃湁璺ㄦā鍧楅渶姹? 淇濇寔鍘熸牱 (鏃?Arc 鍖呰)銆?
pub struct AppState {
    pub user_config: Arc<UserConfigStore>,
    /// System metadata (notebook tag order/layout/hidden state).
    /// Stored at `~/.flowix/boot/system.json`.
    pub system_data: SystemData,
    /// External CLI 璺緞閰嶇疆 (`~/.flowix/agent-external-config.json`) 鈹€鈹€
    /// codex/claude/gemini/hermes/openclaw 鎵ц璺緞鐨勫敮涓€鍙傜収, 鍚姩鎺㈡祴鍐欏叆,
    /// 杩愯鏃?`resolve_external_cli` 鍛戒腑鍗崇敤銆?
    pub agent_external_config: AgentExternalConfig,
    pub memo_file: Arc<RwLock<MemoFile>>,
    /// 褰撳墠 notebook 鐨勫叏鏂囨悳绱㈢储寮?(鍐呭瓨鍊掓帓). 鍒囨崲 notebook 鏃?rebuild;
    /// 鍐欏懡浠ゅ閲?upsert/remove.
    pub search: RwLock<MemoIndex>,
    pub agent_manager: Arc<AgentManager>,
    pub codex_cli_manager: Arc<CodexCliManager>,
    pub claude_cli_manager: Arc<ClaudeCliManager>,
    pub gemini_cli_manager: Arc<simple_cli::SimpleCliManager>,
    pub hermes_cli_manager: Arc<HermesCliManager>,
    pub openclaw_cli_manager: Arc<simple_cli::SimpleCliManager>,
    pub thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>,
    /// Agent 鍙闂洰褰?(notebook + 鐢ㄦ埛鑷坊鍔?folder), 鎸佷箙鍖栧湪
    /// `~/.flowix/agent-access.json`銆傞┍鍔?[`crate::agent_flowix::tools::ToolScope`]
    /// 鐨?`allowed_roots` 涓?`available_dirs` 宸ュ叿鐨勮繃婊ゃ€?
    pub agent_access: Arc<AgentAccessStore>,
    pub security_bookmarks: Arc<SecurityBookmarkStore>,
}
