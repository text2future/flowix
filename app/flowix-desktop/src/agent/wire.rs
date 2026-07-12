use serde::{Deserialize, Serialize};

/// 智能体 ID newtype ── 替代裸 `&str` / `String`, 防止把任意字符串当成 agent_id
/// 传进 [`crate::session::ThreadManager::create_thread`]。当前应用同一时刻只有
/// "当前 ai_config 描述的那一个 agent", schema 仍保留 `agent_id` 列以兼容历史
/// 数据, 全部写入 [`default_agent_id`]`()`。
///
/// `#[serde(transparent)]` 让 wire 形状就是 `String` (例如 `"default"`), 与
/// 历史上 `ThreadInfo.agent_id: String` **二进制兼容** ── 旧 SQLite 行 / 旧
/// IPC payload 不用迁移。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AgentId(pub String);

impl AgentId {
    pub fn new(s: &str) -> Self {
        Self(s.to_string())
    }
}

impl std::fmt::Display for AgentId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<String> for AgentId {
    fn from(s: String) -> Self {
        Self(s)
    }
}

impl From<&str> for AgentId {
    fn from(s: &str) -> Self {
        Self(s.to_string())
    }
}

/// 线程表 `agent_id` 列的固定占位值。重构后前端不再传 agent_id, 但 schema
/// 仍保留该列以兼容历史数据, 所有新建 thread 全部写入此值。
///
/// 用函数而非 `pub const` 是因为 `String` 不能在 const 上下文构造; 调用方
/// 应缓存返回值, 不要每处都重新分配。
pub fn default_agent_id() -> AgentId {
    AgentId::new("default")
}

/// `agent-chunk` 事件里的 `agent_type` 字段 ── Flowix 路径写死 "flowix",
/// 跟 CLI managers 的 `FlowixProviderKind::Flowix.key()` 对齐。前端
/// `dispatchAgentChunk` 拿这个值做按 runtime 路由的 fallback (e.g. Codex /
/// Claude / Gemini 不会传 `agent_type` 时, 用 `threadTypes[tid]` 兜底,
/// Flowix 直接走这条不需要 fallback)。
pub(super) const FLOWIX_AGENT_TYPE: &str = "flowix";

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePathConfig {
    pub cwd: Option<String>,
    #[serde(default)]
    pub workspace_paths: Vec<String>,
    /// Sandbox / 权限档位 ── "read-only" / "workspace-write" /
    /// "danger-full-access" / "inherit"。 各 CLI 自行 normalize。
    pub permission_mode: Option<String>,
    /// LLM model id(若该 provider 支持可配置)。
    /// 通用 metadata 协议字段 ── `StreamStart` chunk 通过 `model_for_runtime` 取值。
    pub model: Option<String>,
    /// 推理 effort("low" / "medium" / "high" / "xhigh")。
    /// 通用 metadata 协议字段,Provider 不支持时为 None。
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
    pub run_id: Option<String>,
    pub system_reminder_directory: Option<String>,
    /// 选中 Agent 类型 ── `'flowix' | 'codex' | 'claude'` (JSON wire: `agentType`).
    /// 前端 chat-store.ts `agent.chatStream()` 第二个入参 payload 字段.
    /// 后端按值分流 (见 `commands/agent.rs:chat_with_agent_stream`).
    pub agent_type: Option<String>,
    pub runtime_config: Option<AgentRuntimeConfig>,
    pub permission_mode: Option<String>,
    pub codex_model: Option<String>,
    pub codex_reasoning_effort: Option<String>,
    pub agent_role_memo_id: Option<String>,
    pub agent_role_name: Option<String>,
}

impl AgentUserMessage {
    /// 共享 accessor ── 所有 dispatch 方法都从这里取该 runtime 的配置。
    /// 早期实现是 7 个方法各自 match typeKey, 现在统一一处。
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

    pub fn codex_model_for_runtime(&self) -> Option<&str> {
        self.model_for_runtime("codex")
    }

    pub fn codex_reasoning_effort_for_runtime(&self) -> Option<&str> {
        self.reasoning_effort_for_runtime("codex")
    }

    /// 通用: 任意 provider 的 model 字段(由 StreamStart chunk 使用)。
    /// 优先从 `runtime_config.{type}.model` 取, fallback 到顶层 `codex_model` 字段
    /// (兼容老版本: 前端可能只填顶层 codex_model)。
    pub fn model_for_runtime(&self, runtime: &str) -> Option<&str> {
        self.runtime_config_for(runtime)
            .and_then(|config| config.model.as_deref())
            .or(self.codex_model.as_deref())
    }

