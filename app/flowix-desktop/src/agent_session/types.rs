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
    /// 鍔╂墜娑堟伅鍏宠仈鐨?tool_calls 鏁扮粍 (OpenAI 鏍煎紡 JSON, 鍗曞厓绱犳垨澶氬厓绱?銆?    /// None 琛ㄧず绾枃鏈姪鎵嬫秷鎭? Some(vec![...]) 琛ㄧず璇ュ姪鎵嬭疆娆″悓鏃跺彂鍑轰簡宸ュ叿璋冪敤銆?    /// 瀛樺偍灞傜敤 serde_json::Value 閬垮厤涓?rllm 绫诲瀷鑰﹀悎銆?
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
pub struct AgentConversationInstance {
    pub instance_id: String,
    pub agent_type: String,
    pub title: String,
    pub thread_id: Option<String>,
    pub runtime_config: Option<String>,
    pub source: AgentConversationSource,
    pub role: Option<AgentConversationRole>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentExternalEvent {
    pub id: i64,
    pub runtime: String,
    pub thread_id: String,
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
    pub title: String,
    pub thread_id: Option<String>,
    pub runtime_config: Option<String>,
    pub source: AgentConversationSource,
    pub role: Option<AgentConversationRole>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
}

/// Layer 4: 鍒嗛〉鍔犺浇鐨勮繑鍥炵被鍨嬨€傚墠绔敤 `oldest_sequence` 浣滀负涓嬩竴椤?cursor,
/// `has_more` 鍐冲畾鏄惁鍦ㄩ《閮ㄦ樉绀?鍔犺浇鏇村"鎴栬嚜鍔?prefetch銆?
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessagesPage {
    pub messages: Vec<ChatMessage>,
    /// 鏈壒鏈€鏃╀竴鏉℃秷鎭殑 sequence; None 琛ㄧず鏈壒涓虹┖銆?
    pub oldest_sequence: Option<i64>,
    /// 鏄惁杩樻湁鏇存棭鐨勫巻鍙? false 鏃跺墠绔仠姝㈤《閮?prefetch銆?
    pub has_more: bool,
}
