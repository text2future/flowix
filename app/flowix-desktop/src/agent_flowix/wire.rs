use serde::{Deserialize, Serialize};

use crate::agent_types::{StatusInfo, UsageInfo};

/// `agent-chunk` 浜嬩欢閲岀殑 `agent_type` 瀛楁 鈹€鈹€ Flowix 璺緞鍐欐 "flowix",
/// 璺?CLI managers 鐨?`FlowixProviderKind::Flowix.key()` 瀵归綈銆傚墠绔?/// `dispatchAgentChunk` 鎷胯繖涓€煎仛鎸?runtime 璺敱鐨?fallback (e.g. Codex /
/// Claude / Gemini 涓嶄細浼?`agent_type` 鏃? 鐢?`threadTypes[tid]` 鍏滃簳,
/// Flowix 鐩存帴璧拌繖鏉′笉闇€瑕?fallback)銆?
pub(super) const FLOWIX_AGENT_TYPE: &str = "flowix";

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePathConfig {
    pub cwd: Option<String>,
    #[serde(default)]
    pub workspace_paths: Vec<String>,
    /// Sandbox / 鏉冮檺妗ｄ綅 鈹€鈹€ "read-only" / "workspace-write" /
    /// "danger-full-access" / "inherit"銆?鍚?CLI 鑷 normalize銆?
    pub permission_mode: Option<String>,
    /// LLM model id(鑻ヨ provider 鏀寔鍙厤缃?銆?
    /// 閫氱敤 metadata 鍗忚瀛楁 鈹€鈹€ `StreamStart` chunk 閫氳繃 `model_for_runtime` 鍙栧€笺€?
    pub model: Option<String>,
    /// 鎺ㄧ悊 effort("low" / "medium" / "high" / "xhigh")銆?
    /// 閫氱敤 metadata 鍗忚瀛楁,Provider 涓嶆敮鎸佹椂涓?None銆?
    pub reasoning_effort: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeConfig {
    pub flowix: Option<RuntimePathConfig>,
    pub codex: Option<RuntimePathConfig>,
    pub claude: Option<RuntimePathConfig>,
    pub gemini: Option<RuntimePathConfig>,
    pub hermes: Option<RuntimePathConfig>,
    pub openclaw: Option<RuntimePathConfig>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentUserMessage {
    pub content: String,
    pub llm_content: Option<String>,
    #[serde(default)]
    pub image_paths: Vec<String>,
    pub run_id: Option<String>,
    pub system_reminder_directory: Option<String>,
    /// 閫変腑 Agent 绫诲瀷 鈹€鈹€ `'flowix' | 'codex' | 'claude'` (JSON wire: `agentType`).
    /// 鍓嶇 chat-store.ts `agent.chatStream()` 绗簩涓叆鍙?payload 瀛楁.
    /// 鍚庣鎸夊€煎垎娴?(瑙?`commands/agent.rs:chat_with_agent_stream`).
    pub agent_type: Option<String>,
    pub runtime_config: Option<AgentRuntimeConfig>,
    pub permission_mode: Option<String>,
    pub codex_model: Option<String>,
    pub codex_reasoning_effort: Option<String>,
    pub agent_role_memo_id: Option<String>,
    pub agent_role_name: Option<String>,
    /// Product-owned conversation title. The command persists this to
    /// `threads.title` before any runtime process can resolve a session id.
    pub conversation_title: Option<String>,
}

impl AgentUserMessage {
    /// 鍏变韩 accessor 鈹€鈹€ 鎵€鏈?dispatch 鏂规硶閮戒粠杩欓噷鍙栬 runtime 鐨勯厤缃€?    /// 鏃╂湡瀹炵幇鏄?7 涓柟娉曞悇鑷?match typeKey, 鐜板湪缁熶竴涓€澶勩€?
    fn runtime_config_for(&self, runtime: &str) -> Option<&RuntimePathConfig> {
        let config = self.runtime_config.as_ref()?;
        match runtime {
            "flowix" => config.flowix.as_ref(),
            "codex" => config.codex.as_ref(),
            "claude" => config.claude.as_ref(),
            "gemini" => config.gemini.as_ref(),
            "hermes" => config.hermes.as_ref(),
            "openclaw" => config.openclaw.as_ref(),
            _ => None,
        }
    }

    pub fn cwd_for_runtime(&self, runtime: &str) -> Option<&str> {
        self.runtime_config_for(runtime)
            .and_then(|config| config.cwd.as_deref())
            .or(self.system_reminder_directory.as_deref())
    }

    pub fn permission_mode_for_runtime(&self, runtime: &str) -> Option<&str> {
        self.runtime_config_for(runtime)
            .and_then(|config| config.permission_mode.as_deref())
            .or(self.permission_mode.as_deref())
    }

    pub fn workspace_paths_for_runtime(&self, runtime: &str) -> Vec<String> {
        self.runtime_config_for(runtime)
            .map(|config| config.workspace_paths.clone())
            .unwrap_or_default()
    }

    pub fn runtime_workspace_paths_for_runtime(&self, runtime: &str) -> Option<Vec<String>> {
        self.runtime_config_for(runtime)
            .map(|config| config.workspace_paths.clone())
    }

    pub fn codex_model_for_runtime(&self) -> Option<&str> {
        self.model_for_runtime("codex")
    }

    pub fn codex_reasoning_effort_for_runtime(&self) -> Option<&str> {
        self.reasoning_effort_for_runtime("codex")
    }

    /// 閫氱敤: 浠绘剰 provider 鐨?model 瀛楁(鐢?StreamStart chunk 浣跨敤)銆?    /// 浼樺厛浠?`runtime_config.{type}.model` 鍙? fallback 鍒伴《灞?`codex_model` 瀛楁銆?
    pub fn model_for_runtime(&self, runtime: &str) -> Option<&str> {
        self.runtime_config_for(runtime)
            .and_then(|config| config.model.as_deref())
            .or(self.codex_model.as_deref())
    }

    /// 閫氱敤: 浠绘剰 provider 鐨?reasoning effort銆?
    pub fn reasoning_effort_for_runtime(&self, runtime: &str) -> Option<&str> {
        self.runtime_config_for(runtime)
            .and_then(|config| config.reasoning_effort.as_deref())
            .or(self.codex_reasoning_effort.as_deref())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatResponse {
    /// Fire-and-forget 鍚庢案杩滄槸绌轰覆 鈹€鈹€ `chat_stream` 鍐呴儴 spawn 鍚庣珛鍒?
    /// `Ok(String::new())` 杩斿洖銆傜湡姝ｇ殑鍔╂墜鍥炵瓟璧?`agent-chunk` 浜嬩欢鐨?
    /// `Text` / `Reasoning` 鍙樹綋銆備繚鐣欏瓧娈垫槸涓轰簡涓嶇牬鍧忔棦鏈?IPC 褰㈢姸銆?
    pub response: String,
}

/// `agent_running_threads` IPC 杩斿洖鍊?鈹€鈹€ 涓€涓?thread_id 鈫?鍏冧俊鎭殑蹇収銆?/// 鍚姩鏃跺墠绔媺涓€娆? seed `threadStates[].isLoading = true`銆?///
/// `started_at` 鐢ㄩ€? UI 鏄剧ず"X 鍒嗛挓鍓嶅紑濮?; Phase 1 涓昏鐢?isLoading 甯冨皵銆?/// `current_tool` 鏆備负 None (瑙?[`AgentManager::running_threads`])銆?
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
    pub started_at: i64,
    pub current_tool: Option<String>,
    pub agent_type: Option<String>,
    pub run_id: Option<String>,
    /// Registry key used when the process was started. External CLIs may later
    /// resolve a provider-native session id; keeping this lets stop/reconcile
    /// distinguish the local launch id from the canonical session id.
    pub pending_thread_id: Option<String>,
    /// Provider-native session id once reported by the external CLI.
    pub session_id: Option<String>,
}

impl RunInfo {
    pub fn active(
        started_at: i64,
        current_tool: Option<&str>,
        agent_type: Option<&str>,
        run_id: Option<String>,
        pending_thread_id: Option<String>,
        session_id: Option<String>,
    ) -> Self {
        Self {
            started_at,
            current_tool: current_tool.map(str::to_string),
            agent_type: agent_type.map(str::to_string),
            run_id,
            pending_thread_id,
            session_id,
        }
    }
}

/// agent 娴佸紡鍗忚 鈥?emit 鍒?`agent-chunk` 浜嬩欢, 鍓嶇 `client.ts:listenToAgentStream`
/// 鐢?`listen<AgentChunk>` 鎺ユ敹銆傚墠绔?TypeScript 闀滃儚瑙?/// `app/flowix-web/types/agent.ts` 鐨勫悓鍚嶇被鍨嬨€?///
/// 鐢?`#[serde(tag = "kind")]` 鍐呴儴鏍囩, 鍓嶇 `switch (chunk.kind)` 鍒ゅ埆;
/// 鏇挎崲涔嬪墠 `[REASONING]:` / `[TOOL_CALL]:` / `[TOOL_RESULT]:` / `[ERROR]:`
/// 瀛楃涓插墠缂€鍗忚 鈹€鈹€ 閭ｇ鍗忚涓?[ERROR] chunk 浼氳鍓嶇 fallthrough 褰撴垚鏅€氭枃鏈?/// 鎷煎埌 assistant 姝ｆ枃, 杩欓噷鏄粨鏋勫寲閿欒浜嬩欢銆?///
/// **姣忎釜鍙樹綋閮藉甫 `thread_id`** 鈥?澶氬璇濆悗鍙板苟琛屾椂, 鍓嶇 store 鎸?thread_id
/// 娲惧彂鍒?`threadStates[tid]`, 浜掍笉涓插彴銆?///
/// **Wire 褰㈢姸**: Tauri `app.emit("agent-chunk", &chunk)` 涓嶇粡杩?IPC 鍙傛暟
/// camelCase 杞崲, 鐩存帴鐢?serde 搴忓垪鍖栫粨鏋溿€俙AgentChunk` 浣跨敤鍐呴儴 tag:
/// `kind` 鎸?snake_case 杈撳嚭, 瀛楁鍚嶄繚鎸?snake_case 鈹€鈹€ `thread_id` 鍦?JSON 閲屽氨鏄?`thread_id`銆?/// TS 绔?listener 鎷垮埌鐨?`payload.thread_id` 涓?Rust 瀛楁鍚屽悕
/// (涓庣幇鏈?`memo-event` 鐨?`payload.memo` / `payload.source` 鍛藉悕涔犳儻涓€鑷?銆?/// 杩欒窡 IPC command args/returns 鐨?`camelCase` 绾﹀畾鏄袱濂楄鍒?鈹€鈹€
/// 鍚庤€呮湁 Tauri 鑷姩杞崲, 鍓嶈€呮病鏈? 涓嶈娣枫€?///
/// `StreamStart` / `StreamEnd` 鏄敓鍛藉懆鏈熷彉浣? 鐢?`chat_stream` 澶栧眰鍦?/// insert / remove cancel_flag 鏃跺悇 emit 涓€娆?鈹€鈹€ 瑕嗙洊鎵€鏈夐€€鍑鸿矾寰?/// (Ok / Err / panic-via-drop)銆傚墠绔潬瀹冧滑鏀舵暃 `isLoading`, 涓嶅啀渚濊禆
/// IPC `chat_with_agent_stream` 鐨?await finally 鍧?(璇?IPC 鍦ㄦ柊妯″瀷涓?/// 绔嬪嵆杩斿洖, 涓嶅啀绛夊緟 stream 璺戝畬)銆?
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentChunk {
    /// 鍔╂墜娴佸紡鍥炵瓟 (鏅€?content)
    Text { thread_id: String, text: String },
    /// 鎺ㄧ悊妯″瀷鐨勬€濊€冭繃绋?(reasoning_content)
    Reasoning { thread_id: String, text: String },
    /// LLM 鍙戝嚭鐨勫伐鍏疯皟鐢?
    ToolCall {
        thread_id: String,
        id: String,
        name: String,
        input: serde_json::Value,
    },
    /// 宸ュ叿鎵ц缁撴灉
    ToolResult {
        thread_id: String,
        id: String,
        name: String,
        result: serde_json::Value,
    },
    /// 閿欒浜嬩欢 (鍗℃ / 瓒?cycle / stream error / not configured 绛?
    // TODO: evolve into a structured variant ({ kind: "stuck" | "max_cycles" |
    // "stream" | "not_configured", ... }) when the frontend needs to discriminate
    // error sources. v1 keeps the message as opaque String 鈹€鈹€ the wire shape
    // crosses the IPC boundary as JSON and is parsed by `chat-store.ts:switch`.
    Error { thread_id: String, message: String },
    /// Stream 寮€濮?鈹€鈹€ chat_stream 鍏ュ彛 insert cancel_flag 鍚?emit 涓€娆°€?
    /// 鍓嶇鍊熸鎶婂搴?thread 鐨?`isLoading` 缃?true銆?
    ///
    /// **`model` / `reasoning_effort` 鏄 run 閿佸畾鐨?LLM 閰嶇疆** 鈹€鈹€
    /// 鐢卞悗绔湪 spawn 鏃剁‘瀹?浠庣敤鎴烽厤缃?CLI override 瑙ｆ瀽),涓嶄緷璧?
    /// streaming 鍝嶅簲涓毚闇茬殑 model 瀛楁(閮ㄥ垎 provider 涓嶈繑鍥?銆?
    /// 閫氱敤鍗忚: 瀵?OpenAI / Codex / Claude / Gemini 绛夋墍鏈?provider 涓€鑷淬€?
    /// 瀛楁鍧囦负 Option,鏃?provider 鏆備笉璇嗗埆鏃朵负 None,鍓嶇 fallback 鍒?
    /// 鍏ㄥ眬閰嶇疆鎴栨樉绀?"鈥?,涓嶇牬鍧忓崗璁€?
    StreamStart {
        thread_id: String,
        model: Option<String>,
        reasoning_effort: Option<String>,
    },
    /// Stream 缁撴潫 鈹€鈹€ chat_stream 鍑哄彛 remove cancel_flag 鍓?emit 涓€娆°€?
    /// 瑕嗙洊鎵€鏈夐€€鍑鸿矾寰?(Ok / Err / panic)銆俙reason` 鍙€? 鐣欎綔鏈潵
    /// 鍖哄垎 "鑷劧瀹屾垚" vs "鐢ㄦ埛涓诲姩 stop" vs "stuck 鐔旀柇" 绛夊満鏅€?
    StreamEnd {
        thread_id: String,
        reason: Option<String>,
    },
    /// Token usage increment 鈥?emitted multiple times per run (per turn /
    /// per stream tail). Token counts are accumulated by the frontend into
    /// `AgentRunState.usage`. `model_id` and `last_run_at` are top-level
    /// metadata, not nested under `usage`. `usage` is the nested token
    /// breakdown (see [`UsageInfo`]). `status_info` is the provider-specific
    /// status snapshot (see [`StatusInfo`]). Compatibility fields
    /// `prompt_tokens` / `completion_tokens` are no longer part of the wire 鈥?    /// SSE parse layer maps them to `input_tokens` / `output_tokens` first.
    Usage {
        thread_id: String,
        model_id: Option<String>,
        last_run_at: Option<i64>,
        usage: Option<UsageInfo>,
        status_info: Option<StatusInfo>,
    },
    /// External CLI runtime resolved a temporary frontend thread id to the
    /// durable provider session id. The frontend uses this to canonicalize
    /// document thread ids without polling.
    SessionResolved {
        thread_id: String,
        session_id: String,
    },
}

impl AgentChunk {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Text { .. } => "text",
            Self::Reasoning { .. } => "reasoning",
            Self::ToolCall { .. } => "tool_call",
            Self::ToolResult { .. } => "tool_result",
            Self::Error { .. } => "error",
            Self::StreamStart { .. } => "stream_start",
            Self::StreamEnd { .. } => "stream_end",
            Self::SessionResolved { .. } => "session_resolved",
            Self::Usage { .. } => "usage",
        }
    }

    pub fn thread_id(&self) -> &str {
        match self {
            Self::Text { thread_id, .. }
            | Self::Reasoning { thread_id, .. }
            | Self::ToolCall { thread_id, .. }
            | Self::ToolResult { thread_id, .. }
            | Self::Error { thread_id, .. }
            | Self::StreamStart { thread_id, .. }
            | Self::StreamEnd { thread_id, .. }
            | Self::SessionResolved { thread_id, .. }
            | Self::Usage { thread_id, .. } => thread_id,
        }
    }
}
/// Agent-layer error converted to strings at the IPC boundary.
#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("thread error: {0}")]
    Thread(#[from] crate::agent_session::ThreadError),
    #[error("user config error: {0}")]
    UserConfig(#[from] crate::config::UserConfigError),
    #[error("llm provider error: {0}")]
    LlmProvider(String),
    #[error("ai model not configured; open Preferences 鈫?Agent to set model and api key")]
    NotConfigured,
    #[error("agent stuck: tool '{tool}' called {count} times with identical arguments")]
    Stuck { tool: String, count: u32 },
    /// 鍗曟 `chat_stream` 璺ㄦ墍鏈?cycle 绱鐨?`total_tokens` 瓒呭嚭 ai_config 閲?    /// 鐨?`max_total_tokens` 涓婇檺 鈹€鈹€ 閰嶅悎 `finalize_with_synthesized_message` 璧?    /// "assistant 姝ｅ父鏀跺彛 + emit Error chunk" 璺緞, 涓?`Stuck` 鍚屽舰, UI 涓嶅脊
    /// 閿欒 toast銆俙used` / `budget` 涓€骞跺甫鍥炰究浜庡墠绔睍绀虹敤閲忋€?
    #[error("token budget exceeded: used {used} of {budget} total tokens")]
    TokenBudget { used: u32, budget: u32 },
}
