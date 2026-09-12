use std::{collections::HashMap, path::Path};

use tauri::State;

use crate::agent_external::runtime_registry::ExternalCliRuntime;
use crate::agent_session::AgentExternalEvent;
use crate::agent_wire::{AgentChatResponse, AgentUserMessage, RunInfo};
use crate::app::state::AppState;

use super::image_cache::{
    resolve_cached_agent_image, MAX_AGENT_IMAGE_BYTES, MAX_AGENT_IMAGE_COUNT,
};
use super::runtime::{
    runtime_from_agent_type, runtime_from_message, runtime_handle, stop_any_runtime_chat,
    AgentRuntime,
};

#[tauri::command]
#[allow(non_snake_case)]
pub async fn chat_with_agent_stream(
    threadId: String,
    mut message: AgentUserMessage,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<AgentChatResponse, String> {
    let runtime = runtime_from_message(&message)?;
    if message.image_paths.len() > MAX_AGENT_IMAGE_COUNT {
        return Err(format!(
            "A message can attach at most {MAX_AGENT_IMAGE_COUNT} images"
        ));
    }
    let mut validated_image_paths = Vec::with_capacity(message.image_paths.len());
    for raw in std::mem::take(&mut message.image_paths) {
        let Some(path) = resolve_cached_agent_image(&raw).await? else {
            continue;
        };
        let metadata = tokio::fs::metadata(&path)
            .await
            .map_err(|error| format!("Failed to inspect cached image: {error}"))?;
        if metadata.len() > MAX_AGENT_IMAGE_BYTES as u64 {
            return Err(format!(
                "Image exceeds {} MB limit",
                MAX_AGENT_IMAGE_BYTES / 1024 / 1024
            ));
        }
        validated_image_paths.push(path.to_string_lossy().into_owned());
    }
    message.image_paths = validated_image_paths;
    tracing::info!(
        "[Command] chat_with_agent_stream called for thread: {}, agent_type: {}",
        threadId,
        runtime.key()
    );

    if let Some(title) = message
        .conversation_title
        .as_deref()
        .map(|value| value.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|value| !value.is_empty())
    {
        let manager = &state.thread_manager;
        manager
            .ensure_thread(
                &threadId,
                crate::agent_types::AgentId::new(runtime.key()),
                title,
            )
            .await
            .map_err(|error| error.to_string())?;
    }

    // Refresh security-scoped access at every run, not only at startup. Start
    // access before validating because a macOS bookmark may be what makes the
    // directory visible to this process. Explicit runtime paths must never
    // silently fall back to the application cwd when a frozen path disappears.
    let runtime_cwd = message
        .cwd_for_runtime(runtime.key())
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_string);
    let runtime_workspace_paths = message.workspace_paths_for_runtime(runtime.key());
    if let Some(path) = runtime_cwd.as_deref() {
        state
            .security_bookmarks
            .start_accessing_for_path(Path::new(path));
    }
    for path in &runtime_workspace_paths {
        state
            .security_bookmarks
            .start_accessing_for_path(Path::new(path));
    }
    if let Some(path) = runtime_cwd.as_deref() {
        if !Path::new(path).is_dir() {
            return Err(format!("Agent working directory is unavailable: {path}"));
        }
    }
    for path in &runtime_workspace_paths {
        if !Path::new(path).is_dir() {
            return Err(format!("Agent workspace directory is unavailable: {path}"));
        }
    }

    // runtime 的 `chat_stream` 内部已经 `tokio::spawn` ── IPC 立即返回,
    // 不再 await 整个 stream 跑完。真正的助手回答通过 `agent-chunk` 事件
    // (`Text` / `Reasoning` 变体) 推到前端, 按 `thread_id` 派发到
    // `threadStates[tid]`。
    let result = runtime_handle(&state, runtime)
        .chat_stream(&threadId, message, &app_handle)
        .await;
    tracing::info!(
        "[Command] {} chat_with_agent_stream result: {:?}",
        runtime.key(),
        result.is_ok()
    );
    result.map(|response| AgentChatResponse { response })
}

/// Append input to the currently active steerable turn without creating a new run.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn steer_agent_stream(
    threadId: String,
    message: AgentUserMessage,
    clientUserMessageId: String,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    match message.agent_type.as_deref() {
        Some("codex") => {
            state
                .external_runtimes
                .steer_codex(&threadId, message, clientUserMessageId, &app_handle)
                .await
        }
        Some("deepseek-harness") | Some("deepseek_harness") | Some("dsh") => {
            state
                .external_runtimes
                .steer_deepseek_harness(&threadId, message, clientUserMessageId, &app_handle)
                .await
        }
        other => Err(format!(
            "turn/steer is not supported for agent type {}",
            other.unwrap_or("<missing>")
        )),
    }
}

/// Execute a DeepSeek Harness human slash command. This is deliberately a
/// separate IPC path from chat/steer: DSH commands are handled by the command
/// registry and are never sent to the model as ordinary prompt text.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn execute_deepseek_harness_command(
    threadId: String,
    command: String,
    message: AgentUserMessage,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    if !matches!(
        message.agent_type.as_deref(),
        Some("deepseek-harness") | Some("deepseek_harness") | Some("dsh") | None
    ) {
        return Err("DSH slash commands require the deepseek-harness agent".to_string());
    }
    state
        .deepseek_harness
        .execute_command(&threadId, &command, &message, &app_handle)
        .await
}

