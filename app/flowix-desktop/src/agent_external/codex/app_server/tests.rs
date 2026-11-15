//! `app_server` 的回归测试。
//!
//! 覆盖的是协议投影里最容易「看起来对、实际错位」的几处：消息 id 的兜底规则、
//! 队列与 provider 的启动顺序对齐、历史重建时的原生证据判定。
//!
//! 单列一个文件是因为它有一千多行，和实现放在一起会把 `app_server.rs` 变成
//! 一个没人愿意打开的入口。

use super::*;

#[test]
fn startup_cancellation_is_scoped_and_consumed_once() {
    let mut pending = HashMap::from([
        ("thread-a".to_string(), "run-a".to_string()),
        ("thread-b".to_string(), "run-b".to_string()),
    ]);
    assert!(take_pending_cancellation(&mut pending, "thread-a", "run-a"));
    assert!(!take_pending_cancellation(
        &mut pending,
        "thread-a",
        "run-a"
    ));
    assert!(!take_pending_cancellation(
        &mut pending,
        "thread-b",
        "new-run"
    ));
    assert!(
        pending.is_empty(),
        "a stale Stop must not cancel a later run"
    );
}

#[test]
fn consumes_only_the_correlated_pending_steer_and_never_recreates_a_receipt() {
    let mut receipts = vec![
        json!({ "clientUserMessageId": "first", "deliveryStatus": "submitting" }),
        json!({ "clientUserMessageId": "second", "deliveryStatus": "steering" }),
    ];
    acknowledge_pending_steers(
        &mut receipts,
        &json!({ "type": "agentMessage", "clientId": "first" }),
    );
    assert_eq!(receipts.len(), 2);
    acknowledge_pending_steers(
        &mut receipts,
        &json!({ "type": "userMessage", "clientId": "first" }),
    );
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0]["clientUserMessageId"], "second");
    finish_pending_steer(&mut receipts, "first", true);
    assert_eq!(receipts.len(), 1);
    acknowledge_pending_steers(
        &mut receipts,
        &json!({ "type": "userMessage", "clientId": "first" }),
    );
    assert_eq!(receipts.len(), 1);
}

#[test]
fn identifies_queue_entries_already_consumed_by_codex() {
    assert!(is_stale_queued_submission_error(
        "queued submission not found: 01a12a9e-d74e-7b71-8771-78cd958e8a72"
    ));
    assert!(!is_stale_queued_submission_error("turn is still active"));
    assert!(is_queue_start_conflict_error(
        "thread already has an active or pending turn"
    ));
}

#[test]
fn reads_queued_submission_content_for_automatic_turn_binding() {
    let queued = queued_follow_up_from_submission(
        "flowix-thread",
        "codex-thread",
        &json!({
            "id": "provider-queue-id",
            "clientUserMessageId": "flowix-user-id",
            "input": [
                { "type": "text", "text": "follow-up request" },
                { "type": "localImage", "path": "/tmp/reference.png" }
            ]
        }),
    )
    .unwrap();

    assert_eq!(queued.flowix_thread_id, "flowix-thread");
    assert_eq!(queued.codex_thread_id, "codex-thread");
    assert_eq!(
        queued.queued_submission_id.as_deref(),
        Some("provider-queue-id")
    );
    assert_eq!(queued.client_user_message_id, "flowix-user-id");
    assert_eq!(queued.message.content, "follow-up request");
    assert_eq!(queued.message.image_paths, vec!["/tmp/reference.png"]);
}

#[test]
fn selects_the_oldest_provider_submission_when_starting_an_idle_queue() {
    let queue = json!({
        "data": [
            {
                "id": "older-queue-id",
                "clientUserMessageId": "older-client-id",
                "input": [{ "type": "text", "text": "older follow-up" }]
            },
            {
                "id": "newer-queue-id",
                "clientUserMessageId": "newer-client-id",
                "input": [{ "type": "text", "text": "newer follow-up" }]
            }
        ]
    });

    let head = queued_follow_up_at_queue_head("flowix-thread", "codex-thread", &queue).unwrap();

    assert_eq!(head.queued_submission_id.as_deref(), Some("older-queue-id"));
    assert_eq!(head.client_user_message_id, "older-client-id");
    assert_eq!(head.message.content, "older follow-up");
}

#[test]
fn aligns_local_turn_binding_order_with_the_provider_queue() {
    let mut items = vec![
        queued_follow_up_from_submission(
            "flowix-thread",
            "codex-thread",
            &json!({
                "id": "newer-queue-id",
                "clientUserMessageId": "newer-client-id",
                "input": [{ "type": "text", "text": "newer follow-up" }]
            }),
        )
        .unwrap(),
        queued_follow_up_from_submission(
            "flowix-thread",
            "codex-thread",
            &json!({
                "id": "older-queue-id",
                "clientUserMessageId": "older-client-id",
                "input": [{ "type": "text", "text": "older follow-up" }]
            }),
        )
        .unwrap(),
    ];

    order_queued_follow_ups(
        &mut items,
        &["older-queue-id".to_string(), "newer-queue-id".to_string()],
    );

    assert_eq!(
        items
            .iter()
            .map(|item| item.client_user_message_id.as_str())
            .collect::<Vec<_>>(),
        ["older-client-id", "newer-client-id"],
    );
}

#[test]
fn compares_codex_cli_versions_numerically() {
    let minimum = parse_codex_version(MIN_PAGINATED_CODEX_VERSION).unwrap();
    assert!(parse_codex_version("0.150.0").unwrap() >= minimum);
    assert!(parse_codex_version("0.152.0").unwrap() > minimum);
    assert!(parse_codex_version("0.149.99").unwrap() < minimum);
    assert_eq!(parse_codex_version("0.150.0-beta.1").unwrap(), minimum);
    assert!(parse_codex_version("not-a-version").is_none());
}

