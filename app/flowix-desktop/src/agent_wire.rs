//! Agent wire 类型 ── `chat_with_agent_stream` IPC 与 `agent-chunk` 事件的
//! 共享协议层。旧内置 provider 移除后,
//! external CLI runtimes (codex / claude / hermes / opencode / deepseek-harness)
//! 仍是这些类型的唯一消费者, 因此独立成顶层模块。
//!
//! 字段命名与序列化形状必须与前端镜像 `app/flowix-web/types/agent.ts`
//! 保持一致; 修改任何字段都是破坏 IPC 契约。

use serde::{Deserialize, Serialize};

/// Structured diagnostics attached to an external runtime error.
///
/// All fields after `category` are optional so older persisted error chunks
/// remain valid. The wire uses snake_case because `AgentChunk` is emitted as
/// a raw Tauri event rather than through the camelCase IPC adapter.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct AgentErrorDetails {
    pub category: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_code: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub retryable: bool,
}

// external runtimes 直接从 `agent_wire` 取这几个共享类型。
pub use crate::agent_types::{AgentId, StatusInfo, UsageInfo};

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePathConfig {
    pub cwd: Option<String>,
    #[serde(default)]
    pub workspace_paths: Vec<String>,
    /// Sandbox / 权限档位 ── "read-only" / "workspace-write" /
    /// "danger-full-access" / "inherit"。各 CLI 自行 normalize。
    pub permission_mode: Option<String>,
    /// LLM model id(若是 provider 路由需要)。
    /// 通用 metadata 协议字段 ── `StreamStart` chunk 通过 `model_for_runtime` 取值。
    pub model: Option<String>,
    /// DeepSeek Harness llm-pi-ai provider route. `None` preserves the
    /// legacy/default route when an older conversation has no provider ID.
    pub provider_id: Option<String>,
    /// 推理 effort("low" / "medium" / "high" / "xhigh")。
    /// 通用 metadata 协议字段,Provider 不支持时为 None。
    pub reasoning_effort: Option<String>,
    /// DeepSeek Harness conversation preset: standard / code / minimal / cordis.
    pub mode: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeConfig {
    pub codex: Option<RuntimePathConfig>,
    pub claude: Option<RuntimePathConfig>,
    pub hermes: Option<RuntimePathConfig>,
    pub opencode: Option<RuntimePathConfig>,
    pub deepseek_harness: Option<RuntimePathConfig>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentUserMessage {
    pub content: String,
    /// 前端拼接的首条消息上下文(Role memo / flowix CLI 提示块)落在这,
    /// 与展示用 `content` 分离。external runtime 持久化 UserMessage chunk
    /// 时优先取它。
    pub llm_content: Option<String>,
    #[serde(default)]
    pub image_paths: Vec<String>,
    pub run_id: Option<String>,
    pub system_reminder_directory: Option<String>,
    /// 选中 Agent 类型 ── `'codex' | 'claude' | 'hermes' | 'opencode' |
    /// 'deepseek-harness'` (JSON wire: `agentType`).
    /// 前端 `agent.chatStream()` 负责填 payload 字段.
    /// 后端按值分流(见 `commands/agent.rs:chat_with_agent_stream`).
    pub agent_type: Option<String>,
    pub runtime_config: Option<AgentRuntimeConfig>,
    pub permission_mode: Option<String>,
    pub codex_model: Option<String>,
    pub codex_reasoning_effort: Option<String>,
    pub conversation_title: Option<String>,
}

impl AgentUserMessage {
    /// 共享 accessor ── 所有 dispatch 方法都从这里取该 runtime 的配置。
    /// 早期实现是 7 个方法各自 match typeKey, 现在统一一处。
    fn runtime_config_for(&self, runtime: &str) -> Option<&RuntimePathConfig> {
        let config = self.runtime_config.as_ref()?;
        match runtime {
            "codex" => config.codex.as_ref(),
            "claude" => config.claude.as_ref(),
            "hermes" => config.hermes.as_ref(),
            "opencode" => config.opencode.as_ref(),
            "deepseek-harness" => config.deepseek_harness.as_ref(),
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

    /// 通用: 任意 provider 的 model 字段(`StreamStart` chunk 使用)。
    /// 优先 `runtime_config.{type}.model`, fallback 到顶层 `codex_model` 字段。
    pub fn model_for_runtime(&self, runtime: &str) -> Option<&str> {
        self.runtime_config_for(runtime)
            .and_then(|config| config.model.as_deref())
            .or(self.codex_model.as_deref())
    }

    pub fn provider_id_for_runtime(&self, runtime: &str) -> Option<&str> {
        self.runtime_config_for(runtime)
            .and_then(|config| config.provider_id.as_deref())
            .filter(|value| !value.trim().is_empty())
    }

    /// 通用: 任意 provider 的 reasoning effort。
    pub fn reasoning_effort_for_runtime(&self, runtime: &str) -> Option<&str> {
        self.runtime_config_for(runtime)
            .and_then(|config| config.reasoning_effort.as_deref())
            .or(self.codex_reasoning_effort.as_deref())
    }

    pub fn mode_for_runtime(&self, runtime: &str) -> Option<&str> {
        self.runtime_config_for(runtime)
            .and_then(|config| config.mode.as_deref())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatResponse {
    /// Fire-and-forget 后永远是空串 ── `chat_stream` 内部 spawn 后立即
    /// `Ok(String::new())` 返回。真正的助手回答走 `agent-chunk` 事件的
    /// `Text` / `Reasoning` 变体。保留字段是为了不破坏既有 IPC 形状。
    pub response: String,
}

/// `agent_running_threads` IPC 返回值 ── 一个 thread_id 的元信息集合。
/// 启动时前端调一次, 用来 seed `threadStates[].isLoading = true`。
///
/// `started_at` 用于 UI 显示"X 分钟前开始"; Phase 1 主要是 isLoading 布尔,
/// `current_tool` 暂为 None (见 external runtime 各 manager)。
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

/// agent 流式协议 ── emit 到 `agent-chunk` 事件, 前端 `client.ts:listenToAgentStream`
/// 用 `listen<AgentChunk>` 接收。前端 TypeScript 镜像在
/// `app/flowix-web/types/agent.ts` 的同名类型。
///
/// 用 `#[serde(tag = "kind")]` 内部标记, 前端按 `switch (chunk.kind)` 判别;
///
/// **每个变体都带 `thread_id`** ── 多会话后台并行时, 前端 store 按 thread_id
/// 派发到 `threadStates[tid]`, 互不串台。
///
/// **Wire 形状**: Tauri `app.emit("agent-chunk", &chunk)` 不经过 IPC 参数
/// camelCase 转换, 直接是 serde 序列化结果。`AgentChunk` 使用内部 tag:
/// `kind` 按 snake_case 输出, 字段名保持 snake_case ── `thread_id` 在 JSON 里就是
/// `thread_id`, TS 侧 listener 拿到 `payload.thread_id` 与 Rust 字段同名。
/// 这跟 IPC command args/returns 的 `camelCase` 约定是两套 ──
/// 后者有 Tauri 宏转换, 前者没有, 不要混淆。
///
/// **`StreamStart` / `StreamEnd` 是生命周期变体**, 各 runtime 在 spawn /
/// 收尾时各 emit 一次 ── 覆盖所有退出路径 (Ok / Err / panic-via-drop)。
/// 前端用它们收敛 `isLoading`, 不再依赖 IPC `chat_with_agent_stream` 的
/// await finally 块(IPC 在新模型下立即返回, 不再等待 stream 跑完)。
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentChunk {
    /// Product-owned user message. External runtimes persist this before
    /// StreamStart so their normalized event log is a complete display source
    /// and does not need transcript rows mixed into it on replay.
    UserMessage {
        thread_id: String,
        id: String,
        text: String,
        timestamp: i64,
    },
    /// 助手流式回答 (普通 content)
    Text { thread_id: String, text: String },
    /// 推理模型的思考过程 (reasoning_content)
    Reasoning { thread_id: String, text: String },
    /// Codex automatically compacted the conversation context.
    ContextCompaction { thread_id: String, id: String },
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
    /// DSH human command lifecycle. This is an operation projection, not a
    /// model turn; the durable source remains DSH's command/run + command/done
    /// event pair and the frontend reconciles it with history afterwards.
    DshCommand {
        thread_id: String,
        id: String,
        name: String,
        args: String,
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<String>,
        timestamp: i64,
    },
    /// Codex-native slash command lifecycle. Codex handles `/compact` and
    /// `/goal` as protocol operations, so they do not appear as ordinary
    /// `userMessage` transcript items. This product-owned row keeps the
    /// command visible and drives the composer busy state.
    CodexCommand {
        thread_id: String,
        id: String,
        command: String,
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<String>,
        timestamp: i64,
    },
    /// 错误事件。`error_details` 是可选的，以兼容历史落盘消息。
    Error {
        thread_id: String,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_details: Option<AgentErrorDetails>,
    },
    /// Stream 开始 ── runtime 入口 emit 一次。
    /// 前端借此把该 thread 的 `isLoading` 置 true。
    ///
    /// **`model` / `reasoning_effort` 是该 run 锁定的 LLM 配置** ──
    /// 由后端在 spawn 时决定(从用户配置 / CLI override 解析),不依赖
    /// streaming 响应里暴露的 model 字段(部分 provider 不返回)。
    /// 通用协议: 对 OpenAI / Codex / Claude / Gemini 等所有 provider 一致,
    /// 字段均为 Option,若 provider 暂不识别时为 None,前端自行 fallback 到
    /// 全局配置或显示 "—",不破坏协议。
    StreamStart {
        thread_id: String,
        model: Option<String>,
        reasoning_effort: Option<String>,
    },
    /// Stream 结束 ── runtime 收尾时 emit 一次,
    /// 覆盖所有退出路径 (Ok / Err / panic)。`reason` 非 None 用于区分
    /// "自然完成" vs "用户主动 stop" vs "异常退出" 等场景。
    StreamEnd {
        thread_id: String,
        reason: Option<String>,
        /// Provider-reported duration of the completed turn, in milliseconds.
        /// Only runtimes that expose a native turn duration (currently Codex
        /// app-server) populate this field.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
    },
    /// Token usage increment ── emitted multiple times per run (per turn /
    /// per stream tail). Token counts are accumulated by the frontend into
    /// `AgentRunState.usage`. `model_id` and `last_run_at` are top-level
    /// metadata, not nested under `usage`. `usage` is the nested token
    /// breakdown (see [`UsageInfo`]). `status_info` is the provider-specific
    /// status snapshot (see [`StatusInfo`]). Compatibility fields
    /// `prompt_tokens` / `completion_tokens` are no longer part of the wire ──
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
            Self::UserMessage { .. } => "user_message",
            Self::Text { .. } => "text",
            Self::Reasoning { .. } => "reasoning",
            Self::ContextCompaction { .. } => "context_compaction",
            Self::ToolCall { .. } => "tool_call",
            Self::ToolResult { .. } => "tool_result",
            Self::DshCommand { .. } => "dsh_command",
            Self::CodexCommand { .. } => "codex_command",
            Self::Error { .. } => "error",
            Self::StreamStart { .. } => "stream_start",
            Self::StreamEnd { .. } => "stream_end",
            Self::SessionResolved { .. } => "session_resolved",
            Self::Usage { .. } => "usage",
        }
    }

    pub fn thread_id(&self) -> &str {
        match self {
            Self::UserMessage { thread_id, .. }
            | Self::Text { thread_id, .. }
            | Self::Reasoning { thread_id, .. }
            | Self::ContextCompaction { thread_id, .. }
            | Self::ToolCall { thread_id, .. }
            | Self::ToolResult { thread_id, .. }
            | Self::DshCommand { thread_id, .. }
            | Self::CodexCommand { thread_id, .. }
            | Self::Error { thread_id, .. }
            | Self::StreamStart { thread_id, .. }
            | Self::StreamEnd { thread_id, .. }
            | Self::SessionResolved { thread_id, .. }
            | Self::Usage { thread_id, .. } => thread_id,
        }
    }
}
