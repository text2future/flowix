use super::*;
use tokio::io::BufReader;

#[test]
fn canonical_message_identity_is_shared_and_idempotent() {
    for agent_type in ["claude", "hermes", "opencode"] {
        let id = canonical_message_id(agent_type, "run-1", "assistant", "source-1");
        assert_eq!(id, format!("msg:{agent_type}:run-1:assistant:source-1"));
        assert_eq!(
            canonical_message_id(agent_type, "run-1", "assistant", &id),
            id
        );
    }

    // Codex app-server item ids are already thread-unique and must match the
    // raw ids returned by thread/turns/list history.
    assert_eq!(
        canonical_message_id("codex", "run-1", "assistant", "source-1"),
        "source-1"
    );
    assert_eq!(
        canonical_message_id("codex", "run-1", "assistant", "source-1"),
        canonical_message_id("codex", "run-2", "assistant", "source-1")
    );
    assert_eq!(
        canonical_message_id("codex", "run-1", "error", "source-1"),
        "msg:codex:run-1:error:source-1"
    );
}

#[test]
fn chunk_payload_keeps_codex_item_id_aligned_with_history() {
    let chunk = AgentChunk::Text {
        thread_id: "thread-1".to_string(),
        text: "hello".to_string(),
    };
    let payload = chunk_payload_value(
        &chunk,
        "codex",
        "run-1",
        &AgentChunkMetadata {
            message_id: Some("assistant-source-1".to_string()),
            ..Default::default()
        },
    )
    .expect("serialize canonical chunk");
    assert_eq!(
        payload.get("message_id").and_then(Value::as_str),
        Some("assistant-source-1")
    );
    assert_eq!(
        payload.get("source_message_id").and_then(Value::as_str),
        Some("assistant-source-1")
    );
}

#[test]
fn chunk_payload_scopes_codex_fallback_identity_per_run() {
    let chunk = AgentChunk::Text {
        thread_id: "thread-1".to_string(),
        text: "hello".to_string(),
    };
    let run_one = chunk_payload_value(&chunk, "codex", "run-1", &AgentChunkMetadata::default())
        .expect("serialize run-one fallback");
    let run_two = chunk_payload_value(&chunk, "codex", "run-2", &AgentChunkMetadata::default())
        .expect("serialize run-two fallback");

    assert_eq!(
        run_one.get("message_id").and_then(Value::as_str),
        Some("msg:codex:run-1:assistant:stream")
    );
    assert_eq!(
        run_two.get("message_id").and_then(Value::as_str),
        Some("msg:codex:run-2:assistant:stream")
    );
    assert_ne!(run_one.get("message_id"), run_two.get("message_id"));
}

#[test]
fn pi_deltas_stay_draft_until_the_native_session_entry_id_arrives() {
    let text = AgentChunk::Text {
        thread_id: "thread-1".to_string(),
        text: "partial".to_string(),
    };
    let reasoning = AgentChunk::Reasoning {
        thread_id: "thread-1".to_string(),
        text: "thinking".to_string(),
    };

    for chunk in [&text, &reasoning] {
        let payload = chunk_payload_value(chunk, "pi", "run-1", &AgentChunkMetadata::default())
            .expect("serialize draft chunk");
        assert!(payload.get("message_id").is_none());
        assert!(payload.get("source_message_id").is_none());
    }

    let final_payload = chunk_payload_value(
        &text,
        "pi",
        "run-1",
        &AgentChunkMetadata {
            message_id: Some("67575cb5".into()),
            content_mode: Some("snapshot"),
            message_phase: Some("completed"),
            ..AgentChunkMetadata::default()
        },
    )
    .expect("serialize native-id snapshot");
    assert_eq!(final_payload["message_id"], "67575cb5");
    assert_eq!(final_payload["source_message_id"], "67575cb5");
}

#[test]
fn pi_tool_rows_keep_tool_call_identity_and_parent_entry_identity_separate() {
    let chunk = AgentChunk::ToolCall {
        thread_id: "thread-1".to_string(),
        id: "call_00_native".to_string(),
        name: "bash".to_string(),
        input: Value::Null,
    };
    let payload = chunk_payload_value(
        &chunk,
        "pi",
        "run-1",
        &AgentChunkMetadata {
            parent_message_id: Some("67575cb5".into()),
            ..AgentChunkMetadata::default()
        },
    )
    .expect("serialize native tool call");

    assert_eq!(payload["message_id"], "call_00_native");
    assert_eq!(payload["source_message_id"], "call_00_native");
    assert_eq!(payload["parent_message_id"], "67575cb5");
}