/// Read the DSH-native Skill catalog for one provider-owned session.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn deepseek_harness_skill_catalog(
    threadId: String,
    message: AgentUserMessage,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    if !matches!(
        message.agent_type.as_deref(),
        Some("deepseek-harness") | Some("deepseek_harness") | Some("dsh") | None
    ) {
        return Err("DSH skills require the deepseek-harness agent".to_string());
    }
    state
        .deepseek_harness
        .skill_catalog(&threadId, &message)
        .await
}

/// Frontend-initiated abort for an in-flight `chat_with_agent_stream`.
/// Returns `true` if a chat was actually running for this `threadId` and
/// got a cancel signal; `false` if there was nothing to cancel (e.g. user
/// clicked stop after the LLM had already finished, or never sent a
/// message). The frontend uses the boolean to decide whether to also
/// hide the stop button / show a toast ── a `false` return is harmless.
///
/// `runId` (optional) scopes the kill to a single in-flight run on the
/// thread. When `None` / unmatched, the manager falls back to a thread-wide
/// stop so legacy callers (and the `thread_delete` cleanup path that
/// doesn't track runs) keep working unchanged.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn stop_agent_stream(
    threadId: String,
    agentType: Option<String>,
    runId: Option<String>,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<bool, String> {
    let runtime = match agentType.as_deref() {
        Some(agent_type) => Some(runtime_from_agent_type(Some(agent_type))?),
        None => None,
    };
    tracing::info!(
        "[Command] stop_agent_stream called for thread: {}, agent_type: {}, run_id: {}",
        threadId,
        runtime.map(AgentRuntime::key).unwrap_or("unknown"),
        runId.as_deref().unwrap_or("<any>")
    );
    let signalled = match runtime {
        Some(runtime) => {
            runtime_handle(&state, runtime)
                .stop_chat(&threadId, run_id_for_kill(runId.as_deref()), &app_handle)
                .await
        }
        None => stop_any_runtime_chat(&threadId, &state, &app_handle).await,
    };
    tracing::info!(
        "[Command] stop_agent_stream result: {} (chat was {}running)",
        threadId,
        if signalled { "" } else { "not " }
    );
    Ok(signalled)
}

fn run_id_for_kill(provided: Option<&str>) -> Option<&str> {
    provided.map(str::trim).filter(|value| !value.is_empty())
}

/// 查询当前所有 in-flight chat ── 前端启动时调一次, 用来 seed
/// `threadStates[].isLoading`, "进程内已有后台跑 chat"在重开后仍正确。
/// 返回 `HashMap<thread_id, RunInfo>`; 空 map 表示当前
/// 没有 in-flight chat (稳定态)。
///
/// 进程退出后 in-flight chat 即消失; 这是"尽力而为"信息, A5 的启动清理
/// 兜底 `is_loading=1` 的 SQLite 残留, 二者组合保证 UI 状态一致。
#[tauri::command]
#[allow(non_snake_case)]
pub async fn agent_running_threads(
    state: State<'_, AppState>,
) -> Result<HashMap<String, RunInfo>, String> {
    Ok(state.external_runtimes.running_threads().await)
}

/// List Codex background terminals for the currently displayed conversation.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn agent_background_terminals(
    threadId: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    state
        .codex_app_server
        .list_background_terminals(&threadId)
        .await
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn agent_background_jobs(
    threadId: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    state.deepseek_harness.background_jobs(&threadId).await
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn agent_external_events(
    threadId: String,
    afterId: Option<i64>,
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<AgentExternalEvent>, String> {
    let manager = &state.thread_manager;
    let mut product_thread_id = threadId.clone();
    for runtime in state.external_runtimes.iter().map(ExternalCliRuntime::key) {
        if let Ok(Some(local_thread_id)) = manager
            .find_thread_by_external_session(&threadId, runtime)
            .await
        {
            product_thread_id = local_thread_id;
            break;
        }
    }
    let page_limit = limit.unwrap_or(1000).clamp(1, 1000);
    manager
        .list_agent_external_events_by_thread(&product_thread_id, afterId, page_limit)
        .await
        .map_err(|error| error.to_string())
}

/// Respond to a Codex app-server server request (command/file approval).
/// `requestId` is the exact JSON-RPC id serialized as text by the backend.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn codex_approval_respond(
    requestId: String,
    result: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .codex_app_server
        .respond_to_server_request(&requestId, result)
        .await
}

/// Update the Codex App Server settings for the next turn of an existing
/// conversation without creating a transcript item.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn codex_thread_settings_update(
    threadId: String,
    model: Option<String>,
    reasoningEffort: Option<String>,
    permissionMode: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .codex_app_server
        .update_thread_settings(
            &threadId,
            model.as_deref(),
            reasoningEffort.as_deref(),
            permissionMode.as_deref(),
        )
        .await
}

/// Execute a Codex-native slash command through the App Server. Commands are
/// kept separate from chat turns because `/compact` and `/goal` are protocol
/// operations, not user prompts.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn codex_slash_command(
    threadId: String,
    command: String,
    runtimeConfig: Option<crate::agent_wire::AgentRuntimeConfig>,
    runId: Option<String>,
    commandId: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    state
        .codex_app_server
        .execute_slash_command(
            &threadId,
            &command,
            runtimeConfig,
            runId.as_deref(),
            commandId.as_deref(),
            &app,
        )
        .await
}
