use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use uuid::Uuid;

use super::history::is_hermes_session_id;
use crate::agent::{AgentChunk, AgentId, AgentUserMessage};
use crate::external_runtime::cli_resolver::{
    no_extra_candidates, resolve_external_cli, ExternalCliSpec,
};
use crate::external_runtime::{
    emit_chunk_with_run_id, emit_stream_end_once, kill_child_tree, resolve_run_id,
    select_external_session_for_runtime, ExternalRunRegistry, USER_STOPPED_REASON,
};
use crate::runtime_log;
use crate::session::{ChatMessage as ThreadChatMessage, ThreadManager};

const AGENT_TYPE: &str = "hermes";
const DISPLAY_NAME: &str = "Hermes Agent";

/// 8 MiB cap on Hermes stdout accumulation. Hermes does not currently expose
/// a Codex-style JSON event stream in this integration, so stdout is treated as
/// final/plain assistant text and bounded defensively.
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

pub struct HermesCliManager {
    thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>,
    runs: ExternalRunRegistry,
}

impl HermesCliManager {
    pub fn new(thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>) -> Self {
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
        let app_handle = app_handle.clone();
        let manager = self.clone();
        let run_id = resolve_run_id(&thread_id, message.run_id.as_deref());
        // 共享的"StreamEnd 已经 emit 出去没"标志 ── 见 CodexCliManager 同名注释。
        let stream_end_emitted = Arc::new(AtomicBool::new(false));

        // Reap any zombie child (kill/oom/broken pipe leaves the registry
        // entry behind until the watchdog sweeps it) and refuse overlapping
        // runs BEFORE we emit StreamStart — otherwise the UI flashes
        // loading for ~ms and then bounces to an error.
        if let Some(reason) = self.runs.reap_stale(&thread_id).await {
            return Err(reason);
        }

        tokio::spawn(async move {
            // 通用 metadata 协议 ── StreamStart 携带该 run 锁定的
            // model / reasoning_effort, 前端 hover card 等组件可读。
            let model = message.model_for_runtime("hermes").map(str::to_string);
            let reasoning_effort = message
                .reasoning_effort_for_runtime("hermes")
                .map(str::to_string);
            emit_chunk_with_run_id(
                &app_handle,
                &AgentChunk::StreamStart {
                    thread_id: thread_id.clone(),
                    model,
                    reasoning_effort,
                },
                AGENT_TYPE,
                &run_id,
            );

            let reason = match manager
                .run_hermes(
                    &thread_id,
                    &run_id,
                    message,
                    &app_handle,
                    stream_end_emitted.clone(),
                )
                .await
            {
                Ok(()) => None,
                Err(err) => {
                    emit_chunk_with_run_id(
                        &app_handle,
                        &AgentChunk::Error {
                            thread_id: thread_id.clone(),
                            message: err.clone(),
                        },
                        AGENT_TYPE,
                        &run_id,
                    );
                    Some(err)
                }
            };

            // 兜底 emit: 若 stop_chat 还没替我们发过 StreamEnd, 由本路径补发;
            // 否则 CAS 失败, 跳过避免重复。详见 `shared::emit_stream_end_once`。
            emit_stream_end_once(
                &app_handle,
                &thread_id,
                &run_id,
                AGENT_TYPE,
                reason,
                &stream_end_emitted,
            );
        });

        Ok(String::new())
    }

    pub async fn stop_chat(
        &self,
        thread_id: &str,
        run_id: Option<&str>,
        app_handle: &tauri::AppHandle,
    ) -> bool {
        let running = match run_id {
            Some(rid) => self.runs.remove_if_run_id(thread_id, Some(rid)).await,
            None => self.runs.remove(thread_id).await,
        };
        let Some(mut running) = running else {
            return false;
        };
        kill_child_tree(&mut running.child, DISPLAY_NAME, thread_id).await;

        let run_id_for_chunk = running.run_id.as_deref().unwrap_or(thread_id).to_string();
        emit_stream_end_once(
            app_handle,
            thread_id,
            &run_id_for_chunk,
            AGENT_TYPE,
            Some(USER_STOPPED_REASON.to_string()),
            &running.stream_end_emitted,
        );
        true
    }

    pub async fn running_threads(&self) -> HashMap<String, crate::agent::RunInfo> {
        self.runs.running_threads().await
    }

    pub async fn stop_all(&self) -> usize {
        self.runs.kill_all(DISPLAY_NAME).await
    }

