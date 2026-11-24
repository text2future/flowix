//! `runtime` 的回归测试。
//!
//! 断言集中在三处容易出错的地方：工具集随权限模式变化、Cloud 凭据刷新只跑一次、
//! 历史分页用的是 Pi 的原生 entry 游标而不是自造的消息 id。

use super::{
    attach_pi_session_message_ids, pi_active_branch_entries, pi_rpc_message_id,
    pi_tools_for_permission_mode, receive_rpc_response, run_startup_cloud_credential_refresh_once,
    run_startup_cloud_refresh_once, CloudRefreshResults,
};
use crate::agent_external::pi::shell::{PiCapabilities, ShellKind};
use serde_json::json;

fn capabilities(shell: ShellKind, ripgrep: bool, fd: bool) -> PiCapabilities {
    PiCapabilities { shell, ripgrep, fd }
}

#[test]
fn full_access_asks_for_the_platform_shell_tool() {
    let bash = pi_tools_for_permission_mode(
        Some("danger-full-access"),
        capabilities(ShellKind::Bash, false, false),
    );
    assert!(bash.split(',').any(|tool| tool == "bash"), "{bash}");

    let powershell = pi_tools_for_permission_mode(
        Some("danger-full-access"),
        capabilities(ShellKind::PowerShell, false, false),
    );
    assert!(powershell.split(',').any(|tool| tool == "powershell"));
    assert!(!powershell.split(',').any(|tool| tool == "bash"));

    let shellless = pi_tools_for_permission_mode(None, capabilities(ShellKind::None, false, false));
    assert!(!shellless.split(',').any(|tool| tool == "bash"));
    assert!(!shellless.split(',').any(|tool| tool == "powershell"));
}

#[test]
fn read_only_mode_stays_useful_without_a_shell() {
    let tools =
        pi_tools_for_permission_mode(Some("read-only"), capabilities(ShellKind::Bash, true, true));
    let parsed: Vec<&str> = tools.split(',').collect();
    assert_eq!(parsed, vec!["read", "ls", "grep", "find"]);
}

#[test]
fn search_tools_are_omitted_when_rg_and_fd_are_missing() {
    let tools = pi_tools_for_permission_mode(
        Some("read-only"),
        capabilities(ShellKind::Bash, false, false),
    );
    assert_eq!(tools, "read,ls");
    // Pi's grep/find try to download from GitHub when the binary is absent,
    // so a partial availability must be handled per tool.
    let partial = pi_tools_for_permission_mode(
        Some("read-only"),
        capabilities(ShellKind::Bash, true, false),
    );
    assert_eq!(partial, "read,ls,grep");
}

#[test]
fn write_modes_keep_the_edit_tools_and_drop_the_shell_when_unavailable() {
    let write = pi_tools_for_permission_mode(
        Some("workspace-write"),
        capabilities(ShellKind::Bash, false, false),
    );
    assert_eq!(write, "read,ls,edit,write");
    let legacy = pi_tools_for_permission_mode(None, capabilities(ShellKind::None, false, false));
    assert_eq!(legacy, "read,ls,edit,write");
}

#[tokio::test]
async fn startup_cloud_refresh_coalesces_failures_and_allows_retry() {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::sync::Mutex;

    let results = Arc::new(Mutex::new(HashMap::new()));
    let refresh_count = Arc::new(AtomicUsize::new(0));
    let run = |results: Arc<Mutex<CloudRefreshResults>>, refresh_count: Arc<AtomicUsize>| async move {
        run_startup_cloud_refresh_once(&results, 7, || async move {
            refresh_count.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Err("credential refresh failed".to_string())
        })
        .await
    };

    let (first, concurrent) = tokio::join!(
        run(results.clone(), refresh_count.clone()),
        run(results.clone(), refresh_count.clone()),
    );
    assert_eq!(first, Err("credential refresh failed".to_string()));
    assert_eq!(concurrent, Err("credential refresh failed".to_string()));
    assert_eq!(refresh_count.load(Ordering::SeqCst), 1);

    let cached = run_startup_cloud_refresh_once(&results, 7, || async { Ok(true) }).await;
    assert_eq!(cached, Err("credential refresh failed".to_string()));
    assert_eq!(refresh_count.load(Ordering::SeqCst), 1);

    results.lock().await.get_mut(&7).unwrap().0 -= std::time::Duration::from_secs(3);
    let retried = run_startup_cloud_refresh_once(&results, 7, || async { Ok(true) }).await;
    assert_eq!(retried, Ok(true));

    let next_generation = run_startup_cloud_refresh_once(&results, 8, || async { Ok(true) }).await;
    assert_eq!(next_generation, Ok(true));
}