#[test]
fn projects_known_tool_items_to_stable_flowix_names() {
    let item = json!({
        "id": "item-1",
        "type": "commandExecution",
        "command": "git status --short"
    });
    assert_eq!(
        codex_tool_call_identity(&item),
        Some(("item-1".to_string(), "command_execution".to_string()))
    );
}

#[test]
fn accepts_current_app_server_tool_item_names() {
    let collab = json!({ "id": "item-c", "type": "collabToolCall", "tool": "spawn_agent" });
    let image_view =
        json!({ "id": "item-view", "type": "imageView", "path": "/tmp/image.png" });
    let image_generation = json!({ "id": "item-generation", "type": "imageGeneration" });

    assert_eq!(
        codex_tool_call_identity(&collab),
        Some(("item-c".to_string(), "collab_agent_tool_call".to_string()))
    );
    assert_eq!(
        codex_tool_call_identity(&image_view),
        Some(("item-view".to_string(), "view_image".to_string()))
    );
    assert_eq!(
        codex_tool_call_identity(&image_generation),
        Some((
            "item-generation".to_string(),
            "image_generation".to_string()
        ))
    );
}

#[test]
fn serializes_app_server_sandbox_objects() {
    assert_eq!(
        app_server_sandbox(Some("unknown-mode")),
        json!({ "type": "readOnly" })
    );
    assert_eq!(app_server_approval_policy(Some("unknown-mode")), "never");
    assert_eq!(
        app_server_sandbox(Some("read-only")),
        json!({ "type": "readOnly" })
    );
    assert_eq!(
        app_server_sandbox(Some("danger-full-access")),
        json!({ "type": "dangerFullAccess" })
    );
    assert_eq!(
        app_server_sandbox(Some("yolo")),
        json!({ "type": "dangerFullAccess" })
    );
    assert_eq!(
        app_server_sandbox(None),
        json!({
            "type": "workspaceWrite",
            "writableRoots": [],
            "networkAccess": false
        })
    );
}

#[test]
fn serializes_legacy_thread_start_sandbox_values() {
    assert_eq!(app_server_legacy_sandbox(Some("unknown-mode")), "read-only");
    assert_eq!(app_server_legacy_sandbox(Some("read-only")), "read-only");
    assert_eq!(
        app_server_legacy_sandbox(Some("workspace-write")),
        "workspace-write"
    );
    assert_eq!(app_server_legacy_sandbox(None), "workspace-write");
    assert_eq!(
        app_server_legacy_sandbox(Some("danger-full-access")),
        "danger-full-access"
    );
    assert_eq!(
        app_server_legacy_sandbox(Some("yolo")),
        "danger-full-access"
    );
}

#[test]
fn enables_interactive_approval_only_for_writable_threads() {
    assert_eq!(
        app_server_approval_policy(Some("workspace-write")),
        "on-request"
    );
    assert_eq!(app_server_approval_policy(None), "on-request");
    assert_eq!(app_server_approval_policy(Some("read-only")), "never");
    assert_eq!(
        app_server_approval_policy(Some("danger-full-access")),
        "never"
    );
}

#[test]
fn uses_current_codex_review_decision_wire_values() {
    assert_eq!(
        server_decline_result("item/commandExecution/requestApproval"),
        json!({ "decision": "decline" })
    );
    assert_eq!(
        server_decline_result("item/permissions/requestApproval"),
        json!({ "permissions": {}, "scope": "turn", "strictAutoReview": null })
    );
}

#[test]
fn ignores_non_tool_items() {
    assert_eq!(
        codex_tool_call_identity(&json!({ "id": "message-1", "type": "agentMessage" })),
        None
    );
}

#[test]
fn projects_codex_commentary_as_agent_message_type() {
    let message = app_server_item_message(
        &json!({
            "id": "commentary-1",
            "type": "agentMessage",
            "text": "Checking the workspace.",
            "phase": "commentary"
        }),
        "2026-01-01T00:00:00Z",
        0,
        0,
        Some("turn-1"),
    )
    .expect("commentary message");

    assert_eq!(message.role, "assistant");
    assert_eq!(
        message.message_type.as_deref(),
        Some(CODEX_COMMENTARY_MESSAGE_TYPE)
    );
}

#[test]
fn strips_workspace_context_from_codex_history_user_message() {
    let message = app_server_item_message(
        &json!({
            "id": "user-1",
            "type": "userMessage",
            "content": "question\n<## CONTEXT PROMPT ##>\nprivate workspace data"
        }),
        "2026-01-01T00:00:00Z",
        0,
        0,
        Some("turn-1"),
    )
    .expect("user message");

    assert_eq!(message.content, "question");
}

#[test]
fn ignores_empty_reasoning_items() {
    let message = app_server_item_message(
        &json!({
            "id": "reasoning-empty",
            "type": "reasoning",
            "summary": [" ", "\n"]
        }),
        "2026-01-01T00:00:00Z",
        0,
        0,
        None,
    );
    assert!(message.is_none());
    assert!(!has_visible_text(" \n\t"));
    assert!(has_visible_text("plan"));
}

#[test]
fn projects_context_compaction_as_a_system_message() {
    let message = app_server_item_message(
        &json!({
            "id": "compaction-1",
            "type": "contextCompaction"
        }),
        "2026-01-01T00:00:00Z",
        0,
        0,
        Some("turn-1"),
    )
    .expect("context compaction");

    assert_eq!(message.role, "system");
    assert_eq!(
        message.message_type.as_deref(),
        Some(CONTEXT_COMPACTION_MESSAGE_TYPE)
    );
    assert_eq!(message.codex_turn_id.as_deref(), Some("turn-1"));
}