    async fn run_hermes(
        &self,
        thread_id: &str,
        run_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
        stream_end_emitted: Arc<AtomicBool>,
    ) -> Result<(), String> {
        let mapped_session_id = {
            let manager = self.thread_manager.read().await;
            manager
                .get_external_session(thread_id, AGENT_TYPE)
                .await
                .map_err(|e| e.to_string())?
        };
        let hint = is_hermes_session_id(thread_id).then(|| thread_id.to_string());
        let session_id = select_external_session_for_runtime(mapped_session_id, hint);

        let cwd = message
            .cwd_for_runtime(AGENT_TYPE)
            .map(PathBuf::from)
            .filter(|p| p.exists())
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."));
        let workspace_paths = message.workspace_paths_for_runtime(AGENT_TYPE);
        let permission_mode = message
            .permission_mode_for_runtime(AGENT_TYPE)
            .map(str::to_string);
        let prompt = message
            .llm_content
            .clone()
            .unwrap_or_else(|| message.content.clone());

        runtime_log::record_agent_event(
            "info",
            "hermes_process",
            "hermes.spawn_start",
            "Starting Hermes Agent CLI",
            Some(thread_id),
            Some(AGENT_TYPE),
            Some(serde_json::json!({
                "run_id": run_id,
                "session_mode": if session_id.is_some() { "resume" } else { "new" },
                "session_id": session_id,
                "cwd": cwd.display().to_string(),
                "workspace_paths": workspace_paths,
                "permission_mode": permission_mode,
                "prompt_chars": prompt.chars().count(),
            })),
        );

        self.persist_user_message(thread_id, &prompt, &message)
            .await?;

        let started_at_ms = chrono::Utc::now().timestamp_millis();
        let result = async {
            let mut child =
                build_hermes_command(&cwd, permission_mode.as_deref(), session_id.as_deref())
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                    .map_err(|e| format!("failed to start {DISPLAY_NAME}: {e}"))?;
            let child_pid = child.id();
            runtime_log::record_agent_event(
                "info",
                "hermes_process",
                "hermes.spawn_ok",
                "Hermes Agent CLI process started",
                Some(thread_id),
                Some(AGENT_TYPE),
                Some(serde_json::json!({
                    "run_id": run_id,
                    "child_pid": child_pid,
                })),
            );

            if let Some(mut stdin) = child.stdin.take() {
                stdin
                    .write_all(prompt.as_bytes())
                    .await
                    .map_err(|e| format!("failed to write Hermes prompt: {e}"))?;
                stdin
                    .shutdown()
                    .await
                    .map_err(|e| format!("failed to close Hermes stdin: {e}"))?;
            }

            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| "failed to capture Hermes stdout".to_string())?;
            let stderr = child
                .stderr
                .take()
                .ok_or_else(|| "failed to capture Hermes stderr".to_string())?;

            if let Err(mut duplicate_child) = self
                .runs
                .try_insert(
                    thread_id.to_string(),
                    child,
                    Some(run_id.to_string()),
                    stream_end_emitted,
                )
                .await
            {
                let _ = duplicate_child.kill().await;
                return Err(format!("{DISPLAY_NAME} is already running for this thread"));
            }

            let stdout_task = read_stdout_as_text(
                thread_id.to_string(),
                run_id.to_string(),
                app_handle.clone(),
                BufReader::new(stdout),
            );
            let stderr_task = read_to_string(BufReader::new(stderr));
            let (stdout_result, stderr_text) = tokio::join!(stdout_task, stderr_task);

            let mut running = self.runs.remove_if_run_id(thread_id, Some(run_id)).await;
            let status = if let Some(running) = running.as_mut() {
                running.child.wait().await.map_err(|e| e.to_string())?
            } else {
                runtime_log::record_agent_event(
                    "warn",
                    "hermes_process",
                    "hermes.child_missing_after_run",
                    "Hermes child removed before wait; likely stopped by user",
                    Some(thread_id),
                    Some(AGENT_TYPE),
                    Some(serde_json::json!({
                        "run_id": run_id,
                        "child_pid": child_pid,
                    })),
                );
                return Ok(());
            };

            let assistant_text = stdout_result?;
            let stderr_text = stderr_text.unwrap_or_default();
            runtime_log::record_agent_event(
                if status.success() { "info" } else { "error" },
                "hermes_process",
                "hermes.exit",
                "Hermes Agent CLI process exited",
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
                let detail = stderr_text.trim();
                return Err(if detail.is_empty() {
                    format!("{DISPLAY_NAME} exited with status {status}")
                } else {
                    format!("{DISPLAY_NAME} exited with status {status}: {detail}")
                });
            }
            if !stderr_text.trim().is_empty() {
                tracing::info!("[HermesCli] stderr: {}", stderr_text.trim());
            }
            self.persist_assistant_message(thread_id, &assistant_text)
                .await?;
            self.resolve_and_persist_session(thread_id, run_id, started_at_ms, app_handle)
                .await;
            Ok(())
        }
        .await;

        if let Err(err) = &result {
            if let Err(persist_err) = self.persist_error_message(thread_id, err).await {
                tracing::warn!(
                    "[HermesCli] failed to persist error message for {thread_id}: {persist_err}"
                );
            }
        }

