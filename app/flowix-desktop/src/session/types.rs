use serde::{Deserialize, Serialize};

use crate::agent::AgentId;

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
    /// 鍔╂墜娑堟伅鍏宠仈鐨?tool_calls 鏁扮粍 (OpenAI 鏍煎紡 JSON, 鍗曞厓绱犳垨澶氬厓绱?銆?
    /// None 琛ㄧず绾枃鏈姪鎵嬫秷鎭? Some(vec![...]) 琛ㄧず璇ュ姪鎵嬭疆娆″悓鏃跺彂鍑轰簡宸ュ叿璋冪敤銆?
    /// 瀛樺偍灞傜敤 serde_json::Value 浠ラ伩鍏嶄笌 rllm 绫诲瀷鑰﹀悎銆?
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
    /// Nested token usage breakdown — see [`crate::agent::UsageInfo`].
    /// Stored as JSON in SQLite (`usage_json` column) so future fields can be
    /// added without a schema migration.
    pub usage: Option<crate::agent::UsageInfo>,
    /// Provider-specific status snapshot — see [`crate::agent::StatusInfo`].
    /// Stored as JSON in SQLite (`status_info_json` column).
    pub status_info: Option<crate::agent::StatusInfo>,
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

/// Layer 4: 鍒嗛〉鍔犺浇鐨勮繑鍥炵被鍨? 鍓嶇鐢?`oldest_sequence` 浣滀笅涓€椤?cursor,
/// `has_more` 鍐冲畾鏄惁鍦ㄩ《閮ㄦ樉绀?鍔犺浇鏇村"鎴栬嚜鍔?prefetch.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessagesPage {
    pub messages: Vec<ChatMessage>,
    /// 鏈壒鏈€鏃╀竴鏉℃秷鎭殑 sequence; None 琛ㄧず鏈壒涓虹┖ (thread 鏃犳秷鎭垨 before_sequence 宸插埌椤?.
    pub oldest_sequence: Option<i64>,
    /// 鏄惁杩樻湁鏇存棭鐨勫巻鍙? false 鏃跺墠绔仠姝?prefetch 椤堕儴.
    pub has_more: bool,
}