#[test]
fn streaming_emit_buffer_batches_text_and_reasoning_in_order() {
    let mut buf = StreamingEmitBuffer::new("t1".to_string());
    assert!(buf.is_empty());
    assert_eq!(buf.pending_bytes(), 0);

    buf.append_text("Hello, ");
    buf.append_text("world!");
    buf.append_reasoning("thinking...");
    // text �?reasoning 各自�?��, 不交叉�?
    assert_eq!(
        buf.pending_bytes(),
        "Hello, world!".len() + "thinking...".len()
    );

    let chunks = buf.flush();
    // reasoning 先于 text (前�? reasoning-first �?��)�?
    assert_eq!(chunks.len(), 2, "expected reasoning + text");
    let reasoning_text = match &chunks[0] {
        AgentChunk::Reasoning { thread_id, text } => {
            assert_eq!(thread_id, "t1");
            text.as_str()
        }
        _ => panic!("expected Reasoning first"),
    };
    assert_eq!(reasoning_text, "thinking...");
    let text_text = match &chunks[1] {
        AgentChunk::Text { thread_id, text } => {
            assert_eq!(thread_id, "t1");
            text.as_str()
        }
        _ => panic!("expected Text second"),
    };
    assert_eq!(text_text, "Hello, world!");
    // flush 后缓冲清�? 再�? flush �?no-op�?
    assert!(buf.is_empty());
    assert!(buf.flush().is_empty());
}

#[test]
fn streaming_emit_buffer_flush_only_emits_non_empty() {
    let mut buf = StreamingEmitBuffer::new("t2".to_string());
    // 只有 text: 仅产出 Text。
    buf.append_text("a");
    let chunks = buf.flush();
    assert_eq!(chunks.len(), 1);
    assert!(matches!(chunks[0], AgentChunk::Text { .. }));
    // 只有 reasoning: 仅产出 Reasoning。
    buf.append_reasoning("b");
    let chunks = buf.flush();
    assert_eq!(chunks.len(), 1);
    assert!(matches!(chunks[0], AgentChunk::Reasoning { .. }));
    // 空: 不产出。
    assert!(buf.flush().is_empty());
}

#[test]
fn streaming_emit_buffer_keeps_first_metadata_anchor_and_clears_it_on_flush() {
    let mut buf = StreamingEmitBuffer::new("metadata-thread".to_string());
    let first = AgentChunkMetadata {
        message_id: Some("assistant-message-1".to_string()),
        source_timestamp: Some(100),
        source_sequence: Some(7),
        source_subsequence: Some(0),
        ..Default::default()
    };
    let later = AgentChunkMetadata {
        message_id: Some("assistant-message-1".to_string()),
        source_timestamp: Some(101),
        source_sequence: Some(8),
        source_subsequence: Some(0),
        ..Default::default()
    };

    buf.append_text_with_metadata("first", first);
    buf.append_text_with_metadata(" second", later);

    let flushed = buf.flush_with_metadata();
    assert_eq!(flushed.len(), 1);
    assert!(matches!(
        &flushed[0].0,
        AgentChunk::Text { text, .. } if text == "first second"
    ));
    assert_eq!(
        flushed[0].1.message_id.as_deref(),
        Some("assistant-message-1")
    );
    assert_eq!(flushed[0].1.source_timestamp, Some(100));
    assert_eq!(flushed[0].1.source_sequence, Some(7));
    assert_eq!(buf.text_message_id(), None);

    buf.append_text_with_metadata(
        "next",
        AgentChunkMetadata {
            message_id: Some("assistant-message-2".to_string()),
            ..Default::default()
        },
    );
    assert_eq!(buf.text_message_id(), Some("assistant-message-2"));
}

#[test]
fn registry_metadata_is_thread_scoped() {
    let registry = ExternalRunRegistry::new("codex", "codex");
    assert_eq!(registry.agent_type, "codex");
    assert_eq!(registry.current_tool, "codex");
}

#[test]
fn raw_json_default_follows_build_profile() {
    assert_eq!(default_raw_json_enabled(), cfg!(debug_assertions));
}

#[test]
fn raw_json_env_bool_accepts_only_explicit_true_values() {
    for value in ["1", "true", "TRUE", " yes ", "on"] {
        assert!(parse_env_bool(value), "{value:?} should enable raw_json");
    }

    for value in ["0", "false", "no", "off", "", "maybe"] {
        assert!(!parse_env_bool(value), "{value:?} should disable raw_json");
    }
}

