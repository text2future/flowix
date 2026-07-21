use rllm::chat::Tool;
use std::path::Path;

use crate::config::AgentAccessKind;
use crate::config::AgentAccessStore;
use crate::lock_utils::read_lock;
use flowix_core::memo_file::NotebookConfig;

use super::{function_tool, ToolResult};

/// 宸ュ叿鍚嶅父閲?鈹€鈹€ 鍦ㄤ笁澶?(宸ュ叿娉ㄥ唽 + handler match + dispatch match) 鍏辩敤,
/// 鏀瑰悕鏃舵敼杩欎竴澶勩€?
pub const TOOL_NAME: &str = "available_dirs";

pub fn available_dirs_tool() -> Tool {
    function_tool(
        TOOL_NAME,
        "List directories the AI is allowed to access. Returns up to 10 entries; each has `kind` (`notebook` | `folder`), `id`, `name`, and absolute `path`. The list contains two kinds of locations: (1) notebook storage paths the user has granted access to 鈥?use these as starting points for `read` / `ls` on memos; (2) user-suggested reference / research paths the user explicitly added to 鏂囦欢鏉冮檺, where the AI may find source material to read. Directories toggled off in 鏂囦欢鏉冮檺 or missing from disk are excluded.",
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

            // 宸叉敞鍐?notebook 绱㈠紩, 鐢?path / icon 瀛楁琛?            // access 鍒楄〃鐨?鐦?entry銆?access 鍒楄〃鏄敤鎴峰嬀閫夌殑鐪熸簮,
            // 娉ㄥ唽琛ㄦ槸璺緞 / 鍚嶅瓧鐨勭湡婧?鈹€鈹€ 涓よ竟閮界湅, 鍙栧苟闆嗕氦杩囨护
            // (access 閲屾湁浣嗘敞鍐岃〃娌′簡 = 骞界伒, 璺?`ToolScope` 鍚屾簮)銆?
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

            // 鈹€鈹€ 1. notebook entries 鈹€鈹€
            // 椤哄簭鎸?access 鍒楄〃 (鐢ㄦ埛鏈€杩戞敼鍚?/ 璋冩暣杩囩殑鏉＄洰, 鐢?            // `add_or_update_notebook` / `rename_notebook` 鎺ㄥ埌瀵瑰簲浣嶇疆),
            // 璺?鍙闂洰褰?瀛愯彍鍗曠殑娓叉煋椤哄簭涓€鑷? 瑙嗚涓庤繑鍥炲€煎寰椾笂銆?
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
                    // path 浠?notebook 娉ㄥ唽琛ㄤ负鍑?鈹€鈹€ access 鍒楄〃閲屽彲鑳?                    // 鏄?reconcile 鍓嶇殑鏃у€? 淇′换娉ㄥ唽琛ㄣ€?                    "path": nb.map(|c| c.path.clone()).unwrap_or_else(|| entry.path.clone()),
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

            // 鈹€鈹€ 2. folder entries 鈹€鈹€
            // 椤哄簭鍚屾牱鎸?access 鍒楄〃 鈹€鈹€ "鍙闂洰褰?瀛愯彍鍗曠殑 folder
            // 娈典篃鏄悓涓€浠介『搴? 鐢ㄦ埛瑙嗚鎰熺煡 = AI 鐪嬪埌鐨勫垪琛ㄣ€?
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
        // 鑰佸悕瀛楀湪 match 涓笉璇嗗埆涔熻蛋杩欓噷, 缁欏墠绔?/ 鏃ュ織涓€涓兘鏌ュ埌鐨?
        // 閿欒淇℃伅; 瀹為檯鍏煎鍒嗘敮宸茬粡鍦ㄤ笂闈竴骞跺懡涓簡銆?
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
