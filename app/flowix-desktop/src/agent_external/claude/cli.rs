use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncWriteExt, BufReader};
#[cfg(test)]
use tokio::process::Command;

use super::super::lifecycle::ExternalLifecycleEmitter;
pub(crate) use super::binary::resolve_claude_binary;
use super::command::{build_claude_command, preflight_claude, resolve_claude_cwd};
#[cfg(test)]
use super::command::{
    latest_versioned_subdir, normalized_claude_model, normalized_claude_permission_mode,
    parse_node_version, resolve_claude_node_binary,
};
#[cfg(test)]
use super::events::parse_claude_stdout_line;
use super::history::{claude_session_cwd, is_claude_session_id};
use super::stream::read_claude_stdout;
use super::AGENT_TYPE;
use crate::agent_external::{
    persist_and_emit_external_chunk, persist_external_chunk, read_stderr_to_string,
    resolve_and_freeze_runtime_cwd, resolve_external_failure, select_external_session_for_runtime,
    truncate_for_log, ExternalRunRegistry, USER_STOPPED_REASON,
};
use crate::agent_session::ThreadManager;
use crate::agent_wire::{AgentChunk, AgentUserMessage};
use crate::runtime_log;

fn append_attached_image_context(mut prompt: String, image_paths: &[String]) -> String {
    let paths: Vec<&str> = image_paths
        .iter()
        .map(String::as_str)
        .filter(|path| PathBuf::from(path).is_file())
        .collect();
    if paths.is_empty() {
        return prompt;
    }
    prompt.push_str("\n\n<attached_images>\n");
    for path in paths {
        prompt.push_str("- ");
        prompt.push_str(path);
        prompt.push('\n');
    }
    prompt.push_str("</attached_images>");
    prompt
}

pub struct ClaudeCliManager {
    thread_manager: Arc<ThreadManager>,
    runs: ExternalRunRegistry,
}

#[async_trait::async_trait]
impl ExternalLifecycleEmitter for ClaudeCliManager {
    fn lifecycle_agent_type(&self) -> &'static str {
        AGENT_TYPE
    }

    async fn emit_and_persist_lifecycle_chunk(
        &self,
        app_handle: &tauri::AppHandle,
        chunk: &AgentChunk,
        run_id: &str,
    ) {
        persist_and_emit_external_chunk(
            app_handle,
            &self.thread_manager,
            AGENT_TYPE,
            chunk,
            run_id,
            None,
        )
        .await;
    }

    async fn persist_emitted_stream_end(&self, chunk: &AgentChunk, run_id: &str) {
        persist_external_chunk(&self.thread_manager, AGENT_TYPE, chunk, run_id, None).await;
    }
}

impl ClaudeCliManager {
    pub fn new(thread_manager: Arc<ThreadManager>) -> Self {
        Self {
            thread_manager,
            runs: ExternalRunRegistry::new(AGENT_TYPE, AGENT_TYPE),
        }
    }