    /// 通用: 任意 provider 的 reasoning effort。
    pub fn reasoning_effort_for_runtime(&self, runtime: &str) -> Option<&str> {
        self.runtime_config_for(runtime)
            .and_then(|config| config.reasoning_effort.as_deref())
            .or(self.codex_reasoning_effort.as_deref())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatResponse {
    /// Fire-and-forget 后永远是空串 ── `chat_stream` 内部 spawn 后立刻
    /// `Ok(String::new())` 返回。真正的助手回答走 `agent-chunk` 事件的
    /// `Text` / `Reasoning` 变体。保留字段是为了不破坏既有 IPC 形状。
    pub response: String,
}

/// `agent_running_threads` IPC 返回值 ── 一个 thread_id → 元信息的快照。
/// 启动时前端拉一次, seed `threadStates[].isLoading = true`。
///
/// `started_at` 用途: UI 显示"X 分钟前开始"; Phase 1 主要用 isLoading 布尔。
/// `current_tool` 暂为 None (见 [`AgentManager::running_threads`])。
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

/// Token usage breakdown emitted as a nested object on the `usage` field of
/// [`AgentChunk::Usage`]. Fields are all `Option` so that providers which do
/// not report a particular breakdown (e.g. only `total_tokens` is reported)
/// can still send the chunk without zero-filling every field.
///
/// `total_tokens` is used by the Rust `token_budget` cross-cycle breaker
/// (`AgentManager::chat_stream_inner`). `input_tokens` / `output_tokens` are
/// the new-protocol fields; `cached_input_tokens` is the cache-hit portion;
/// `reasoning_output_tokens` is o-series style internal consumption;
/// `model_context_window` is the provider-reported context window for UI.
///
/// Compatibility fields `prompt_tokens` / `completion_tokens` are intentionally
/// not part of this struct — old providers that only report them are mapped
/// to `input_tokens` / `output_tokens` at SSE-parse time
/// ([`crate::providers::openai_compatible`]), so the wire shape stays clean.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "snake_case")]
pub struct UsageInfo {
    pub input_tokens: Option<u32>,
    pub cached_input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
    pub reasoning_output_tokens: Option<u32>,
    pub total_tokens: Option<u32>,
    pub model_context_window: Option<u32>,
}

/// Provider-specific status snapshot emitted as a nested object on the
/// `status_info` field of [`AgentChunk::Usage`]. Fields use `codex_` /
/// `claude_` / `hermes_` prefixes to keep namespaces flat — we deliberately
/// do **not** nest a `codex: CodexStatus { ... }` sub-struct, because that
/// adds a layer that buys no real abstraction.
///
/// Fields are overwritten on every chunk (latest snapshot, not accumulated).
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "snake_case")]
pub struct StatusInfo {
    pub codex_plan_type: Option<String>,
    pub codex_used_percent: Option<f64>,
    pub codex_resets_at: Option<i64>,
}

