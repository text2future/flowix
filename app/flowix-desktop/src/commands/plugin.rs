use std::sync::Arc;
use tauri::{AppHandle, Listener, State};

use crate::agent_session::ThreadManager;
use crate::agent_wire::{AgentRuntimeConfig, AgentUserMessage, RuntimePathConfig};
use crate::app::state::AppState;
use crate::commands::agent::runtime::start_plugin_chat;
use crate::commands::agent::runtime::stop_any_runtime_chat;
use crate::plugin::{self, PluginArtifact, PluginDescriptor};

#[tauri::command]
pub fn plugin_list() -> Result<Vec<PluginDescriptor>, String> {
    plugin::list_plugins()
}

#[tauri::command]
pub fn plugin_refresh() -> Result<Vec<PluginDescriptor>, String> {
    plugin::refresh_plugins()
}

#[tauri::command]
pub fn plugin_install(
    source_directory: String,
    app_handle: AppHandle,
) -> Result<PluginDescriptor, String> {
    let descriptor = plugin::install_from_directory(&source_directory)?;
    plugin::emit_catalog_changed(&app_handle)?;
    Ok(descriptor)
}

#[tauri::command]
pub fn plugin_uninstall(plugin_id: String, app_handle: AppHandle) -> Result<(), String> {
    plugin::uninstall(&plugin_id)?;
    plugin::emit_catalog_changed(&app_handle)
}

#[tauri::command]
pub fn plugin_get(plugin_id: String) -> Result<PluginDescriptor, String> {
    plugin::get_plugin(&plugin_id)
}

#[tauri::command]
pub fn plugin_prepare_prompt(
    plugin_id: String,
    user_prompt: String,
    context: String,
) -> Result<String, String> {
    plugin::prepare_prompt(&plugin_id, &user_prompt, &context)
}

#[tauri::command]
pub fn plugin_list_notes(
    plugin_id: String,
    notebook_id: String,
    state: State<AppState>,
) -> Result<Vec<flowix_core::memo_file::Memo>, String> {
    plugin::list_notes(&plugin_id, &notebook_id, &state.memo_file)
}

#[tauri::command]
pub fn plugin_resolve_note(
    memo_id: String,
    state: State<AppState>,
) -> Result<PluginArtifact, String> {
    // Compatibility endpoint. The actual read is host-owned so the old
    // plugin API also remains usable after its producer has been removed.
    let session = crate::artifact::resolve(&memo_id, &state.memo_file)?;
    Ok(PluginArtifact {
        plugin_id: session.plugin_id,
        path: session.path,
        name: session.name,
        created_at: session.created_at,
        format: session.format,
        renderer: session.renderer,
        content: session.content,
        note_id: session.note_id,
    })
}

#[tauri::command]
pub async fn plugin_run(
    plugin_id: String,
    user_prompt: String,
    context: String,
    agent_type: String,
    notebook_path: String,
    source_note: Option<String>,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<plugin::PluginRunStarted, String> {
    let notebook_path = plugin::registered_notebook(&notebook_path, &state.memo_file)?
        .to_string_lossy()
        .into_owned();
    let agent_type = plugin::resolve_agent_type(&plugin_id, &agent_type)?;
    let prepared = plugin::prepare_prompt(&plugin_id, &user_prompt, &context)?;
    let run_id = plugin::new_run_id();
    if !state
        .plugin_runs
        .try_reserve(run_id.clone(), plugin_id.clone(), agent_type.clone())
        .await
    {
        return Err("plugin is already running".to_string());
    }
    let thread = match state
        .thread_manager
        .create_thread(
            crate::agent_types::default_agent_id(),
            format!("plugin:{plugin_id}"),
        )
        .await
    {
        Ok(thread) => thread,
        Err(error) => {
            let _ = state.plugin_runs.remove(&run_id).await;
            return Err(error.to_string());
        }
    };
    if !state
        .plugin_runs
        .attach_thread(&run_id, thread.thread_id.clone())
        .await
    {
        let _ = state
            .thread_manager
            .delete_thread_with_agent_conversations(&thread.thread_id)
            .await;
        let _ = state.plugin_runs.remove(&run_id).await;
        return Err("plugin run reservation expired".to_string());
    }
    let started = match plugin::begin_run_with_prepared(
        &plugin_id,
        prepared.clone(),
        &agent_type,
        &run_id,
        &app_handle,
    ) {
        Ok(started) => started,
        Err(error) => {
            let _ = state
                .thread_manager
                .delete_thread_with_agent_conversations(&thread.thread_id)
                .await;
            let _ = state.plugin_runs.remove(&run_id).await;
            return Err(error);
        }
    };
    let plugin_runs = state.plugin_runs.clone();
    let memo_file = Arc::clone(&state.memo_file);
    let thread_manager = Arc::clone(&state.thread_manager);
    let app = app_handle.clone();
    let state_agent = AgentUserMessage {
        content: prepared.clone(),
        llm_content: None,
        image_paths: Vec::new(),
        run_id: Some(run_id.clone()),
        system_reminder_directory: Some(notebook_path.clone()),
        agent_type: Some(agent_type.clone()),
        runtime_config: Some(AgentRuntimeConfig {
            deepseek_harness: Some(RuntimePathConfig {
                cwd: Some(notebook_path.clone()),
                workspace_paths: vec![notebook_path.clone()],
                permission_mode: None,
                model: None,
                provider_id: None,
                reasoning_effort: None,
                mode: None,
            }),
            ..Default::default()
        }),
        permission_mode: None,
        codex_model: None,
        codex_reasoning_effort: None,
        conversation_title: Some(format!("plugin:{plugin_id}")),
    };
    let plugin_id_for_task = plugin_id.clone();
    let (stream_end_tx, stream_end_rx) = tokio::sync::mpsc::unbounded_channel();
    let stream_end_run_id = run_id.clone();
    let stream_end_listener = app.listen("agent-chunk", move |event| {
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
            return;
        };
        if payload.get("run_id").and_then(serde_json::Value::as_str)
            != Some(stream_end_run_id.as_str())
            || payload.get("kind").and_then(serde_json::Value::as_str) != Some("stream_end")
        {
            return;
        }
        let reason = payload
            .get("reason")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let _ = stream_end_tx.send(reason);
    });
    if let Err(error) = start_plugin_chat(&state, &thread.thread_id, state_agent, &app).await {
        app.unlisten(stream_end_listener);
        let _ = thread_manager
            .delete_thread_with_agent_conversations(&thread.thread_id)
            .await;
        plugin_runs.remove(&run_id).await;
        let _ = plugin::emit_run_failed(&run_id, &plugin_id_for_task, &agent_type, &error, &app);
        return Err(error);
    }
    tauri::async_runtime::spawn(async move {
        let result = wait_for_plugin_output(
            &app,
            &plugin_runs,
            &run_id,
            &plugin_id_for_task,
            &agent_type,
            &thread.thread_id,
            &notebook_path,
            source_note.as_deref(),
            &memo_file,
            &thread_manager,
            stream_end_rx,
        )
        .await;
        app.unlisten(stream_end_listener);
        // Claim the terminal transition before cleaning up. Cancellation
        // removes the run from the coordinator first, so the cancellation
        // path remains the sole owner of stop-then-delete ordering.
        let owns_cleanup = plugin_runs.remove(&run_id).await.is_some();
        if owns_cleanup {
            if let Err(error) = result {
                let _ = plugin::emit_run_failed(
                    &run_id,
                    &plugin_id_for_task,
                    &agent_type,
                    &error,
                    &app,
                );
            }
        }
        if owns_cleanup {
            if let Err(error) = thread_manager
                .delete_thread_with_agent_conversations(&thread.thread_id)
                .await
            {
                tracing::warn!(thread_id = %thread.thread_id, "clean up plugin thread failed: {error}");
            }
        }
    });
    Ok(started)
}

