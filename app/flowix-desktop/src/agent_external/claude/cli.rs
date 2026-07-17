use std::collections::HashMap;
#[cfg(test)]
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::io::{AsyncWriteExt, BufReader};
#[cfg(test)]
use tokio::process::Command;

pub(crate) use super::binary::resolve_claude_binary;
use super::command::{build_claude_command, preflight_claude, resolve_claude_cwd};
#[cfg(test)]
use super::command::{
    latest_versioned_subdir, normalized_claude_model, normalized_claude_permission_mode,
    parse_node_version, resolve_claude_node_binary,
};
#[cfg(test)]
use super::events::parse_claude_stdout_line;
use super::history::is_claude_session_id;
use super::stream::read_claude_stdout;
use super::{truncate_for_log, AGENT_TYPE};
use crate::agent_external::{
    emit_chunk_with_run_id, emit_stream_end_once, kill_child_tree,
    persist_watchdog_finalized_run_state, read_stderr_to_string, resolve_run_id,
    select_external_session_for_runtime, ExternalRunRegistry, USER_STOPPED_REASON,
};
use crate::agent_flowix::{AgentChunk, AgentUserMessage};
use crate::agent_session::ThreadManager;
use crate::runtime_log;

pub struct ClaudeCliManager {
    thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>,
    runs: ExternalRunRegistry,
}

