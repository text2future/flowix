//! Agent IPC — LLM 流式 chat + abort。
//!
//! Agent 的配置真源是 `~/.flowix/flowix-ai-config.toml` (经 `set_ai_config` 命令落盘)。
//! 后端按需从 `UserConfigStore` 拉取并在 `AgentManager` 里缓存 provider 实例,
//! 前端不再 init agent / 提交模型信息, 只发起 chat / thread 操作。

use std::collections::HashMap;

use tauri::State;

use crate::agent::{AgentChatResponse, AgentUserMessage, RunInfo};

use super::AppState;

#[tauri::command]
#[allow(non_snake_case)]
pub async fn chat_with_agent_stream(
    threadId: String,
    message: AgentUserMessage,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<AgentChatResponse, String> {
    let runtime = message
        .runtime
        .as_deref()
        .unwrap_or("flowix")
        .to_ascii_lowercase();
    tracing::info!(
        "[Command] chat_with_agent_stream called for thread: {}, runtime: {}",
        threadId,
        runtime
    );
    if runtime == "codex" {
        let result = state
            .codex_cli_manager
            .chat_stream(&threadId, message, &app_handle)
            .await;
        tracing::info!(
            "[Command] codex chat_with_agent_stream result: {:?}",
            result.is_ok()
        );
        return result
            .map(|response| AgentChatResponse { response })
            .map_err(|e| e.to_string());
    }

    // `agent_manager` 是 `Arc<AgentManager>`, `chat_stream` 内部已经
    // `tokio::spawn` ── IPC 立即返回, 不再 await 整个 stream 跑完。
    // 真正的助手回答通过 `agent-chunk` 事件 (`Text` / `Reasoning` 变体)
    // 推到前端, 按 `thread_id` 派发到 `threadStates[tid]`。
    //
    // Tauri IPC 边界仍要求 `Result<T, String>` ── `AgentError` 在此
    // `.map_err(|e| e.to_string())` 透传。当前 spawn 后不会走到 Err 分支
    // (错误信号已全部走 `Error` chunk), 但保留 Result 形状不破 IPC 契约。
    let result = state
        .agent_manager
        .chat_stream(&threadId, message, &app_handle)
        .await;
    tracing::info!(
        "[Command] chat_with_agent_stream result: {:?}",
        result.is_ok()
    );
    result
        .map(|response| AgentChatResponse { response })
        .map_err(|e| e.to_string())
}

/// Frontend-initiated abort for an in-flight `chat_with_agent_stream`.
/// Returns `true` if a chat was actually running for this `threadId` and
/// got a cancel signal; `false` if there was nothing to cancel (e.g. user
/// clicked stop after the LLM had already finished, or never sent a
/// message). The frontend uses the boolean to decide whether to also
/// hide the stop button / show a toast — a `false` return is harmless.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn stop_agent_stream(
    threadId: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    tracing::info!(
        "[Command] stop_agent_stream called for thread: {}",
        threadId
    );
    let flowix_signalled = state.agent_manager.stop_chat(&threadId).await;
    let codex_signalled = state.codex_cli_manager.stop_chat(&threadId).await;
    let signalled = flowix_signalled || codex_signalled;
    tracing::info!(
        "[Command] stop_agent_stream result: {} (chat was {}running)",
        threadId,
        if signalled { "" } else { "not " }
    );
    Ok(signalled)
}

/// 查询当前所有 in-flight chat ── 前端启动时调一次, seed
/// `threadStates[].isLoading`, 让"进程内已有后台跑 chat"在重启后
/// 仍然可见。返回 `HashMap<thread_id, RunInfo>`; 空 map 表示当前
/// 没有 in-flight chat (稳态)。
///
/// 进程退出 in-flight chat 自然死, 这是"瞬态"信息; A5 启动清理
/// 兜底 `is_loading=1` 的 SQLite 残留行, 二者组合保证 UI 状态一致。
#[tauri::command]
#[allow(non_snake_case)]
pub async fn agent_running_threads(
    state: State<'_, AppState>,
) -> Result<HashMap<String, RunInfo>, String> {
    let mut running = state.agent_manager.running_threads().await;
    running.extend(state.codex_cli_manager.running_threads().await);
    Ok(running)
}
