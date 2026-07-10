//! Thread IPC — 对话线程 CRUD。
//!
//! `thread_delete` 顺带清 `AgentManager` 的 in-memory 状态 (与该 thread 关联的
//! read 工具快照 + 卡死检测计数), 否则会无限泄露。

use serde::Serialize;
use tauri::State;
use tokio::process::Command;

use crate::agent::default_agent_id;
use crate::threads::{
    AgentConversationInstance, AgentConversationRun, ChatMessage, ThreadInfo, ThreadMessagesPage,
    UpsertAgentConversationInstance,
};

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
pub async fn local_agent_thread_list(
    agent_type: String,
    state: State<'_, AppState>,
) -> Result<Vec<ThreadInfo>, String> {
    let agent_type = agent_type.trim().to_ascii_lowercase();
    if !matches!(agent_type.as_str(), "gemini" | "hermes" | "openclaw") {
        return Err(format!("unsupported local agent type: {agent_type}"));
    }

    let manager = state.thread_manager.read().await;
    manager
        .list_threads_by_agent(&agent_type)
        .await
        .map_err(|e| e.to_string())
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
pub async fn agent_conversation_list(
    state: State<'_, AppState>,
) -> Result<Vec<AgentConversationInstance>, String> {
    let manager = state.thread_manager.read().await;
    manager
        .list_agent_conversation_instances()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_conversation_get(
    instance_id: String,
    state: State<'_, AppState>,
) -> Result<Option<AgentConversationInstance>, String> {
    let manager = state.thread_manager.read().await;
    manager
        .get_agent_conversation_instance(&instance_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_conversation_find_by_thread(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Option<AgentConversationInstance>, String> {
    let manager = state.thread_manager.read().await;
    manager
        .find_agent_conversation_by_thread_id(&thread_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_conversation_find_by_run(
    run_id: String,
    state: State<'_, AppState>,
) -> Result<Option<AgentConversationInstance>, String> {
    let manager = state.thread_manager.read().await;
    manager
        .find_agent_conversation_by_run_id(&run_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_conversation_upsert(
    instance: UpsertAgentConversationInstance,
    state: State<'_, AppState>,
) -> Result<AgentConversationInstance, String> {
    let manager = state.thread_manager.read().await;
    manager
        .upsert_agent_conversation_instance(instance)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_conversation_upsert_run_state(
    instance_id: String,
    run: AgentConversationRun,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let manager = state.thread_manager.read().await;
    manager
        .upsert_agent_conversation_run_state(&instance_id, run)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_conversation_delete(
    instance_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let manager = state.thread_manager.read().await;
    manager
        .delete_agent_conversation_instance(&instance_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_conversation_delete_for_thread(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    let manager = state.thread_manager.read().await;
    manager
        .delete_agent_conversation_instances_for_thread(&thread_id)
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
pub async fn codex_thread_get_page(
    thread_id: String,
    before_sequence: Option<i64>,
    limit: i64,
) -> Result<ThreadMessagesPage, String> {
    crate::codex_history::get_session_page(&thread_id, before_sequence, limit).await
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
pub async fn claude_thread_list() -> Result<Vec<ThreadInfo>, String> {
    crate::claude_history::list_sessions().await
}

#[tauri::command]
pub async fn claude_thread_get(thread_id: String) -> Result<GetThreadResponse, String> {
    let messages = crate::claude_history::get_session(&thread_id).await?;
    Ok(GetThreadResponse { messages })
}

#[tauri::command]
pub async fn claude_thread_session_id(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    if crate::claude_history::is_claude_session_id(&thread_id) {
        return Ok(Some(thread_id));
    }

    let manager = state.thread_manager.read().await;
    manager
        .get_external_session(&thread_id, "claude")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn hermes_thread_list() -> Result<Vec<ThreadInfo>, String> {
    crate::hermes_history::list_sessions().await
}

#[tauri::command]
pub async fn hermes_thread_get(thread_id: String) -> Result<GetThreadResponse, String> {
    let messages = crate::hermes_history::get_session(&thread_id).await?;
    Ok(GetThreadResponse { messages })
}

#[tauri::command]
pub async fn hermes_thread_get_page(
    thread_id: String,
    before_sequence: Option<i64>,
    limit: i64,
) -> Result<ThreadMessagesPage, String> {
    crate::hermes_history::get_session_page(&thread_id, before_sequence, limit).await
}

#[tauri::command]
pub async fn hermes_thread_session_id(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    if crate::hermes_history::is_hermes_session_id(&thread_id) {
        return Ok(Some(thread_id));
    }

    let manager = state.thread_manager.read().await;
    manager
        .get_external_session(&thread_id, "hermes")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn codex_default_model() -> Result<String, String> {
    if let Some(model) = read_codex_config_model() {
        return Ok(model);
    }

    if let Some(model) = query_codex_models().await?.first().cloned() {
        return Ok(model);
    }

    Ok("gpt-5.5".to_string())
}

#[tauri::command]
pub async fn agent_supported_models(agent_type: String) -> Result<Vec<String>, String> {
    match agent_type.trim().to_ascii_lowercase().as_str() {
        "codex" => query_codex_models().await,
        _ => Ok(Vec::new()),
    }
}

async fn query_codex_models() -> Result<Vec<String>, String> {
    let mut cmd = Command::new(crate::codex_cli::resolve_codex_binary());
    crate::process_window::hide_command_window(&mut cmd);
    let output = cmd
        .args(["debug", "models"])
        .output()
        .await
        .map_err(|e| format!("failed to query Codex models: {e}"))?;

    if output.status.success() {
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
            return Ok(parse_codex_models(&value));
        }
    }

    Ok(Vec::new())
}

fn parse_codex_models(value: &serde_json::Value) -> Vec<String> {
    let Some(models) = value.get("models").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    models
        .iter()
        .filter_map(|model| {
            model
                .get("slug")
                .or_else(|| model.get("id"))
                .or_else(|| model.get("name"))
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|model| !model.is_empty())
        })
        .filter(|model| seen.insert((*model).to_string()))
        .map(str::to_string)
        .collect()
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
    let flowix_stopped = state.agent_manager.stop_chat(&thread_id, None).await;
    let codex_stopped = state.codex_cli_manager.stop_chat(&thread_id, None).await;
    let claude_stopped = state.claude_cli_manager.stop_chat(&thread_id, None).await;
    let gemini_stopped = state.gemini_cli_manager.stop_chat(&thread_id, None).await;
    let hermes_stopped = state.hermes_cli_manager.stop_chat(&thread_id, None).await;
    let openclaw_stopped = state.openclaw_cli_manager.stop_chat(&thread_id, None).await;
    if flowix_stopped
        || codex_stopped
        || claude_stopped
        || gemini_stopped
        || hermes_stopped
        || openclaw_stopped
    {
        tracing::info!("[Thread] stopped running agent before deleting thread {thread_id}");
    }

    // 先清 AgentManager 的 in-memory 状态 ── 与该 thread 关联的 read 工具快照
    // (HashMap<thread_id, HashMap<path, full_file_content>>, 整本笔记本大小)
    // 与卡死检测计数, 否则会无限泄露。两张表独立 HashMap.remove, 总是成功。
    //
    // `agent_manager` 是 `Arc<AgentManager>`, `cleanup_thread` 是 `&self` 方法,
    // 直接调用即可, 不再需要 `.write().await` 包装。
    state.agent_manager.cleanup_thread(&thread_id).await;
    let manager = state.thread_manager.read().await;
    manager
        .delete_thread_with_agent_conversations(&thread_id)
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
#[allow(non_snake_case)]
pub async fn thread_update_title(
    thread_id: String,
    title: String,
    agentType: Option<String>,
    state: State<'_, AppState>,
) -> Result<Option<ThreadInfo>, String> {
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return Err("Thread title cannot be empty".to_string());
    }
    tracing::info!(
        "[Thread] update title requested for thread_id: {}, agent_type: {}",
        thread_id,
        agentType.as_deref().unwrap_or("unknown")
    );
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

    #[test]
    fn parses_codex_supported_models() {
        let value = serde_json::json!({
            "models": [
                { "slug": "gpt-5.6" },
                { "id": "gpt-5.6-sol" },
                { "name": "gpt-5.6-terra" },
                { "slug": "gpt-5.6" },
                { "slug": "" }
            ]
        });

        assert_eq!(
            parse_codex_models(&value),
            vec!["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra"]
        );
    }
}