/// agent 流式协议 — emit 到 `agent-chunk` 事件, 前端 `client.ts:listenToAgentStream`
/// 用 `listen<AgentChunk>` 接收。前端 TypeScript 镜像见
/// `app/flowix-web/types/agent.ts` 的同名类型。
///
/// 用 `#[serde(tag = "kind")]` 内部标签, 前端 `switch (chunk.kind)` 判别;
/// 替换之前 `[REASONING]:` / `[TOOL_CALL]:` / `[TOOL_RESULT]:` / `[ERROR]:`
/// 字符串前缀协议 ── 那种协议下 [ERROR] chunk 会被前端 fallthrough 当成普通文本
/// 拼到 assistant 正文, 这里是结构化错误事件。
///
/// **每个变体都带 `thread_id`** — 多对话后台并行时, 前端 store 按 thread_id
/// 派发到 `threadStates[tid]`, 互不串台。
///
/// **Wire 形状**: Tauri `app.emit("agent-chunk", &chunk)` 不经过 IPC 参数
/// camelCase 转换, 直接用 serde 序列化结果。`AgentChunk` 使用内部 tag:
/// `kind` 按 snake_case 输出, 字段名保持 snake_case ── `thread_id` 在 JSON 里就是 `thread_id`。
/// TS 端 listener 拿到的 `payload.thread_id` 与 Rust 字段同名
/// (与现有 `memo-event` 的 `payload.memo` / `payload.source` 命名习惯一致)。
/// 这跟 IPC command args/returns 的 `camelCase` 约定是两套规则 ──
/// 后者有 Tauri 自动转换, 前者没有, 不要混。
///
/// `StreamStart` / `StreamEnd` 是生命周期变体, 由 `chat_stream` 外层在
/// insert / remove cancel_flag 时各 emit 一次 ── 覆盖所有退出路径
/// (Ok / Err / panic-via-drop)。前端靠它们收敛 `isLoading`, 不再依赖
/// IPC `chat_with_agent_stream` 的 await finally 块 (该 IPC 在新模型下
/// 立即返回, 不再等待 stream 跑完)。
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentChunk {
    /// 助手流式回答 (普通 content)
    Text { thread_id: String, text: String },
    /// 推理模型的思考过程 (reasoning_content)
    Reasoning { thread_id: String, text: String },
    /// LLM 发出的工具调用
    ToolCall {
        thread_id: String,
        id: String,
        name: String,
        input: serde_json::Value,
    },
    /// 工具执行结果
    ToolResult {
        thread_id: String,
        id: String,
        name: String,
        result: serde_json::Value,
    },
    /// 错误事件 (卡死 / 超 cycle / stream error / not configured 等)
    // TODO: evolve into a structured variant ({ kind: "stuck" | "max_cycles" |
    // "stream" | "not_configured", ... }) when the frontend needs to discriminate
    // error sources. v1 keeps the message as opaque String ── the wire shape
    // crosses the IPC boundary as JSON and is parsed by `chat-store.ts:switch`.
    Error { thread_id: String, message: String },
    /// Stream 开始 ── chat_stream 入口 insert cancel_flag 后 emit 一次。
    /// 前端借此把对应 thread 的 `isLoading` 置 true。
    ///
    /// **`model` / `reasoning_effort` 是该 run 锁定的 LLM 配置** ──
    /// 由后端在 spawn 时确定(从用户配置/CLI override 解析),不依赖
    /// streaming 响应中暴露的 model 字段(部分 provider 不返回)。
    /// 通用协议: 对 OpenAI / Codex / Claude / Gemini 等所有 provider 一致。
    /// 字段均为 Option,旧 provider 暂不识别时为 None,前端 fallback 到
    /// 全局配置或显示 "—",不破坏协议。
    StreamStart {
        thread_id: String,
        model: Option<String>,
        reasoning_effort: Option<String>,
    },
    /// Stream 结束 ── chat_stream 出口 remove cancel_flag 前 emit 一次。
    /// 覆盖所有退出路径 (Ok / Err / panic)。`reason` 可选, 留作未来
    /// 区分 "自然完成" vs "用户主动 stop" vs "stuck 熔断" 等场景。
    StreamEnd {
        thread_id: String,
        reason: Option<String>,
    },
    /// Token usage increment — emitted multiple times per run (per turn /
    /// per stream tail). Token counts are accumulated by the frontend into
    /// `AgentRunState.usage`. `model_id` and `last_run_at` are top-level
    /// metadata, not nested under `usage`. `usage` is the nested token
    /// breakdown (see [`UsageInfo`]). `status_info` is the provider-specific
    /// status snapshot (see [`StatusInfo`]). Compatibility fields
    /// `prompt_tokens` / `completion_tokens` are no longer part of the wire —
    /// SSE parse layer maps them to `input_tokens` / `output_tokens` first.
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

/// agent 层错误。`Thread` / `UserConfig` 透传 `#[from]`, 让 agent 内部
/// `?` 一步到位 (例如 `manager.get_thread(...)?`)。语义错误 (stuck / max cycles /
/// not configured) 显式构造, 配合 Tauri IPC 边界 `.map_err(|e| e.to_string())`
/// 转字符串给前端。
///
/// 复合变体 `Thread(ThreadError::Sqlite(rusqlite::Error))` 显示为
/// `"agent error: thread error: thread database error: <rusqlite>"` ── 三层前缀。
/// 嫌长可改 `#[error(transparent)]` on the wrapper, 但 v1 保持显式便于排查。
#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("thread error: {0}")]
    Thread(#[from] crate::session::ThreadError),
    #[error("user config error: {0}")]
    UserConfig(#[from] crate::config::UserConfigError),
    #[error("llm provider error: {0}")]
    LlmProvider(String),
    #[error("ai model not configured; open Preferences → Agent to set model and api key")]
    NotConfigured,
    #[error("agent stuck: tool '{tool}' called {count} times with identical arguments")]
    Stuck { tool: String, count: u32 },
    /// 单次 `chat_stream` 跨所有 cycle 累计的 `total_tokens` 超出 ai_config 里
    /// 的 `max_total_tokens` 上限 ── 配合 `finalize_with_synthesized_message` 走
    /// "assistant 正常收口 + emit Error chunk" 路径, 与 `Stuck` 同形, UI 不弹
    /// 错误 toast。`used` / `budget` 一并带回便于前端展示用量。
    #[error("token budget exceeded: used {used} of {budget} total tokens")]
    TokenBudget { used: u32, budget: u32 },
}