#[test]
fn context_compaction_without_native_identity_uses_the_live_fallback() {
    let messages = app_server_turn_messages(&[json!({
        "status": "completed",
        "items": [{ "type": "contextCompaction" }]
    })]);

    let marker = messages
        .iter()
        .find(|message| message.role == "system")
        .expect("context compaction marker");
    assert_eq!(marker.id, "codex-context-compaction");
}

#[test]
fn codex_history_only_confirms_assistant_rows_with_native_terminal_evidence() {
    let active = app_server_turn_messages(&[json!({
        "id": "turn-active", "status": "inProgress",
        "items": [
            { "id": "reply-active", "type": "agentMessage", "text": "partial" },
            { "id": "reasoning-active", "type": "reasoning", "summary": "thinking" }
        ]
    })]);
    assert!(active
        .iter()
        .all(|message| message.is_completed == Some(false)));

    let completed_item = app_server_turn_messages(&[json!({
        "id": "turn-active", "status": "inProgress",
        "items": [{ "id": "reply-complete", "type": "agentMessage", "status": "completed", "text": "stable" }]
    })]);
    assert_eq!(completed_item[0].is_completed, Some(true));

    let page = paginate_app_server_turns(
        &[
            json!({ "id": "turn-done", "status": "completed", "items": [] }),
            json!({ "id": "turn-active", "status": "inProgress", "items": [] }),
        ],
        None,
        None,
        10,
    );
    assert_eq!(page.complete_turn_ids, Some(vec!["turn-done".to_string()]));

    let finished = app_server_turn_messages(&[json!({
        "id": "turn-finished", "status": "completed",
        "items": [
            { "id": "reply-finished", "type": "agentMessage", "text": "done" },
            { "id": "reasoning-finished", "type": "reasoning", "summary": "thought" }
        ]
    })]);
    assert!(finished
        .iter()
        .all(|message| message.is_completed == Some(true)));
}

#[test]
fn restores_manual_compact_as_a_history_user_message() {
    let messages = app_server_turn_messages(&[json!({
        "id": "turn-compact",
        "startedAt": 1_730_910_000,
        "status": "completed",
        "items": [{
            "id": "compaction-1",
            "type": "contextCompaction"
        }]
    })]);

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[0].content, "/compact");
    assert_eq!(
        messages[0].message_type.as_deref(),
        Some(CODEX_COMMAND_MESSAGE_TYPE)
    );
    assert_eq!(
        messages[0].id,
        codex_command_message_id(Some("turn-compact"), "")
    );
    assert_eq!(messages[0].id, "flowix:codex:command:turn-compact");
    assert_eq!(messages[0].codex_turn_id.as_deref(), Some("turn-compact"));
    assert_eq!(messages[1].role, "system");
    assert_eq!(
        messages[1].message_type.as_deref(),
        Some(CONTEXT_COMPACTION_MESSAGE_TYPE)
    );
}

#[test]
fn history_commands_without_turn_ids_use_the_unbound_namespace() {
    let compact = app_server_compact_command_message(
        &json!({ "id": "compact-item", "type": "contextCompaction" }),
        "2026-01-01T00:00:00Z",
        0,
        0,
        None,
    );
    let goal = app_server_goal_command_message("Ship it", "2026-01-01T00:00:00Z", 2, None);

    assert_eq!(compact.id, "flowix:codex:command:unbound:compact-item");
    assert_eq!(goal.id, "flowix:codex:command:unbound:turn-2");
}

#[test]
fn codex_missing_item_ids_use_turn_content_and_occurrence() {
    let messages = app_server_turn_messages(&[json!({
        "id": "turn-fallback",
        "status": "completed",
        "items": [
            { "type": "agentMessage", "text": "same reply" },
            { "type": "agentMessage", "text": "same reply" },
            { "type": "reasoning", "summary": "same thought" },
            { "type": "reasoning", "summary": "same thought" }
        ]
    })]);

    assert_eq!(messages.len(), 4);
    assert_eq!(
        messages[0].id,
        codex_fallback_item_message_id("turn-fallback", "assistant", "same reply", 0)
    );
    assert_eq!(
        messages[0].id,
        "flowix:codex:item:turn-fallback:assistant:c9c3d78b64eaec57:0"
    );
    assert_eq!(
        codex_fallback_item_message_id("t", "assistant", "你好🙂", 0),
        "flowix:codex:item:t:assistant:71b13a3934f0304d:0"
    );
    assert_eq!(
        messages[1].id,
        codex_fallback_item_message_id("turn-fallback", "assistant", "same reply", 1)
    );
    assert_ne!(messages[0].id, messages[1].id);
    assert_eq!(
        messages[2].id,
        codex_fallback_item_message_id("turn-fallback", "reasoning", "same thought", 0)
    );
    assert_eq!(
        messages[3].id,
        codex_fallback_item_message_id("turn-fallback", "reasoning", "same thought", 1)
    );
}

#[test]
fn repeated_codex_user_items_without_ids_match_the_live_fallback_policy() {
    let messages = app_server_turn_messages(&[json!({
        "id": "turn-users",
        "status": "completed",
        "items": [
            { "type": "userMessage", "content": "repeat" },
            { "type": "userMessage", "content": "repeat" }
        ]
    })]);

    assert_eq!(messages.len(), 2);
    assert_eq!(
        messages[0].id,
        codex_fallback_item_message_id("turn-users", "user", "repeat", 0)
    );
    assert_eq!(
        messages[1].id,
        codex_fallback_item_message_id("turn-users", "user", "repeat", 1)
    );
}

