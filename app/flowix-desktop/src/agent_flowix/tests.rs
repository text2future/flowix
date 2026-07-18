use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use rllm::chat::MessageType;
use rllm::{FunctionCall, ToolCall as LlmToolCall};

use crate::agent_session::ChatMessage as ThreadChatMessage;

use super::context::{build_llm_context_window, LLM_CONTEXT_RECENT_MESSAGES};
use super::persistence::tool_call_row_id;
use super::state::{compute_call_key, STUCK_THRESHOLD};
use super::stream::{classify_llm_failure, format_llm_unavailable_message, LlmFailureKind};
use super::*;

fn test_thread_message(role: &str, content: &str) -> ThreadChatMessage {
    ThreadChatMessage {
        id: format!("{role}-{content}"),
        role: role.to_string(),
        content: content.to_string(),
        llm_content: None,
        system_reminder_directory: None,
        timestamp: "2026-01-01T00:00:00Z".to_string(),
        is_loading: None,
        tool_call_id: None,
        tool_name: None,
        tool_data: None,
        tool_input: None,
        tool_calls: None,
        reasoning: None,
        is_completed: None,
        is_collapsed: None,
    }
}

fn test_assistant_tool_call(id: &str) -> ThreadChatMessage {
    let call = LlmToolCall {
        id: id.to_string(),
        call_type: "function".to_string(),
        function: FunctionCall {
            name: "read".to_string(),
            arguments: r#"{"path":"/tmp/a.md"}"#.to_string(),
        },
    };
    let mut message = test_thread_message("assistant", "");
    message.tool_calls = Some(serde_json::Value::Array(vec![
        serde_json::to_value(call).unwrap()
    ]));
    message
}

