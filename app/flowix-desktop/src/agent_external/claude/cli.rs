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
    emit_stream_end_once, kill_child_tree, persist_and_emit_external_chunk, persist_external_chunk,
    read_stderr_to_string, resolve_run_id, select_external_session_for_runtime,
    ExternalRunRegistry, USER_STOPPED_REASON,
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
        // 鍏变韩鐨?StreamEnd 宸茬粡 emit 鍑哄幓娌?鏍囧織 鈹€鈹€ 瑙?CodexCliManager 鍚屽悕娉ㄩ噴銆?
        let stream_end_emitted = Arc::new(AtomicBool::new(false));

        // Reap any zombie child (kill/oom/broken pipe leaves the registry
        // entry behind until the watchdog sweeps it) and refuse overlapping
        // runs BEFORE we emit StreamStart 鈥?otherwise the UI flashes
        // loading for ~ms and then bounces to an error.
        if let Some(reason) = self.runs.reap_stale(&thread_id).await {
            return Err(reason);
        }

        tokio::spawn(async move {
            // 閫氱敤 metadata 鍗忚 鈹€鈹€ StreamStart 鎼哄甫璇?run 閿佸畾鐨?            // model / reasoning_effort, 鍓嶇 hover card 绛夌粍浠跺彲璇汇€?
            let model = message.model_for_runtime("claude").map(str::to_string);
            let reasoning_effort = message
                .reasoning_effort_for_runtime("claude")
                .map(str::to_string);
            persist_and_emit_external_chunk(
                &app_handle,
                &manager.thread_manager,
                AGENT_TYPE,
                &AgentChunk::StreamStart {
                    thread_id: thread_id.clone(),
                    model,
                    reasoning_effort,
                },
                &run_id,
                None,
            )
            .await;

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
                    persist_and_emit_external_chunk(
                        &app_handle,
                        &manager.thread_manager,
                        AGENT_TYPE,
                        &AgentChunk::Error {
                            thread_id: thread_id.clone(),
                            message: err.clone(),
                        },
                        &run_id,
                        None,
                    )
                    .await;
                    Some(err)
                }
            };

            // 鍏滃簳 emit: 鑻?stop_chat / watchdog 杩樻病鏇挎垜浠彂杩?StreamEnd,
            // 鐢辨湰璺緞琛ュ彂; 鍚﹀垯 CAS 澶辫触, 璺宠繃閬垮厤閲嶅銆?
            let stream_end = AgentChunk::StreamEnd {
                thread_id: thread_id.clone(),
                reason,
            };
            if emit_stream_end_once(
                &app_handle,
                &thread_id,
                &run_id,
                AGENT_TYPE,
                match &stream_end {
                    AgentChunk::StreamEnd { reason, .. } => reason.clone(),
                    _ => None,
                },
                &stream_end_emitted,
            ) {
                persist_external_chunk(
                    &manager.thread_manager,
                    AGENT_TYPE,
                    &stream_end,
                    &run_id,
                    None,
                )
                .await;
            }
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
        let stream_end = AgentChunk::StreamEnd {
            thread_id: thread_id.to_string(),
            reason: Some(USER_STOPPED_REASON.to_string()),
        };
        if emit_stream_end_once(
            app_handle,
            thread_id,
            &run_id_for_chunk,
            AGENT_TYPE,
            Some(USER_STOPPED_REASON.to_string()),
            &running.stream_end_emitted,
        ) {
            persist_external_chunk(
                &self.thread_manager,
                AGENT_TYPE,
                &stream_end,
                &run_id_for_chunk,
                None,
            )
            .await;
        }
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
            // CAS 宸插湪 `reap_inactive` 閿佸唴鎶㈣繃 鈹€鈹€ 杩欓噷鐨?run 閮芥槸 watchdog 璧㈠緱
            // slot 鐨? 鐩存帴鍙?Error + StreamEnd + persist, 涓嶄細鍙屽彂銆?
            let run_id = run.run_id.as_deref().unwrap_or(run.thread_id.as_str());
            if let Some(reason) = run.reason.clone() {
                persist_and_emit_external_chunk(
                    app_handle,
                    &self.thread_manager,
                    AGENT_TYPE,
                    &AgentChunk::Error {
                        thread_id: run.thread_id.clone(),
                        message: reason.clone(),
                    },
                    run_id,
                    None,
                )
                .await;
            }
            persist_and_emit_external_chunk(
                app_handle,
                &self.thread_manager,
                AGENT_TYPE,
                &AgentChunk::StreamEnd {
                    thread_id: run.thread_id.clone(),
                    reason: run.reason.clone(),
                },
                run_id,
                None,
            )
            .await;
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
            // child 宸茶 stop_chat 鎴?watchdog 绉昏蛋 鈹€鈹€ 浜岃€呴兘宸?CAS 鎶㈠彂杩?
            // StreamEnd, 杩欓噷鐩存帴杩斿洖, tail 鐨?CAS 浼氬け璐ヨ€?skip, 涓嶅弻鍙戙€?
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
    //! (`PATH`, `CLAUDE_NODE_PATH`, `CLAUDE_CODE_CLI_PATH`, 鈥?. These
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
    //! `#[must_use]`-able via the leading `_guard =` binding 鈥?a missing
    //! `_` (or just dropping it) will still hold the lock until the
    //! function ends, so the binding just makes the intent obvious.
    use super::super::events::{
        claude_event_to_chunks, claude_event_to_chunks_with_state, should_silence_event,
        silence_reason, ClaudeStreamState,
    };
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
        // type=user 鐨?content array 閲屽悓鏃跺惈 text 涓?tool_result 鍧楁椂,涓や釜鍧?        // 閮藉彂鈥斺€攖ext 鍧楀彂 AgentChunk::Text,tool_result 鍧楀彂 AgentChunk::ToolResult銆?        // 杩欐槸 events.rs 娴佸紡璺緞鐨勫綋鍓嶈涓?涓?history.rs 璧拌繃鐨勮矾寰?        // 涓€鑷粹€斺€旀枃鏈疮绉繘 user ChatMessage銆乼ool_result 淇濈暀涓?tool 娑堟伅)銆?
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
        // type=user 鐨?content array 閲屽彧鏈?tool_result 鍧?鏃?text)鏃?
        // 鍙彂 ToolResult 涓€鏉?chunk,涓庡師鏈殑 tool_result 澶勭悊璺緞涓€鑷淬€?
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
        // type=user 鐨?content array 鍚?image / attachment 绛夐潪 text/tool_result
        // 鍧楁椂,涓嶄骇鐢熶换浣?chunk(娌℃湁 AgentChunk 鍙樹綋鍙互鎵胯浇 user image)銆?
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
        // 娴佸紡 stdout 鐨?isSynthetic=true 鈥?Skill 宸ュ叿璋冪敤鎴愬姛鏃?harness
        // 鎶?skill body 娉ㄥ叆鍒颁富 agent 鐨?user 娑堟伅閲屻€傝瀛楁瑕嗙洊鍒颁簡銆?
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

        // 鎸佷箙鍖?JSONL 鐨?isMeta=true 鈥?鍚屼竴绫绘秷鎭湪 --resume / 鍘嬬缉閲嶅缓鍚?        // 鐨勫舰鎬併€傚悓涓€ helper 搴斿綋鍏煎銆?
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
        // 鍙嶅悜娴嬭瘯 鈥?sub-agent 娲诲姩瑕佸睍绀哄湪涓?thread card 涓?甯︾湡瀹炲伐鍏峰悕銆?        // ToolResult 鐨?name 瀛楁鐢?stream.rs 鐨?tool_use_id->name 鏄犲皠濉厖
        // (杩欓噷鍗曟祴鍙獙璇?chunk emit, 涓嶉獙璇?name 濉厖)銆?        // type=user + subagent_type(sub-agent tool_result) -> 鎺?ToolResult
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

        // type=assistant + subagent_type(sub-agent tool_use) -> 鎺?ToolCall
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

        // type=assistant + subagent_type(sub-agent text) -> 鎺?Text
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
        // 涓?agent 鍦?assistant 琛岄噷骞惰璋冭捣澶氫釜 Agent (Task) sub-agent 鈹€鈹€
        // 姣忎釜 tool_use 鍧楀搴斾竴涓?spawn,涓?thread card **搴斿綋**灞曠ず杩欎簺
        // tool_call 鍗＄墖(甯︾湡瀹炲伐鍏峰悕 "Agent")銆傛枃鏈?/ 鏅€氬伐鍏?(Bash / Read)
        // 鍚屾牱姝ｅ父鍙戙€?
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

        // 涓変釜 Agent tool_use 鍏ㄩ儴灞曠ず涓?ToolCall(name="Agent")
        let agent_count = chunks
            .iter()
            .filter(|c| matches!(c, AgentChunk::ToolCall { name, .. } if name == "Agent"))
            .count();
        assert_eq!(
            agent_count, 3,
            "should emit 3 Agent ToolCall chunks; got {}",
            agent_count
        );

        // text 鍧楁甯稿彂
        assert!(chunks.iter().any(|c| matches!(
            c, AgentChunk::Text { text, .. } if text == "let me run several analyses in parallel"
        )));

        // 鏅€?Bash tool_use 姝ｅ父鍙?
        assert!(chunks.iter().any(|c| matches!(
            c, AgentChunk::ToolCall { name, .. } if name == "Bash"
        )));
    }

    #[test]
    fn emits_agent_launch_metadata_tool_result() {
        // 鍙嶅悜娴嬭瘯 鈥?"Async agent launched successfully" launch metadata
        // 涔熻 emit(涓?thread card 灞曠ず Agent tool 璋冭捣鍚庣殑 launch 鐘舵€?銆?        // content 鏈?string 鍜?array 涓ょ褰㈡€?閮藉簲姝ｅ父鎺?ToolResult銆?
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
        // 鏅€?Bash / Read tool_result 鍗充究娌?name 瀛楁涔熷簲姝ｅ父鎺?ToolResult
        // 鈹€鈹€ 鍚庣涓嶈噯鏂€俢ontent 浠?"Async agent launched successfully"
        // 璧峰ご閭ｆ潯鎵嶄涪,鍏朵粬鍘熸牱鐨?tool_result 涓€寰嬬収甯搞€俷ame 绌哄瓧绗︿覆鏄?        // 娴佽矾寰勭殑鍥哄畾琛屼负,鐢卞墠绔喅瀹氭€庝箞 fallback銆?
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
        // 鍙嶅悜娴嬭瘯 鈥?isSidechain=true 鏍囪鐨?sub-agent 鏂囨湰搴旀甯稿睍绀恒€?
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
        // 鍙嶅悜娴嬭瘯 鈥?isSidechain=true 鏍囪鐨?sub-agent tool_result 搴旀甯稿睍绀恒€?
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
        // sub-agent / sidechain 杩囨护宸蹭粠 silence_reason 鎾ら櫎 (鐢ㄦ埛瑕佹眰灞曠ず
        // sub-agent 宸ュ叿璋冪敤), 瀵瑰簲 helper 鍑芥暟浜﹀凡鍒犻櫎銆俿ilence_reason 鐜板湪鍙?catch:
        //   1. synthetic_user_event 鈥?task-notification XML
        //   2. synthetic_user_marker 鈥?isSynthetic / isMeta / Skill body
        //
        // synthetic_user_event: origin.kind == "task-notification"
        let synthetic = serde_json::json!({
            "type": "user",
            "origin": { "kind": "task-notification" },
            "message": { "role": "user", "content": "<task-notification>x</task-notification>" }
        });
        assert_eq!(silence_reason(&synthetic), Some("synthetic_user_event"));

        // synthetic_user_marker: type=user + isSynthetic=true (娴佸紡) 鎴?isMeta=true (JSONL)
        let stream_marker = serde_json::json!({
            "type": "user",
            "isSynthetic": true,
            "message": { "role": "user", "content": [{"type":"text","text":"skill body"}] }
        });
        assert_eq!(
            silence_reason(&stream_marker),
            Some("synthetic_user_marker")
        );

        let persistent_marker = serde_json::json!({
            "type": "user",
            "isMeta": true,
            "message": { "role": "user", "content": "[hidden reminder]" }
        });
        assert_eq!(
            silence_reason(&persistent_marker),
            Some("synthetic_user_marker")
        );

        let compact_summary_marker = serde_json::json!({
            "type": "user",
            "isVisibleInTranscriptOnly": true,
            "isCompactSummary": true,
            "message": {
                "role": "user",
                "content": [{
                    "type": "text",
                    "text": "This session is being continued from a previous conversation that ran out of context."
                }]
            }
        });
        assert_eq!(
            silence_reason(&compact_summary_marker),
            Some("synthetic_user_marker")
        );
        assert!(claude_event_to_chunks("thread_1", &compact_summary_marker).is_empty());

        let skill_injection = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "type": "text",
                    "text": "Base directory for this skill: C:\\Users\\Administrator\\AppData\\Local\\Temp\\claude\\bundled-skills\\2.1.199\\abc\\claude-api\n\n# Building LLM-Powered Applications with Claude"
                }]
            }
        });
        assert_eq!(
            silence_reason(&skill_injection),
            Some("synthetic_user_marker")
        );
        assert!(claude_event_to_chunks("thread_1", &skill_injection).is_empty());

        let malformed_skill_line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Base directory for this skill: C:\Users\Administrator\AppData\Local\Temp\claude\bundled-skills\2.1.199\d0c1b73065a070ff56cb23ffc36804fa\claude-api\n\n# Building LLM-Powered Applications with Claude"}]}}"#;
        assert!(parse_claude_stdout_line("thread_1", malformed_skill_line)
            .chunks
            .is_empty());

        // 鍙嶅悜鏂█: sub-agent 娲诲姩 + 鏅€氫富閾捐矾閮戒笉搴旇 silence_reason 鎷?        // (鍓嶈€呭湪 history/stream 涓ゆ潯 path 涓婇兘搴旀甯?emit, 鐢?stream.rs 鐨?        // tool_use_id->name 鏄犲皠淇濊瘉 ToolResult 鎷垮埌鐪熷疄宸ュ叿鍚?
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

        // 涓婚摼璺?assistant 涓嶅懡涓?
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
        // 鍚屼竴琛屼换鎰忎袱濂楄皳璇嶅繀椤讳竴鑷?鈥?鍙嶅悜鏉′欢(history.rs 鏍囬妫€鏌ョ敤
        // should_silence_event,姝ｅ悜涓㈠純鐢?silence_reason)濡傛灉鍙戠敓鍒嗘浼?        // 鍑虹幇"琚潤榛樹絾琚綋浣?title 鍊欓€?鎴?搴斾涪寮冨嵈娓叉煋"鐨勫洖褰掋€?
        for value in [
            serde_json::json!({"type":"user","subagent_type":"Explore","message":{"role":"user","content":[]}}),
            serde_json::json!({"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[]}}),
            serde_json::json!({"type":"user","origin":{"kind":"task-notification"},"message":{"role":"user","content":"<task-notification>x</task-notification>"}}),
            serde_json::json!({"type":"user","isSynthetic":true,"message":{"role":"user","content":[{"type":"text","text":"x"}]}}),
            serde_json::json!({"type":"user","isMeta":true,"message":{"role":"user","content":"x"}}),
            serde_json::json!({"type":"user","isVisibleInTranscriptOnly":true,"isCompactSummary":true,"message":{"role":"user","content":[{"type":"text","text":"This session is being continued from a previous conversation that ran out of context."}]}}),
            serde_json::json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":"Base directory for this skill: C:\\Temp\\claude\\bundled-skills\\skill\n\n# Building LLM-Powered Applications with Claude"}]}}),
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

    // ---- --include-partial-messages (stream_event) streaming tests ----
    // partial 妯″紡涓?Claude Code 鎶婂洖绛旀媶鎴?Anthropic 鍘熺敓 stream_event 澧為噺;
    // 涓嬪垪娴嬭瘯瑕嗙洊 text_delta / thinking_delta / tool_use input 绱Н / assistant
    // 蹇収鎶戝埗 / message_delta usage, 瀵瑰簲 events::stream_event_to_chunks銆?
    #[test]
    fn stream_event_text_delta_emits_incremental_text() {
        let value = serde_json::json!({
            "type": "stream_event",
            "event": { "type": "content_block_delta", "index": 0,
                "delta": { "type": "text_delta", "text": "Hel" } }
        });
        let chunks = claude_event_to_chunks("thread_1", &value);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::Text { text, .. }] if text == "Hel"
        ));
    }

    #[test]
    fn stream_event_thinking_delta_emits_reasoning() {
        let value = serde_json::json!({
            "type": "stream_event",
            "event": { "type": "content_block_delta", "index": 0,
                "delta": { "type": "thinking_delta", "thinking": "step 1" } }
        });
        let chunks = claude_event_to_chunks("thread_1", &value);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::Reasoning { text, .. }] if text == "step 1"
        ));
    }

    #[test]
    fn stream_event_text_deltas_emit_one_chunk_per_fragment() {
        // 姣忎釜 text_delta 鏄閲忕墖娈?-> 鍚勮嚜涓€涓?Text chunk; 鍓嶇 append 杩樺師鍏ㄦ枃銆?
        let d1 = serde_json::json!({
            "type": "stream_event",
            "event": { "type": "content_block_delta", "index": 0,
                "delta": { "type": "text_delta", "text": "1," } }
        });
        let d2 = serde_json::json!({
            "type": "stream_event",
            "event": { "type": "content_block_delta", "index": 0,
                "delta": { "type": "text_delta", "text": " 2" } }
        });
        let mut state = ClaudeStreamState::default();
        let c1 = claude_event_to_chunks_with_state("thread_1", &d1, true, &mut state);
        let c2 = claude_event_to_chunks_with_state("thread_1", &d2, true, &mut state);
        assert!(matches!(c1.as_slice(), [AgentChunk::Text { text, .. }] if text == "1,"));
        assert!(matches!(c2.as_slice(), [AgentChunk::Text { text, .. }] if text == " 2"));
    }

    #[test]
    fn stream_event_tool_use_accumulates_input_across_deltas() {
        // content_block_start(tool_use) + N x input_json_delta + content_block_stop
        // -> 鍗曚釜 ToolCall, input 涓哄悎骞跺悗瑙ｆ瀽鐨?JSON銆俿tart / delta 涓?emit銆?
        let mut state = ClaudeStreamState::default();
        let start = serde_json::json!({
            "type": "stream_event",
            "event": { "type": "content_block_start", "index": 1,
                "content_block": { "type": "tool_use", "id": "toolu_1",
                    "name": "Bash", "input": {} } }
        });
        let d1 = serde_json::json!({
            "type": "stream_event",
            "event": { "type": "content_block_delta", "index": 1,
                "delta": { "type": "input_json_delta", "partial_json": "{\"command\":" } }
        });
        let d2 = serde_json::json!({
            "type": "stream_event",
            "event": { "type": "content_block_delta", "index": 1,
                "delta": { "type": "input_json_delta", "partial_json": " \"echo hi\"}" } }
        });
        let stop = serde_json::json!({
            "type": "stream_event",
            "event": { "type": "content_block_stop", "index": 1 }
        });

        assert!(claude_event_to_chunks_with_state("thread_1", &start, true, &mut state).is_empty());
        assert!(claude_event_to_chunks_with_state("thread_1", &d1, true, &mut state).is_empty());
        assert!(claude_event_to_chunks_with_state("thread_1", &d2, true, &mut state).is_empty());

        let chunks = claude_event_to_chunks_with_state("thread_1", &stop, true, &mut state);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::ToolCall { id, name, input, .. }]
                if id == "toolu_1" && name == "Bash"
                    && input.get("command").and_then(|v| v.as_str()) == Some("echo hi")
        ));
    }

    #[test]
    fn partial_suppresses_assistant_snapshot_but_non_partial_emits() {
        // partial=true: 鍐椾綑绱Н蹇収涓㈠純(delta 宸查┍鍔ㄦ覆鏌?銆?        // partial=false: 鏁存鏂囨湰鐓у父 emit(鍥炲綊淇濇姢)銆?
        let assistant = serde_json::json!({
            "type": "assistant",
            "message": { "content": [{ "type": "text", "text": "hello" }] }
        });
        let mut state = ClaudeStreamState::default();
        assert!(
            claude_event_to_chunks_with_state("thread_1", &assistant, true, &mut state).is_empty()
        );
        let chunks = claude_event_to_chunks_with_state("thread_1", &assistant, false, &mut state);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::Text { text, .. }] if text == "hello"
        ));
    }

    #[test]
    fn stream_event_message_delta_emits_usage() {
        let value = serde_json::json!({
            "type": "stream_event",
            "event": { "type": "message_delta",
                "delta": { "stop_reason": "end_turn" },
                "usage": { "input_tokens": 974, "output_tokens": 3,
                    "cache_read_input_tokens": 18432 } }
        });
        let chunks = claude_event_to_chunks("thread_1", &value);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::Usage { usage: Some(u), .. }]
                if u.input_tokens == Some(974)
                    && u.output_tokens == Some(3)
                    && u.cached_input_tokens == Some(18432)
        ));
    }

    #[test]
    fn partial_snapshot_reconciles_builtin_tool_use_without_stream_event() {
        // Claude Code 内置工具(WebSearch / Agent / TaskOutput)没有 stream_event
        // 增量,只出现在完整 type=assistant 快照里。partial 模式必须从快照补发
        // ToolCall(含完整 input),否则后续 tool_result(name 恒为空)会渲染成
        // "Unknown Tool"。
        let assistant = serde_json::json!({
            "type": "assistant",
            "message": { "content": [{
                "type": "tool_use", "id": "call_ws_1", "name": "WebSearch",
                "input": { "query": "cloudflare d1 limits" }
            }] }
        });
        let mut state = ClaudeStreamState::default();
        let chunks = claude_event_to_chunks_with_state("thread_1", &assistant, true, &mut state);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::ToolCall { id, name, input, .. }]
                if id == "call_ws_1" && name == "WebSearch"
                    && input.get("query").and_then(|v| v.as_str()) == Some("cloudflare d1 limits")
        ));
    }

    #[test]
    fn partial_snapshot_skips_text_but_emits_tool_use() {
        let assistant = serde_json::json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "text", "text": "searching now" },
                { "type": "tool_use", "id": "call_t_1", "name": "TaskOutput",
                  "input": { "task_id": "abc", "block": true } }
            ] }
        });
        let mut state = ClaudeStreamState::default();
        // partial: text 已由 delta 渲染 -> 跳过;仅 tool_use 补发
        let partial_chunks =
            claude_event_to_chunks_with_state("thread_1", &assistant, true, &mut state);
        assert!(matches!(
            partial_chunks.as_slice(),
            [AgentChunk::ToolCall { id, name, .. }] if id == "call_t_1" && name == "TaskOutput"
        ));
        // 非 partial: text + tool_use 都照常 emit
        let mut state2 = ClaudeStreamState::default();
        let full_chunks =
            claude_event_to_chunks_with_state("thread_1", &assistant, false, &mut state2);
        assert_eq!(full_chunks.len(), 2);
        assert!(matches!(full_chunks[0], AgentChunk::Text { .. }));
        assert!(matches!(full_chunks[1], AgentChunk::ToolCall { .. }));
    }

    #[test]
    fn partial_snapshot_does_not_duplicate_stream_event_tool_call() {
        // stream_event 增量已发过 id=toolu_1 的 ToolCall;同 id 再出现在完整快照里时
        // 不得重复发(否则前端两行 tool / tool_names 重复 insert)。
        let mut state = ClaudeStreamState::default();
        let start = serde_json::json!({
            "type": "stream_event",
            "event": { "type": "content_block_start", "index": 0,
                "content_block": { "type": "tool_use", "id": "toolu_1",
                    "name": "Bash", "input": {} } }
        });
        let stop = serde_json::json!({
            "type": "stream_event",
            "event": { "type": "content_block_stop", "index": 0 }
        });
        assert!(claude_event_to_chunks_with_state("thread_1", &start, true, &mut state).is_empty());
        let stop_chunks = claude_event_to_chunks_with_state("thread_1", &stop, true, &mut state);
        assert!(matches!(
            stop_chunks.as_slice(),
            [AgentChunk::ToolCall { id, .. }] if id == "toolu_1"
        ));

        let snapshot = serde_json::json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "text", "text": "done" },
                { "type": "tool_use", "id": "toolu_1", "name": "Bash",
                  "input": { "command": "echo hi" } }
            ] }
        });
        let snap_chunks =
            claude_event_to_chunks_with_state("thread_1", &snapshot, true, &mut state);
        // text 跳过 + tool_use 已发过 -> 整条快照不再产 ToolCall
        assert!(snap_chunks.is_empty());
    }
}
