use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, BufReader};
use tokio::process::Command;
use uuid::Uuid;

use crate::agent::{AgentChunk, AgentId, AgentUserMessage};
use crate::external_runtime::{
    emit_chunk_with_run_id, kill_child_tree, resolve_run_id, ExternalRunRegistry,
};
use crate::runtime_log;
use crate::session::{ChatMessage as ThreadChatMessage, ThreadManager};

/// 8 MiB cap on simple_cli stdout accumulation. Different from Codex/Claude
/// (whose stdout is line-JSON and bounded by `MAX_STDOUT_LINE_BYTES`); here
/// stdout is the assistant answer streamed back verbatim. 8 MiB is large
/// enough for any realistic response yet small enough to keep us honest
/// against a misbehaving CLI that streams without end.
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug)]
pub enum SimpleCliKind {
    Gemini,
    OpenClaw,
}

impl SimpleCliKind {
    pub fn key(self) -> &'static str {
        match self {
            Self::Gemini => "gemini",
            Self::OpenClaw => "openclaw",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Gemini => "Gemini CLI",
            Self::OpenClaw => "OpenClaw",
        }
    }

    fn binary_name(self) -> &'static str {
        match self {
            Self::Gemini => "gemini",
            Self::OpenClaw => "openclaw",
        }
    }

    fn env_var(self) -> &'static str {
        match self {
            Self::Gemini => "GEMINI_CLI_PATH",
            Self::OpenClaw => "OPENCLAW_CLI_PATH",
        }
    }

    fn env_var_aliases(self) -> &'static [&'static str] {
        match self {
            Self::Gemini => &[],
            Self::OpenClaw => &[],
        }
    }

    /// Category prefix used by `runtime_log::record_agent_event` for this
    /// vendor. Keeping the prefix short lets ops grep `simple_cli_process:`
    /// once and get all three vendors together when needed.
    fn log_category(self) -> &'static str {
        "simple_cli_process"
    }
}

pub struct SimpleCliManager {
    kind: SimpleCliKind,
    thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>,
    runs: ExternalRunRegistry,
}