#[test]
fn orphan_custom_tool_history_uses_provider_output_id_or_call_fallback() {
    let messages = app_server_turn_messages(&[json!({
        "id": "turn-tools",
        "status": "completed",
        "items": [
            { "id": "output-item", "type": "custom_tool_call_output", "call_id": "call-a", "output": "done" },
            { "type": "custom_tool_call_output", "call_id": "call-b", "output": "done" }
        ]
    })]);

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].id, "output-item");
    assert_eq!(
        messages[1].id,
        codex_custom_tool_output_message_id(Some("turn-tools"), "call-b")
    );
    assert_eq!(messages[1].id, "flowix:codex:tool-output:turn-tools:call-b");
}

#[test]
fn custom_tool_call_without_item_id_uses_the_live_call_fallback() {
    let messages = app_server_turn_messages(&[json!({
        "id": "turn-tools",
        "status": "completed",
        "items": [{
            "type": "custom_tool_call",
            "call_id": "call-a",
            "name": "future_connector",
            "input": { "query": "x" }
        }]
    })]);

    assert_eq!(messages.len(), 1);
    assert_eq!(
        messages[0].id,
        codex_tool_call_message_id(Some("turn-tools"), "call-a")
    );
    assert_eq!(messages[0].id, "flowix:codex:tool-call:turn-tools:call-a");
    assert_eq!(messages[0].tool_call_id.as_deref(), Some("call-a"));
}

#[test]
fn codex_tool_call_without_turn_or_item_id_uses_the_unbound_live_fallback() {
    let messages = app_server_turn_messages(&[json!({
        "status": "completed",
        "items": [{
            "type": "custom_tool_call",
            "call_id": "call-a",
            "name": "future_connector",
            "input": { "query": "x" }
        }]
    })]);

    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].id, codex_tool_call_message_id(None, "call-a"));
    assert_eq!(messages[0].id, "flowix:codex:tool-call:unbound:call-a");
}

#[test]
fn cancelled_turn_history_emits_the_same_error_identity_as_live() {
    let messages = app_server_turn_messages(&[json!({
        "id": "turn-cancelled",
        "status": "cancelled",
        "items": []
    })]);

    assert_eq!(messages.len(), 1);
    assert_eq!(
        messages[0].id,
        codex_turn_error_message_id("turn-cancelled")
    );
    assert_eq!(messages[0].content, "Codex turn failed");
}

#[test]
fn restores_initial_goal_command_before_goal_tools_and_hides_internal_context() {
    let internal = r#"<codex_internal_context source="goal">
<objective>
Analyze the project briefly
</objective>
Budget:
- Tokens used: 0
</codex_internal_context>"#;
    let messages = app_server_turn_messages(&[json!({
        "id": "turn-goal",
        "startedAt": 1_730_910_000,
        "status": "completed",
        "items": [
            { "id": "goal-context", "type": "userMessage", "content": internal },
            {
                "id": "exec-1",
                "type": "commandExecution",
                "command": "rg --files",
                "aggregatedOutput": "Cargo.toml",
                "status": "completed"
            },
            {
                "id": "goal-complete",
                "type": "dynamicToolCall",
                "tool": "update_goal",
                "result": { "status": "complete" },
                "status": "completed"
            },
            { "id": "answer-1", "type": "agentMessage", "text": "Done" }
        ]
    })]);

    assert_eq!(messages.len(), 4);
    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[0].content, "/goal Analyze the project briefly");
    assert_eq!(
        messages[0].message_type.as_deref(),
        Some(CODEX_COMMAND_MESSAGE_TYPE)
    );
    assert_eq!(messages[0].codex_turn_id.as_deref(), Some("turn-goal"));
    assert_eq!(messages[1].tool_name.as_deref(), Some("command_execution"));
    assert_eq!(messages[2].tool_name.as_deref(), Some("dynamic_tool_call"));
    assert_eq!(messages[3].role, "assistant");
    assert!(messages
        .iter()
        .all(|message| !message.content.contains("codex_internal_context")));
}

#[test]
fn restores_goal_from_goal_metadata_when_turn_history_omits_user_context() {
    let mut turns = vec![json!({
        "id": "turn-goal",
        "startedAt": 1_789_222_779,
        "status": "completed",
        "items": [
            { "id": "reason-1", "type": "reasoning", "summary": [], "content": [] },
            {
                "id": "exec-1",
                "type": "commandExecution",
                "aggregatedOutput": "result",
                "status": "completed"
            },
            { "id": "answer-1", "type": "agentMessage", "text": "Done" }
        ]
    })];
    annotate_goal_turn(
        &mut turns,
        &json!({
            "goal": {
                "objective": "分析项目，简要即可",
                "status": "complete",
                "createdAt": 1_789_222_779
            }
        }),
    );

    let messages = app_server_turn_messages(&turns);
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[0].content, "/goal 分析项目，简要即可");
    assert_eq!(messages[0].codex_turn_id.as_deref(), Some("turn-goal"));
    assert_eq!(messages[1].role, "tool");
    assert_eq!(messages[2].role, "assistant");
}

#[test]
fn attaches_an_edited_goal_to_the_turn_containing_updated_at() {
    let mut turns = vec![
        json!({
            "id": "turn-original-goal",
            "startedAt": 1_789_222_779_i64,
            "completedAt": 1_789_222_825_i64,
            "items": [{ "id": "old-answer", "type": "agentMessage", "text": "Old" }]
        }),
        json!({
            "id": "turn-edited-goal",
            "startedAt": 1_789_223_553_i64,
            "completedAt": 1_789_223_586_i64,
            "items": [{ "id": "new-answer", "type": "agentMessage", "text": "New" }]
        }),
    ];
    annotate_goal_turn(
        &mut turns,
        &json!({
            "goal": {
                "objective": "你好",
                "createdAt": 1_789_222_779_i64,
                "updatedAt": 1_789_223_578_i64
            }
        }),
    );

    let messages = app_server_turn_messages(&turns);
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[0].content, "Old");
    assert_eq!(messages[1].content, "/goal 你好");
    assert_eq!(
        messages[1].codex_turn_id.as_deref(),
        Some("turn-edited-goal")
    );
    assert_eq!(messages[2].content, "New");
}