impl ClaudeCliManager {
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
            let model = message.model_for_runtime("claude").map(str::to_string);
            let reasoning_effort = message
                .reasoning_effort_for_runtime("claude")
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
                .run_claude(
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

            // 兜底 emit: 若 stop_chat / watchdog 还没替我们发过 StreamEnd,
            // 由本路径补发; 否则 CAS 失败, 跳过避免重复。
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
        let mut running = match run_id {
            Some(rid) => self.runs.remove_if_run_id(thread_id, Some(rid)).await,
            None => self.runs.remove(thread_id).await,
        };
        if running.is_none() {
            let mapped_thread_id = {
                let manager = self.thread_manager.read().await;
                manager
                    .find_thread_by_external_session(thread_id, AGENT_TYPE)
                    .await
                    .ok()
                    .flatten()
            };
            if let Some(mapped_thread_id) = mapped_thread_id {
                if mapped_thread_id != thread_id {
                    running = match run_id {
                        Some(rid) => {
                            self.runs
                                .remove_if_run_id(&mapped_thread_id, Some(rid))
                                .await
                        }
                        None => self.runs.remove(&mapped_thread_id).await,
                    };
                }
            }
        }
        let Some(mut running) = running else {
            return false;
        };
        kill_child_tree(&mut running.child, "ClaudeCli", thread_id).await;

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

    pub async fn running_threads(&self) -> HashMap<String, crate::agent_flowix::RunInfo> {
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
        for run in &finalized {
            // CAS 已在 `reap_inactive` 锁内抢过 ── 这里的 run 都是 watchdog 赢得
            // slot 的, 直接发 Error + StreamEnd + persist, 不会双发。
            let run_id = run.run_id.as_deref().unwrap_or(run.thread_id.as_str());
            if let Some(reason) = run.reason.clone() {
                emit_chunk_with_run_id(
                    app_handle,
                    &AgentChunk::Error {
                        thread_id: run.thread_id.clone(),
                        message: reason.clone(),
                    },
                    AGENT_TYPE,
                    run_id,
                );
            }
            emit_chunk_with_run_id(
                app_handle,
                &AgentChunk::StreamEnd {
                    thread_id: run.thread_id.clone(),
                    reason: run.reason.clone(),
                },
                AGENT_TYPE,
                run_id,
            );
            persist_watchdog_finalized_run_state(&self.thread_manager, run, "ClaudeCli").await;
        }
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
            let manager = self.thread_manager.read().await;
            manager
                .get_external_session(thread_id, AGENT_TYPE)
                .await
                .map_err(|e| e.to_string())?
        };
        let hint = is_claude_session_id(thread_id).then(|| thread_id.to_string());
        let session_id = select_external_session_for_runtime(mapped_session_id, hint);

        let cwd = resolve_claude_cwd(&message, session_id.as_deref());
        let workspace_paths = message.workspace_paths_for_runtime(AGENT_TYPE);

        let permission_mode = message
            .permission_mode_for_runtime(AGENT_TYPE)
            .map(str::to_string);
        let model = message.model_for_runtime(AGENT_TYPE).map(str::to_string);
        let prompt = message.llm_content.unwrap_or(message.content);

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

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(prompt.as_bytes())
                .await
                .map_err(|e| format!("failed to write Claude Code prompt: {e}"))?;
            stdin
                .shutdown()
                .await
                .map_err(|e| format!("failed to close Claude Code stdin: {e}"))?;
        }

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture Claude Code stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "failed to capture Claude Code stderr".to_string())?;

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
            return Err("Claude Code CLI is already running for this thread".to_string());
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

        let mut child = self.runs.remove_if_run_id(thread_id, Some(run_id)).await;
        let status = if let Some(running) = child.as_mut() {
            running.child.wait().await.map_err(|e| e.to_string())?
        } else {
            // child 已被 stop_chat 或 watchdog 移走 ── 二者都已 CAS 抢发过
            // StreamEnd, 这里直接返回, tail 的 CAS 会失败而 skip, 不双发。
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

        stdout_result?;
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
            let detail = stderr_text.trim();
            return Err(if detail.is_empty() {
                format!("Claude Code CLI exited with status {status}")
            } else {
                format!("Claude Code CLI exited with status {status}: {detail}")
            });
        }
        if !stderr_text.trim().is_empty() {
            tracing::info!("[ClaudeCli] stderr: {}", stderr_text.trim());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    //! Tests in this module read or write process-global env vars
    //! (`PATH`, `CLAUDE_NODE_PATH`, `CLAUDE_CODE_CLI_PATH`, …). These
    //! mutations are process-wide and are visible to every other test
    //! in the binary, so the tests must hold the shared external-agent
    //! environment lock for the entire duration of the env access.
    //!
    //! **Convention:** any test that calls `std::env::var*` /
    //! `std::env::set_var` / `std::env::remove_var` (or transitively
    //! calls a helper that does) must start with
    //!
    //! ```ignore
    //! let _guard = acquire_env_lock();
    //! ```
    //!
    //! and hold `_guard` for the whole test body. Pure-function tests
    //! (e.g. parsers, sort helpers) don't need the lock.
    //!
    //! The guard returned by [`acquire_env_lock`] is intentionally
    //! `#[must_use]`-able via the leading `_guard =` binding — a missing
    //! `_` (or just dropping it) will still hold the lock until the
    //! function ends, so the binding just makes the intent obvious.
    use super::super::events::claude_event_to_chunks;
    use super::*;
    use crate::agent_external::acquire_test_env_lock as acquire_env_lock;

    #[test]
    fn maps_claude_assistant_text_to_chunk() {
        let value = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [{ "type": "text", "text": "hello" }]
            }
        });
        let chunks = claude_event_to_chunks("thread_1", &value);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::Text { text, .. }] if text == "hello"
        ));
    }

    #[test]
    fn maps_permission_modes() {
        assert_eq!(
            normalized_claude_permission_mode(Some("read-only")),
            Some("plan")
        );
        assert_eq!(
            normalized_claude_permission_mode(Some("workspace-write")),
            Some("acceptEdits")
        );
        assert_eq!(
            normalized_claude_permission_mode(Some("danger-full-access")),
            Some("bypassPermissions")
        );
        assert_eq!(
            normalized_claude_permission_mode(Some("yolo")),
            Some("bypassPermissions")
        );
        assert_eq!(normalized_claude_permission_mode(Some("inherit")), None);
    }

    #[test]
    fn normalizes_claude_model_override() {
        assert_eq!(
            normalized_claude_model(Some("claude-sonnet-4-20250514")),
            Some("claude-sonnet-4-20250514")
        );
        assert_eq!(normalized_claude_model(Some(" inherit ")), None);
        assert_eq!(normalized_claude_model(Some("")), None);
        assert_eq!(normalized_claude_model(None), None);
    }

    #[test]
    fn claude_command_adds_model_and_workspace_dirs() {
        let root = std::env::temp_dir().join(format!(
            "flowix-claude-workspace-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
        ));
        let cwd = root.join("primary");
        let secondary = root.join("secondary");
        let third = root.join("third");
        std::fs::create_dir_all(&cwd).expect("create primary dir");
        std::fs::create_dir_all(&secondary).expect("create secondary dir");
        std::fs::create_dir_all(&third).expect("create third dir");

        let workspace_paths = vec![
            cwd.to_string_lossy().to_string(),
            secondary.to_string_lossy().to_string(),
            secondary.to_string_lossy().to_string(),
            root.join("missing").to_string_lossy().to_string(),
            third.to_string_lossy().to_string(),
        ];
        let cmd = build_claude_command(
            None,
            &cwd,
            &workspace_paths,
            Some("workspace-write"),
            Some("claude-sonnet-4-20250514"),
        );
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();

        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--permission-mode" && pair[1] == "acceptEdits"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--model" && pair[1] == "claude-sonnet-4-20250514"));
        assert_eq!(
            args.windows(2)
                .filter(|pair| pair[0] == "--add-dir")
                .map(|pair| pair[1].clone())
                .collect::<Vec<_>>(),
            vec![
                secondary.to_string_lossy().to_string(),
                third.to_string_lossy().to_string()
            ]
        );

        cleanup(&root);
    }

    #[test]
    fn claude_command_maps_yolo_to_bypass_permissions() {
        let cwd = std::env::temp_dir();
        let workspace_paths = Vec::new();
        let cmd = build_claude_command(None, &cwd, &workspace_paths, Some("yolo"), None);
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();

        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--permission-mode" && pair[1] == "bypassPermissions"));
        assert!(!args.iter().any(|arg| arg == "--yolo"));
    }

    #[test]
    fn parse_claude_stdout_line_extracts_session_and_text() {
        let parsed = parse_claude_stdout_line(
            "thread_1",
            r#"{"type":"assistant","session_id":"019f0000-0000-7000-8000-000000000000","message":{"content":[{"type":"text","text":"hello"}]}}"#,
        );

        assert_eq!(
            parsed.session_id.as_deref(),
            Some("019f0000-0000-7000-8000-000000000000")
        );
        assert!(matches!(
            parsed.chunks.as_slice(),
            [AgentChunk::Text { thread_id, text }] if thread_id == "thread_1" && text == "hello"
        ));
    }

    #[test]
    fn parse_claude_stdout_line_keeps_non_json_as_text() {
        let parsed = parse_claude_stdout_line("thread_1", "plain progress");

        assert!(parsed.value.is_none());
        assert!(parsed.session_id.is_none());
        assert!(matches!(
            parsed.chunks.as_slice(),
            [AgentChunk::Text { text, .. }] if text == "plain progress\n"
        ));
    }

    #[test]
    fn parse_claude_stdout_line_maps_system_error() {
        let parsed = parse_claude_stdout_line(
            "thread_1",
            r#"{"type":"system","subtype":"error","message":"bad auth"}"#,
        );

        assert!(matches!(
            parsed.chunks.as_slice(),
            [AgentChunk::Error { message, .. }] if message == "bad auth"
        ));
    }

    #[test]
    fn maps_claude_tool_blocks_to_chunks() {
        let assistant = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "Read",
                    "input": { "file_path": "README.md" }
                }]
            }
        });
        let chunks = claude_event_to_chunks("thread_1", &assistant);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::ToolCall { id, name, input, .. }]
                if id == "toolu_1" && name == "Read" && input["file_path"] == "README.md"
        ));

        let user = serde_json::json!({
            "type": "user",
            "message": {
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_1",
                    "content": "file contents"
                }]
            }
        });
        let chunks = claude_event_to_chunks("thread_1", &user);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::ToolResult { id, name, result, .. }]
                if id == "toolu_1" && name.is_empty() && result["content"] == "file contents"
        ));
    }

    #[test]
    fn ignores_claude_user_text_blocks_while_streaming() {
        let value = serde_json::json!({
            "type": "user",
            "message": {
                "content": [
                    {
                        "type": "text",
                        "text": "Base directory for this skill: /tmp/verify\n\nskill body"
                    },
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_1",
                        "content": "loaded"
                    }
                ]
            }
        });

        let chunks = claude_event_to_chunks("thread_1", &value);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::ToolResult { id, result, .. }]
                if id == "toolu_1" && result["content"] == "loaded"
        ));
    }

    fn make_fake_executable(dir_suffix: &str, name: &str, body: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "flowix-claude-cli-test-{}-{}-{}",
            std::process::id(),
            dir_suffix,
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let executable = dir.join(name);
        std::fs::write(&executable, body).expect("write fake executable");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&executable)
                .expect("stat fake executable")
                .permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&executable, perms).expect("chmod fake executable");
        }
        (dir, executable)
    }

    #[test]
    fn resolve_claude_node_binary_prefers_claude_node_path_env() {
        let _guard = acquire_env_lock();
        let (dir, fake_node) = make_fake_executable("node-env", "node", "#!/bin/sh\nexit 0\n");

        let original = std::env::var_os("CLAUDE_NODE_PATH");
        std::env::set_var("CLAUDE_NODE_PATH", &fake_node);
        let resolved = resolve_claude_node_binary();
        match original {
            Some(value) => std::env::set_var("CLAUDE_NODE_PATH", value),
            None => std::env::remove_var("CLAUDE_NODE_PATH"),
        }
        cleanup(&dir);

        assert_eq!(resolved, Some(fake_node));
    }

    #[test]
    fn resolve_claude_node_binary_finds_node_in_path() {
        let _guard = acquire_env_lock();
        let (dir, fake_node) = make_fake_executable("node-path", "node", "#!/bin/sh\nexit 0\n");

        let original_path = std::env::var_os("PATH");
        let original_node_env = std::env::var_os("CLAUDE_NODE_PATH");
        std::env::remove_var("CLAUDE_NODE_PATH");
        let sep = if cfg!(windows) { ';' } else { ':' };
        let joined = match &original_path {
            Some(path) => format!("{}{}{}", dir.display(), sep, path.to_string_lossy()),
            None => dir.display().to_string(),
        };
        std::env::set_var("PATH", joined);
        let resolved = resolve_claude_node_binary();
        match original_path {
            Some(value) => std::env::set_var("PATH", value),
            None => std::env::remove_var("PATH"),
        }
        match original_node_env {
            Some(value) => std::env::set_var("CLAUDE_NODE_PATH", value),
            None => std::env::remove_var("CLAUDE_NODE_PATH"),
        }
        cleanup(&dir);

        assert_eq!(resolved, Some(fake_node));
    }

    #[test]
    fn claude_command_launches_js_cli_through_node() {
        let _guard = acquire_env_lock();
        let (claude_dir, fake_claude_js) =
            make_fake_executable("js-cli", "claude.js", "#!/usr/bin/env node\n");
        let (node_dir, fake_node) = make_fake_executable("js-node", "node", "#!/bin/sh\nexit 0\n");

        let original_cli = std::env::var_os("CLAUDE_CODE_CLI_PATH");
        let original_node = std::env::var_os("CLAUDE_NODE_PATH");
        std::env::set_var("CLAUDE_CODE_CLI_PATH", &fake_claude_js);
        std::env::set_var("CLAUDE_NODE_PATH", &fake_node);

        let cwd = std::env::temp_dir();
        let cmd = build_claude_command(None, &cwd, &[], None, None);
        let program = cmd.as_std().get_program().to_string_lossy().to_string();
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        let expected_cli = std::fs::canonicalize(&fake_claude_js)
            .unwrap_or_else(|_| fake_claude_js.clone())
            .to_string_lossy()
            .to_string();

        match original_cli {
            Some(value) => std::env::set_var("CLAUDE_CODE_CLI_PATH", value),
            None => std::env::remove_var("CLAUDE_CODE_CLI_PATH"),
        }
        match original_node {
            Some(value) => std::env::set_var("CLAUDE_NODE_PATH", value),
            None => std::env::remove_var("CLAUDE_NODE_PATH"),
        }
        cleanup(&claude_dir);
        cleanup(&node_dir);

        assert_eq!(program, fake_node.to_string_lossy());
        assert_eq!(
            args.first().map(String::as_str),
            Some(expected_cli.as_str())
        );
    }

    #[test]
    fn preflight_claude_returns_friendly_error_when_no_node() {
        let _guard = acquire_env_lock();
        let (dir, fake_claude_js) =
            make_fake_executable("preflight-js", "claude.js", "#!/usr/bin/env node\n");

        let original_path = std::env::var_os("PATH");
        let original_node_env = std::env::var_os("CLAUDE_NODE_PATH");
        let original_cli_env = std::env::var_os("CLAUDE_CODE_CLI_PATH");
        std::env::remove_var("CLAUDE_NODE_PATH");
        std::env::set_var("PATH", "");
        std::env::set_var("CLAUDE_CODE_CLI_PATH", &fake_claude_js);

        let result = preflight_claude();

        match original_path {
            Some(value) => std::env::set_var("PATH", value),
            None => std::env::remove_var("PATH"),
        }
        match original_node_env {
            Some(value) => std::env::set_var("CLAUDE_NODE_PATH", value),
            None => std::env::remove_var("CLAUDE_NODE_PATH"),
        }
        match original_cli_env {
            Some(value) => std::env::set_var("CLAUDE_CODE_CLI_PATH", value),
            None => std::env::remove_var("CLAUDE_CODE_CLI_PATH"),
        }
        cleanup(&dir);

        if let Err(message) = result {
            assert!(message.contains("Node.js"));
            assert!(message.contains("CLAUDE_NODE_PATH") || message.contains("nodejs.org"));
        }
    }

    #[tokio::test]
    async fn real_claude_binary_smoke_test_opt_in() {
        if std::env::var("FLOWIX_RUN_REAL_CLAUDE_TESTS")
            .ok()
            .as_deref()
            != Some("1")
        {
            return;
        }

        preflight_claude().expect("claude preflight should pass");
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            Command::new(resolve_claude_binary())
                .arg("--version")
                .output(),
        )
        .await
        .expect("claude --version timed out")
        .expect("failed to run claude --version");

        assert!(
            output.status.success(),
            "claude --version failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn latest_versioned_subdir_prefers_high_major_over_lexicographic() {
        // Older Node left over from a long-ago install. A pure lexicographic
        // sort would compare '8' > '1' and wrongly resolve `swap_remove(last)`
        // to this old v8 directory. The semver-aware sort must pick v20.10.0.
        let parent = std::env::temp_dir().join(format!(
            "flowix-claude-cli-test-semver-major-{}",
            std::process::id(),
        ));
        std::fs::create_dir_all(&parent).expect("create temp dir");
        let v8 = parent.join("v8.17.0");
        let v18 = parent.join("v18.19.0");
        let v20 = parent.join("v20.10.0");
        for d in [&v8, &v18, &v20] {
            std::fs::create_dir_all(d).expect("create version dir");
        }
        // Non-version siblings must not poison the result.
        std::fs::create_dir_all(parent.join("latest")).expect("create latest dir");
        std::fs::create_dir_all(parent.join("current")).expect("create current dir");
        std::fs::write(parent.join("README.md"), "# readme").expect("write readme");

        let picked = latest_versioned_subdir(&parent);

        cleanup(&parent);

        assert_eq!(
            picked,
            Some(v20),
            "expected highest semver v20.10.0; got {:?} (lexicographic sort \
             would wrongly pick v8.17.0 since '8' > '1')",
            picked,
        );
    }

    #[test]
    fn parse_node_version_handles_nvm_fnm_and_asdf_shapes() {
        // nvm / fnm use the `v`-prefixed shape.
        assert_eq!(parse_node_version("v20.10.0"), Some((20, 10, 0)));
        assert_eq!(parse_node_version("v18.19.0"), Some((18, 19, 0)));
        // asdf installs use the unprefixed shape.
        assert_eq!(parse_node_version("18.19.0"), Some((18, 19, 0)));
        // Pre-release suffix is truncated before parsing the leading triple.
        assert_eq!(parse_node_version("v20.0.0-rc.1"), Some((20, 0, 0)),);
        // Junk / non-semver / over-segmented names return None, not garbage.
        assert_eq!(parse_node_version("latest"), None);
        assert_eq!(parse_node_version("current"), None);
        assert_eq!(parse_node_version("v18"), None);
        assert_eq!(parse_node_version("18.19.0.foo"), None);
    }
}
