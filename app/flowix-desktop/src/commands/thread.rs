//! Thread IPC — 对话线程 CRUD。
//!
//! `thread_delete` 顺带清 `AgentManager` 的 in-memory 状态 (与该 thread 关联的
//! read 工具快照 + 卡死检测计数), 否则会无限泄露。

use serde::Serialize;
use tauri::State;
use tokio::process::Command;

use crate::agent::default_agent_id;
use crate::threads::{ChatMessage, ThreadInfo, ThreadMessagesPage};

use super::AppState;

#[derive(Serialize)]
pub struct GetThreadResponse {
    pub messages: Vec<ChatMessage>,
}

#[tauri::command]
pub async fn thread_list(state: State<'_, AppState>) -> Result<Vec<ThreadInfo>, String> {
    let manager = state.thread_manager.read().await;
    manager.list_threads().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn thread_create(
    title: String,
    state: State<'_, AppState>,
) -> Result<ThreadInfo, String> {
    let manager = state.thread_manager.read().await;
    // agent_id 列保留以兼容旧 schema, 统一用 default_agent_id() 占位 ─ 见 agent.rs。
    manager
        .create_thread(default_agent_id(), title)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn thread_get(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<GetThreadResponse, String> {
    let manager = state.thread_manager.read().await;
    match manager
        .get_thread(&thread_id)
        .await
        .map_err(|e| e.to_string())?
    {
        Some(thread) => Ok(GetThreadResponse {
            messages: thread.messages,
        }),
        None => Err("Thread not found".to_string()),
    }
}

/// Layer 4: 分页加载 thread 历史. 取代 thread_get 在 1MB 级 thread 上的全量
/// 序列化开销, IPC payload 从 ~1MB 降到 ~100KB (100 条 × 平均 1KB).
///
/// 参数:
///   - thread_id: 目标 thread
///   - before_sequence: None → 取最近 limit 条; Some(s) → 取 sequence < s 的最近 limit 条
///   - limit: 单次返回上限, 服务端 clamp 到 [1, 1000], 默认建议前端传 100
///
/// 返回 ThreadMessagesPage { messages (ASC), oldest_sequence, has_more }
/// 前端用 oldest_sequence 作为下一页 cursor, has_more 决定顶部 prefetch.
///
/// 旧 thread_get 保留不删 ── 一些路径 (调试 / 全量导出) 仍可能需要,
/// 也避免破坏未迁移到分页的调用方.
#[tauri::command]
pub async fn thread_get_page(
    thread_id: String,
    before_sequence: Option<i64>,
    limit: i64,
    state: State<'_, AppState>,
) -> Result<ThreadMessagesPage, String> {
    let manager = state.thread_manager.read().await;
    manager
        .get_thread_messages_page(&thread_id, before_sequence, limit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn codex_thread_list() -> Result<Vec<ThreadInfo>, String> {
    crate::codex_history::list_sessions().await
}

#[tauri::command]
pub async fn codex_thread_get(thread_id: String) -> Result<GetThreadResponse, String> {
    let messages = crate::codex_history::get_session(&thread_id).await?;
    Ok(GetThreadResponse { messages })
}

#[tauri::command]
pub async fn codex_thread_session_id(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    if crate::codex_history::is_codex_session_id(&thread_id) {
        return Ok(Some(thread_id));
    }

    let manager = state.thread_manager.read().await;
    manager
        .get_external_session(&thread_id, "codex")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn codex_default_model() -> Result<String, String> {
    if let Some(model) = read_codex_config_model() {
        return Ok(model);
    }

    let output = Command::new(crate::codex_cli::resolve_codex_binary())
        .args(["debug", "models"])
        .output()
        .await
        .map_err(|e| format!("failed to query Codex models: {e}"))?;

    if output.status.success() {
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
            if let Some(model) = value
                .get("models")
                .and_then(serde_json::Value::as_array)
                .and_then(|models| models.first())
                .and_then(|model| model.get("slug"))
                .and_then(serde_json::Value::as_str)
                .filter(|model| !model.trim().is_empty())
            {
                return Ok(model.to_string());
            }
        }
    }

    Ok("gpt-5.5".to_string())
}

fn read_codex_config_model() -> Option<String> {
    let config_path = dirs::home_dir()?.join(".codex").join("config.toml");
    let content = std::fs::read_to_string(config_path).ok()?;
    parse_codex_config_model(&content)
}

fn parse_codex_config_model(content: &str) -> Option<String> {
    content.lines().find_map(|line| {
        let line = line.trim();
        if line.starts_with('#') || !line.starts_with("model") {
            return None;
        }
        let (key, value) = line.split_once('=')?;
        if key.trim() != "model" {
            return None;
        }
        let value = value
            .split('#')
            .next()
            .unwrap_or_default()
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

#[tauri::command]
pub async fn thread_delete(thread_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    // 先清 AgentManager 的 in-memory 状态 ── 与该 thread 关联的 read 工具快照
    // (HashMap<thread_id, HashMap<path, full_file_content>>, 整本笔记本大小)
    // 与卡死检测计数, 否则会无限泄露。两张表独立 HashMap.remove, 总是成功。
    //
    // `agent_manager` 是 `Arc<AgentManager>`, `cleanup_thread` 是 `&self` 方法,
    // 直接调用即可, 不再需要 `.write().await` 包装。
    state.agent_manager.cleanup_thread(&thread_id).await;
    let manager = state.thread_manager.read().await;
    manager
        .delete_thread(&thread_id)
        .await
        .map_err(|e| e.to_string())
}

/// 重命名 thread ── 改 SQLite `threads.title` 列, 顺带 bump `updated_at`,
/// 让历史列表按"最近活动"排序时, 刚被改名的对话能正确顶到顶部。
///
/// 返回 `None` 表示 thread 不存在 (UI 应忽略); 返回 `Some(info)` 时 info.title
/// 已经是新值, 可直接用于更新本地 store。前端 `sendMessageStream` 在首条用户
/// 消息落地后调一次, 覆盖"点了"新建对话"再发消息"的早期路径(那种情况下
/// `ensureThread` 走 early return, 不会生成新标题)。
#[tauri::command]
pub async fn thread_update_title(
    thread_id: String,
    title: String,
    state: State<'_, AppState>,
) -> Result<Option<ThreadInfo>, String> {
    let manager = state.thread_manager.read().await;
    manager
        .update_title(&thread_id, title)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_codex_config_model() {
        assert_eq!(
            parse_codex_config_model("model = \"gpt-5.5\"\n").as_deref(),
            Some("gpt-5.5")
        );
        assert_eq!(
            parse_codex_config_model("model = 'gpt-5-codex' # comment\n").as_deref(),
            Some("gpt-5-codex")
        );
        assert_eq!(parse_codex_config_model("service_tier = \"default\""), None);
    }
}
