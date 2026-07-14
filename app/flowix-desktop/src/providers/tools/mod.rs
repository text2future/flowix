//! Agent tools.

use rllm::chat::Tool;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::config::AgentAccessStore;
use crate::config::SecurityBookmarkStore;
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

#[derive(Clone)]
pub struct ToolScope {
    allowed_roots: Vec<PathBuf>,
    /// Canonical default notebook path (e.g. `~/Documents/flowix` on macOS).
    /// Held separately so the read / scope tools can hint the correct path
    /// when the LLM tries one that's outside the registered scope. See
    /// `MemoFile::get_default_notebook_path`.
    _default_root: PathBuf,
    security_bookmarks: Option<Arc<SecurityBookmarkStore>>,
}

impl ToolScope {
    pub fn from_runtime_workspace_paths(
        memo_file: &std::sync::RwLock<flowix_core::memo_file::MemoFile>,
        workspace_paths: &[String],
        security_bookmarks: Option<Arc<SecurityBookmarkStore>>,
    ) -> Self {
        let default_root = memo_file
            .read()
            .map(|guard| guard.get_default_notebook_path())
            .unwrap_or_default();

        let mut roots: Vec<PathBuf> = workspace_paths
            .iter()
            .filter_map(|path| normalize_root_path(path))
            .collect();
        roots.sort();
        roots.dedup();

        let default_root = roots.first().cloned().unwrap_or(default_root);

        Self {
            allowed_roots: roots,
            _default_root: default_root,
            security_bookmarks,
        }
    }

    /// 构造时同时读 access 列表 (启用且未失联) 与 memo_file 的默认 notebook
    /// 路径。 access 列表是 AI 可见目录的**真源** ── 用户可以在
    /// `~/.flowix/agent-access.json` 里取消勾选某个 notebook 让 AI
    /// 看不到, 不影响 notebook 本身存在。`default_root` 在 access 列表为
    /// 空时只保留 `default_root` 作为报错提示路径, 不把它隐式加入允许范围。
    /// Build the legacy/global scope from `agent-access.json`.
    ///
    /// This is a compatibility fallback for old requests that do not carry
    /// runtime workspace paths. New agent-thread-card runs should pass
    /// `runtime_workspace_paths` to `execute_tool`, which makes
    /// `from_runtime_workspace_paths` authoritative for that run.
    pub fn from_memo_file_and_access(
        memo_file: &std::sync::RwLock<flowix_core::memo_file::MemoFile>,
        agent_access: &AgentAccessStore,
        security_bookmarks: Option<Arc<SecurityBookmarkStore>>,
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
            if entry.kind == crate::config::AgentAccessKind::Notebook {
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
            security_bookmarks,
        }
    }

    pub fn is_allowed(&self, path: &Path) -> bool {
        self.allowed_roots
            .iter()
            .any(|root| crate::config::path_is_inside(path, root))
    }

    /// Canonical default notebook path. Use this to construct error
    /// messages that tell the LLM where the *real* notebook is.
    #[allow(dead_code)]
    pub fn default_root(&self) -> &Path {
        &self._default_root
    }

    pub fn start_accessing_for_path(&self, path: &Path) {
        if let Some(bookmarks) = &self.security_bookmarks {
            bookmarks.start_accessing_for_path(path);
        }
    }
}