impl SimpleCliManager {
    pub fn new(
        kind: SimpleCliKind,
        thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>,
    ) -> Self {
        let key = kind.key();
        Self {
            kind,
            thread_manager,
            runs: ExternalRunRegistry::new(key, key),
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

        tokio::spawn(async move {
            // 通用 metadata 协议 ── StreamStart 携带该 run 锁定的
            // model / reasoning_effort, 前端 hover card 等组件可读。
            // 按 manager 自身 kind 取, 避免 Gemini/OpenClaw 误读 flowix 段。
            let metadata_key = manager.kind.key();
            let model = message.model_for_runtime(metadata_key).map(str::to_string);
            let reasoning_effort = message
                .reasoning_effort_for_runtime(metadata_key)
                .map(str::to_string);
            emit_chunk_with_run_id(
                &app_handle,
                &AgentChunk::StreamStart {
                    thread_id: thread_id.clone(),
                    model,
                    reasoning_effort,
                },
                manager.kind.key(),
                &run_id,
            );

            let reason = match manager
                .run_cli(&thread_id, &run_id, message, &app_handle)
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
                        manager.kind.key(),
                        &run_id,
                    );
                    Some(err)
                }
            };

            emit_chunk_with_run_id(
                &app_handle,
                &AgentChunk::StreamEnd { thread_id, reason },
                manager.kind.key(),
                &run_id,
            );
        });

        Ok(String::new())
    }

    pub async fn stop_chat(&self, thread_id: &str, run_id: Option<&str>) -> bool {
        let running = match run_id {
            Some(rid) => self.runs.remove_if_run_id(thread_id, Some(rid)).await,
            None => self.runs.remove(thread_id).await,
        };
        let Some(mut running) = running else {
            return false;
        };
        kill_child_tree(&mut running.child, self.kind.display_name(), thread_id).await;
        true
    }

    pub async fn running_threads(&self) -> HashMap<String, crate::agent::RunInfo> {
        self.runs.running_threads().await
    }

    pub async fn stop_all(&self) -> usize {
        self.runs.kill_all(self.kind.display_name()).await
    }

    async fn run_cli(
        &self,
        thread_id: &str,
        run_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<(), String> {
        let cwd = message
            .cwd_for_runtime(self.kind.key())
            .map(PathBuf::from)
            .filter(|p| p.exists())
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."));
        let prompt = message
            .llm_content
            .clone()
            .unwrap_or_else(|| message.content.clone());
        if self.runs.contains(thread_id).await {
            return Err(format!(
                "{} is already running for this thread",
                self.kind.display_name()
            ));
        }

        runtime_log::record_agent_event(
            "info",
            self.kind.log_category(),
            "simple_cli.spawn_start",
            &format!("Starting {}", self.kind.display_name()),
            Some(thread_id),
            Some(self.kind.key()),
            Some(serde_json::json!({
                "run_id": run_id,
                "cwd": cwd.display().to_string(),
                "prompt_chars": prompt.chars().count(),
            })),
        );

        self.persist_user_message(thread_id, &prompt, &message)
            .await?;

        let result =
            async {
                let mut child = build_command(self.kind, &cwd, &prompt)
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                    .map_err(|e| format!("failed to start {}: {e}", self.kind.display_name()))?;
                let child_pid = child.id();
                runtime_log::record_agent_event(
                    "info",
                    self.kind.log_category(),
                    "simple_cli.spawn_ok",
                    &format!("{} process started", self.kind.display_name()),
                    Some(thread_id),
                    Some(self.kind.key()),
                    Some(serde_json::json!({
                        "run_id": run_id,
                        "child_pid": child_pid,
                    })),
                );

                drop(child.stdin.take());

                let stdout = child.stdout.take().ok_or_else(|| {
                    format!("failed to capture {} stdout", self.kind.display_name())
                })?;
                let stderr = child.stderr.take().ok_or_else(|| {
                    format!("failed to capture {} stderr", self.kind.display_name())
                })?;

                if self.runs.contains(thread_id).await {
                    let _ = child.kill().await;
                    return Err(format!(
                        "{} is already running for this thread",
                        self.kind.display_name()
                    ));
                }
                self.runs
                    .insert(thread_id.to_string(), child, Some(run_id.to_string()))
                    .await;

                let stdout_task = read_stdout_as_text(
                    thread_id.to_string(),
                    run_id.to_string(),
                    app_handle.clone(),
                    self.kind.key(),
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
                        self.kind.log_category(),
                        "simple_cli.child_missing_after_run",
                        "Child removed before wait; likely stopped by user",
                        Some(thread_id),
                        Some(self.kind.key()),
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
                    self.kind.log_category(),
                    "simple_cli.exit",
                    &format!("{} process exited", self.kind.display_name()),
                    Some(thread_id),
                    Some(self.kind.key()),
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
                        format!("{} exited with status {status}", self.kind.display_name())
                    } else {
                        format!(
                            "{} exited with status {status}: {detail}",
                            self.kind.display_name()
                        )
                    });
                }
                if !stderr_text.trim().is_empty() {
                    tracing::info!(
                        "[{}] stderr: {}",
                        self.kind.display_name(),
                        stderr_text.trim()
                    );
                }
                self.persist_assistant_message(thread_id, &assistant_text)
                    .await?;
                Ok(())
            }
            .await;

        if let Err(err) = &result {
            if let Err(persist_err) = self.persist_error_message(thread_id, err).await {
                tracing::warn!(
                    "[{}] failed to persist error message for {thread_id}: {persist_err}",
                    self.kind.display_name()
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
                AgentId(self.kind.key().to_string()),
                default_thread_title(self.kind, prompt),
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

fn build_command(kind: SimpleCliKind, cwd: &Path, prompt: &str) -> Command {
    let mut cmd = Command::new(resolve_simple_cli_binary(kind));
    crate::process_window::hide_command_window(&mut cmd);
    cmd.current_dir(cwd);
    cmd.args(command_args(kind, prompt));
    cmd
}

fn command_args(kind: SimpleCliKind, prompt: &str) -> Vec<String> {
    match kind {
        SimpleCliKind::Gemini => vec!["-p".to_string(), prompt.to_string()],
        SimpleCliKind::OpenClaw => {
            let agent_id =
                std::env::var("OPENCLAW_AGENT_ID").unwrap_or_else(|_| "main".to_string());
            vec![
                "agent".to_string(),
                "--agent".to_string(),
                agent_id,
                "--message".to_string(),
                prompt.to_string(),
            ]
        }
    }
}

pub(crate) fn resolve_simple_cli_binary(kind: SimpleCliKind) -> PathBuf {
    for env_var in std::iter::once(kind.env_var()).chain(kind.env_var_aliases().iter().copied()) {
        if let Ok(path) = std::env::var(env_var) {
            let path = PathBuf::from(path);
            if path.exists() {
                return path;
            }
        }
    }

    #[cfg(windows)]
    {
        if let Some(home) = dirs::home_dir() {
            let npm_cmd = home
                .join("AppData")
                .join("Roaming")
                .join("npm")
                .join(format!("{}.cmd", kind.binary_name()));
            if npm_cmd.exists() {
                return npm_cmd;
            }
        }
        PathBuf::from(format!("{}.cmd", kind.binary_name()))
    }

    #[cfg(not(windows))]
    {
        if let Ok(found) = which_simple_cli(kind) {
            return found;
        }
        if let Some(home) = dirs::home_dir() {
            let candidates = [
                home.join(".npm-global/bin").join(kind.binary_name()),
                home.join(".npm/bin").join(kind.binary_name()),
                home.join(".local/bin").join(kind.binary_name()),
                home.join(".cargo/bin").join(kind.binary_name()),
                home.join(".bun/bin").join(kind.binary_name()),
                home.join(".volta/bin").join(kind.binary_name()),
                PathBuf::from("/opt/homebrew/bin").join(kind.binary_name()),
                PathBuf::from("/usr/local/bin").join(kind.binary_name()),
            ];
            for candidate in candidates {
                if candidate.exists() {
                    return candidate;
                }
            }
        }
        PathBuf::from(kind.binary_name())
    }
}

#[cfg(not(windows))]
fn which_simple_cli(kind: SimpleCliKind) -> Result<PathBuf, ()> {
    let Some(path_var) = std::env::var_os("PATH") else {
        return Err(());
    };
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(kind.binary_name());
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(())
}

async fn read_stdout_as_text<R>(
    thread_id: String,
    run_id: String,
    app_handle: tauri::AppHandle,
    agent_type: &'static str,
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
            agent_type,
            &run_id,
        );
        output.push_str(&text);
        total_bytes = total_bytes.saturating_add(n);
        if total_bytes >= MAX_OUTPUT_BYTES {
            runtime_log::record_agent_event(
                "warn",
                "simple_cli_stdout",
                "simple_cli.stdout_truncated",
                "Simple cli stdout exceeded soft cap; further bytes dropped",
                Some(&thread_id),
                Some(agent_type),
                Some(serde_json::json!({
                    "run_id": run_id,
                    "max_bytes": MAX_OUTPUT_BYTES,
                })),
            );
            // Drain remaining bytes without emitting so the child still sees
            // its stdio closed; the accumulated `output` is what's persisted.
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
        "simple_cli_stdout",
        "simple_cli.stdout_eof",
        "Simple cli stdout reached EOF",
        Some(&thread_id),
        Some(agent_type),
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

fn default_thread_title(kind: SimpleCliKind, prompt: &str) -> String {
    let title = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        format!("{} session", kind.display_name())
    } else {
        title.chars().take(28).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_args_match_cli_contracts() {
        assert_eq!(
            command_args(SimpleCliKind::Gemini, "hello"),
            vec!["-p", "hello"]
        );
        assert_eq!(
            command_args(SimpleCliKind::OpenClaw, "hello"),
            vec!["agent", "--agent", "main", "--message", "hello"]
        );
    }

    #[test]
    fn default_thread_title_collapses_whitespace_and_truncates() {
        assert_eq!(
            default_thread_title(SimpleCliKind::Gemini, "  fix   this now  "),
            "fix this now"
        );
        assert_eq!(
            default_thread_title(SimpleCliKind::OpenClaw, "abcdefghijklmnopqrstuvwxyz123456"),
            "abcdefghijklmnopqrstuvwxyz12"
        );
    }
}