/// `stream_end_emitted` �?`stop_chat` / 流式任务 tail / watchdog 三方共享
/// �?StreamEnd 已发"哨兵 ── 各持一�?Arc clone, 谁先 CAS(false -> true) 谁负�?    /// �? 另两�?CAS 失败�?skip。这条测试钉死�?不变�? 注册时�?进去�?flag
/// 与调用方手里那份�?��一�?AtomicBool, 且只有一�?CAS 能赢�?
#[cfg(unix)]
#[tokio::test]
async fn stream_end_emitted_flag_is_shared_and_oneshot() {
    use std::sync::atomic::Ordering;

    let registry = ExternalRunRegistry::new("codex", "codex");
    let stream_end_emitted = Arc::new(AtomicBool::new(false));
    let caller_clone = stream_end_emitted.clone();

    let child = tokio::process::Command::new("/usr/bin/true")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn `/usr/bin/true`");
    registry
        .insert(
            "t".to_string(),
            child,
            Some("run-1".to_string()),
            stream_end_emitted,
        )
        .await;

    // stop_chat �?��: �?registry 抢出 entry, �?entry 里的 flag CAS�?
    let running = registry.remove("t").await.expect("running entry exists");
    let stop_won = running
        .stream_end_emitted
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok();

    // 流式任务 tail �?��: 用调用方手里�?clone �?CAS, 必须失败�?
    let tail_won = caller_clone
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok();

    assert!(stop_won, "stop_chat should win the CAS");
    assert!(!tail_won, "streaming tail must skip after stop_chat won");
    assert!(
        caller_clone.load(Ordering::SeqCst),
        "flag must be visible as true to the tail clone"
    );
}

#[test]
fn resolve_run_id_prefers_frontend_run_id() {
    assert_eq!(
        resolve_run_id("thread_1", Some(" frontend-run ")),
        "frontend-run"
    );
}

#[test]
fn resolve_run_id_falls_back_to_generated_thread_scoped_id() {
    let run_id = resolve_run_id("thread_1", Some(" "));
    assert!(run_id.starts_with("thread_1-"));
}

#[test]
fn generated_run_ids_are_unique_within_one_millisecond() {
    let ids: std::collections::HashSet<_> = (0..1000)
        .map(|_| create_run_id("thread_1"))
        .collect();
    assert_eq!(ids.len(), 1000);
}

#[tokio::test]
async fn prepare_start_normalizes_run_id_and_creates_unclaimed_terminal_slot() {
    use std::sync::atomic::Ordering;

    let registry = ExternalRunRegistry::new("codex", "codex");
    let start = registry
        .prepare_start("thread_1", Some(" run-1 "))
        .await
        .expect("fresh run should be accepted");

    assert_eq!(start.run_id, "run-1");
    assert!(!start.stream_end_emitted.load(Ordering::SeqCst));
}

#[tokio::test]
async fn starting_reservation_rejects_a_second_run_and_is_visible_to_queries() {
    let registry = ExternalRunRegistry::new("claude", "ClaudeCli");
    let first = registry.reserve_start("thread_1", Some("run-1")).await.unwrap();
    assert_eq!(first.run_id, "run-1");
    assert!(registry.reserve_start("thread_1", Some("run-2")).await.is_err());
    let running = registry.running_threads().await;
    assert_eq!(running.get("thread_1").and_then(|run| run.run_id.as_deref()), Some("run-1"));
    assert_eq!(running.get("thread_1").and_then(|run| run.phase.as_deref()), Some("starting"));
    assert!(!registry.cancel_start("thread_1", Some("run-2")).await);
    assert!(registry.cancel_start("thread_1", Some("run-1")).await);
    assert!(registry.start_cancelled("thread_1", "run-1").await);
    assert_eq!(registry.running_threads().await.get("thread_1").and_then(|run| run.phase.as_deref()), Some("stopping"));
    registry.release_start("thread_1", "run-1").await;
    assert!(registry.running_threads().await.is_empty());
    assert!(registry.reserve_start("thread_1", Some("run-2")).await.is_ok());
}

#[tokio::test]
async fn simultaneous_starts_claim_the_thread_once() {
    let registry = ExternalRunRegistry::new("claude", "ClaudeCli");
    let (first, second) = tokio::join!(
        registry.reserve_start("thread_1", Some("run-a")),
        registry.reserve_start("thread_1", Some("run-b")),
    );
    assert_ne!(first.is_ok(), second.is_ok());
    assert_eq!(registry.running_threads().await.len(), 1);
}