        result
    }

    async fn persist_user_message(
        &self,
        thread_id: &str,
        prompt: &str,
        message: &AgentUserMessage,
    ) -> Result<(), String> {
        let manager = self.thread_manager.read().await;
        manager
            .ensure_thread(
                thread_id,
                AgentId(AGENT_TYPE.to_string()),
                default_thread_title(prompt),
            )
            .await
            .map_err(|e| e.to_string())?;
        manager
            .add_message(
                thread_id,
                ThreadChatMessage {
                    id: format!("user_{}", Uuid::new_v4()),
                    role: "user".to_string(),
                    content: prompt.to_string(),
                    llm_content: Some(prompt.to_string()),
                    system_reminder_directory: message.system_reminder_directory.clone(),
                    timestamp: chrono::Utc::now().to_rfc3339(),
                    is_loading: None,
                    tool_call_id: None,
                    tool_name: None,
                    tool_data: None,
                    tool_input: None,
                    tool_calls: None,
                    reasoning: None,
                    is_completed: None,
                    is_collapsed: None,
                },
            )
            .await
            .map_err(|e| e.to_string())
    }

    async fn persist_assistant_message(&self, thread_id: &str, text: &str) -> Result<(), String> {
        if text.trim().is_empty() {
            return Ok(());
        }
        let manager = self.thread_manager.read().await;
        manager
            .add_message(
                thread_id,
                ThreadChatMessage {
                    id: format!("assistant_{}", Uuid::new_v4()),
                    role: "assistant".to_string(),
                    content: text.to_string(),
                    llm_content: None,
                    system_reminder_directory: None,
                    timestamp: chrono::Utc::now().to_rfc3339(),
                    is_loading: None,
                    tool_call_id: None,
                    tool_name: None,
                    tool_data: None,
                    tool_input: None,
                    tool_calls: None,
                    reasoning: None,
                    is_completed: None,
                    is_collapsed: None,
                },
            )
            .await
            .map_err(|e| e.to_string())
    }

    async fn persist_error_message(&self, thread_id: &str, error: &str) -> Result<(), String> {
        let text = format!("Error: {}", error.trim());
        self.persist_assistant_message(thread_id, &text).await
    }

    async fn resolve_and_persist_session(
        &self,
        thread_id: &str,
        run_id: &str,
        started_at_ms: i64,
        app_handle: &tauri::AppHandle,
    ) {
        let Ok(Some(session_id)) = super::history::most_recent_session_since(started_at_ms).await
        else {
            return;
        };
        runtime_log::record_agent_event(
            "info",
            "hermes_process",
            "hermes.session_resolved",
            "Hermes CLI session resolved from sessions list",
            Some(thread_id),
            Some(AGENT_TYPE),
            Some(serde_json::json!({
                "run_id": run_id,
                "session_id": session_id,
            })),
        );
        let manager = self.thread_manager.read().await;
        if let Err(err) = manager
            .upsert_external_session(
                thread_id,
                AGENT_TYPE,
                &session_id,
                Some(serde_json::json!({
                    "source": "hermes sessions list/export",
                    "run_id": run_id,
                })),
            )
            .await
        {
            runtime_log::record_agent_event(
                "warn",
                "hermes_process",
                "hermes.session_persist_failed",
                "Failed to persist Hermes external session mapping",
                Some(thread_id),
                Some(AGENT_TYPE),
                Some(serde_json::json!({
                    "run_id": run_id,
                    "session_id": session_id,
                    "error": err.to_string(),
                })),
            );
        }
        emit_chunk_with_run_id(
            app_handle,
            &AgentChunk::SessionResolved {
                thread_id: thread_id.to_string(),
                session_id,
            },
            AGENT_TYPE,
            run_id,
        );
    }
}

fn build_hermes_command(
    cwd: &Path,
    permission_mode: Option<&str>,
    session_id: Option<&str>,
) -> Command {
    let mut cmd = Command::new(resolve_hermes_binary());
    crate::process_window::hide_command_window(&mut cmd);
    cmd.current_dir(cwd);
    cmd.args(command_args(permission_mode, session_id));
    cmd
}

fn command_args(permission_mode: Option<&str>, session_id: Option<&str>) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(session_id) = session_id.filter(|s| !s.trim().is_empty()) {
        args.push("--resume".to_string());
        args.push(session_id.to_string());
    }
    args.push("-z".to_string());
    args.push(String::new());
    if normalized_yolo_permission(permission_mode) {
        args.push("--yolo".to_string());
    }
    args
}

fn normalized_yolo_permission(permission_mode: Option<&str>) -> bool {
    matches!(permission_mode.map(str::trim), Some("danger-full-access"))
}

pub(crate) fn resolve_hermes_binary() -> PathBuf {
    resolve_external_cli(&HERMES_CLI_SPEC)
}