#[test]
fn does_not_attach_stale_goal_metadata_to_an_unrelated_turn() {
    let mut turns = vec![json!({
        "id": "turn-later",
        "startedAt": 1_789_222_900_i64,
        "items": [{ "id": "answer-1", "type": "agentMessage", "text": "Later" }]
    })];
    annotate_goal_turn(
        &mut turns,
        &json!({ "goal": { "objective": "Old goal", "createdAt": 1_789_222_779_i64 } }),
    );

    let messages = app_server_turn_messages(&turns);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].content, "Later");
}

#[test]
fn does_not_synthesize_a_goal_command_when_codex_has_no_current_goal() {
    let mut turns = vec![json!({
        "id": "turn-1",
        "startedAt": 1_789_222_779_i64,
        "items": [{ "id": "answer-1", "type": "agentMessage", "text": "Done" }]
    })];
    annotate_goal_turn(&mut turns, &json!({ "goal": null }));

    let messages = app_server_turn_messages(&turns);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].role, "assistant");
    assert_eq!(messages[0].content, "Done");
}

#[test]
fn does_not_duplicate_goal_command_for_continuation_turns() {
    let messages = app_server_turn_messages(&[json!({
        "id": "turn-goal-continuation",
        "startedAt": 1_730_910_000,
        "status": "completed",
        "items": [
            {
                "id": "goal-context",
                "type": "userMessage",
                "content": "<codex_internal_context source=\"goal\">\n<objective>Ship it</objective>\n- Tokens used: 120\n</codex_internal_context>"
            },
            { "id": "answer-1", "type": "agentMessage", "text": "Continuing" }
        ]
    })]);

    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].role, "assistant");
}

#[test]
fn does_not_restore_automatic_compaction_as_a_user_command() {
    let messages = app_server_turn_messages(&[json!({
        "id": "turn-auto-compact",
        "startedAt": 1_730_910_000,
        "status": "completed",
        "items": [
            {
                "id": "user-1",
                "type": "userMessage",
                "content": "Continue"
            },
            {
                "id": "compaction-1",
                "type": "contextCompaction"
            },
            {
                "id": "assistant-1",
                "type": "agentMessage",
                "text": "Done"
            }
        ]
    })]);

    assert_eq!(messages.len(), 3);
    assert!(messages
        .iter()
        .all(|message| message.message_type.as_deref() != Some(CODEX_COMMAND_MESSAGE_TYPE)));
    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[1].role, "system");
    assert_eq!(messages[2].role, "assistant");
}

#[test]
fn gives_tool_lifecycle_events_the_provider_item_identity() {
    let metadata = item_metadata(&json!({
        "id": "call-1",
        "type": "commandExecution"
    }));
    assert_eq!(metadata.message_id.as_deref(), Some("call-1"));
    assert_eq!(metadata.source_message_id.as_deref(), Some("call-1"));
}

#[test]
fn projects_completed_agent_message_as_authoritative_snapshot() {
    let (chunk, metadata) = completed_message_chunk(
        "thread-1",
        &json!({ "id": "message-1", "type": "agentMessage", "text": "Final answer" }),
        None,
    )
    .expect("completed agent message");

    assert!(matches!(
        chunk,
        AgentChunk::Text { thread_id, text }
            if thread_id == "thread-1" && text == "Final answer"
    ));
    assert_eq!(metadata.message_id.as_deref(), Some("message-1"));
    assert_eq!(metadata.source_message_id.as_deref(), Some("message-1"));
    assert_eq!(metadata.message_phase.as_deref(), Some("completed"));
    assert_eq!(metadata.content_mode.as_deref(), Some("snapshot"));
}

#[tokio::test]
async fn preserves_distinct_identical_idless_agent_items_and_suppresses_terminal_replay() {
    let messages = Arc::new(Mutex::new(Vec::new()));
    let first = json!({ "type": "agentMessage", "text": "Final answer" });
    let second = json!({ "type": "agentMessage", "text": "Final answer" });
    let mut first_metadata = AgentChunkMetadata::default();
    let mut second_metadata = AgentChunkMetadata::default();
    let first_should_emit = should_emit_completed_agent_message(
        &messages,
        &first,
        Some("turn-1"),
        None,
        &mut first_metadata,
    )
    .await;
    let second_should_emit = should_emit_completed_agent_message(
        &messages,
        &second,
        Some("turn-1"),
        None,
        &mut second_metadata,
    )
    .await;

    assert!(first_should_emit);
    assert_eq!(
        first_metadata.message_id.as_deref(),
        Some(codex_fallback_item_message_id("turn-1", "assistant", "Final answer", 0).as_str())
    );
    assert!(second_should_emit);
    assert_eq!(
        second_metadata.message_id.as_deref(),
        Some(codex_fallback_item_message_id("turn-1", "assistant", "Final answer", 1).as_str())
    );

    let history = app_server_turn_messages(&[json!({
        "id": "turn-1",
        "status": "completed",
        "items": [first.clone(), second.clone()]
    })]);
    assert_eq!(
        history
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        [
            first_metadata.message_id.as_deref().unwrap(),
            second_metadata.message_id.as_deref().unwrap(),
        ]
    );

    let partial_stream = Arc::new(Mutex::new(Vec::new()));
    let mut partial_metadata = AgentChunkMetadata::default();
    assert!(
        should_emit_completed_agent_message(
            &partial_stream,
            &first,
            Some("turn-1"),
            None,
            &mut partial_metadata,
        )
        .await
    );
    let mut terminal_second_metadata = AgentChunkMetadata::default();
    assert!(
        should_emit_completed_agent_message(
            &partial_stream,
            &second,
            Some("turn-1"),
            Some(1),
            &mut terminal_second_metadata,
        )
        .await
    );
    assert_eq!(
        terminal_second_metadata.message_id.as_deref(),
        Some(codex_fallback_item_message_id("turn-1", "assistant", "Final answer", 1).as_str())
    );

    let mut terminal_metadata = AgentChunkMetadata::default();
    assert!(
        !should_emit_completed_agent_message(
            &messages,
            &second,
            Some("turn-1"),
            Some(1),
            &mut terminal_metadata,
        )
        .await
    );
}

