use rllm::chat::Tool;
use std::path::Path;

use crate::config::AgentAccessKind;
use crate::config::AgentAccessStore;
use crate::lock_utils::read_lock;
use flowix_core::memo_file::NotebookConfig;

use super::{function_tool, ToolResult};

/// 工具名常量 ── 在三处 (工具注册 + handler match + dispatch match) 共用,
/// 改名时改这一处。
pub const TOOL_NAME: &str = "available_dirs";

pub fn available_dirs_tool() -> Tool {
    function_tool(
        TOOL_NAME,
        "List directories the AI is allowed to access. Returns up to 10 entries; each has `kind` (`notebook` | `folder`), `id`, `name`, and absolute `path`. The list contains two kinds of locations: (1) notebook storage paths the user has granted access to — use these as starting points for `read` / `ls` on memos; (2) user-suggested reference / research paths the user explicitly added to 文件权限, where the AI may find source material to read. Directories toggled off in 文件权限 or missing from disk are excluded.",
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
    runtime_workspace_paths: Option<&[String]>,
) -> ToolResult {
    match tool_name {
        TOOL_NAME => {
            if let Some(paths) = runtime_workspace_paths {
                return runtime_available_dirs(memo_file, paths);
            }

            let access_cfg = agent_access.get_config();

            // 已注册 notebook 索引, 用 path / icon 字段补
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

fn runtime_available_dirs(
    memo_file: &std::sync::RwLock<flowix_core::memo_file::MemoFile>,
    workspace_paths: &[String],
) -> ToolResult {
    let notebook_index: std::collections::HashMap<String, NotebookConfig> = {
        let guard = read_lock(memo_file, "memo_file");
        guard
            .read_notebook_configs()
            .unwrap_or_default()
            .into_iter()
            .map(|c| (normalize_path_str(&c.path), c))
            .collect()
    };

    let mut seen = std::collections::HashSet::new();
    let mut result: Vec<serde_json::Value> = Vec::new();

    for path in workspace_paths {
        let normalized = normalize_path_str(path);
        if normalized.is_empty() || !seen.insert(normalized.clone()) {
            continue;
        }

        if let Some(nb) = notebook_index.get(&normalized) {
            let mut obj = serde_json::json!({
                "kind": "notebook",
                "id": nb.id,
                "name": nb.name,
                "path": nb.path,
            });
            if let Some(icon) = &nb.icon {
                obj["icon"] = serde_json::Value::String(icon.clone());
            }
            result.push(obj);
        } else {
            result.push(serde_json::json!({
                "kind": "folder",
                "id": format!("runtime_{}", result.len()),
                "name": display_name(&normalized),
                "path": normalized,
            }));
        }

        if result.len() >= 10 {
            break;
        }
    }

    ToolResult::success(result)
}

fn normalize_path_str(path: &str) -> String {
    path.trim()
        .trim_end_matches(|ch| ch == '/' || ch == '\\')
        .trim()
        .to_string()
}

fn display_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(path)
        .to_string()
}
