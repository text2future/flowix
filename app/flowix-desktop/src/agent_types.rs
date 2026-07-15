use serde::{Deserialize, Serialize};

/// 智能体 ID newtype ── 替代裸 `&str` / `String`, 防止把任意字符串当成 agent_id
/// 传进 [`crate::agent_session::ThreadManager::create_thread`]。
///
/// `#[serde(transparent)]` 让 wire 形状就是 `String` (例如 `"default"`)。
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

/// 线程表 `agent_id` 列的固定占位值。所有新建 thread 都写入 `"default"`。
///
/// 用函数而非 `pub const` 是因为 `String` 不能在 const 上下文构造; 调用方
/// 应缓存返回值, 不要每处都重新分配。
pub fn default_agent_id() -> AgentId {
    AgentId::new("default")
}

/// Token usage breakdown shared by agent streaming events and persisted run state.
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

/// Provider-specific status snapshot shared by agent streaming events and
/// persisted run state.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "snake_case")]
pub struct StatusInfo {
    pub codex_plan_type: Option<String>,
    pub codex_used_percent: Option<f64>,
    pub codex_resets_at: Option<i64>,
}