#[tokio::test]
async fn startup_cloud_refresh_fetches_latest_catalog_once_even_if_credential_is_cached() {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::sync::Mutex;

    let results = Mutex::new(HashMap::new());
    let credential_generation = Mutex::new(Some(7));
    let refresh_count = Arc::new(AtomicUsize::new(0));
    let count = refresh_count.clone();
    let refreshed = run_startup_cloud_credential_refresh_once(
        &results,
        &credential_generation,
        7,
        || async move {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
    )
    .await;
    assert_eq!(refreshed, Ok(true));
    assert_eq!(refresh_count.load(Ordering::SeqCst), 1);

    let count = refresh_count.clone();
    let coalesced = run_startup_cloud_credential_refresh_once(
        &results,
        &credential_generation,
        7,
        || async move {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
    )
    .await;
    assert_eq!(coalesced, Ok(true));
    assert_eq!(refresh_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn stderr_is_visible_before_eof_and_keeps_only_a_bounded_tail() {
    use std::sync::Arc;
    use tokio::io::AsyncWriteExt;
    use tokio::sync::Mutex;
    let (mut writer, reader) = tokio::io::duplex(4096);
    let captured = Arc::new(Mutex::new(String::new()));
    let task = tokio::spawn(super::capture_pi_stderr(reader, captured.clone()));
    writer.write_all(b"startup diagnostic").await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            if captured.lock().await.contains("startup diagnostic") {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(
        !task.is_finished(),
        "diagnostics must be visible before EOF"
    );
    writer
        .write_all(&vec![b'x'; super::PI_STDERR_TAIL_BYTES * 2])
        .await
        .unwrap();
    writer.write_all("最新错误".as_bytes()).await.unwrap();
    drop(writer);
    task.await.unwrap().unwrap();
    let text = captured.lock().await;
    assert!(text.ends_with("最新错误"));
    assert!(text.len() <= super::PI_STDERR_TAIL_BYTES);
    assert!(!text.contains("startup diagnostic"));
}
#[tokio::test]
async fn pi_queue_rebuild_keeps_duplicate_message_attachments_with_the_right_item() {
    use super::{known_pi_queue_payloads, pi_queue_target_index, ActivePiRun, PiQueuedMessage};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, AtomicI64};
    use std::sync::Arc;
    use tokio::sync::{Mutex, Notify};

    let first = PiQueuedMessage {
        command_type: "follow_up",
        payload: json!({"message":"same text","images":[{"data":"first"}]}),
        sequence: 1,
        display_text: "first".into(),
        attachments: Vec::new(),
    };
    let second = PiQueuedMessage {
        command_type: "follow_up",
        payload: json!({"message":"same text","images":[{"data":"second"}]}),
        sequence: 2,
        display_text: "second".into(),
        attachments: Vec::new(),
    };
    let active = ActivePiRun {
        run_id: "test".into(),
        started_at: 0,
        session: Mutex::new(None),
        session_state: tokio::sync::watch::channel(None).0,
        session_id: Mutex::new(None),
        queued_messages: Mutex::new(HashMap::from([
            ("first".into(), first.clone()),
            ("second".into(), second.clone()),
        ])),
        queue_lock: Mutex::new(()),
        stop_notify: Notify::new(),
        last_event_at: AtomicI64::new(0),
        stop_reason: Mutex::new(None),
        finalizing: AtomicBool::new(false),
        stream_end_emitted: Arc::new(AtomicBool::new(false)),
    };
    let texts = vec!["same text".to_string(), "same text".to_string()];
    assert_eq!(
        pi_queue_target_index(&active, &texts, &second).await,
        Some(1)
    );
    let mut known =
        known_pi_queue_payloads(&active, &[], &["same text".to_string()], Some("first")).await;
    let payloads = super::queued_payloads("follow_up", &["same text".to_string()], &mut known);
    assert_eq!(payloads[0]["images"][0]["data"], "second");
    let delivered = active.take_queued_user_message("same text").await.unwrap();
    assert_eq!(delivered.client_message_id.as_deref(), Some("first"));
    assert_eq!(delivered.text, "first");
    assert_eq!(
        super::pi_user_message_text(&json!({
            "role": "user",
            "content": [{"type": "text", "text": "same text"}]
        })),
        "same text"
    );
}

#[tokio::test]
async fn pi_rpc_accepts_frames_larger_than_the_shared_512_kib_limit() {
    let expected =
        json!({"type":"response","data":{"messages":[{"content":"文本".repeat(150_000)}]}});
    let mut bytes = serde_json::to_vec(&expected).unwrap();
    assert!(bytes.len() > 512 * 1024);
    bytes.extend_from_slice(b"\n{\"type\":\"next\"}\n");
    let mut reader = tokio::io::BufReader::new(bytes.as_slice());
    assert_eq!(
        super::read_pi_rpc_record(&mut reader).await.unwrap(),
        Some(expected)
    );
    assert_eq!(
        super::read_pi_rpc_record(&mut reader).await.unwrap(),
        Some(json!({"type":"next"}))
    );
    assert!(super::read_pi_rpc_record(&mut reader)
        .await
        .unwrap()
        .is_none());
}

#[test]
fn pi_backend_pages_complete_turns_using_native_entry_cursors() {
    let snapshot = super::PiSessionSnapshot {
        messages: vec![
            json!({"role":"user","_pi_session_message_id":"u1"}),
            json!({"role":"assistant","_pi_session_message_id":"a1","content":[{"type":"text","text":"before"},{"type":"toolCall","id":"call"},{"type":"text","text":"after"}]}),
            json!({"role":"toolResult","_pi_session_message_id":"r1","toolCallId":"call"}),
            json!({"role":"user","_pi_session_message_id":"u2"}),
            json!({"role":"assistant","_pi_session_message_id":"a2"}),
        ],
        revision: super::PiHistoryRevision {
            session_id: "session".into(),
            append_cursor: Some("a2".into()),
            leaf_id: Some("a2".into()),
        },
    };
    let latest = super::page_pi_snapshot(&snapshot, None, 1).unwrap();
    assert_eq!(latest.messages.len(), 2);
    assert_eq!(latest.before_entry_id.as_deref(), Some("u2"));
    assert_eq!(latest.oldest_sequence, Some(3));
    assert!(latest.has_more);
    let older = super::page_pi_snapshot(&snapshot, latest.before_entry_id.as_deref(), 1).unwrap();
    assert_eq!(older.messages.len(), 3);
    assert_eq!(older.messages[1]["content"].as_array().unwrap().len(), 3);
    assert_eq!(older.messages[2]["toolCallId"], "call");
    assert_eq!(older.before_entry_id.as_deref(), Some("u1"));
    assert!(!older.has_more);
    assert_eq!(older.revision, latest.revision);
    assert_eq!(older.snapshot_sequence, latest.snapshot_sequence);
    assert!(super::page_pi_snapshot(&snapshot, Some("unknown"), 1).is_err());
    let empty = super::page_pi_snapshot(&snapshot, Some("u1"), 1).unwrap();
    assert!(empty.messages.is_empty());
    assert_eq!(empty.before_entry_id, None);
}

#[test]
fn pi_snapshot_exposes_native_revision_without_generating_message_ids() {
    let snapshot = super::PiSessionSnapshot {
        messages: vec![json!({"_pi_session_message_id":"native-entry"})],
        revision: super::PiHistoryRevision {
            session_id: "native-session".into(),
            append_cursor: Some("append-entry".into()),
            leaf_id: Some("branch-leaf".into()),
        },
    };
    let value = serde_json::to_value(snapshot).unwrap();
    assert_eq!(
        value["messages"][0]["_pi_session_message_id"],
        "native-entry"
    );
    assert_eq!(
        value["revision"],
        json!({"sessionId":"native-session","appendCursor":"append-entry","leafId":"branch-leaf"})
    );
}

#[test]
fn pi_incremental_cache_tracks_append_cursor_and_active_branch() {
    let mut cache = super::PiEntriesCache::default();
    let message = json!({"role":"assistant","content":"same"});
    cache.update(
        &[json!({"id":"a","type":"message","parentId":null,"message":message})],
        true,
    );
    cache.update(
        &[json!({"id":"b","type":"message","parentId":null,"message":message})],
        false,
    );
    assert_eq!(cache.entries.last().unwrap()["id"], "b");
    assert_eq!(cache.message_id(Some("a"), &message).unwrap(), "a");
    assert_eq!(cache.message_id(Some("b"), &message).unwrap(), "b");
    cache.update(&[], false);
    assert_eq!(cache.entries.len(), 2);
    cache.update(
        &[json!({"id":"c","type":"message","parentId":null,"message":message})],
        true,
    );
    assert_eq!(cache.entries.len(), 1);
    assert!(cache.message_id(Some("a"), &message).is_err());
}

#[tokio::test]
async fn pi_entries_response_preserves_interleaved_events_in_order() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let events = vec![
        json!({"type":"message_end","message":{"role":"assistant"}}),
        json!({"type":"tool_execution_start","toolCallId":"call-1"}),
        json!({"type":"response","id":"other","success":true}),
        json!({"type":"agent_settled"}),
    ];
    for event in &events {
        tx.send(Ok(event.clone())).unwrap();
    }
    tx.send(Ok(json!({"type":"response","id":"entries","success":true})))
        .unwrap();
    let mut deferred = std::collections::VecDeque::new();
    let response = receive_rpc_response(&mut rx, &mut deferred, "entries")
        .await
        .unwrap();
    assert_eq!(response["id"], "entries");
    assert_eq!(deferred.into_iter().collect::<Vec<_>>(), events);
}

#[test]
fn pi_live_identity_uses_active_rpc_branch_even_for_identical_messages() {
    let message =
        json!({"role":"assistant","content":[{"type":"text","text":"same"}],"timestamp":42});
    let entries = vec![
        json!({"type":"message","id":"active","parentId":null,"message":message}),
        json!({"type":"message","id":"abandoned","parentId":null,"message":message}),
    ];
    assert_eq!(
        pi_rpc_message_id(&entries, Some("active"), &message).unwrap(),
        "active"
    );
    assert!(pi_rpc_message_id(&[], None, &message).is_err());
}

#[test]
fn pi_history_message_ids_follow_the_current_branch_and_exact_messages() {
    let user = json!({
        "role": "user",
        "content": [{"type": "text", "text": "second prompt"}],
        "timestamp": 1791301625351_i64
    });
    let assistant = json!({
        "role": "assistant",
        "content": [{"type": "text", "text": "answer"}],
        "timestamp": 1791301626000_i64,
        "stopReason": "stop"
    });
    let entries = vec![
        json!({"type":"message","id":"u1","parentId":null,"message":user}),
        json!({"type":"message","id":"old-answer","parentId":"u1","message":{"role":"assistant","content":[{"type":"text","text":"abandoned"}],"timestamp":1791301626000_i64}}),
        json!({"type":"message","id":"a1","parentId":"u1","message":assistant}),
    ];
    let mut messages = vec![user, assistant];

    attach_pi_session_message_ids(&mut messages, &entries, Some("a1"))
        .expect("reconcile current branch history");

    assert_eq!(messages[0]["_pi_session_message_id"], "u1");
    assert_eq!(messages[1]["_pi_session_message_id"], "a1");
    assert_eq!(messages[1]["_pi_session_parent_id"], "u1");
    let branch = pi_active_branch_entries(&entries, Some("a1")).expect("resolve active branch");
    assert_eq!(
        branch
            .iter()
            .map(|entry| entry["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["u1", "a1"]
    );
}

#[test]
fn pi_history_does_not_silently_accept_unmatched_renderable_messages() {
    let mut messages = vec![json!({
        "role": "assistant",
        "content": [{"type": "text", "text": "answer"}],
        "timestamp": 10_i64
    })];

    let error = attach_pi_session_message_ids(&mut messages, &[], None)
        .expect_err("history identity mismatch must be surfaced");

    assert!(error.contains("could not be reconciled with native ids"));
}
