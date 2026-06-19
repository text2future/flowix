use rllm::chat::Tool;

use crate::agent_access::AgentAccessKind;
use crate::agent_access::AgentAccessStore;
use crate::lock_utils::read_lock;
use flowix_core::memo_file::NotebookConfig;

use super::{function_tool, ToolResult};

/// 工具名常量 ── 在三处 (工具注册 + handler match + dispatch match) 共用,
/// 改名时改这一处。 历史名 `list_notebooks` 仅出现在 handler / dispatch
/// 的兼容分支里, 注册端以新名暴露给 LLM。
pub const TOOL_NAME: &str = "available_dirs";
pub const LEGACY_TOOL_NAME: &str = "list_notebooks";

pub fn available_dirs_tool() -> Tool {
    function_tool(
        TOOL_NAME,
        "List directories the AI is allowed to access. Returns up to 10 entries; each has `kind` (`notebook` | `folder`), `id`, `name`, and absolute `path`. Notebook entries additionally include `is_default`. The list contains two kinds of locations: (1) notebook storage paths the user has granted access to — use these as starting points for `read` / `ls` on memos; (2) user-suggested reference / research paths the user explicitly added to 文件权限, where the AI may find source material to read. Directories toggled off in 文件权限 or missing from disk are excluded.",
        serde_json::json!({
            "type": "object",
            "properties": {},
            "required": []
        }),
    )
}

pub async fn execute_tool(
    tool_name: &str,
    memo_file: &std::sync::RwLock<flowix_core::memo_file::MemoFile>,
    agent_access: &AgentAccessStore,
) -> ToolResult {
    match tool_name {
        // 双名兼容: 历史对话 / 日志回放可能携带老名字的 tool_call,
        // dispatch 仍能命中, 不至于把已经在飞的请求打回。
        LEGACY_TOOL_NAME | TOOL_NAME => {
            let access_cfg = agent_access.get_config();

            // 已注册 notebook 索引, 用 path / is_default / icon 字段补
            // access 列表的"瘦"entry。 access 列表是用户勾选的真源,
            // 注册表是路径 / 名字的真源 ── 两边都看, 取并集交过滤
            // (access 里有但注册表没了 = 幽灵, 跟 `ToolScope` 同源)。
            let notebook_index: std::collections::HashMap<String, NotebookConfig> = {
                let guard = read_lock(memo_file, "memo_file");
                guard
                    .read_notebook_configs()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|c| (c.id.clone(), c))
                    .collect()
            };

            let mut result: Vec<serde_json::Value> = Vec::new();

            // ── 1. notebook entries ──
            // 顺序按 access 列表 (用户最近改名 / 调整过的条目, 由
            // `add_or_update_notebook` / `rename_notebook` 推到对应位置),
            // 跟"可访问目录"子菜单的渲染顺序一致, 视觉与返回值对得上。
            for entry in access_cfg
                .entries
                .iter()
                .filter(|e| e.kind == AgentAccessKind::Notebook && e.enabled && !e.missing)
                .filter(|e| notebook_index.contains_key(&e.id))
            {
                let nb = notebook_index.get(&entry.id);
                let mut obj = serde_json::json!({
                    "kind": "notebook",
                    "id": entry.id,
                    "name": nb.map(|c| c.name.clone()).unwrap_or_else(|| entry.name.clone()),
                    // path 以 notebook 注册表为准 ── access 列表里可能
                    // 是 reconcile 前的旧值, 信任注册表。
                    "path": nb.map(|c| c.path.clone()).unwrap_or_else(|| entry.path.clone()),
                });
                if let Some(c) = nb {
                    obj["is_default"] = serde_json::Value::Bool(c.is_default);
                    if let Some(icon) = &c.icon {
                        obj["icon"] = serde_json::Value::String(icon.clone());
                    }
                }
                result.push(obj);
                if result.len() >= 10 {
                    return ToolResult::success(result);
                }
            }

            // ── 2. folder entries ──
            // 顺序同样按 access 列表 ── "可访问目录"子菜单的 folder
            // 段也是同一份顺序, 用户视觉感知 = AI 看到的列表。
            for entry in access_cfg
                .entries
                .iter()
                .filter(|e| e.kind == AgentAccessKind::Folder && e.enabled && !e.missing)
            {
                result.push(serde_json::json!({
                    "kind": "folder",
                    "id": entry.id,
                    "name": entry.name,
                    "path": entry.path,
                }));
                if result.len() >= 10 {
                    break;
                }
            }

            ToolResult::success(result)
        }
        // 老名字在 match 中不识别也走这里, 给前端 / 日志一个能查到的
        // 错误信息; 实际兼容分支已经在上面一并命中了。
        _ => ToolResult::error(format!("Unknown notebook tool: {}", tool_name)),
    }
}
