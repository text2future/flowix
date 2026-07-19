use std::collections::HashMap;
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
    use super::super::events::{claude_event_to_chunks, silence_reason, should_silence_event};
    use super::*;
    use crate::agent_external::acquire_test_env_lock as acquire_env_lock;

    #[test]
    fn appends_existing_images_as_claude_context() {
        let root =
            std::env::temp_dir().join(format!("flowix-claude-image-test-{}", std::process::id(),));
        std::fs::create_dir_all(&root).expect("create image test dir");
        let image = root.join("pasted.png");
        std::fs::write(&image, b"png").expect("create image");
        let prompt = append_attached_image_context(
            "describe this".to_string(),
            &[image.to_string_lossy().into_owned()],
        );
        assert!(prompt.contains("<attached_images>"));
        assert!(prompt.contains(&image.to_string_lossy().to_string()));
        cleanup(&root);
    }

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
    fn emits_text_and_tool_result_blocks_from_user_array_content() {
        // type=user 的 content array 里同时含 text 与 tool_result 块时,两个块
        // 都发——text 块发 AgentChunk::Text,tool_result 块发 AgentChunk::ToolResult。
        // 这是 events.rs 流式路径的当前行为(与 history.rs 走过的路径
        // 一致——文本累积进 user ChatMessage、tool_result 保留为 tool 消息)。
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
            [
                AgentChunk::Text { text, .. },
                AgentChunk::ToolResult { id, result, .. }
            ] if text == "Base directory for this skill: /tmp/verify\n\nskill body"
                && id == "toolu_1"
                && result["content"] == "loaded"
        ));
    }

    #[test]
    fn user_tool_result_only_content_emits_tool_result_chunk() {
        // type=user 的 content array 里只有 tool_result 块(无 text)时,
        // 只发 ToolResult 一条 chunk,与原本的 tool_result 处理路径一致。
        let value = serde_json::json!({
            "type": "user",
            "message": {
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_2",
                    "content": "file contents"
                }]
            }
        });

        let chunks = claude_event_to_chunks("thread_1", &value);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::ToolResult { id, result, .. }]
                if id == "toolu_2" && result["content"] == "file contents"
        ));
    }

    #[test]
    fn user_image_block_is_silently_dropped() {
        // type=user 的 content array 含 image / attachment 等非 text/tool_result
        // 块时,不产生任何 chunk(没有 AgentChunk 变体可以承载 user image)。
        let value = serde_json::json!({
            "type": "user",
            "message": {
                "content": [
                    {
                        "type": "image",
                        "source": { "type": "base64", "media_type": "image/png", "data": "abc" }
                    },
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_3",
                        "content": "ok"
                    }
                ]
            }
        });

        let chunks = claude_event_to_chunks("thread_1", &value);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::ToolResult { id, result, .. }]
                if id == "toolu_3" && result["content"] == "ok"
        ));
    }

    #[test]
    fn drops_claude_synthetic_user_marker_while_streaming() {
        // 流式 stdout 的 isSynthetic=true — Skill 工具调用成功时,harness
        // 把 skill body 注入到主 agent 的 user 消息里。该字段覆盖到了。
        let stream_marker = serde_json::json!({
            "type": "user",
            "isSynthetic": true,
            "message": {
                "role": "user",
                "content": [{
                    "type": "text",
                    "text": "Base directory for this skill: /private/tmp/claude-501/bundled-skills/2.1.207/.../dataviz\n\n# Data Visualization\n\n..."
                }]
            }
        });
        let chunks = claude_event_to_chunks("thread_1", &stream_marker);
        assert!(chunks.is_empty());

        // 持久化 JSONL 的 isMeta=true — 同一类消息在 --resume / 压缩重建后
        // 的形态。同一 helper 应当兼容。
        let persistent_marker = serde_json::json!({
            "type": "user",
            "isMeta": true,
            "message": {
                "role": "user",
                "content": "[Your previous response had no visible output. Please continue.]"
            }
        });
        let chunks = claude_event_to_chunks("thread_1", &persistent_marker);
        assert!(chunks.is_empty());
    }

    #[test]
    fn emits_claude_subagent_event_while_streaming() {
        // 反向测试 — sub-agent 活动要展示在主 thread card 上,带真实工具名。
        // ToolResult 的 name 字段由 stream.rs 的 tool_use_id->name 映射填充
        // (这里单测只验证 chunk emit, 不验证 name 填充)。
        // type=user + subagent_type(sub-agent tool_result) -> 推 ToolResult
        let user_row = serde_json::json!({
            "type": "user",
            "subagent_type": "Explore",
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_xxx",
                    "content": "flowix"
                }]
            }
        });
        let chunks = claude_event_to_chunks("thread_1", &user_row);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::ToolResult { id, .. }] if id == "toolu_xxx"
        ));

        // type=assistant + subagent_type(sub-agent tool_use) -> 推 ToolCall
        let assistant_tool_use = serde_json::json!({
            "type": "assistant",
            "subagent_type": "general-purpose",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "call_6e8f0e4380094c58b5748d38",
                    "name": "Read",
                    "input": { "file_path": "README.md" }
                }]
            }
        });
        let chunks = claude_event_to_chunks("thread_1", &assistant_tool_use);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::ToolCall { name, .. }] if name == "Read"
        ));

        // type=assistant + subagent_type(sub-agent text) -> 推 Text
        let assistant_text = serde_json::json!({
            "type": "assistant",
            "subagent_type": "general-purpose",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "sub-agent reply" }]
            }
        });
        let chunks = claude_event_to_chunks("thread_1", &assistant_text);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::Text { text, .. }] if text == "sub-agent reply"
        ));
    }

    #[test]
    fn emits_subagent_spawn_tool_use_blocks_in_assistant_message() {
        // 主 agent 在 assistant 行里并行调起多个 Agent (Task) sub-agent ──
        // 每个 tool_use 块对应一个 spawn,主 thread card **应当**展示这些
        // tool_call 卡片(带真实工具名 "Agent")。文本 / 普通工具 (Bash / Read)
        // 同样正常发。
        let value = serde_json::json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "text", "text": "let me run several analyses in parallel" },
                    { "type": "tool_use", "id": "toolu_1", "name": "Agent",
                      "input": { "description": "Research Plausible and Umami" } },
                    { "type": "tool_use", "id": "toolu_2", "name": "Agent",
                      "input": { "description": "Research Matomo and Cloudflare" } },
                    { "type": "tool_use", "id": "toolu_3", "name": "Agent",
                      "input": { "description": "Research Fathom and Pirsch" } },
                    { "type": "tool_use", "id": "toolu_4", "name": "Bash",
                      "input": { "command": "echo main" } }
                ]
            }
        });

        let chunks = claude_event_to_chunks("thread_1", &value);

        // 三个 Agent tool_use 全部展示为 ToolCall(name="Agent")
        let agent_count = chunks.iter().filter(|c| {
            matches!(c, AgentChunk::ToolCall { name, .. } if name == "Agent")
        }).count();
        assert_eq!(agent_count, 3, "should emit 3 Agent ToolCall chunks; got {}", agent_count);

        // text 块正常发
        assert!(chunks.iter().any(|c| matches!(
            c, AgentChunk::Text { text, .. } if text == "let me run several analyses in parallel"
        )));

        // 普通 Bash tool_use 正常发
        assert!(chunks.iter().any(|c| matches!(
            c, AgentChunk::ToolCall { name, .. } if name == "Bash"
        )));
    }

    #[test]
    fn emits_agent_launch_metadata_tool_result() {
        // 反向测试 — "Async agent launched successfully" launch metadata
        // 也要 emit(主 thread card 展示 Agent tool 调起后的 launch 状态)。
        // content 有 string 和 array 两种形态,都应正常推 ToolResult。
        let string_form = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "call_e6e37468672748648ccf4b3e",
                    "content": "Async agent launched successfully. placeholder"
                }]
            }
        });
        let chunks = claude_event_to_chunks("thread_1", &string_form);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::ToolResult { ref id, .. }] if id == "call_e6e37468672748648ccf4b3e"
        ));

        let array_form = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "call_xx",
                    "content": [{
                        "type": "text",
                        "text": "Async agent launched successfully. array form"
                    }]
                }]
            }
        });
        let chunks = claude_event_to_chunks("thread_1", &array_form);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::ToolResult { ref id, .. }] if id == "call_xx"
        ));
    }

    #[test]
    fn keeps_normal_tool_result_with_empty_name_unchanged() {
        // 普通 Bash / Read tool_result 即便没 name 字段也应正常推 ToolResult
        // ── 后端不臆断。content 以 "Async agent launched successfully"
        // 起头那条才丢,其他原样的 tool_result 一律照常。name 空字符串是
        // 流路径的固定行为,由前端决定怎么 fallback。
        let value = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_1",
                    "content": "file contents"
                }]
            }
        });

        let chunks = claude_event_to_chunks("thread_1", &value);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::ToolResult { id, result, .. }]
                if id == "toolu_1" && result["content"] == "file contents"
        ));
    }

    #[test]
    fn emits_claude_sidechain_assistant_text_while_streaming() {
        // 反向测试 — isSidechain=true 标记的 sub-agent 文本应正常展示。
        let value = serde_json::json!({
            "type": "assistant",
            "isSidechain": true,
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "sub-agent says hi" }]
            }
        });

        let chunks = claude_event_to_chunks("thread_1", &value);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::Text { text, .. }] if text == "sub-agent says hi"
        ));
    }

    #[test]
    fn emits_claude_sidechain_user_tool_result_while_streaming() {
        // 反向测试 — isSidechain=true 标记的 sub-agent tool_result 应正常展示。
        let value = serde_json::json!({
            "type": "user",
            "isSidechain": true,
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_1",
                    "content": "sub-agent tool output"
                }]
            }
        });

        let chunks = claude_event_to_chunks("thread_1", &value);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::ToolResult { ref id, .. }] if id == "toolu_1"
        ));
    }

    #[test]
    fn silence_reason_categorizes_each_filter_case() {
        // is_subagent_event / is_sidechain_event 已从 silence_reason 撤除
        // (用户要求展示 sub-agent 工具调用)。silence_reason 现在只 catch:
        //   1. synthetic_user_event — task-notification XML
        //   2. synthetic_user_marker — isSynthetic / isMeta / Skill body
        //
        // synthetic_user_event: origin.kind == "task-notification"
        let synthetic = serde_json::json!({
            "type": "user",
            "origin": { "kind": "task-notification" },
            "message": { "role": "user", "content": "<task-notification>x</task-notification>" }
        });
        assert_eq!(silence_reason(&synthetic), Some("synthetic_user_event"));

        // synthetic_user_marker: type=user + isSynthetic=true (流式) 或 isMeta=true (JSONL)
        let stream_marker = serde_json::json!({
            "type": "user",
            "isSynthetic": true,
            "message": { "role": "user", "content": [{"type":"text","text":"skill body"}] }
        });
        assert_eq!(silence_reason(&stream_marker), Some("synthetic_user_marker"));

        let persistent_marker = serde_json::json!({
            "type": "user",
            "isMeta": true,
            "message": { "role": "user", "content": "[hidden reminder]" }
        });
        assert_eq!(silence_reason(&persistent_marker), Some("synthetic_user_marker"));

        // 反向断言: sub-agent 活动 + 普通主链路都不应被 silence_reason 拦
        // (前者在 history/stream 两条 path 上都应正常 emit, 由 stream.rs 的
        // tool_use_id->name 映射保证 ToolResult 拿到真实工具名)
        let subagent_user = serde_json::json!({
            "type": "user",
            "subagent_type": "Explore",
            "message": { "role": "user", "content": [{"type":"tool_result","tool_use_id":"x","content":"y"}] }
        });
        assert_eq!(silence_reason(&subagent_user), None);

        let subagent_assistant = serde_json::json!({
            "type": "assistant",
            "isSidechain": true,
            "message": { "role": "assistant", "content": [{"type":"tool_use","id":"x","name":"Read","input":{}}] }
        });
        assert_eq!(silence_reason(&subagent_assistant), None);

        // 主链路 assistant 不命中
        let main = serde_json::json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "hello" }]
            }
        });
        assert_eq!(silence_reason(&main), None);
        assert!(!should_silence_event(&main));
    }

    #[test]
    fn should_silence_event_agrees_with_silence_reason_is_some() {
        // 同一行任意两套谓词必须一致 — 反向条件(history.rs 标题检查用
        // should_silence_event,正向丢弃用 silence_reason)如果发生分歧会
        // 出现"被静默但被当作 title 候选"或"应丢弃却渲染"的回归。
        for value in [
            serde_json::json!({"type":"user","subagent_type":"Explore","message":{"role":"user","content":[]}}),
            serde_json::json!({"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[]}}),
            serde_json::json!({"type":"user","origin":{"kind":"task-notification"},"message":{"role":"user","content":"<task-notification>x</task-notification>"}}),
            serde_json::json!({"type":"user","isSynthetic":true,"message":{"role":"user","content":[{"type":"text","text":"x"}]}}),
            serde_json::json!({"type":"user","isMeta":true,"message":{"role":"user","content":"x"}}),
            serde_json::json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}),
            serde_json::json!({"type":"user","message":{"role":"user","content":"real user prompt"}}),
        ] {
            assert_eq!(
                should_silence_event(&value),
                silence_reason(&value).is_some(),
                "predicate mismatch for {value}"
            );
        }
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
