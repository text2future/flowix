use serde::{Deserialize, Serialize};

use crate::agent_types::AgentId;
use crate::agent_wire::{AgentErrorDetails, AgentMessageAttachment};

// `AgentErrorDetails` is also used by the raw `agent-chunk` event, whose
// public wire contract is snake_case. ChatMessage, however, is an IPC history
// payload and uses camelCase. Keep the shared Rust value type while adapting
// its nested representation at this boundary. Accepting both spellings keeps
// older persisted/history payloads readable during rollout.
mod chat_error_details_serde {
    use super::AgentErrorDetails;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    #[derive(Clone, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct WireErrorDetails {
        category: String,
        #[serde(default, alias = "status_code")]
        status_code: Option<u16>,
        #[serde(default, alias = "request_id")]
        request_id: Option<String>,
        #[serde(default, alias = "retry_after")]
        retry_after: Option<String>,
        #[serde(default, alias = "exit_code")]
        exit_code: Option<i32>,
        #[serde(default, alias = "upstream_message")]
        upstream_message: Option<String>,
        #[serde(default)]
        source: Option<String>,
        #[serde(default)]
        retryable: bool,
    }

    impl From<&AgentErrorDetails> for WireErrorDetails {
        fn from(value: &AgentErrorDetails) -> Self {
            Self {
                category: value.category.clone(),
                status_code: value.status_code,
                request_id: value.request_id.clone(),
                retry_after: value.retry_after.clone(),
                exit_code: value.exit_code,
                upstream_message: value.upstream_message.clone(),
                source: value.source.clone(),
                retryable: value.retryable,
            }
        }
    }

    impl From<WireErrorDetails> for AgentErrorDetails {
        fn from(value: WireErrorDetails) -> Self {
            Self {
                category: value.category,
                status_code: value.status_code,
                request_id: value.request_id,
                retry_after: value.retry_after,
                exit_code: value.exit_code,
                upstream_message: value.upstream_message,
                source: value.source,
                retryable: value.retryable,
            }
        }
    }

    pub fn serialize<S>(value: &Option<AgentErrorDetails>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        value
            .as_ref()
            .map(WireErrorDetails::from)
            .serialize(serializer)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<AgentErrorDetails>, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<WireErrorDetails>::deserialize(deserializer)
            .map(|value| value.map(AgentErrorDetails::from))
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadInfo {
    pub thread_id: String,
    pub agent_id: AgentId,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    /// Provider-specific display type for non-conversational timeline items.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_type: Option<String>,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<AgentMessageAttachment>>,
    pub llm_content: Option<String>,
    pub system_reminder_directory: Option<String>,
    pub timestamp: String,
    /// Provider event sequence used by external runtimes for history actions
    /// such as forking a conversation at a stable message boundary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_sequence: Option<i64>,
    pub is_loading: Option<bool>,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub tool_data: Option<String>,
    pub tool_input: Option<serde_json::Value>,
    /// Raw provider tool events projected by DSH history. These are response
    /// metadata only and are not persisted in the local message store.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_result: Option<serde_json::Value>,
    /// 助手消息关联�?tool_calls 数组 (OpenAI 格式 JSON, 单元素或多元�?�?    /// None 表示�?���?��手消�? Some(vec![...]) 表示该助手轮次同时发出了工具调用�?    /// 存储层用 serde_json::Value 避免�?rllm 类型耦合�?
    #[serde(default)]
    pub tool_calls: Option<serde_json::Value>,
    pub reasoning: Option<String>,
    pub is_completed: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "chat_error_details_serde"
    )]
    pub error_details: Option<AgentErrorDetails>,
    pub is_collapsed: Option<bool>,
    /// Codex app-server Turn that owns this message. Used by provider-specific
    /// actions such as forking a conversation from a completed assistant turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_turn_id: Option<String>,
    /// Native provider turn duration in milliseconds, displayed beside the
    /// assistant message actions when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_duration_ms: Option<u64>,
}