const HERMES_CLI_SPEC: ExternalCliSpec = ExternalCliSpec {
    binary_name: "hermes",
    #[cfg(windows)]
    windows_binary_name: "hermes.cmd",
    env_vars: &["HERMES_AGENT_CLI_PATH", "HERMES_CLI_PATH"],
    extra_unix_candidates: no_extra_candidates,
    #[cfg(windows)]
    extra_windows_candidates: hermes_extra_windows_candidates,
};

#[cfg(windows)]
fn hermes_extra_windows_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(local_app_data) = dirs::data_local_dir() {
        for file_name in ["hermes.exe", "hermes.cmd", "hermes.bat"] {
            candidates.push(
                local_app_data
                    .join("hermes")
                    .join("hermes-agent")
                    .join("venv")
                    .join("Scripts")
                    .join(file_name),
            );
        }
    }
    candidates
}

async fn read_stdout_as_text<R>(
    thread_id: String,
    run_id: String,
    app_handle: tauri::AppHandle,
    reader: BufReader<R>,
) -> Result<String, String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut reader = reader;
    let mut buffer = [0_u8; 4096];
    let mut output = String::new();
    let mut total_bytes: usize = 0;
    loop {
        let n = reader.read(&mut buffer).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        let text = String::from_utf8_lossy(&buffer[..n]).to_string();
        emit_chunk_with_run_id(
            &app_handle,
            &AgentChunk::Text {
                thread_id: thread_id.clone(),
                text: text.clone(),
            },
            AGENT_TYPE,
            &run_id,
        );
        output.push_str(&text);
        total_bytes = total_bytes.saturating_add(n);
        if total_bytes >= MAX_OUTPUT_BYTES {
            runtime_log::record_agent_event(
                "warn",
                "hermes_stdout",
                "hermes.stdout_truncated",
                "Hermes stdout exceeded soft cap; further bytes dropped",
                Some(&thread_id),
                Some(AGENT_TYPE),
                Some(serde_json::json!({
                    "run_id": run_id,
                    "max_bytes": MAX_OUTPUT_BYTES,
                })),
            );
            let mut drain = [0_u8; 4096];
            loop {
                match reader.read(&mut drain).await {
                    Ok(0) => break,
                    Ok(_) => continue,
                    Err(_) => break,
                }
            }
            break;
        }
    }
    runtime_log::record_agent_event(
        "info",
        "hermes_stdout",
        "hermes.stdout_eof",
        "Hermes stdout reached EOF",
        Some(&thread_id),
        Some(AGENT_TYPE),
        Some(serde_json::json!({
            "run_id": run_id,
            "total_bytes": total_bytes,
        })),
    );
    Ok(output)
}

async fn read_to_string<R>(reader: BufReader<R>) -> Result<String, String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut reader = reader;
    let mut out = String::new();
    reader
        .read_to_string(&mut out)
        .await
        .map_err(|e| e.to_string())?;
    Ok(out)
}

fn truncate_for_log(text: &str) -> String {
    const MAX_LOG_TEXT_CHARS: usize = 2048;
    let mut chars = text.chars();
    let truncated: String = chars.by_ref().take(MAX_LOG_TEXT_CHARS).collect();
    if chars.next().is_some() {
        format!("{truncated}\n...[truncated]")
    } else {
        truncated
    }
}

fn default_thread_title(prompt: &str) -> String {
    let title = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        format!("{DISPLAY_NAME} session")
    } else {
        title.chars().take(28).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hermes_command_uses_stdin_prompt_contract() {
        assert_eq!(command_args(None, None), vec!["-z", ""]);
        assert_eq!(
            command_args(None, Some("session_123")),
            vec!["--resume", "session_123", "-z", ""]
        );
    }

    #[test]
    fn hermes_command_maps_danger_full_access_to_yolo() {
        assert_eq!(
            command_args(Some("danger-full-access"), None),
            vec!["-z", "", "--yolo"]
        );
        assert_eq!(command_args(Some("workspace-write"), None), vec!["-z", ""]);
        assert_eq!(command_args(Some("read-only"), None), vec!["-z", ""]);
    }

    #[test]
    fn hermes_default_thread_title_collapses_whitespace_and_truncates() {
        assert_eq!(default_thread_title("  fix   this now  "), "fix this now");
        assert_eq!(default_thread_title(""), "Hermes Agent session");
        assert_eq!(
            default_thread_title("abcdefghijklmnopqrstuvwxyz123456"),
            "abcdefghijklmnopqrstuvwxyz12"
        );
    }

    #[test]
    fn hermes_yolo_permission_is_strict() {
        assert!(normalized_yolo_permission(Some("danger-full-access")));
        assert!(!normalized_yolo_permission(Some(" workspace-write ")));
        assert!(!normalized_yolo_permission(None));
    }
}