#[tokio::test]
async fn cancelled_start_rejects_a_late_child() {
    let registry = ExternalRunRegistry::new("claude", "ClaudeCli");
    let start = registry.reserve_start("thread_1", Some("run-a")).await.unwrap();
    assert!(registry.cancel_start("thread_1", Some("run-a")).await);
    #[cfg(windows)]
    let mut command = tokio::process::Command::new("cmd");
    #[cfg(windows)]
    command.args(["/C", "exit", "0"]);
    #[cfg(not(windows))]
    let mut command = tokio::process::Command::new("true");
    let child = command.spawn().unwrap();
    let mut rejected = registry.insert_reserved(
        "thread_1".to_string(), child, "run-a", start.stream_end_emitted,
    ).await.expect_err("cancelled start must reject a late child");
    let _ = rejected.wait().await;
    assert!(registry.running_threads().await.contains_key("thread_1"));
    registry.release_start("thread_1", "run-a").await;
}

#[cfg(unix)]
#[tokio::test]
async fn stop_run_preserves_expected_run_matching_and_shared_terminal_slot() {
    use std::sync::atomic::Ordering;

    let registry = ExternalRunRegistry::new("codex", "codex");
    let stream_end_emitted = Arc::new(AtomicBool::new(false));
    let caller_flag = stream_end_emitted.clone();
    let child = tokio::process::Command::new("/bin/sleep")
        .arg("5")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn `/bin/sleep`");
    registry
        .insert(
            "thread_1".to_string(),
            child,
            Some("run-1".to_string()),
            stream_end_emitted,
        )
        .await;

    assert!(matches!(registry
        .stop_run("thread_1", "thread_1", Some("wrong-run"), "TestCli")
        .await, Ok(None)));
    assert!(registry.contains("thread_1").await);

    let stopped = registry
        .stop_run("thread_1", "thread_1", Some("run-1"), "TestCli")
        .await
        .expect("stop should be confirmed")
        .expect("matching run should be stopped");
    assert_eq!(stopped.run_id, "run-1");
    assert!(!registry.contains("thread_1").await);
    assert!(Arc::ptr_eq(&caller_flag, &stopped.stream_end_emitted));
    assert!(!caller_flag.load(Ordering::SeqCst));
}

#[tokio::test]
async fn stopping_slot_blocks_new_run_and_is_visible_to_queries() {
    let registry = ExternalRunRegistry::new("claude", "ClaudeCli");
    registry.stopping.lock().await.insert(
        "thread_1".to_string(),
        ExternalStoppingRun { run_id: "run-1".to_string(), started_at: 123 },
    );

    assert!(registry.reserve_start("thread_1", Some("run-2")).await.is_err());
    assert!(matches!(
        registry.stop_run("thread_1", "thread_1", Some("run-1"), "TestCli").await,
        Err(StopUnconfirmed { run_id }) if run_id == "run-1"
    ));
    assert!(matches!(
        registry.stop_run("thread_1", "thread_1", Some("run-2"), "TestCli").await,
        Ok(None)
    ));
    let info = registry.running_threads().await;
    assert_eq!(info["thread_1"].phase.as_deref(), Some("stopping"));
    assert_eq!(info["thread_1"].run_id.as_deref(), Some("run-1"));
}