    pub async fn chat_stream(
        self: &Arc<Self>,
        thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<String, String> {
        let thread_id = thread_id.to_string();
        let start = self
            .runs
            .reserve_start(&thread_id, message.run_id.as_deref())
            .await?;
        let app_handle = app_handle.clone();
        let manager = self.clone();
        let run_id = start.run_id;
        let stream_end_emitted = start.stream_end_emitted;

        tokio::spawn(async move {
            manager
                .emit_user_message(&app_handle, &thread_id, &message, &run_id)
                .await;
            manager
                .emit_stream_start(&app_handle, &thread_id, &message, &run_id)
                .await;

            let result = manager
                .run_claude(
                    &thread_id,
                    &run_id,
                    message,
                    &app_handle,
                    stream_end_emitted.clone(),
                )
                .await;
            let cancelled = manager.runs.start_cancelled(&thread_id, &run_id).await;
            manager.runs.release_start(&thread_id, &run_id).await;
            let reason = if stream_end_emitted.load(Ordering::SeqCst) {
                None
            } else if cancelled {
                Some(USER_STOPPED_REASON.to_string())
            } else { match result {
                Ok(()) => None,
                Err(err) => {
                    manager
                        .emit_run_error(&app_handle, &thread_id, err.clone(), &run_id)
                        .await;
                    Some(err)
                }
            }};

            manager
                .emit_stream_end(
                    &app_handle,
                    &thread_id,
                    &run_id,
                    reason,
                    &stream_end_emitted,
                )
                .await;
        });

        Ok(String::new())
    }

    pub async fn stop_chat(
        &self,
        thread_id: &str,
        run_id: Option<&str>,
        app_handle: &tauri::AppHandle,
    ) -> bool {
        let mut event_thread_id = thread_id.to_string();
        let mut lookup_thread_id = thread_id.to_string();
        let mut stopped = match self
            .runs
            .stop_run(thread_id, thread_id, run_id, "ClaudeCli")
            .await {
                Ok(stopped) => stopped,
                Err(unconfirmed) => {
                    tracing::warn!("[ClaudeCli] stop still unconfirmed for run {}", unconfirmed.run_id);
                    return false;
                }
            };
        if stopped.is_none() {
            let mapped_thread_id = {
                self.thread_manager
                    .find_thread_by_external_session(thread_id, AGENT_TYPE)
                    .await
                    .ok()
                    .flatten()
            };
            if let Some(mapped_thread_id) = mapped_thread_id {
                if mapped_thread_id != thread_id {
                    lookup_thread_id = mapped_thread_id.clone();
                    stopped = match self
                        .runs
                        .stop_run(&mapped_thread_id, thread_id, run_id, "ClaudeCli")
                        .await {
                            Ok(stopped) => stopped,
                            Err(unconfirmed) => {
                                tracing::warn!("[ClaudeCli] stop still unconfirmed for run {}", unconfirmed.run_id);
                                return false;
                            }
                        };
                    if stopped.is_some() {
                        event_thread_id = mapped_thread_id;
                    }
                }
            }
        }
        let Some(stopped) = stopped else {
            if self.runs.cancel_start(&lookup_thread_id, run_id).await {
                return true;
            }
            // The reservation may have become a child between the first
            // stop lookup and cancellation. Recheck before reporting failure.
            let stopped = match self.runs.stop_run(&lookup_thread_id, thread_id, run_id, "ClaudeCli").await {
                Ok(Some(stopped)) => stopped,
                Ok(None) => return false,
                Err(unconfirmed) => {
                    tracing::warn!("[ClaudeCli] stop still unconfirmed for run {}", unconfirmed.run_id);
                    return false;
                }
            };
            event_thread_id = lookup_thread_id;
            self.emit_stream_end(
                app_handle,
                &event_thread_id,
                &stopped.run_id,
                Some(USER_STOPPED_REASON.to_string()),
                &stopped.stream_end_emitted,
            ).await;
            return true;
        };

        let run_id_for_chunk = stopped.run_id;
        self.emit_stream_end(
            app_handle,
            &event_thread_id,
            &run_id_for_chunk,
            Some(USER_STOPPED_REASON.to_string()),
            &stopped.stream_end_emitted,
        )
        .await;
        true
    }

    pub async fn running_threads(&self) -> HashMap<String, crate::agent_wire::RunInfo> {
        self.runs.running_threads().await
    }

    pub async fn stop_all(&self) -> usize {
        self.runs.kill_all("ClaudeCli").await
    }

    pub async fn reap_inactive_runs(
        &self,
        app_handle: &tauri::AppHandle,
        idle_timeout_ms: i64,
    ) -> usize {
        let finalized = self.runs.reap_inactive(idle_timeout_ms, "ClaudeCli").await;
        self.emit_watchdog_finalized(app_handle, &finalized).await;
        finalized.len()
    }

    async fn run_claude(
        &self,
        thread_id: &str,
        run_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
        stream_end_emitted: Arc<AtomicBool>,
    ) -> Result<(), String> {
        let mapped_session_id = {
            self.thread_manager
                .get_external_session(thread_id, AGENT_TYPE)
                .await
                .map_err(|e| e.to_string())?
        };
        let hint = is_claude_session_id(thread_id).then(|| thread_id.to_string());
        let session_id = select_external_session_for_runtime(mapped_session_id, hint);

        let authoritative_session_cwd = session_id
            .as_deref()
            .and_then(|sid| claude_session_cwd(sid).ok().flatten())
            .filter(|path| path.is_dir());

        let cwd = {
            if let (Some(frozen), Some(session_cwd)) = (
                self.thread_manager
                    .read_frozen_cwd(&thread_id)
                    .await
                    .ok()
                    .flatten(),
                authoritative_session_cwd.as_ref(),
            ) {
                if frozen.as_path() != session_cwd.as_path() {
                    runtime_log::record_agent_event(
                        "warn",
                        "claude_process",
                        "claude.cwd_reconciled",
                        "Frozen cwd differed from Claude session cwd; using session cwd",
                        Some(&thread_id),
                        Some(AGENT_TYPE),
                        Some(serde_json::json!({
                            "run_id": run_id,
                            "session_id": session_id,
                            "frozen_cwd": frozen.display().to_string(),
                            "session_cwd": session_cwd.display().to_string(),
                        })),
                    );
                }
            }
            resolve_and_freeze_runtime_cwd(
                &self.thread_manager,
                &thread_id,
                resolve_claude_cwd,
                &message,
                session_id.as_deref(),
                authoritative_session_cwd.as_deref(),
            )
            .await?
        };
        let mut workspace_paths = message.workspace_paths_for_runtime(AGENT_TYPE);
        for image_path in &message.image_paths {
            if let Some(parent) = std::path::Path::new(image_path).parent() {
                let parent = parent.to_string_lossy().into_owned();
                if !workspace_paths.contains(&parent) {
                    workspace_paths.push(parent);
                }
            }
        }

        let permission_mode = message
            .permission_mode_for_runtime(AGENT_TYPE)
            .map(str::to_string);
        let model = message.model_for_runtime(AGENT_TYPE).map(str::to_string);
        let prompt = append_attached_image_context(
            message.llm_content.unwrap_or(message.content),
            &message.image_paths,
        );

        runtime_log::record_agent_event(
            "info",
            "claude_process",
            "claude.spawn_start",
            "Starting Claude Code CLI",
            Some(thread_id),
            Some(AGENT_TYPE),
            Some(serde_json::json!({
                "run_id": run_id,
                "session_mode": if session_id.is_some() { "resume" } else { "new" },
                "session_id": session_id,
                "cwd": cwd.display().to_string(),
                "workspace_paths": workspace_paths,
                "permission_mode": permission_mode,
                "model": model,
                "prompt_chars": prompt.chars().count(),
            })),
        );

        preflight_claude()?;

        if self.runs.start_cancelled(thread_id, run_id).await {
            return Err(USER_STOPPED_REASON.to_string());
        }

        let mut child = build_claude_command(
            session_id.as_deref(),
            &cwd,
            &workspace_paths,
            permission_mode.as_deref(),
            model.as_deref(),
        )
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start Claude Code CLI: {e}"))?;
        let child_pid = child.id();
        runtime_log::record_agent_event(
            "info",
            "claude_process",
            "claude.spawn_ok",
            "Claude Code CLI process started",
            Some(thread_id),
            Some(AGENT_TYPE),
            Some(serde_json::json!({
                "run_id": run_id,
                "child_pid": child_pid,
            })),
        );

        let stdin = child.stdin.take();
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                crate::agent_external::shared::kill_child_tree(&mut child, "ClaudeCli", thread_id).await;
                return Err("failed to capture Claude Code stdout".to_string());
            }
        };
        let stderr = match child.stderr.take() {
            Some(stderr) => stderr,
            None => {
                crate::agent_external::shared::kill_child_tree(&mut child, "ClaudeCli", thread_id).await;
                return Err("failed to capture Claude Code stderr".to_string());
            }
        };