#[tokio::test]
async fn uses_terminal_item_order_for_an_unseen_idless_snapshot() {
    let items = vec![
        json!({ "type": "agentMessage", "text": "Repeated", "status": "completed" }),
        json!({ "type": "agentMessage", "text": "Repeated", "status": "completed" }),
    ];
    let occurrence = codex_fallback_agent_message_occurrence(&items, 1, "completed");
    assert_eq!(occurrence, 1);

    let mut metadata = AgentChunkMetadata::default();
    let should_emit = should_emit_completed_agent_message(
        &Arc::new(Mutex::new(Vec::new())),
        &items[1],
        Some("turn-1"),
        Some(occurrence),
        &mut metadata,
    )
    .await;
    assert!(should_emit);
    assert_eq!(
        metadata.message_id.as_deref(),
        Some(codex_fallback_item_message_id("turn-1", "assistant", "Repeated", 1).as_str())
    );
}

#[tokio::test]
async fn does_not_mark_an_empty_agent_snapshot_as_completed() {
    let messages = Arc::new(Mutex::new(Vec::new()));
    let empty = json!({
        "id": "message-1",
        "type": "agentMessage",
        "text": ""
    });
    let complete = json!({
        "id": "message-1",
        "type": "agentMessage",
        "text": "Final answer"
    });

    let mut metadata = AgentChunkMetadata::default();
    assert!(
        should_emit_completed_agent_message(
            &messages,
            &empty,
            Some("turn-1"),
            None,
            &mut metadata,
        )
        .await
    );
    assert!(
        should_emit_completed_agent_message(
            &messages,
            &complete,
            Some("turn-1"),
            None,
            &mut metadata,
        )
        .await
    );
    assert!(
        !should_emit_completed_agent_message(
            &messages,
            &complete,
            Some("turn-1"),
            None,
            &mut metadata,
        )
        .await
    );
}

#[test]
fn projects_completed_user_message_content_from_codex_item() {
    let item = json!({
        "id": "user-item-1",
        "type": "userMessage",
        "content": [{ "type": "text", "text": "Inspect this file" }]
    });
    let (chunk, metadata) = completed_message_chunk("thread-1", &item, Some("turn-1"))
        .expect("completed user message");

    assert!(matches!(
        chunk,
        AgentChunk::UserMessage { thread_id, id, text, .. }
            if thread_id == "thread-1" && id == "user-item-1" && text == "Inspect this file"
    ));
    assert_eq!(metadata.message_id.as_deref(), Some("user-item-1"));
    assert_eq!(metadata.codex_turn_id.as_deref(), Some("turn-1"));
    assert_eq!(metadata.message_phase.as_deref(), Some("completed"));
    assert_eq!(metadata.content_mode.as_deref(), Some("snapshot"));
}

#[test]
fn suppresses_codex_native_command_echoes_but_keeps_regular_user_messages() {
    for command in ["/compact", "/GOAL", "/goal set ship it", "/goal clear"] {
        assert!(
            app_server_item_message(
                &json!({
                    "id": "command-echo",
                    "type": "userMessage",
                    "content": command
                }),
                "2026-01-01T00:00:00Z",
                0,
                0,
                Some("turn-1"),
            )
            .is_none(),
            "expected native command echo to be hidden: {command}"
        );
    }

    let message = app_server_item_message(
        &json!({
            "id": "regular-user",
            "type": "userMessage",
            "content": [{ "type": "text", "text": "/goal-oriented review" }]
        }),
        "2026-01-01T00:00:00Z",
        0,
        0,
        Some("turn-1"),
    )
    .expect("regular user message");
    assert_eq!(message.role, "user");
    assert_eq!(message.content, "/goal-oriented review");
}

#[test]
fn recognizes_only_the_native_compact_command() {
    assert!(is_codex_compact_command(" /COMPACT "));
    assert!(!is_codex_compact_command("/compact now"));
    assert!(!is_codex_compact_command("/compactly"));
}

#[test]
fn recognizes_goal_mutations_that_start_autonomous_work() {
    for command in [
        "/goal set ship it",
        "/goal edit ship it",
        "/goal pause",
        "/goal resume",
        "/GOAL SET ship it",
    ] {
        assert!(
            is_codex_goal_mutation_command(command),
            "expected goal mutation to await provider turn: {command}"
        );
    }
    for command in ["/goal", "/goal get", "/goal clear", "/goal-oriented review"] {
        assert!(
            !is_codex_goal_mutation_command(command),
            "expected synchronous/non-native goal command: {command}"
        );
    }
}

#[test]
fn formats_native_goal_operation_results_without_exposing_raw_json() {
    assert_eq!(
        codex_command_result_text(
            "/goal",
            &json!({
                "goal": {
                    "objective": "Ship the command lifecycle",
                    "status": "active"
                }
            }),
        )
        .as_deref(),
        Some("Ship the command lifecycle (active)")
    );
    assert_eq!(
        codex_command_result_text("/goal clear", &json!({ "cleared": true })).as_deref(),
        Some("No Codex goal is currently set")
    );
}