#[cfg(windows)]
#[tokio::test]
async fn stop_run_keeps_slot_until_process_exit_is_confirmed() {
    let registry = ExternalRunRegistry::new("claude", "ClaudeCli");
    let child = tokio::process::Command::new("cmd")
        .args(["/C", "ping -n 20 127.0.0.1 >nul"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn long-running command");
    registry.insert("thread_1".to_string(), child, Some("run-1".to_string()), Arc::new(AtomicBool::new(false))).await;

    let stopped = registry.stop_run("thread_1", "thread_1", Some("run-1"), "TestCli").await;
    assert!(matches!(stopped, Ok(Some(_))), "process exit must be confirmed before stop succeeds");
    assert!(!registry.running_threads().await.contains_key("thread_1"));
    assert!(registry.reserve_start("thread_1", Some("run-2")).await.is_ok());
}

#[test]
fn workspace_context_lists_only_existing_additional_roots() {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().join("primary");
    let reference = temp.path().join("reference");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(&reference).unwrap();
    let missing = temp.path().join("missing");
    let paths = vec![
        cwd.to_string_lossy().to_string(),
        reference.to_string_lossy().to_string(),
        reference.to_string_lossy().to_string(),
        missing.to_string_lossy().to_string(),
    ];

    let prompt = append_workspace_context("Question", &cwd, &paths);

    assert!(prompt.starts_with("Question\n\n<## CONTEXT PROMPT ##>"));
    assert_eq!(
        prompt
            .matches(&reference.to_string_lossy().to_string())
            .count(),
        1
    );
    assert!(!prompt.contains(&missing.to_string_lossy().to_string()));
}

#[tokio::test]
async fn capped_stdout_reader_truncates_long_lines() {
    let input = format!("{}{}\nnext\n", "x".repeat(20), "y".repeat(20));
    let mut reader = BufReader::new(input.as_bytes());

    let (line, truncated) = read_capped_line(&mut reader, 16)
        .await
        .expect("read line")
        .expect("line");
    assert_eq!(line.len(), 16);
    assert!(truncated);

    let (line, truncated) = read_capped_line(&mut reader, 16)
        .await
        .expect("read next line")
        .expect("next line");
    assert_eq!(line.trim(), "next");
    assert!(!truncated);
}

#[tokio::test]
async fn stderr_reader_preserves_lines_and_newlines() {
    let registry = ExternalRunRegistry::new("codex", "codex");
    let reader = BufReader::new("first\nsecond".as_bytes());

    let stderr = read_stderr_to_string("thread_1", Some("run_1"), &registry, reader)
        .await
        .expect("stderr reader should succeed");

    assert_eq!(stderr, "first\nsecond\n");
}

#[tokio::test]
async fn stderr_reader_drains_but_bounds_and_redacts_retained_text() {
    let registry = ExternalRunRegistry::new("codex", "codex");
    let secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    let input = format!(
        "Authorization: Bearer {secret}\n{}\ntail\n",
        "x".repeat(MAX_STDERR_CHARS + 1024)
    );
    let reader = BufReader::new(input.as_bytes());

    let stderr = read_stderr_to_string("thread_1", Some("run_1"), &registry, reader)
        .await
        .expect("stderr reader should succeed");

    assert!(!stderr.contains(secret));
    assert!(stderr.contains("[REDACTED]"));
    assert!(stderr.ends_with("...[stderr truncated]"));
    assert!(stderr.chars().count() <= MAX_STDERR_CHARS + 32);
}

#[cfg(unix)]
#[tokio::test]
async fn stderr_reader_touches_matching_run() {
    let registry = ExternalRunRegistry::new("codex", "codex");
    let child = tokio::process::Command::new("/bin/sleep")
        .arg("1")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn `/bin/sleep`");
    registry
        .insert(
            "thread_1".to_string(),
            child,
            Some("run_1".to_string()),
            Arc::new(AtomicBool::new(false)),
        )
        .await;

    {
        let mut children = registry.children.lock().await;
        let running = children
            .get_mut("thread_1")
            .expect("running entry should exist");
        running.last_event_at = 1;
    }

    let reader = BufReader::new("stderr\n".as_bytes());
    read_stderr_to_string("thread_1", Some("run_1"), &registry, reader)
        .await
        .expect("stderr reader should succeed");

    let last_event_at = {
        let children = registry.children.lock().await;
        children
            .get("thread_1")
            .expect("running entry should exist")
            .last_event_at
    };
    assert!(last_event_at > 1);

    let mut running = registry
        .remove("thread_1")
        .await
        .expect("running entry should be removable");
    let _ = running.child.kill().await;
}

#[tokio::test]
async fn reap_stale_returns_none_when_no_entry() {
    let registry = ExternalRunRegistry::new("codex", "codex");
    assert!(registry.reap_stale("missing").await.is_none());
}

/// Spawn a child that exits immediately, register it, wait for it to
/// exit, then call reap_stale 鈥?should drop the entry and return None.
#[cfg(unix)]
#[tokio::test]
async fn reap_stale_drops_already_exited_child() {
    let registry = ExternalRunRegistry::new("codex", "codex");
    let child = tokio::process::Command::new("/usr/bin/true")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn `/usr/bin/true`");
    registry
        .insert(
            "t".to_string(),
            child,
            Some("run-1".to_string()),
            Arc::new(AtomicBool::new(false)),
        )
        .await;
    // Give the kernel a moment to actually reap the process. Without
    // this, try_wait can still return Ok(None) on slow runners.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    assert!(registry.reap_stale("t").await.is_none());
    assert!(!registry.contains("t").await);
}