fn test_tool_result(id: &str) -> ThreadChatMessage {
    let mut message = test_thread_message("tool", "tool result");
    message.tool_call_id = Some(id.to_string());
    message.tool_name = Some("read".to_string());
    message.tool_data = Some(r#"{"success":true,"content":"ok"}"#.to_string());
    message
}

#[test]
fn call_key_stable_for_same_inputs() {
    let k1 = compute_call_key("read", r#"{"path":"/a.md"}"#);
    let k2 = compute_call_key("read", r#"{"path":"/a.md"}"#);
    assert_eq!(k1, k2);
}

#[test]
fn call_key_distinguishes_different_args() {
    let k1 = compute_call_key("read", r#"{"path":"/a.md"}"#);
    let k2 = compute_call_key("read", r#"{"path":"/b.md"}"#);
    assert_ne!(k1.args_hash, k2.args_hash);
}

#[test]
fn call_key_distinguishes_different_tools() {
    let k1 = compute_call_key("read", r#"{"path":"/a.md"}"#);
    let k2 = compute_call_key("write", r#"{"path":"/a.md"}"#);
    assert_ne!(k1.tool_name, k2.tool_name);
}

#[test]
fn tool_call_row_id_uses_tool_call_id_when_present() {
    // 主流路径: LLM 给的 tool_call.id 直接拼前缀 ── 与历史持久化层完全兼容。
    assert_eq!(tool_call_row_id("call_abc123"), "tool_call_abc123");
    assert_eq!(
        tool_call_row_id("call_019f0000-0000-7000-8000-000000000000"),
        "tool_call_019f0000-0000-7000-8000-000000000000",
    );
}

#[test]
fn tool_call_row_id_falls_back_to_uuid_when_empty() {
    // 兜底路径: LLM 偶发不给 id,空串必须变唯一 id 才能避开 PRIMARY KEY 撞车。
    // 两次调用都拿到 UUID,彼此一定不同。
    let a = tool_call_row_id("");
    let b = tool_call_row_id("");

    assert!(a.starts_with("tool_"));
    assert!(b.starts_with("tool_"));
    assert_ne!(a, b, "两次空 id 必须落到不同 UUID,否则 PRIMARY KEY 仍会撞");

    // UUID v4 形态: 8-4-4-4-12 hex digits,带连字符 ── 防止未来替换成
    // 别的随机源后 format 漂移。
    let uuid_part = a.strip_prefix("tool_").expect("prefix");
    assert_eq!(
        uuid_part.len(),
        36,
        "expected UUID v4 length 36, got {uuid_part:?}"
    );
    assert_eq!(uuid_part.chars().filter(|c| *c == '-').count(), 4);
}

#[test]
fn llm_context_window_leaves_short_history_unchanged() {
    let messages = vec![
        test_thread_message("user", "hello"),
        test_thread_message("assistant", "world"),
    ];

    let out = build_llm_context_window(messages);

    assert_eq!(out.len(), 2);
    assert_eq!(out[0].content, "hello");
    assert_eq!(out[1].content, "world");
}

#[test]
fn llm_context_window_compacts_long_history() {
    let messages = (0..(LLM_CONTEXT_RECENT_MESSAGES + 5))
        .map(|i| test_thread_message("user", &format!("message-{i}")))
        .collect::<Vec<_>>();

    let out = build_llm_context_window(messages);

    assert_eq!(out.len(), LLM_CONTEXT_RECENT_MESSAGES + 1);
    assert!(out[0]
        .content
        .contains("Earlier conversation was compacted"));
    assert_eq!(out[1].content, "message-5");
}

#[test]
fn llm_context_window_keeps_tool_result_with_call() {
    let mut messages = vec![
        test_thread_message("user", "old-0"),
        test_assistant_tool_call("call-1"),
        test_tool_result("call-1"),
    ];
    for i in 0..(LLM_CONTEXT_RECENT_MESSAGES - 1) {
        messages.push(test_thread_message("user", &format!("recent-{i}")));
    }

    let out = build_llm_context_window(messages);

    assert!(out[0]
        .content
        .contains("Earlier conversation was compacted"));
    assert!(matches!(out[1].message_type, MessageType::ToolUse(_)));
    assert!(matches!(out[2].message_type, MessageType::ToolResult(_)));
}

#[test]
fn llm_unavailable_message_wraps_raw_reason() {
    // The plain inner-error path (e.g. mid-stream `Stream error: ...`).
    let msg = format_llm_unavailable_message("Stream error: connection reset by peer");
    assert_eq!(
        msg,
        "(LLM 暂时不可用, 原因: Stream error: connection reset by peer)"
    );
}

#[test]
fn llm_unavailable_message_takes_reason_verbatim() {
    // Reason strings are constructed by callers in the recovery loop
    // (e.g. `format!("Stream failed: {}", e)`); the formatter must
    // not strip or re-wrap anything. This guards against accidental
    // re-introduction of a prefix-strip step that would silently
    // drop caller context.
    let inputs = [
        "Stream failed: API error 401: {\"type\":\"error\"}",
        "Stream error: connection reset by peer",
        "any reason",
    ];
    for input in inputs {
        let msg = format_llm_unavailable_message(input);
        assert!(
            msg.ends_with(&format!("原因: {})", input)),
            "input={input}, got={msg}"
        );
    }
}

#[test]
fn llm_unavailable_message_preserves_chinese_punctuation() {
    // Chinese half-width comma (`,`) is intentional — matches the
    // rest of the codebase. Full-width comma (`，`) would also
    // be valid but is a different code point; this test guards
    // against accidental character substitution during refactors.
    let msg = format_llm_unavailable_message("any reason");
    assert!(msg.contains("(LLM 暂时不可用, 原因: "), "got: {msg}");
}

#[test]
fn llm_failure_classifier_identifies_retryable_mid_stream_errors() {
    let cases = [
        (
            "Stream error: connection reset by peer",
            LlmFailureKind::RetryableTransport,
        ),
        (
            "Stream error: request timed out while reading body",
            LlmFailureKind::RetryableTransport,
        ),
        (
            "Stream failed: API error 429: rate limit exceeded",
            LlmFailureKind::RetryableRateLimit,
        ),
        (
            "Stream failed: API error 503: service unavailable",
            LlmFailureKind::RetryableServer,
        ),
    ];

    for (input, expected) in cases {
        assert_eq!(classify_llm_failure(input), expected, "input={input}");
    }
}

#[test]
fn llm_failure_classifier_keeps_fatal_errors_out_of_auto_resume() {
    let cases = [
        ("API error 401: unauthorized", LlmFailureKind::FatalAuth),
        (
            "API error 404: model not found",
            LlmFailureKind::FatalNotFound,
        ),
        (
            "context length exceeded: too many tokens",
            LlmFailureKind::FatalContext,
        ),
        (
            "API error 400: invalid request",
            LlmFailureKind::FatalRequest,
        ),
        (
            "invalid function arguments json string",
            LlmFailureKind::RecoverableHistory,
        ),
    ];

    for (input, expected) in cases {
        assert_eq!(classify_llm_failure(input), expected, "input={input}");
    }
}

#[tokio::test]
async fn record_tool_call_threshold_triggers_on_sixth() {
    let mgr = AgentManager::for_tests();
    let args = r#"{"path":"/a.md"}"#;
    for i in 1..=STUCK_THRESHOLD {
        let stuck = mgr.record_tool_call("thread-1", "read", args).await;
        assert!(
            !stuck,
            "第 {i} 次调用不该触发熔断 (阈值 {})",
            STUCK_THRESHOLD
        );
    }
    // 第 STUCK_THRESHOLD + 1 次必须返回 true
    let stuck = mgr.record_tool_call("thread-1", "read", args).await;
    assert!(stuck, "第 {} 次同调用应触发熔断", STUCK_THRESHOLD + 1);
}

#[tokio::test]
async fn record_tool_call_isolates_threads() {
    let mgr = AgentManager::for_tests();
    let args = r#"{"path":"/a.md"}"#;
    // thread-A 触发熔断
    for _ in 0..=STUCK_THRESHOLD {
        let _ = mgr.record_tool_call("thread-A", "read", args).await;
    }
    // thread-B 应不受影响, 计数独立
    let stuck = mgr.record_tool_call("thread-B", "read", args).await;
    assert!(!stuck, "不同 thread 的卡死计数应隔离");
}

#[tokio::test]
async fn clear_tool_call_attempts_resets() {
    let mgr = AgentManager::for_tests();
    let args = r#"{"path":"/a.md"}"#;
    for _ in 0..=STUCK_THRESHOLD {
        let _ = mgr.record_tool_call("thread-1", "read", args).await;
    }
    mgr.clear_tool_call_attempts("thread-1").await;
    // 清空后重新计数, 不应立即触发
    let stuck = mgr.record_tool_call("thread-1", "read", args).await;
    assert!(!stuck, "clear 后计数应从 0 重新开始");
}

#[tokio::test]
async fn assistant_checkpoint_can_be_completed_in_place() {
    let mgr = AgentManager::for_tests();
    let thread_id = {
        let manager = mgr.thread_manager.read().await;
        manager
            .create_thread(default_agent_id(), "checkpoint".to_string())
            .await
            .expect("create thread")
            .thread_id
    };

    let message_id = mgr
        .flush_assistant_checkpoint(&thread_id, "partial", None)
        .await
        .expect("flush partial assistant");

    mgr.update_assistant_checkpoint(
        &thread_id,
        &message_id,
        "partial done",
        Some(true),
        None,
        None,
    )
    .await
    .expect("complete checkpoint");

    let thread = {
        let manager = mgr.thread_manager.read().await;
        manager
            .get_thread(&thread_id)
            .await
            .expect("get thread")
            .expect("thread")
    };

    assert_eq!(thread.messages.len(), 1);
    assert_eq!(thread.messages[0].id, message_id);
    assert_eq!(thread.messages[0].content, "partial done");
    assert_eq!(thread.messages[0].is_completed, Some(true));
    assert!(thread.messages[0].tool_calls.is_none());
}

#[tokio::test]
async fn assistant_checkpoint_can_be_promoted_to_tool_call_message() {
    let mgr = AgentManager::for_tests();
    let thread_id = {
        let manager = mgr.thread_manager.read().await;
        manager
            .create_thread(default_agent_id(), "checkpoint tool".to_string())
            .await
            .expect("create thread")
            .thread_id
    };
    let message_id = mgr
        .flush_assistant_checkpoint(&thread_id, "I should inspect the file", None)
        .await
        .expect("flush partial assistant");
    let tool_call = LlmToolCall {
        id: "call-checkpoint".to_string(),
        call_type: "function".to_string(),
        function: FunctionCall {
            name: "read".to_string(),
            arguments: r#"{"path":"/tmp/a.md"}"#.to_string(),
        },
    };

    mgr.update_assistant_checkpoint(
        &thread_id,
        &message_id,
        "I should inspect the file",
        Some(true),
        Some(std::slice::from_ref(&tool_call)),
        Some("thinking before tool"),
    )
    .await
    .expect("promote checkpoint");

    let thread = {
        let manager = mgr.thread_manager.read().await;
        manager
            .get_thread(&thread_id)
            .await
            .expect("get thread")
            .expect("thread")
    };
    let calls = thread.messages[0]
        .tool_calls
        .as_ref()
        .and_then(|v| v.as_array())
        .expect("tool_calls array");

    assert_eq!(thread.messages.len(), 1);
    assert_eq!(thread.messages[0].id, message_id);
    assert_eq!(thread.messages[0].is_completed, Some(true));
    assert_eq!(
        thread.messages[0].reasoning.as_deref(),
        Some("thinking before tool")
    );
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["id"], "call-checkpoint");
    assert_eq!(calls[0]["function"]["name"], "read");
}

#[tokio::test]
async fn cleanup_thread_removes_read_snapshot() {
    let mgr = AgentManager::for_tests();
    // 直接通过公共 API 触发, 这里只看 HashMap 状态
    // 不能调用 execute_tool_for_thread (要 memo_file), 但 cleanup 的语义
    // 仅是 HashMap::remove, 单独验证 read_snapshots 这一侧。
    {
        let mut snapshots = mgr.read_snapshots.write().await;
        snapshots
            .entry("thread-1".to_string())
            .or_default()
            .insert("/a.md".to_string(), "content".to_string());
        assert!(snapshots.contains_key("thread-1"));
    }
    mgr.cleanup_thread("thread-1").await;
    let snapshots = mgr.read_snapshots.read().await;
    assert!(
        !snapshots.contains_key("thread-1"),
        "read_snapshots 应被清空"
    );
}

#[tokio::test]
async fn cleanup_thread_removes_tool_call_attempts() {
    let mgr = AgentManager::for_tests();
    let args = r#"{"path":"/a.md"}"#;
    for _ in 0..=STUCK_THRESHOLD {
        let _ = mgr.record_tool_call("thread-1", "read", args).await;
    }
    mgr.cleanup_thread("thread-1").await;
    // 清理后重新计数, 不应被上次的累积触发
    let stuck = mgr.record_tool_call("thread-1", "read", args).await;
    assert!(!stuck, "cleanup 后计数应从 0 重新开始");
}

#[tokio::test]
async fn cleanup_thread_isolates_threads() {
    let mgr = AgentManager::for_tests();
    let args = r#"{"path":"/a.md"}"#;
    // thread-A 触发一次计数
    let _ = mgr.record_tool_call("thread-A", "read", args).await;
    // thread-B 注入 read snapshot
    {
        let mut snapshots = mgr.read_snapshots.write().await;
        snapshots
            .entry("thread-B".to_string())
            .or_default()
            .insert("/b.md".to_string(), "content".to_string());
    }
    mgr.cleanup_thread("thread-A").await;
    // thread-A 状态清空
    let attempts = mgr.tool_call_attempts.read().await;
    assert!(
        !attempts.contains_key("thread-A"),
        "thread-A 卡死计数应被清空"
    );
    drop(attempts);
    // thread-B 的 read snapshot 不受影响
    let snapshots = mgr.read_snapshots.read().await;
    assert!(
        snapshots.contains_key("thread-B"),
        "thread-B 数据不应被波及"
    );
}

#[tokio::test]
async fn cleanup_thread_is_idempotent() {
    let mgr = AgentManager::for_tests();
    // 对不存在的 thread_id 调用, 不应 panic
    mgr.cleanup_thread("nonexistent").await;
    mgr.cleanup_thread("nonexistent").await; // 二次调用同样安全
    let snapshots = mgr.read_snapshots.read().await;
    let attempts = mgr.tool_call_attempts.read().await;
    assert!(snapshots.is_empty());
    assert!(attempts.is_empty());
}

#[tokio::test]
async fn running_threads_reports_in_flight_run_id() {
    let mgr = AgentManager::for_tests();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut in_flight = mgr.in_flight.lock().await;
        in_flight.insert(
            "thread-1".to_string(),
            InFlightChat {
                cancel,
                started_at: 1_700_000_000_000,
                run_id: "run-1".to_string(),
            },
        );
    }

    let running = mgr.running_threads().await;
    let info = running.get("thread-1").expect("thread should be running");
    assert_eq!(info.started_at, 1_700_000_000_000);
    assert_eq!(info.agent_type.as_deref(), Some("flowix"));
    assert_eq!(info.run_id.as_deref(), Some("run-1"));
}

#[tokio::test]
async fn stop_chat_signals_and_removes_in_flight_run() {
    let mgr = AgentManager::for_tests();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut in_flight = mgr.in_flight.lock().await;
        in_flight.insert(
            "thread-1".to_string(),
            InFlightChat {
                cancel: cancel.clone(),
                started_at: 1,
                run_id: "run-1".to_string(),
            },
        );
    }

    assert!(mgr.stop_chat("thread-1", None).await);
    assert!(cancel.load(Ordering::Acquire));
    assert!(mgr.running_threads().await.is_empty());
    assert!(!mgr.stop_chat("thread-1", None).await);
}

#[tokio::test]
async fn unregister_in_flight_does_not_remove_newer_run() {
    let mgr = AgentManager::for_tests();
    let old_cancel = Arc::new(AtomicBool::new(false));
    let new_cancel = Arc::new(AtomicBool::new(false));
    {
        let mut in_flight = mgr.in_flight.lock().await;
        in_flight.insert(
            "thread-1".to_string(),
            InFlightChat {
                cancel: new_cancel.clone(),
                started_at: 2,
                run_id: "new-run".to_string(),
            },
        );
    }

    mgr.unregister_in_flight_if_current("thread-1", &old_cancel)
        .await;
    let running = mgr.running_threads().await;
    assert_eq!(
        running
            .get("thread-1")
            .and_then(|info| info.run_id.as_deref()),
        Some("new-run")
    );

    mgr.unregister_in_flight_if_current("thread-1", &new_cancel)
        .await;
    assert!(mgr.running_threads().await.is_empty());
}

// AgentChunk 序列化 ── 验证 wire 协议形状, 防止日后误改 serde tag 默默
// 破坏前后端 IPC 约定。`kind` 必须是 snake_case, 字段命名
// (threadId/text/id/name/input/result/message/reason) 是与前端的硬
// 契约, 不要随便改。`thread_id` 走 serde `rename_all = "snake_case"`,
// 前端 TS 端字段是 `threadId` (camelCase, serde 双向自动转换)。
#[test]
fn agent_chunk_text_serializes_with_snake_case_tag() {
    let chunk = AgentChunk::Text {
        thread_id: "thread_1".to_string(),
        text: "hello".to_string(),
    };
    let v: serde_json::Value = serde_json::to_value(&chunk).unwrap();
    assert_eq!(v["kind"], "text");
    assert_eq!(v["thread_id"], "thread_1");
    assert_eq!(v["text"], "hello");
}

#[test]
fn agent_chunk_reasoning_serializes_with_snake_case_tag() {
    let chunk = AgentChunk::Reasoning {
        thread_id: "thread_1".to_string(),
        text: "thinking...".to_string(),
    };
    let v: serde_json::Value = serde_json::to_value(&chunk).unwrap();
    assert_eq!(v["kind"], "reasoning");
    assert_eq!(v["thread_id"], "thread_1");
    assert_eq!(v["text"], "thinking...");
}

#[test]
fn agent_chunk_tool_call_serializes_with_snake_case_tag() {
    let chunk = AgentChunk::ToolCall {
        thread_id: "thread_1".to_string(),
        id: "call_1".to_string(),
        name: "read".to_string(),
        input: serde_json::json!({"path": "/a.md"}),
    };
    let v: serde_json::Value = serde_json::to_value(&chunk).unwrap();
    assert_eq!(v["kind"], "tool_call");
    assert_eq!(v["thread_id"], "thread_1");
    assert_eq!(v["id"], "call_1");
    assert_eq!(v["name"], "read");
    assert_eq!(v["input"]["path"], "/a.md");
}

#[test]
fn agent_chunk_tool_result_serializes_with_snake_case_tag() {
    let chunk = AgentChunk::ToolResult {
        thread_id: "thread_1".to_string(),
        id: "call_1".to_string(),
        name: "read".to_string(),
        result: serde_json::json!({"content": "data"}),
    };
    let v: serde_json::Value = serde_json::to_value(&chunk).unwrap();
    assert_eq!(v["kind"], "tool_result");
    assert_eq!(v["thread_id"], "thread_1");
    assert_eq!(v["id"], "call_1");
    assert_eq!(v["name"], "read");
    assert_eq!(v["result"]["content"], "data");
}

#[test]
fn agent_chunk_error_serializes_with_snake_case_tag() {
    let chunk = AgentChunk::Error {
        thread_id: "thread_1".to_string(),
        message: "Agent stuck".to_string(),
    };
    let v: serde_json::Value = serde_json::to_value(&chunk).unwrap();
    assert_eq!(v["kind"], "error");
    assert_eq!(v["thread_id"], "thread_1");
    assert_eq!(v["message"], "Agent stuck");
}

#[test]
fn agent_chunk_stream_start_serializes_with_snake_case_tag() {
    let chunk = AgentChunk::StreamStart {
        thread_id: "thread_1".to_string(),
        model: Some("gpt-5.5".to_string()),
        reasoning_effort: Some("medium".to_string()),
    };
    let v: serde_json::Value = serde_json::to_value(&chunk).unwrap();
    assert_eq!(v["kind"], "stream_start");
    assert_eq!(v["thread_id"], "thread_1");
    assert_eq!(v["model"], "gpt-5.5");
    assert_eq!(v["reasoning_effort"], "medium");
}

#[test]
fn agent_chunk_usage_serializes_with_snake_case_tag() {
    let chunk = AgentChunk::Usage {
        thread_id: "thread_1".to_string(),
        model_id: Some("gpt-5.5".to_string()),
        last_run_at: Some(1_777_777_000_000),
        usage: Some(UsageInfo {
            input_tokens: Some(100),
            cached_input_tokens: Some(25),
            output_tokens: Some(50),
            reasoning_output_tokens: Some(10),
            total_tokens: Some(150),
            model_context_window: Some(200_000),
        }),
        status_info: Some(StatusInfo {
            codex_plan_type: Some("pro".to_string()),
            codex_used_percent: Some(22.0),
            codex_resets_at: Some(1_777_777_777),
        }),
    };
    let v: serde_json::Value = serde_json::to_value(&chunk).unwrap();
    assert_eq!(v["kind"], "usage");
    assert_eq!(v["thread_id"], "thread_1");
    assert_eq!(v["model_id"], "gpt-5.5");
    assert_eq!(v["last_run_at"], 1_777_777_000_000i64);
    let usage = &v["usage"];
    assert_eq!(usage["input_tokens"], 100);
    assert_eq!(usage["cached_input_tokens"], 25);
    assert_eq!(usage["output_tokens"], 50);
    assert_eq!(usage["reasoning_output_tokens"], 10);
    assert_eq!(usage["total_tokens"], 150);
    assert_eq!(usage["model_context_window"], 200_000);
    let status_info = &v["status_info"];
    assert_eq!(status_info["codex_plan_type"], "pro");
    assert_eq!(status_info["codex_used_percent"], 22.0);
    assert_eq!(status_info["codex_resets_at"], 1_777_777_777);
}

#[test]
fn agent_chunk_stream_end_serializes_with_snake_case_tag() {
    // 两个分支: 正常完成 (reason = null) / 异常退出 (reason = "...")。
    // run_id 已在 #3 重构后移到 `emit_chunk_with_run_id` 在 JSON 层注入,
    // 不再是 AgentChunk 结构体字段 ── 见 external_run.rs::emit_chunk_with_run_id。
    let chunk = AgentChunk::StreamEnd {
        thread_id: "thread_1".to_string(),
        reason: None,
    };
    let v: serde_json::Value = serde_json::to_value(&chunk).unwrap();
    assert_eq!(v["kind"], "stream_end");
    assert_eq!(v["thread_id"], "thread_1");
    assert!(
        v["reason"].is_null(),
        "正常完成时 reason 必须是 null, 不是缺字段"
    );

    let chunk_err = AgentChunk::StreamEnd {
        thread_id: "thread_2".to_string(),
        reason: Some("agent stuck".to_string()),
    };
    let v2: serde_json::Value = serde_json::to_value(&chunk_err).unwrap();
    assert_eq!(v2["kind"], "stream_end");
    assert_eq!(v2["thread_id"], "thread_2");
    assert_eq!(v2["reason"], "agent stuck");
}

#[test]
fn agent_chunk_session_resolved_serializes_with_snake_case_tag() {
    let chunk = AgentChunk::SessionResolved {
        thread_id: "codex-local-agent-inst-1".to_string(),
        session_id: "019f0000-0000-7000-8000-000000000000".to_string(),
    };
    let v: serde_json::Value = serde_json::to_value(&chunk).unwrap();
    assert_eq!(v["kind"], "session_resolved");
    assert_eq!(v["thread_id"], "codex-local-agent-inst-1");
    assert_eq!(v["session_id"], "019f0000-0000-7000-8000-000000000000");
}

#[tokio::test]
async fn runtime_config_applies_for_non_persisted_local_thread() {
    let message = AgentUserMessage {
        content: "hello".to_string(),
        llm_content: None,
        image_paths: vec![],
        run_id: None,
        system_reminder_directory: None,
        agent_type: Some("claude".to_string()),
        runtime_config: Some(AgentRuntimeConfig {
            claude: Some(RuntimePathConfig {
                cwd: Some("/tmp/work".to_string()),
                workspace_paths: vec!["/tmp/work".to_string(), "memo-1".to_string()],
                permission_mode: Some("workspace-write".to_string()),
                model: Some("claude-sonnet-5".to_string()),
                reasoning_effort: Some("high".to_string()),
            }),
            ..AgentRuntimeConfig::default()
        }),
        permission_mode: None,
        codex_model: None,
        codex_reasoning_effort: None,
        agent_role_memo_id: None,
        agent_role_name: None,
        conversation_title: None,
    };

    assert_eq!(message.model_for_runtime("claude"), Some("claude-sonnet-5"));
    assert_eq!(message.reasoning_effort_for_runtime("claude"), Some("high"));
    assert_eq!(message.cwd_for_runtime("claude"), Some("/tmp/work"));
    let claude = message
        .runtime_config
        .as_ref()
        .and_then(|cfg| cfg.claude.as_ref())
        .expect("claude runtime config should be populated");
    assert_eq!(claude.cwd.as_deref(), Some("/tmp/work"));
    assert_eq!(claude.permission_mode.as_deref(), Some("workspace-write"));
    assert_eq!(
        claude.workspace_paths,
        vec!["/tmp/work".to_string(), "memo-1".to_string()]
    );
}

#[test]
fn run_info_serializes_with_camel_case() {
    // 验证 `agent_running_threads` IPC 返回值形状 ── 跟 CLAUDE.md 的
    // 跨 IPC struct 必须 camelCase 一致。`started_at` / `current_tool`
    // 是 wire 硬契约, 前端 TS 端 `runInfo.startedAt` / `runInfo.currentTool`。
    let info = RunInfo {
        started_at: 1_700_000_000_000,
        current_tool: Some("read".to_string()),
        agent_type: Some("codex".to_string()),
        run_id: Some("run-1".to_string()),
        pending_thread_id: Some("codex-local-agent-inst-1".to_string()),
        session_id: Some("session-1".to_string()),
    };
    let v: serde_json::Value = serde_json::to_value(&info).unwrap();
    assert_eq!(v["startedAt"], 1_700_000_000_000_i64);
    assert_eq!(v["currentTool"], "read");
    assert_eq!(v["agentType"], "codex");
    assert_eq!(v["runId"], "run-1");
    assert_eq!(v["pendingThreadId"], "codex-local-agent-inst-1");
    assert_eq!(v["sessionId"], "session-1");

    let none_info = RunInfo {
        started_at: 0,
        current_tool: None,
        agent_type: None,
        run_id: None,
        pending_thread_id: None,
        session_id: None,
    };
    let v2: serde_json::Value = serde_json::to_value(&none_info).unwrap();
    assert!(v2["currentTool"].is_null());
}

#[test]
fn default_agent_id_returns_stable_placeholder() {
    // 占位值应稳定为 "default", 历史 schema 兼容要求。
    let a = default_agent_id();
    let b = default_agent_id();
    assert_eq!(a, b);
    assert_eq!(a.0, "default");
}

#[test]
fn agent_id_display_matches_inner() {
    let id = AgentId::new("custom-agent");
    assert_eq!(id.to_string(), "custom-agent");
    assert_eq!(format!("{}", id), "custom-agent");
}

#[test]
fn agent_id_from_string_and_str() {
    let from_string: AgentId = String::from("a").into();
    let from_str: AgentId = "b".into();
    assert_eq!(from_string.0, "a");
    assert_eq!(from_str.0, "b");
}

#[test]
fn token_budget_error_message_includes_used_and_budget() {
    // 前端 `agent-chunk` Error case 会拿到这段字符串, 用于 toast / 上下文提示。
    // 锁住字段名 (used / budget) 与单位, 防止文案漂移破坏前端正则解析。
    let err = AgentError::TokenBudget {
        used: 120_000,
        budget: 100_000,
    };
    let msg = err.to_string();
    assert!(msg.contains("120000"), "应包含 used 数值, 实际: {msg}");
    assert!(msg.contains("100000"), "应包含 budget 数值, 实际: {msg}");
    assert!(
        msg.contains("token budget"),
        "应保留错误类型标识, 实际: {msg}"
    );
}