#[test]
fn projects_completed_context_compaction_with_stable_identity() {
    let (chunk, metadata) = completed_message_chunk(
        "thread-1",
        &json!({ "id": "compaction-1", "type": "contextCompaction" }),
        Some("turn-1"),
    )
    .expect("completed context compaction");

    assert!(matches!(
        chunk,
        AgentChunk::ContextCompaction { thread_id, id }
            if thread_id == "thread-1" && id == "compaction-1"
    ));
    assert_eq!(metadata.message_id.as_deref(), Some("compaction-1"));
    assert_eq!(metadata.codex_turn_id.as_deref(), Some("turn-1"));
    assert_eq!(metadata.message_phase.as_deref(), Some("completed"));
}

#[test]
fn context_compaction_without_provider_ids_uses_shared_fallback_identity() {
    for turn_id in [None, Some("")] {
        let (chunk, metadata) = completed_message_chunk(
            "thread-1",
            &json!({ "type": "contextCompaction" }),
            turn_id,
        )
        .expect("completed context compaction");

        assert!(matches!(
            chunk,
            AgentChunk::ContextCompaction { id, .. }
                if id == "codex-context-compaction"
        ));
        assert!(metadata.message_id.is_none());
    }
}

#[test]
fn projects_completed_reasoning_summary_as_authoritative_snapshot() {
    let (chunk, metadata) = completed_message_chunk(
        "thread-1",
        &json!({
            "id": "reasoning-1",
            "type": "reasoning",
            "summary": [{ "type": "text", "text": "Final reasoning" }],
            "content": [{ "type": "text", "text": "Hidden detail" }]
        }),
        None,
    )
    .expect("completed reasoning");

    assert!(matches!(
        chunk,
        AgentChunk::Reasoning { thread_id, text }
            if thread_id == "thread-1" && text == "Final reasoning"
    ));
    assert_eq!(metadata.message_phase.as_deref(), Some("completed"));
    assert_eq!(metadata.content_mode.as_deref(), Some("snapshot"));
}

#[test]
fn turn_scoped_notifications_require_turn_id() {
    assert!(turn_scoped_notification("item/started"));
    assert!(turn_scoped_notification("item/completed"));
    assert!(turn_scoped_notification("turn/completed"));
    assert!(!turn_scoped_notification("thread/status/changed"));
}

#[test]
fn client_messages_omit_the_optional_jsonrpc_header() {
    let message = json!({
        "id": 1,
        "method": "initialize",
        "params": { "clientInfo": { "name": "flowix", "version": "1" } }
    });
    assert!(message.get("jsonrpc").is_none());
}

#[test]
fn projects_app_server_history_without_persisting_it() {
    let thread = json!({
        "turns": [{
            "id": "turn-1",
            "startedAt": 1_730_910_000,
            "durationMs": 69078,
            "items": [
                { "id": "u1", "type": "userMessage", "content": [{ "type": "text", "text": "Hello" }] },
                { "id": "a1", "type": "agentMessage", "text": "Hi" },
                { "id": "r1", "type": "reasoning", "summary": ["Plan"] },
                { "id": "c1", "type": "commandExecution", "command": "git status", "status": "completed", "aggregatedOutput": "clean" }
            ]
        }]
    });

    let messages = app_server_turn_messages(
        thread
            .get("turns")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default(),
    );
    assert_eq!(messages.len(), 4);
    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[0].content, "Hello");
    assert_eq!(messages[1].role, "assistant");
    assert_eq!(messages[1].turn_duration_ms, Some(69078));
    assert_eq!(messages[2].reasoning.as_deref(), Some("Plan"));
    assert_eq!(messages[3].tool_name.as_deref(), Some("command_execution"));
    assert_eq!(
        messages[3]
            .tool_input
            .as_ref()
            .and_then(|input| input.get("command")),
        Some(&json!("git status")),
    );
    assert!(messages[3].tool_data.is_some());
}

#[test]
fn preserves_interleaved_app_server_item_order() {
    let thread = json!({
        "turns": [{
            "startedAt": 1_730_910_000,
            "items": [
                { "id": "a1", "type": "agentMessage", "text": "I will inspect this." },
                { "id": "c1", "type": "commandExecution", "command": "pwd", "status": "completed" },
                { "id": "a2", "type": "agentMessage", "text": "The result is ..." }
            ]
        }]
    });

    let messages = app_server_turn_messages(
        thread
            .get("turns")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default(),
    );

    assert_eq!(
        messages
            .iter()
            .map(|message| message.role.as_str())
            .collect::<Vec<_>>(),
        ["assistant", "tool", "assistant"],
    );
    assert_eq!(messages[1].id, "c1");
}

#[test]
fn projects_failed_turn_errors_from_app_server_history() {
    let turns = vec![json!({
        "id": "turn-1",
        "startedAt": 1_730_910_000,
        "status": "failed",
        "error": { "message": "rate limit exceeded" },
        "items": [{ "id": "u1", "type": "userMessage", "content": [{ "type": "text", "text": "Hello" }] }]
    })];

    let messages = app_server_turn_messages(&turns);
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1].role, "assistant");
    assert_eq!(messages[1].content, "rate limit exceeded");
    assert_eq!(messages[1].id, codex_turn_error_message_id("turn-1"));
    assert!(messages[1].error_details.is_some());
}