fn normalize_root_path(path: &str) -> Option<PathBuf> {
    let trimmed = path
        .trim()
        .trim_end_matches(|ch| ch == '/' || ch == '\\')
        .trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

/// Execute a tool by name with the given arguments.
pub async fn execute_tool(
    tool_name: &str,
    arguments: &str,
    memo_file: &std::sync::RwLock<flowix_core::memo_file::MemoFile>,
    agent_access: &AgentAccessStore,
    security_bookmarks: Option<Arc<SecurityBookmarkStore>>,
    skill_store: &SkillStore,
    runtime_workspace_paths: Option<&[String]>,
    read_snapshot: Option<&str>,
) -> ToolResult {
    let scope = if let Some(paths) = runtime_workspace_paths {
        ToolScope::from_runtime_workspace_paths(memo_file, paths, security_bookmarks)
    } else {
        ToolScope::from_memo_file_and_access(memo_file, agent_access, security_bookmarks)
    };
    match tool_name {
        notebook::TOOL_NAME => {
            notebook::execute_tool(tool_name, memo_file, agent_access, runtime_workspace_paths)
                .await
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AgentAccessConfig, AgentAccessEntry, AgentAccessKind};
    use flowix_core::memo_file::MemoFile;
    use std::sync::RwLock;

    struct ToolTestFixture {
        _tmp: tempfile::TempDir,
        memo_file: RwLock<MemoFile>,
        agent_access: AgentAccessStore,
        skill_store: SkillStore,
        global_root: PathBuf,
        runtime_root: PathBuf,
    }

    fn fixture() -> ToolTestFixture {
        let tmp = tempfile::Builder::new()
            .prefix("flowix-agent-tools-")
            .tempdir()
            .expect("tempdir");
        let root = tmp.path();
        let app_data = root.join("data");
        let config_dir = root.join("config");
        let skills_dir = root.join("skills");
        let global_root = root.join("global");
        let runtime_root = root.join("runtime");
        std::fs::create_dir_all(&app_data).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&skills_dir).unwrap();
        std::fs::create_dir_all(&global_root).unwrap();
        std::fs::create_dir_all(&runtime_root).unwrap();

        let memo_file_raw = MemoFile::new(config_dir.clone());
        let agent_access = AgentAccessStore::new(config_dir, &memo_file_raw);
        agent_access
            .replace_config(AgentAccessConfig {
                version: 1,
                defaults: None,
                entries: vec![AgentAccessEntry {
                    id: "global".to_string(),
                    kind: AgentAccessKind::Folder,
                    path: global_root.to_string_lossy().to_string(),
                    name: "Global".to_string(),
                    enabled: true,
                    workspace: true,
                    added_at: 1,
                    updated_at: 1,
                    missing: false,
                }],
            })
            .unwrap();

        ToolTestFixture {
            _tmp: tmp,
            memo_file: RwLock::new(memo_file_raw),
            agent_access,
            skill_store: SkillStore::load(&skills_dir),
            global_root,
            runtime_root,
        }
    }

    #[tokio::test]
    async fn available_dirs_uses_runtime_paths_when_present() {
        let fx = fixture();
        let runtime_paths = vec![fx.runtime_root.to_string_lossy().to_string()];

        let result = execute_tool(
            notebook::TOOL_NAME,
            "{}",
            &fx.memo_file,
            &fx.agent_access,
            None,
            &fx.skill_store,
            Some(&runtime_paths),
            None,
        )
        .await;

        assert!(result.success);
        let data = result.data.unwrap();
        let dirs = data.as_array().unwrap();
        assert_eq!(dirs.len(), 1);
        assert_eq!(dirs[0]["kind"], "folder");
        assert_eq!(
            dirs[0]["path"],
            fx.runtime_root.to_string_lossy().to_string()
        );
    }

    #[tokio::test]
    async fn available_dirs_runtime_empty_does_not_fall_back_to_global_access() {
        let fx = fixture();
        let runtime_paths: Vec<String> = Vec::new();

        let result = execute_tool(
            notebook::TOOL_NAME,
            "{}",
            &fx.memo_file,
            &fx.agent_access,
            None,
            &fx.skill_store,
            Some(&runtime_paths),
            None,
        )
        .await;

        assert!(result.success);
        assert_eq!(result.data.unwrap().as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn read_tool_uses_runtime_scope_instead_of_global_access() {
        let fx = fixture();
        let runtime_file = fx.runtime_root.join("allowed.txt");
        let global_file = fx.global_root.join("global.txt");
        std::fs::write(&runtime_file, "runtime").unwrap();
        std::fs::write(&global_file, "global").unwrap();
        let runtime_paths = vec![fx.runtime_root.to_string_lossy().to_string()];

        let runtime_read = execute_tool(
            "read",
            &serde_json::json!({ "path": runtime_file }).to_string(),
            &fx.memo_file,
            &fx.agent_access,
            None,
            &fx.skill_store,
            Some(&runtime_paths),
            None,
        )
        .await;
        assert!(runtime_read.success, "{runtime_read:?}");

        let global_read = execute_tool(
            "read",
            &serde_json::json!({ "path": global_file }).to_string(),
            &fx.memo_file,
            &fx.agent_access,
            None,
            &fx.skill_store,
            Some(&runtime_paths),
            None,
        )
        .await;
        assert!(!global_read.success);

        let empty_paths: Vec<String> = Vec::new();
        let global_read_with_empty_runtime = execute_tool(
            "read",
            &serde_json::json!({ "path": fx.global_root.join("global.txt") }).to_string(),
            &fx.memo_file,
            &fx.agent_access,
            None,
            &fx.skill_store,
            Some(&empty_paths),
            None,
        )
        .await;
        assert!(!global_read_with_empty_runtime.success);
    }
}
