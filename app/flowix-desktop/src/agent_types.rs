use serde::{Deserialize, Serialize};

/// Agent id newtype used on the wire as a plain string.
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

/// 绾跨▼琛?`agent_id` 鍒楃殑鍥哄畾鍗犱綅鍊笺€傛墍鏈夋柊寤?thread 閮藉啓鍏?`"default"`銆?///
/// 鐢ㄥ嚱鏁拌€岄潪 `pub const` 鏄洜涓?`String` 涓嶈兘鍦?const 涓婁笅鏂囨瀯閫? 璋冪敤鏂?/// 搴旂紦瀛樿繑鍥炲€? 涓嶈姣忓閮介噸鏂板垎閰嶃€?
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