#[test]
fn live_turn_error_metadata_uses_the_history_identity() {
    let metadata = codex_turn_error_metadata(Some("turn-1"));
    let expected_id = codex_turn_error_message_id("turn-1");

    assert_eq!(metadata.codex_turn_id.as_deref(), Some("turn-1"));
    assert_eq!(metadata.message_id.as_deref(), Some(expected_id.as_str()));
}

#[test]
fn keeps_tool_items_and_interruption_with_their_own_turn() {
    let turns = vec![
        json!({
            "id": "turn-1",
            "startedAt": 1_730_910_000,
            "status": "interrupted",
            "items": [
                { "id": "u1", "type": "userMessage", "content": [{ "type": "text", "text": "Inspect it" }] },
                { "id": "a1", "type": "agentMessage", "text": "Checking." },
                { "id": "tool-1", "type": "commandExecution", "command": "pwd", "status": "completed", "aggregatedOutput": "/workspace" }
            ]
        }),
        json!({
            "id": "turn-2",
            "startedAt": 1_730_911_000,
            "status": "completed",
            "items": [
                { "id": "u2", "type": "userMessage", "content": [{ "type": "text", "text": "Next" }] },
                { "id": "a2", "type": "agentMessage", "text": "Done." }
            ]
        }),
    ];

    let messages = app_server_turn_messages(&turns);
    assert_eq!(
        messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        [
            "u1",
            "a1",
            "tool-1",
            "msg:codex:turn-error:turn-1",
            "u2",
            "a2"
        ],
    );
    assert_eq!(messages[2].role, "tool");
    assert_eq!(messages[3].content, "Codex turn interrupted");
}

#[test]
fn omits_unfinished_assistant_items_from_interrupted_turn_history() {
    let turns = vec![json!({
        "id": "turn-interrupted",
        "startedAt": 1_730_910_000,
        "status": "interrupted",
        "items": [
            { "id": "u1", "type": "userMessage", "content": [{ "type": "text", "text": "Inspect" }] },
            { "id": "draft", "type": "agentMessage", "status": "inProgress", "text": "unfinished" },
            { "id": "answer", "type": "agentMessage", "status": "completed", "text": "Completed before stop" }
        ]
    })];

    let messages = app_server_turn_messages(&turns);
    assert_eq!(
        messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        ["u1", "answer", "msg:codex:turn-error:turn-interrupted"],
    );
    assert_eq!(messages[1].content, "Completed before stop");
    assert_eq!(messages[1].is_completed, Some(true));
}

#[test]
fn history_fallback_ids_ignore_omitted_interrupted_items() {
    let items = vec![
        json!({ "type": "agentMessage", "status": "inProgress", "text": "Repeated" }),
        json!({ "type": "agentMessage", "status": "completed", "text": "Repeated" }),
    ];
    let turn_id = "turn-interrupted";
    let occurrence = codex_fallback_agent_message_occurrence(&items, 1, "interrupted");
    let history = app_server_turn_messages(&[json!({
        "id": turn_id,
        "status": "interrupted",
        "items": items
    })]);
    let assistant = history
        .iter()
        .find(|message| message.role == "assistant")
        .expect("completed assistant message");

    assert_eq!(occurrence, 0);
    assert_eq!(
        assistant.id,
        codex_fallback_item_message_id(turn_id, "assistant", "Repeated", occurrence)
    );
}

#[test]
fn pages_projected_history_on_complete_turn_boundaries() {
    let turns = (0..3)
        .map(|index| json!({
            "id": format!("turn-{index}"),
            "startedAt": 1_730_911_000 + index,
            "status": "completed",
            "items": [
                { "id": format!("u{index}"), "type": "userMessage", "content": format!("Q{index}") },
                { "id": format!("a{index}"), "type": "agentMessage", "text": format!("A{index}") }
            ]
        }))
        .collect::<Vec<_>>();
    let page = paginate_app_server_turns(&turns, None, None, 2);
    assert_eq!(page.messages.len(), 4);
    assert_eq!(page.messages[0].id, "u1");
    assert_eq!(page.oldest_sequence, Some(1));
    assert_eq!(page.snapshot_sequence, Some(3));
    assert!(page.has_more);

    let older = paginate_app_server_turns(
        &[
            turns,
            vec![json!({
                "id": "turn-3",
                "startedAt": 1_730_911_003,
                "status": "completed",
                "items": [{ "id": "u3", "type": "userMessage", "content": "new" }]
            })],
        ]
        .concat(),
        page.oldest_sequence,
        page.snapshot_sequence,
        2,
    );
    assert_eq!(
        older
            .messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        ["u0", "a0"]
    );
    assert_eq!(older.snapshot_sequence, Some(3));
}

#[test]
fn ordinary_chat_waits_for_its_start_response_before_routing_events() {
    assert_eq!(
        unbound_notification_action(TurnBinding::StartResponse, "turn/started", true),
        UnboundNotificationAction::Buffer
    );
    assert_eq!(
        unbound_notification_action(
            TurnBinding::StartResponse,
            "item/agentMessage/delta",
            true,
        ),
        UnboundNotificationAction::Buffer
    );
    assert_eq!(
        unbound_notification_action(
            TurnBinding::StartResponse,
            "thread/tokenUsage/updated",
            true,
        ),
        UnboundNotificationAction::Ignore
    );
}

#[test]
fn asynchronous_commands_bind_only_from_turn_started() {
    assert_eq!(
        unbound_notification_action(TurnBinding::StartedNotification, "turn/started", true,),
        UnboundNotificationAction::Bind
    );
    assert_eq!(
        unbound_notification_action(TurnBinding::StartedNotification, "item/completed", true,),
        UnboundNotificationAction::Buffer
    );
    assert_eq!(
        unbound_notification_action(TurnBinding::StartedNotification, "turn/started", false,),
        UnboundNotificationAction::Ignore
    );
}
