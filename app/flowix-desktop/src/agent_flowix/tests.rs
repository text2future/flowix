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
    // 涓绘祦璺緞: LLM 缁欑殑 tool_call.id 鐩存帴鎷煎墠缂€ 鈹€鈹€ 涓庡巻鍙叉寔涔呭寲灞傚畬鍏ㄥ吋瀹广€?    assert_eq!(tool_call_row_id("call_abc123"), "tool_call_abc123");
    assert_eq!(
        tool_call_row_id("call_019f0000-0000-7000-8000-000000000000"),
        "tool_call_019f0000-0000-7000-8000-000000000000",
    );
}

#[test]
fn tool_call_row_id_falls_back_to_uuid_when_empty() {
    // 鍏滃簳璺緞: LLM 鍋跺彂涓嶇粰 id,绌轰覆蹇呴』鍙樺敮涓€ id 鎵嶈兘閬垮紑 PRIMARY KEY 鎾炶溅銆?    // 涓ゆ璋冪敤閮芥嬁鍒?UUID,褰兼涓€瀹氫笉鍚屻€?
    let a = tool_call_row_id("");
    let b = tool_call_row_id("");

    assert!(a.starts_with("tool_"));
    assert!(b.starts_with("tool_"));
    assert_ne!(a, b, "empty ids must generate distinct UUID-backed row ids");

    // UUID v4 褰㈡€? 8-4-4-4-12 hex digits,甯﹁繛瀛楃 鈹€鈹€ 闃叉鏈潵鏇挎崲鎴?    // 鍒殑闅忔満婧愬悗 format 婕傜Щ銆?
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
    assert!(msg.contains("Stream error: connection reset by peer"));
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
            msg.ends_with(&format!(": {})", input)),
            "input={input}, got={msg}"
        );
    }
}

#[test]
fn llm_unavailable_message_preserves_chinese_punctuation() {
    // Chinese half-width comma (`,`) is intentional 鈥?matches the
    // rest of the codebase. Full-width comma (`锛宍) would also
    // be valid but is a different code point; this test guards
    // against accidental character substitution during refactors.
    let msg = format_llm_unavailable_message("any reason");
    assert!(msg.contains("(LLM 鏆傛椂涓嶅彲鐢? 鍘熷洜: "), "got: {msg}");
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
            "绗?{i} 娆¤皟鐢ㄤ笉璇ヨЕ鍙戠啍鏂?(闃堝€?{})",
            STUCK_THRESHOLD
        );
    }
    // 绗?STUCK_THRESHOLD + 1 娆″繀椤昏繑鍥?true
    let stuck = mgr.record_tool_call("thread-1", "read", args).await;
    assert!(stuck, "same tool call should trigger stuck detection");
}

#[tokio::test]
async fn record_tool_call_isolates_threads() {
    let mgr = AgentManager::for_tests();
    let args = r#"{"path":"/a.md"}"#;
    // thread-A 瑙﹀彂鐔旀柇
    for _ in 0..=STUCK_THRESHOLD {
        let _ = mgr.record_tool_call("thread-A", "read", args).await;
    }
    // thread-B 搴斾笉鍙楀奖鍝? 璁℃暟鐙珛
    let stuck = mgr.record_tool_call("thread-B", "read", args).await;
    assert!(!stuck, "stuck counters should be isolated per thread");
}

#[tokio::test]
async fn clear_tool_call_attempts_resets() {
    let mgr = AgentManager::for_tests();
    let args = r#"{"path":"/a.md"}"#;
    for _ in 0..=STUCK_THRESHOLD {
        let _ = mgr.record_tool_call("thread-1", "read", args).await;
    }
    mgr.clear_tool_call_attempts("thread-1").await;
    // 娓呯┖鍚庨噸鏂拌鏁? 涓嶅簲绔嬪嵆瑙﹀彂
    let stuck = mgr.record_tool_call("thread-1", "read", args).await;
    assert!(!stuck, "clear should reset stuck counters");
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
    // 鐩存帴閫氳繃鍏叡 API 瑙﹀彂, 杩欓噷鍙湅 HashMap 鐘舵€?
    // 涓嶈兘璋冪敤 execute_tool_for_thread (瑕?memo_file), 浣?cleanup 鐨勮涔?
    // 浠呮槸 HashMap::remove, 鍗曠嫭楠岃瘉 read_snapshots 杩欎竴渚с€?
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
        "read_snapshots 搴旇娓呯┖"
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
    // 娓呯悊鍚庨噸鏂拌鏁? 涓嶅簲琚笂娆＄殑绱Н瑙﹀彂
    let stuck = mgr.record_tool_call("thread-1", "read", args).await;
    assert!(!stuck, "cleanup should reset stuck counters");
}