        if let Err(mut cancelled_child) = self
            .runs
            .insert_reserved(
                thread_id.to_string(),
                child,
                run_id,
                stream_end_emitted,
            )
            .await
        {
            crate::agent_external::shared::kill_child_tree(
                &mut cancelled_child, "ClaudeCli", thread_id,
            ).await;
            return Err(USER_STOPPED_REASON.to_string());
        }

        if let Some(mut stdin) = stdin {
            let write_result = async {
                stdin.write_all(prompt.as_bytes()).await
                    .map_err(|e| format!("failed to write Claude Code prompt: {e}"))?;
                stdin.shutdown().await
                    .map_err(|e| format!("failed to close Claude Code stdin: {e}"))
            }.await;
            if let Err(error) = write_result {
                let _ = self.runs.stop_run(thread_id, thread_id, Some(run_id), "ClaudeCli").await;
                return Err(error);
            }
        }

        let stdout_task = read_claude_stdout(
            thread_id.to_string(),
            run_id.to_string(),
            app_handle.clone(),
            self.thread_manager.clone(),
            self.runs.clone(),
            BufReader::new(stdout),
        );
        let stderr_task =
            read_stderr_to_string(thread_id, Some(run_id), &self.runs, BufReader::new(stderr));
        let (stdout_result, stderr_text) = tokio::join!(stdout_task, stderr_task);

        let status = if let Some(status) = self.runs.wait_for_exit_and_remove_if_run_id(thread_id, run_id).await? {
            status
        } else {
            // child 已�? stop_chat �?watchdog 移走 ── 二者都�?CAS 抢发�?
            // StreamEnd, 这里直接返回, tail �?CAS 会失败�?skip, 不双发�?
            runtime_log::record_agent_event(
                "warn",
                "claude_process",
                "claude.child_missing_after_run",
                "Claude child was removed before wait; likely stopped by user or watchdog",
                Some(thread_id),
                Some(AGENT_TYPE),
                Some(serde_json::json!({
                    "run_id": run_id,
                    "child_pid": child_pid,
                })),
            );
            return Ok(());
        };

        let provider_error = stdout_result?;
        let stderr_text = stderr_text.unwrap_or_default();
        runtime_log::record_agent_event(
            if status.success() { "info" } else { "error" },
            "claude_process",
            "claude.exit",
            "Claude Code CLI process exited",
            Some(thread_id),
            Some(AGENT_TYPE),
            Some(serde_json::json!({
                "run_id": run_id,
                "child_pid": child_pid,
                "success": status.success(),
                "code": status.code(),
                "stderr_chars": stderr_text.chars().count(),
                "stderr_preview": truncate_for_log(stderr_text.trim()),
            })),
        );
        if !status.success() {
            return Err(resolve_external_failure(
                provider_error.as_deref(),
                None,
                &stderr_text,
                "Claude Code CLI",
                &status.to_string(),
            ));
        }
        if let Some(provider_error) = provider_error {
            return Err(provider_error);
        }
        if !stderr_text.trim().is_empty() {
            tracing::info!("[ClaudeCli] stderr: {}", stderr_text.trim());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
