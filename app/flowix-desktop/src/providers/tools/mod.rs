//! Agent tools.

use rllm::chat::Tool;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::agent_access::AgentAccessStore;
use crate::skills::SkillStore;

mod filesystem;
mod notebook;
mod shell;
mod skills;
pub mod sub_agent;
mod web_search;

/// Tool result type for returning data from tool executions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub success: bool,
    pub data: Option<serde_json::Value>,
    pub error: Option<String>,
}

impl ToolResult {
    pub fn success(data: impl Serialize) -> Self {
        Self {
            success: true,
            data: Some(serde_json::to_value(data).unwrap_or(serde_json::Value::Null)),
            error: None,
        }
    }

    pub fn error(msg: impl Into<String>) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(msg.into()),
        }
    }
}

fn function_tool(name: &str, description: &str, parameters: serde_json::Value) -> Tool {
    Tool {
        tool_type: "function".to_string(),
        function: rllm::chat::FunctionTool {
            name: name.to_string(),
            description: description.to_string(),
            parameters,
        },
        cache_control: None,
    }
}

/// Get all available tools registered to the agent.
///
/// Tool definitions are static (don't depend on the SkillStore contents);
/// the `load_skill` tool body is fixed and pulls from `SkillStore` at
/// execute time. We pass the store through `execute_tool` instead of
/// baking it into `get_all_tools`.
pub fn get_all_tools() -> Vec<Tool> {
    vec![
        notebook::available_dirs_tool(),
        filesystem::read_tool(),
        filesystem::write_tool(),
        filesystem::delete_tool(),
        filesystem::edit_tool(),
        filesystem::ls_tool(),
        filesystem::glob_tool(),
        filesystem::grep_tool(),
        web_search::web_search_tool(),
        shell::shell_tool(),
        skills::load_skill_tool(),
        sub_agent::sub_agent_tool(),
    ]
}

/// Tools exposed inside the delegated sub-agent.
///
/// Keep this read-only. The sub-agent may inspect the workspace and load skills,
/// but must not mutate files or spawn another sub-agent recursively.
pub fn get_sub_agent_tools() -> Vec<Tool> {
    vec![
        notebook::available_dirs_tool(),
        filesystem::read_tool(),
        filesystem::ls_tool(),
        filesystem::glob_tool(),
        filesystem::grep_tool(),
        web_search::web_search_tool(),
        skills::load_skill_tool(),
    ]
}

#[derive(Clone, Debug)]
pub struct ToolScope {
    allowed_roots: Vec<PathBuf>,
    /// Canonical default notebook path (e.g. `~/Documents/flowix` on macOS).
    /// Held separately so the read / scope tools can hint the *correct*
    /// path when the LLM tries one that's outside the registered scope —
    /// typically a stale `~/Documents/woop notebook` from before the
    /// 2026/06 brand rename. See `MemoFile::get_default_notebook_path`.
    _default_root: PathBuf,
}

impl ToolScope {
    /// 构造时同时读 access 列表 (启用且未失联) 与 memo_file 的默认 notebook
    /// 路径。 access 列表是 AI 可见目录的**真源** ── 用户可以在
    /// `~/.flowix/agent-access.json` 里取消勾选某个 notebook 让 AI
    /// 看不到, 不影响 notebook 本身存在。`default_root` 在 access 列表为
    /// 空时只保留 `default_root` 作为报错提示路径, 不把它隐式加入允许范围。
    pub fn from_memo_file_and_access(
        memo_file: &std::sync::RwLock<flowix_core::memo_file::MemoFile>,
        agent_access: &AgentAccessStore,
    ) -> Self {
        let (default_root, registered) = memo_file
            .read()
            .map(|guard| {
                (
                    guard.get_default_notebook_path(),
                    guard.read_notebook_configs().unwrap_or_default(),
                )
            })
            .unwrap_or_else(|_| (PathBuf::new(), Vec::new()));

        let cfg = agent_access.get_config();
        let mut roots: Vec<PathBuf> = Vec::new();
        for entry in &cfg.entries {
            if !entry.enabled || entry.missing {
                continue;
            }
            // kind=Notebook: 必须仍然存在于 notebook 注册表 (防止 access
            // 列表里有 "幽灵 notebook id" 把 `~/etc/` 这种路径放行)。
            // kind=Folder: 直接信任。
            if entry.kind == crate::agent_access::AgentAccessKind::Notebook {
                let still_registered = registered.iter().any(|c| c.id == entry.id);
                if !still_registered {
                    continue;
                }
            }
            roots.push(PathBuf::from(&entry.path));
        }

        roots.sort();
        roots.dedup();

        let default_root = roots.first().cloned().unwrap_or(default_root);

        Self {
            allowed_roots: roots,
            _default_root: default_root,
        }
    }

    pub fn is_allowed(&self, path: &Path) -> bool {
        self.allowed_roots
            .iter()
            .any(|root| crate::path_scope::path_is_inside(path, root))
    }

    /// Canonical default notebook path. Use this to construct error
    /// messages that tell the LLM where the *real* notebook is.
    #[allow(dead_code)]
    pub fn default_root(&self) -> &Path {
        &self._default_root
    }
}

/// Execute a tool by name with the given arguments.
pub async fn execute_tool(
    tool_name: &str,
    arguments: &str,
    memo_file: &std::sync::RwLock<flowix_core::memo_file::MemoFile>,
    agent_access: &AgentAccessStore,
    skill_store: &SkillStore,
    read_snapshot: Option<&str>,
) -> ToolResult {
    let scope = ToolScope::from_memo_file_and_access(memo_file, agent_access);
    match tool_name {
        // `available_dirs` 是新名字 (`list_notebooks` 的升级版, 详见
        // notebook.rs), 兼容老名字 ── 老对话 / 老 checkpoint 流出
        // `list_notebooks` tool_call 仍然要 dispatch 到同一个 handler。
        notebook::LEGACY_TOOL_NAME | notebook::TOOL_NAME => {
            notebook::execute_tool(tool_name, memo_file, agent_access).await
        }
        "read" | "write" | "delete" | "edit" | "ls" | "glob" | "grep" => {
            filesystem::execute_tool(tool_name, arguments, read_snapshot, &scope).await
        }
        web_search::TOOL_NAME => web_search::execute_tool(arguments).await,
        shell::TOOL_NAME => shell::execute_tool(arguments, &scope).await,
        skills::TOOL_NAME => skills::execute_tool(skill_store, arguments).await,
        "bash" => ToolResult::error("Shell execution is disabled for AI agents"),
        _ => ToolResult::error(format!("Unknown tool: {}", tool_name)),
    }
}
