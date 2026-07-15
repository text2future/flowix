use serde::{Deserialize, Serialize};

use crate::agent_types::AgentId;

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
    pub content: String,
    pub llm_content: Option<String>,
    pub system_reminder_directory: Option<String>,
    pub timestamp: String,
    pub is_loading: Option<bool>,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub tool_data: Option<String>,
    pub tool_input: Option<serde_json::Value>,
    /// 助手消息关联的 tool_calls 数组 (OpenAI 格式 JSON, 单元素或多元素)。
    /// None 表示纯文本助手消息; Some(vec![...]) 表示该助手轮次同时发出了工具调用。
    /// 存储层用 serde_json::Value 避免与 rllm 类型耦合。
    #[serde(default)]
    pub tool_calls: Option<serde_json::Value>,
    pub reasoning: Option<String>,
    pub is_completed: Option<bool>,
    pub is_collapsed: Option<bool>,
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
    pub memo_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversationRole {
    pub memo_id: Option<String>,
    pub name: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversationRun {
    pub run_id: String,
    pub status: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub current_tool: Option<String>,
    pub model: Option<String>,
    pub model_id: Option<String>,
    pub reasoning_effort: Option<String>,
    pub last_run_at: Option<i64>,
    pub reason: Option<String>,
    /// Nested token usage breakdown — see [`crate::agent_types::UsageInfo`].
    /// Stored as JSON in SQLite (`usage_json` column) so future fields can be
    /// added without a schema migration.
    pub usage: Option<crate::agent_types::UsageInfo>,
    /// Provider-specific status snapshot — see [`crate::agent_types::StatusInfo`].
    /// Stored as JSON in SQLite (`status_info_json` column).
    pub status_info: Option<crate::agent_types::StatusInfo>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversationInstance {
    pub instance_id: String,
    pub agent_type: String,
    pub title: String,
    pub thread_id: Option<String>,
    pub runtime_config: Option<String>,
    pub source: AgentConversationSource,
    pub role: Option<AgentConversationRole>,
    pub run: Option<AgentConversationRun>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertAgentConversationInstance {
    pub instance_id: String,
    pub agent_type: String,
    pub title: String,
    pub thread_id: Option<String>,
    pub runtime_config: Option<String>,
    pub source: AgentConversationSource,
    pub role: Option<AgentConversationRole>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
}

/// Layer 4: 分页加载的返回类型。前端用 `oldest_sequence` 作为下一页 cursor,
/// `has_more` 决定是否在顶部显示"加载更多"或自动 prefetch。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessagesPage {
    pub messages: Vec<ChatMessage>,
    /// 本批最早一条消息的 sequence; None 表示本批为空。
    pub oldest_sequence: Option<i64>,
    /// 是否还有更早的历史; false 时前端停止顶部 prefetch。
    pub has_more: bool,
}
