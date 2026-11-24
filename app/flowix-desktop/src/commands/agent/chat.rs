use std::{collections::HashMap, path::Path};

use tauri::State;

use crate::agent_wire::{AgentChatResponse, AgentUserMessage, RunInfo};
use crate::app::state::AppState;

use super::flowix_instructions::sync_native_agent_instructions;
use super::runtime::{
    runtime_from_agent_type, runtime_from_message, runtime_handle, stop_any_runtime_chat,
    AgentRuntime,
};
use crate::agent_image_cache::{
    resolve_cached_agent_image, MAX_AGENT_IMAGE_BYTES, MAX_AGENT_IMAGE_COUNT,
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
        runtime.id()
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
                crate::agent_types::AgentId::new(runtime.id()),
                title,
            )
            .await
            .map_err(|error| error.to_string())?;
    }

    let (runtime_cwd, runtime_workspace_paths) =
        validate_runtime_workspace(&message, runtime.id(), &state)?;

    if let Some(path) = runtime_cwd.as_deref() {
        let preference = state.user_config.get_preference();
        if let Err(error) = sync_native_agent_instructions(
            Path::new(path),
            runtime.id(),
            &runtime_workspace_paths,
            &preference.ai_memory_locations,
            &preference.ai_memory_folder,
            &preference.ai_personality,
        ) {
            tracing::warn!("Failed to sync agent instructions: {error}");
        }
    }

    // runtime 的 `chat_stream` 内部已经 `tokio::spawn` ── IPC 立即返回,
    // 不再 await 整个 stream 跑完。真正的助手回答通过 `agent-chunk` 事件
    // (`Text` / `Reasoning` 变体) 推到前端, 按 `thread_id` 派发到
    // `threadStates[tid]`。
    let result = state
        .external_runtimes
        .dispatch_chat(&threadId, runtime, message, &app_handle)
        .await;
    tracing::info!(
        "[Command] {} chat_with_agent_stream result: {:?}",
        runtime.id(),
        result.is_ok()
    );
    result.map(|response| AgentChatResponse { response })
}

fn validate_runtime_workspace(
    message: &AgentUserMessage,
    runtime: &str,
    state: &AppState,
) -> Result<(Option<String>, Vec<String>), String> {
    // Explicit runtime paths must never silently fall back to the application
    // cwd when a frozen path disappears.
    let runtime_cwd = message
        .cwd_for_runtime(runtime)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_string);
    let runtime_workspace_paths = message.workspace_paths_for_runtime(runtime);
    {
        let memo = state
            .memo_file
            .read()
            .map_err(|_| "memo file lock poisoned")?;
        let workspace = memo.read_notebook_workspace().map_err(|e| e.to_string())?;
        let scope = message
            .runtime_config
            .as_ref()
            .and_then(|config| config.notebook_id.as_deref());
        check_workspace_paths(
            &workspace,
            scope,
            runtime_cwd
                .iter()
                .chain(runtime_workspace_paths.iter())
                .map(String::as_str),
        )?;
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

    Ok((runtime_cwd, runtime_workspace_paths))
}

fn check_workspace_paths<'a>(
    workspace: &flowix_core::memo_file::NotebookWorkspaceSnapshot,
    scope: Option<&str>,
    paths: impl Iterator<Item = &'a str>,
) -> Result<(), String> {
    let mut roots = Vec::new();
    for notebook in &workspace.notebooks {
        if scope.is_some_and(|id| id != notebook.id) {
            continue;
        }
        roots.push(notebook.path.as_str());
        if let Some(config) = workspace.notebook_configs.get(&notebook.id) {
            roots.extend(
                config
                    .add_dirs
                    .iter()
                    .filter(|d| d.enabled && !d.missing)
                    .map(|d| d.path.as_str()),
            );
        }
    }
    for path in paths {
        let path = Path::new(path);
        if !roots
            .iter()
            .any(|root| crate::config::path_is_inside(path, Path::new(root)))
        {
            return Err(format!(
                "Agent workspace directory is no longer mounted: {}",
                path.display()
            ));
        }
        if workspace.notebooks.iter().any(|notebook| {
            crate::config::path_is_inside_reserved_directory(
                path,
                Path::new(&notebook.path),
                ".flowix",
            )
        }) {
            return Err("Agent workspace cannot use notebook internal storage".into());
        }
    }
    Ok(())
}