/// `ChatMessage.role` 的合法取值。存储层仍是 `String` (SQLite TEXT), 这个
/// 枚举仅用于写入/读取处消除 magic string, 编译期防拼错。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessageRole {
    User,
    Assistant,
    Tool,
    Reasoning,
    System,
    End,
}

impl MessageRole {
    pub const fn as_str(self) -> &'static str {
        match self {
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            MessageRole::Tool => "tool",
            MessageRole::Reasoning => "reasoning",
            MessageRole::System => "system",
            MessageRole::End => "end",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "user" => Some(MessageRole::User),
            "assistant" => Some(MessageRole::Assistant),
            "tool" => Some(MessageRole::Tool),
            "reasoning" => Some(MessageRole::Reasoning),
            "system" => Some(MessageRole::System),
            "end" => Some(MessageRole::End),
            _ => None,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub info: ThreadInfo,
    pub messages: Vec<ChatMessage>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversationSource {
    pub kind: String,
    pub document_path: Option<String>,
    #[serde(default)]
    pub relative_path: Option<String>,
    /// Owning notebook for the source note, so the conversation list can be
    /// scoped per notebook. `None` for conversations started outside any note
    /// (dedicated conversation surface / external docs). `#[serde(default)]`
    /// keeps deserialization tolerant of older payloads that omit it.
    #[serde(default)]
    pub notebook_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversationInstance {
    pub instance_id: String,
    pub agent_type: String,
    /// Product title projected from `threads.title`; it is not stored on the
    /// conversation-instance row. `None` means the card has not started a
    /// conversation yet.
    pub thread_title: Option<String>,
    pub thread_id: Option<String>,
    /// Provider-owned session id, when the conversation has been bound to one.
    /// This is read from the provider branch table together with the instance
    /// so presentation layers do not need to resolve it on demand.
    pub session_id: Option<String>,
    pub runtime_config: Option<String>,
    /// Backend-owned working directory frozen on the first external-agent run.
    /// It is deliberately not part of `UpsertAgentConversationInstance`, so a
    /// stale frontend runtime-config snapshot cannot overwrite it.
    pub frozen_cwd: Option<String>,
    pub source: AgentConversationSource,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Stable cursor for the conversation list. The pair mirrors the list's
/// `updated_at DESC, id DESC` ordering so rows are neither skipped nor
/// repeated when older rows are loaded incrementally.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversationCursor {
    pub updated_at: i64,
    pub instance_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversationTypeCount {
    pub agent_type: String,
    pub count: usize,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentExternalEvent {
    pub id: i64,
    pub runtime: String,
    pub thread_id: String,
    pub event_key: Option<String>,
    pub normalized_json: String,
    pub raw_json: Option<String>,
    pub created_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAgentExternalEvent {
    pub runtime: String,
    pub thread_id: String,
    pub normalized_json: String,
    pub raw_json: Option<String>,
    pub created_at: Option<i64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertAgentConversationInstance {
    pub instance_id: String,
    pub agent_type: String,
    /// Initial title used only when `thread_id` needs a product thread row.
    /// Later title changes must go through the thread title command.
    pub initial_title: String,
    pub thread_id: Option<String>,
    pub runtime_config: Option<String>,
    pub source: AgentConversationSource,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
}

/// Layer 4: 分页加载的返回类型。前�?�� `oldest_sequence` 作为下一�?cursor,
/// `has_more` 决定�?��在顶部显�?加载更�?"或自�?prefetch�?
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessagesPage {
    pub messages: Vec<ChatMessage>,
    /// �?��最早一条消�?�� sequence; None 表示�?��为空�?
    pub oldest_sequence: Option<i64>,
    /// �?��还有更早的历�? false 时前�?��止顶�?prefetch�?
    pub has_more: bool,
    /// Pins all pages in one history traversal to the same DSH event snapshot.
    #[serde(default)]
    pub snapshot_sequence: Option<i64>,
    /// Native turns proven terminal and fully represented by this page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub complete_turn_ids: Option<Vec<String>>,
}