#[tokio::test]
async fn cleanup_thread_isolates_threads() {
    let mgr = AgentManager::for_tests();
    let args = r#"{"path":"/a.md"}"#;
    // thread-A 瑙﹀彂涓€娆¤鏁?
    let _ = mgr.record_tool_call("thread-A", "read", args).await;
    // thread-B 娉ㄥ叆 read snapshot
    {
        let mut snapshots = mgr.read_snapshots.write().await;
        snapshots
            .entry("thread-B".to_string())
            .or_default()
            .insert("/b.md".to_string(), "content".to_string());
    }
    mgr.cleanup_thread("thread-A").await;
    // thread-A 鐘舵€佹竻绌?
    let attempts = mgr.tool_call_attempts.read().await;
    assert!(
        !attempts.contains_key("thread-A"),
        "thread-A 鍗℃璁℃暟搴旇娓呯┖"
    );
    drop(attempts);
    // thread-B 鐨?read snapshot 涓嶅彈褰卞搷
    let snapshots = mgr.read_snapshots.read().await;
    assert!(
        snapshots.contains_key("thread-B"),
        "thread-B data should not be affected"
    );
}

#[tokio::test]
async fn cleanup_thread_is_idempotent() {
    let mgr = AgentManager::for_tests();
    // 瀵逛笉瀛樺湪鐨?thread_id 璋冪敤, 涓嶅簲 panic
    mgr.cleanup_thread("nonexistent").await;
    mgr.cleanup_thread("nonexistent").await; // 浜屾璋冪敤鍚屾牱瀹夊叏
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

// AgentChunk 搴忓垪鍖?鈹€鈹€ 楠岃瘉 wire 鍗忚褰㈢姸, 闃叉鏃ュ悗璇敼 serde tag 榛橀粯
// 鐮村潖鍓嶅悗绔?IPC 绾﹀畾銆俙kind` 蹇呴』鏄?snake_case, 瀛楁鍛藉悕
// (threadId/text/id/name/input/result/message/reason) 鏄笌鍓嶇鐨勭‖
// 濂戠害, 涓嶈闅忎究鏀广€俙thread_id` 璧?serde `rename_all = "snake_case"`,
// 鍓嶇 TS 绔瓧娈垫槸 `threadId` (camelCase, serde 鍙屽悜鑷姩杞崲)銆?
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
    // 涓や釜鍒嗘敮: 姝ｅ父瀹屾垚 (reason = null) / 寮傚父閫€鍑?(reason = "...")銆?    // run_id 宸插湪 #3 閲嶆瀯鍚庣Щ鍒?`emit_chunk_with_run_id` 鍦?JSON 灞傛敞鍏?
    // 涓嶅啀鏄?AgentChunk 缁撴瀯浣撳瓧娈?鈹€鈹€ 瑙?external_run.rs::emit_chunk_with_run_id銆?
    let chunk = AgentChunk::StreamEnd {
        thread_id: "thread_1".to_string(),
        reason: None,
    };
    let v: serde_json::Value = serde_json::to_value(&chunk).unwrap();
    assert_eq!(v["kind"], "stream_end");
    assert_eq!(v["thread_id"], "thread_1");
    assert!(
        v["reason"].is_null(),
        "normal completion reason should serialize as null"
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
    // 楠岃瘉 `agent_running_threads` IPC 杩斿洖鍊煎舰鐘?鈹€鈹€ 璺?CLAUDE.md 鐨?    // 璺?IPC struct 蹇呴』 camelCase 涓€鑷淬€俙started_at` / `current_tool`
    // 鏄?wire 纭绾? 鍓嶇 TS 绔?`runInfo.startedAt` / `runInfo.currentTool`銆?
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
    // 鍗犱綅鍊煎簲绋冲畾涓?"default", 鍘嗗彶 schema 鍏煎瑕佹眰銆?
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
    // 鍓嶇 `agent-chunk` Error case 浼氭嬁鍒拌繖娈靛瓧绗︿覆, 鐢ㄤ簬 toast / 涓婁笅鏂囨彁绀恒€?    // 閿佷綇瀛楁鍚?(used / budget) 涓庡崟浣? 闃叉鏂囨婕傜Щ鐮村潖鍓嶇姝ｅ垯瑙ｆ瀽銆?
    let err = AgentError::TokenBudget {
        used: 120_000,
        budget: 100_000,
    };
    let msg = err.to_string();
    assert!(msg.contains("120000"), "should include used tokens: {msg}");
    assert!(msg.contains("100000"), "should include token budget: {msg}");
    assert!(
        msg.contains("token budget"),
        "should keep token budget error label: {msg}"
    );
}
