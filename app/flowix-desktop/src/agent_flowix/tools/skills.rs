//! `load_skill` tool 鈥?pulls a registered skill's full body on demand.
//!
//! Mirrors the structure of `notebook.rs` (file-level `TOOL_NAME` const +
//! `*_tool()` constructor + free `execute_tool()` function). Registered in
//! `super::get_all_tools()` and dispatched from `super::execute_tool()`.
//!
//! The agent's system prompt lists every available skill as
//! `- \`<name>\` 鈥?<short_description>` so the LLM knows which names to
//! pass here. On unknown names the handler returns a sorted "Available: [...]"
//! list so the LLM can self-correct without losing its turn.

use rllm::chat::Tool;
use serde::Deserialize;

use crate::agent_flowix::skills::{SkillOrigin, SkillStore};

use super::{function_tool, ToolResult};

pub const TOOL_NAME: &str = "load_skill";

pub fn load_skill_tool() -> Tool {
    function_tool(
        TOOL_NAME,
        "Load a registered skill's full instructions by name. The system prompt lists every available skill as `- `<name>` 鈥?<short_description>`; call this tool when a task matches one of them. Returns `{name, description, origin, body}` where `body` is the full markdown body (frontmatter already stripped). Use the returned instructions verbatim 鈥?do not paraphrase.",
        serde_json::json!({
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Skill identifier as listed in the system prompt's Skills section."
                }
            },
            "required": ["name"]
        }),
    )
}

#[derive(Debug, Deserialize)]
struct Args {
    name: String,
}

pub async fn execute_tool(skill_store: &SkillStore, arguments: &str) -> ToolResult {
    let args: Args = match serde_json::from_str(arguments) {
        Ok(a) => a,
        Err(e) => {
            return ToolResult::error(format!(
                "load_skill: invalid arguments 鈥?expected {{\"name\": \"<skill_name>\"}}: {e}"
            ))
        }
    };

    let name = args.name.trim();
    if name.is_empty() {
        return ToolResult::error("load_skill: `name` must be a non-empty string");
    }

    match skill_store.get(name) {
        Some(skill) => {
            let origin_str = match skill.origin {
                SkillOrigin::System => "system",
                SkillOrigin::User => "user",
            };
            ToolResult::success(serde_json::json!({
                "name": skill.name,
                "description": skill.description,
                "origin": origin_str,
                "body": skill.body,
            }))
        }
        None => {
            // Sorted list so the LLM can pick without guessing. If the store
            // is completely empty, surface that explicitly 鈥?calling
            // load_skill on an empty system should never silently succeed.
            let names = skill_store.summaries();
            let available = if names.is_empty() {
                "<none>".to_string()
            } else {
                names
                    .iter()
                    .map(|s| s.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            ToolResult::error(format!(
                "load_skill: unknown skill '{name}'. Available: [{available}]"
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_flowix::skills::SkillStore;
    use std::fs;

    fn build_store() -> (tempfile::TempDir, SkillStore) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let skill_dir = root.join(".system").join("alpha");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: alpha\ndescription: alpha skill\nmetadata:\n  short-description: alpha short\n---\n\nalpha body\n",
        )
        .unwrap();
        let user_dir = root.join("beta");
        fs::create_dir_all(&user_dir).unwrap();
        fs::write(
            user_dir.join("SKILL.md"),
            "---\nname: beta\ndescription: beta skill\n---\n\nbeta body\n",
        )
        .unwrap();
        let store = SkillStore::load(root);
        (tmp, store)
    }

    #[tokio::test]
    async fn execute_tool_success_system_skill() {
        let (_tmp, store) = build_store();
        let result = execute_tool(&store, r#"{"name":"alpha"}"#).await;
        assert!(result.success);
        let data = result.data.unwrap();
        assert_eq!(data["name"], "alpha");
        assert_eq!(data["description"], "alpha skill");
        assert_eq!(data["origin"], "system");
        assert_eq!(data["body"], "alpha body");
    }

    #[tokio::test]
    async fn execute_tool_success_user_skill() {
        let (_tmp, store) = build_store();
        let result = execute_tool(&store, r#"{"name":"beta"}"#).await;
        assert!(result.success);
        let data = result.data.unwrap();
        assert_eq!(data["name"], "beta");
        assert_eq!(data["origin"], "user");
    }

    #[tokio::test]
    async fn execute_tool_unknown_name_lists_available() {
        let (_tmp, store) = build_store();
        let result = execute_tool(&store, r#"{"name":"nope"}"#).await;
        assert!(!result.success);
        let msg = result.error.unwrap();
        assert!(
            msg.contains("nope"),
            "msg should mention the bad name: {msg}"
        );
        assert!(msg.contains("alpha"), "msg should list alpha: {msg}");
        assert!(msg.contains("beta"), "msg should list beta: {msg}");
    }

    #[tokio::test]
    async fn execute_tool_unknown_name_empty_store_says_none() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SkillStore::load(tmp.path());
        let result = execute_tool(&store, r#"{"name":"x"}"#).await;
        assert!(!result.success);
        let msg = result.error.unwrap();
        assert!(msg.contains("<none>"), "msg should say <none>: {msg}");
    }

    #[tokio::test]
    async fn execute_tool_invalid_args_returns_error() {
        let (_tmp, store) = build_store();
        let result = execute_tool(&store, r#"{}"#).await;
        assert!(!result.success);
        assert!(result.error.unwrap().contains("invalid arguments"));
    }

    #[tokio::test]
    async fn execute_tool_garbage_json_returns_error() {
        let (_tmp, store) = build_store();
        let result = execute_tool(&store, "not json").await;
        assert!(!result.success);
    }

    #[tokio::test]
    async fn execute_tool_empty_name_returns_error() {
        let (_tmp, store) = build_store();
        let result = execute_tool(&store, r#"{"name":"   "}"#).await;
        assert!(!result.success);
        assert!(result.error.unwrap().contains("non-empty"));
    }
}