#[tauri::command]
pub async fn plugin_run_stop(
    run_id: String,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<bool, String> {
    let Some(info) = state.plugin_runs.cancel(&run_id).await else {
        return Ok(false);
    };
    let stopped = info
        .thread_id
        .as_deref()
        .map(|thread_id| async { stop_any_runtime_chat(thread_id, &state, &app_handle).await });
    let stopped = match stopped {
        Some(stopped) => stopped.await,
        None => false,
    };
    if let Some(thread_id) = info.thread_id.as_deref() {
        if let Err(error) = state
            .thread_manager
            .delete_thread_with_agent_conversations(thread_id)
            .await
        {
            tracing::warn!(
                thread_id,
                "clean up cancelled plugin thread failed: {error}"
            );
        }
    }
    let _ = plugin::emit_run_event(
        &app_handle,
        plugin::PluginRunEvent {
            run_id,
            plugin_id: info.plugin_id,
            status: "cancelled".to_string(),
            agent_type: info.agent_type,
            artifact: None,
            error: None,
            content: None,
        },
    );
    Ok(stopped)
}

async fn wait_for_plugin_output(
    app: &AppHandle,
    runs: &plugin::PluginRunCoordinator,
    run_id: &str,
    plugin_id: &str,
    agent_type: &str,
    thread_id: &str,
    notebook_path: &str,
    source_note: Option<&str>,
    memo_file: &Arc<std::sync::RwLock<flowix_core::memo_file::MemoFile>>,
    thread_manager: &Arc<ThreadManager>,
    mut stream_end_rx: tokio::sync::mpsc::UnboundedReceiver<Option<String>>,
) -> Result<(), String> {
    if runs.thread_id(run_id).await.is_none() {
        // plugin_run_stop removes the coordinator entry and emits the
        // plugin-level cancelled event itself. Do not turn the later
        // Agent stream_end into a second failed event.
        return Ok(());
    }
    let reason = tokio::time::timeout(tokio::time::Duration::from_secs(600), stream_end_rx.recv())
        .await
        .map_err(|_| "plugin generation timed out".to_string())?
        .ok_or_else(|| "plugin agent event stream closed unexpectedly".to_string())?;
    if runs.thread_id(run_id).await.is_none() {
        return Ok(());
    }
    if let Some(reason) = reason.filter(|value| !value.trim().is_empty()) {
        return Err(reason);
    }
    let content = read_plugin_agent_output(thread_manager, agent_type, thread_id).await?;
    if runs.begin_finish(run_id).await.is_none() {
        return Ok(());
    }
    plugin::write_output(
        plugin_id,
        notebook_path,
        &content,
        agent_type,
        source_note,
        Some(run_id),
        Some(app),
        memo_file,
    )?;
    Ok(())
}

async fn read_plugin_agent_output(
    thread_manager: &Arc<ThreadManager>,
    agent_type: &str,
    thread_id: &str,
) -> Result<String, String> {
    let content = thread_manager
        .get_external_event_messages_page(agent_type, thread_id, None, 1)
        .await
        .map_err(|e| e.to_string())?
        .and_then(|page| {
            page.messages
                .into_iter()
                .rev()
                .find(|message| message.role == "assistant")
                .map(|message| message.content)
        });
    let content = content.unwrap_or_default();
    if content.trim().is_empty() {
        return Err("plugin agent returned empty output".to_string());
    }
    Ok(content)
}