/// Append input to the currently active steerable turn without creating a new run.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn steer_agent_stream(
    threadId: String,
    message: AgentUserMessage,
    clientUserMessageId: String,
    deliveryMode: Option<String>,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    validate_runtime_workspace(&message, runtime_from_message(&message)?.id(), &state)?;
    match message.agent_type.as_deref() {
        Some("codex") => {
            state
                .external_runtimes
                .steer_codex(&threadId, message, clientUserMessageId, &app_handle)
                .await
        }
        Some("dsh") => {
            state
                .external_runtimes
                .steer_deepseek_harness(&threadId, message, clientUserMessageId, &app_handle)
                .await
        }
        Some("pi") => {
            let delivery = deliveryMode.as_deref().unwrap_or("steer");
            state
                .external_runtimes
                .queue_pi_message(&threadId, message, clientUserMessageId, delivery)
                .await
        }
        other => Err(format!(
            "turn/steer is not supported for agent type {}",
            other.unwrap_or("<missing>")
        )),
    }
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn promote_pi_follow_up_to_steer(
    threadId: String,
    clientUserMessageId: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .external_runtimes
        .promote_pi_follow_up(&threadId, &clientUserMessageId)
        .await
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn delete_pi_queued_message(
    threadId: String,
    clientUserMessageId: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .external_runtimes
        .delete_pi_queued_message(&threadId, &clientUserMessageId)
        .await
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn queue_codex_follow_up(
    threadId: String,
    message: AgentUserMessage,
    clientUserMessageId: String,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    state
        .external_runtimes
        .queue_codex_follow_up(&threadId, message, clientUserMessageId, &app_handle)
        .await
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn list_codex_follow_ups(
    threadId: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    state
        .external_runtimes
        .list_codex_follow_ups(&threadId)
        .await
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn restore_codex_follow_ups(
    threadId: String,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    state
        .external_runtimes
        .restore_codex_follow_ups(&threadId, &app_handle)
        .await
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn delete_codex_follow_up(
    threadId: String,
    queuedSubmissionId: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    state
        .external_runtimes
        .delete_codex_follow_up(&threadId, &queuedSubmissionId)
        .await
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn deliver_codex_follow_up_now(
    threadId: String,
    queuedSubmissionId: String,
    message: AgentUserMessage,
    clientUserMessageId: String,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    state
        .external_runtimes
        .deliver_codex_follow_up_now(
            &threadId,
            &queuedSubmissionId,
            message,
            clientUserMessageId,
            &app_handle,
        )
        .await
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
    state
        .external_runtimes
        .ensure_thread_writable(&threadId)
        .await?;
    if !matches!(message.agent_type.as_deref(), Some("dsh") | None) {
        return Err("DSH slash commands require the deepseek-harness agent".to_string());
    }
    validate_runtime_workspace(&message, "dsh", &state)?;
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
    if !matches!(message.agent_type.as_deref(), Some("dsh") | None) {
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
        runtime.map(AgentRuntime::id).unwrap_or("unknown"),
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

#[tauri::command]
pub async fn codex_approval_pending(
    state: State<'_, AppState>,
) -> Result<Vec<crate::agent_external::codex::CodexApprovalRequest>, String> {
    Ok(state.codex_app_server.pending_approval_requests().await)
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

#[cfg(test)]
mod workspace_tests {
    use super::*;
    use flowix_core::memo_file::{
        NotebookAddDir, NotebookConfig, NotebookWorkspaceConfig, NotebookWorkspaceSnapshot,
    };
    #[test]
    fn runtime_paths_follow_notebook_mounts_and_protect_internal_storage() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notes");
        let repo = temp.path().join("repo");
        std::fs::create_dir_all(root.join(".flowix")).unwrap();
        std::fs::create_dir(&repo).unwrap();
        let root = root.to_string_lossy().into_owned();
        let repo = repo.to_string_lossy().into_owned();
        let mut workspace = NotebookWorkspaceSnapshot {
            notebooks: vec![NotebookConfig {
                id: "one".into(),
                name: "One".into(),
                icon: None,
                path: root.clone(),
                is_default: true,
                sort: 0,
                created_at: 0,
                updated_at: 0,
            }],
            notebook_configs: HashMap::from([(
                "one".into(),
                NotebookWorkspaceConfig {
                    version: 1,
                    revision: 1,
                    add_dirs: vec![NotebookAddDir {
                        id: "repo".into(),
                        path: repo.clone(),
                        label: "Repo".into(),
                        enabled: true,
                        missing: false,
                    }],
                },
            )]),
        };
        assert!(check_workspace_paths(
            &workspace,
            Some("one"),
            [root.as_str(), repo.as_str()].into_iter()
        )
        .is_ok());
        assert!(
            check_workspace_paths(&workspace, Some("other"), [repo.as_str()].into_iter()).is_err()
        );
        let internal = Path::new(&root)
            .join(".flowix")
            .to_string_lossy()
            .into_owned();
        assert!(
            check_workspace_paths(&workspace, Some("one"), [internal.as_str()].into_iter())
                .is_err()
        );
        workspace
            .notebook_configs
            .get_mut("one")
            .unwrap()
            .add_dirs
            .clear();
        assert!(
            check_workspace_paths(&workspace, Some("one"), [repo.as_str()].into_iter()).is_err()
        );
    }
}
