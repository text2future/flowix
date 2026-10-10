use super::*;

#[test]
fn recognizes_claude_session_ids() {
    assert!(is_claude_session_id("019ed38f-e9e3-7b61-8be3-80a40788d6e3"));
    assert!(!is_claude_session_id("claude-local-1"));
}

#[test]
fn rejects_local_claude_thread_ids() {
    // 回归 ── 这条字�?串长�?�?32 且含 5 �?dash, 老版宽松规则会�?判为
    // "�?���?session id", �?`claude-local-agent-inst-...` 当真�?UUID
    // 透传�?Claude CLI �?--resume�?CLI �?UUID 严格校验, 报错:
    // "Provided value ... is not a UUID and does not match any session
    // title"�?�??后必须以 `claude-local-` 前缀直接拒掉�?
    assert!(!is_claude_session_id(
        "claude-local-agent-inst-1783828675847-3"
    ));
    assert!(!is_claude_session_id(
        "claude-local-agent-inst-1783828675847-100"
    ));
    // 空白 + �?��符串 ── 老版意�?匹配�?corner�?
    assert!(!is_claude_session_id(""));
    assert!(!is_claude_session_id("   "));
}

#[test]
fn paginates_claude_messages_backwards_with_stable_sequence_cursors() {
    let messages = (0..5)
        .map(|index| {
            base_message(
                format!("message-{index}"),
                "assistant",
                format!("body {index}"),
                "2026-07-30T00:00:00Z".to_string(),
            )
        })
        .collect::<Vec<_>>();

    let latest = paginate_claude_messages(messages.clone(), None, 2);
    assert_eq!(
        latest
            .messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        vec!["message-3", "message-4"]
    );
    assert_eq!(latest.oldest_sequence, Some(4));
    assert!(latest.has_more);

    let previous = paginate_claude_messages(messages.clone(), latest.oldest_sequence, 2);
    assert_eq!(
        previous
            .messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        vec!["message-1", "message-2"]
    );
    assert_eq!(previous.oldest_sequence, Some(2));
    assert!(previous.has_more);

    let oldest = paginate_claude_messages(messages, previous.oldest_sequence, 2);
    assert_eq!(oldest.messages[0].id, "message-0");
    assert_eq!(oldest.oldest_sequence, Some(1));
    assert!(!oldest.has_more);
}

#[test]
fn maps_assistant_message_to_chat_message() {
    let value = serde_json::json!({
        "type": "assistant",
        "timestamp": "2026-06-29T01:00:00Z",
        "message": {
            "role": "assistant",
            "content": [{ "type": "text", "text": "hello" }]
        }
    });
    let messages = value_to_chat_messages("session_1", 0, &value);
    let message = messages.first().expect("message");
    assert_eq!(message.role, "assistant");
    assert_eq!(message.content, "hello");
}

#[test]
fn maps_tool_blocks_to_tool_messages() {
    let assistant = serde_json::json!({
        "type": "assistant",
        "timestamp": "2026-06-29T01:00:00Z",
        "message": {
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": "toolu_1",
                "name": "Read",
                "input": { "file_path": "README.md" }
            }]
        }
    });
    let messages = value_to_chat_messages("session_1", 0, &assistant);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].role, "tool");
    assert_eq!(messages[0].tool_call_id.as_deref(), Some("toolu_1"));
    assert_eq!(messages[0].tool_name.as_deref(), Some("Read"));
    assert_eq!(
        messages[0]
            .tool_input
            .as_ref()
            .and_then(|v| v.get("file_path")),
        Some(&serde_json::json!("README.md"))
    );

    let user = serde_json::json!({
        "type": "user",
        "timestamp": "2026-06-29T01:00:01Z",
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": "toolu_1",
                "content": "file contents"
            }]
        }
    });
    let messages = value_to_chat_messages("session_1", 1, &user);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].role, "tool");
    assert_eq!(messages[0].tool_call_id.as_deref(), Some("toolu_1"));
    assert_eq!(messages[0].tool_name.as_deref(), Some("tool_result"));
    assert!(messages[0].content.contains("file contents"));
    assert_eq!(messages[0].is_loading, Some(false));
}

#[test]
fn merges_tool_result_into_existing_tool_message() {
    let assistant = serde_json::json!({
        "type": "assistant",
        "timestamp": "2026-06-29T01:00:00Z",
        "message": {
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": "toolu_1",
                "name": "Read",
                "input": { "file_path": "README.md" }
            }]
        }
    });
    let user = serde_json::json!({
        "type": "user",
        "timestamp": "2026-06-29T01:00:01Z",
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": "toolu_1",
                "content": "file contents",
                "is_error": true
            }]
        }
    });

    let mut messages = Vec::new();
    for message in value_to_chat_messages("session_1", 0, &assistant) {
        append_claude_history_message(&mut messages, message);
    }
    for message in value_to_chat_messages("session_1", 1, &user) {
        append_claude_history_message(&mut messages, message);
    }

    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].role, "tool");
    assert_eq!(messages[0].tool_call_id.as_deref(), Some("toolu_1"));
    assert_eq!(messages[0].tool_name.as_deref(), Some("Read"));
    assert!(messages[0].content.contains("file contents"));
    assert!(messages[0].content.contains("is_error"));
    assert_eq!(messages[0].is_loading, Some(false));
}

// `skips_user_text_only_skill_injection_messages` �?    // `skips_user_text_when_mixed_only_with_tool_result` 这两�?��试是
// **有意永久删除**的——它�?��言的块�?`should_skip_user_text_blocks`
// �?��式不再存在于 history.rs。守�?��留与否不影响实际 dev 行为(已实�?,
// 保留守卫时这两条�?��归护�?删除守卫后它�?��反过�?fail,所以一并删除�?    // 若未来重新引入守�?�?`value_to_chat_messages` 内的设�?说明),
// 把这两条测试�?git history 拉回来即�?�?
#[test]
fn skips_meta_user_messages_in_session_history() {
    let user = serde_json::json!({
        "parentUuid": "c4ed80bd-9300-46a7-a454-2849594d41e6",
        "type": "user",
        "message": {
            "role": "user",
            "content": "[Your previous response had no visible output. Please continue.]"
        },
        "isMeta": true,
        "uuid": "7257a401-a054-4807-9f88-27a0ad4b58f7",
        "timestamp": "2026-07-18T14:42:15.285Z"
    });

    let messages = value_to_chat_messages("session_1", 1, &user);
    assert!(messages.is_empty());
}

#[test]
fn shows_sidechain_assistant_messages_in_session_history() {
    // 反向 —isSidechain=true assistant 文本应在历史 thread card 展示�?
    let value = serde_json::json!({
        "type": "assistant",
        "isSidechain": true,
        "timestamp": "2026-07-18T15:00:00Z",
        "message": {
            "role": "assistant",
            "content": [{ "type": "text", "text": "sub-agent reply" }]
        }
    });
    let messages = value_to_chat_messages("session_1", 2, &value);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].role, "assistant");
    assert_eq!(messages[0].content, "sub-agent reply");
}

#[test]
fn shows_sidechain_user_tool_results_in_session_history() {
    // 反向 —isSidechain=true sub-agent tool_result 应在历史 thread card 展示�?
    let value = serde_json::json!({
        "type": "user",
        "isSidechain": true,
        "timestamp": "2026-07-18T15:00:01Z",
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": "toolu_1",
                "content": "sub-agent tool output"
            }]
        }
    });
    let messages = value_to_chat_messages("session_1", 3, &value);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].role, "tool");
    assert_eq!(messages[0].tool_name.as_deref(), Some("tool_result"));
    assert!(messages[0].content.contains("sub-agent tool output"));
}

#[test]
fn shows_agent_tool_use_in_assistant_history() {
    // 反向 —main agent �?Task 工具(name="Agent")tool_use 应在历史 thread card 展示�?
    let assistant = serde_json::json!({
        "type": "assistant",
        "isSidechain": false,
        "timestamp": "2026-07-18T15:36:31.240Z",
        "message": {
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": "call_e6e37468672748648ccf4b3e",
                "name": "Agent",
                "input": { "description": "Read README.md", "subagent_type": "Explore" }
            }]
        }
    });
    let messages = value_to_chat_messages("session_1", 0, &assistant);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].role, "tool");
    assert_eq!(messages[0].tool_name.as_deref(), Some("Agent"));
    assert_eq!(
        messages[0].tool_call_id.as_deref(),
        Some("call_e6e37468672748648ccf4b3e")
    );
}

#[test]
fn keeps_user_array_text_when_other_block_types_are_present() {
    let user = serde_json::json!({
        "type": "user",
        "timestamp": "2026-06-29T01:00:01Z",
        "message": {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "real user text"
                },
                {
                    "type": "image",
                    "source": { "type": "base64", "media_type": "image/png", "data": "abc" }
                }
            ]
        }
    });

    let messages = value_to_chat_messages("session_1", 1, &user);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[0].content, "real user text");
}

#[test]
fn close_orphan_claude_tool_calls_closes_only_unmatched_uses() {
    // tool_use(call_id=X) merged with its tool_result at the helper layer.
    // tool_use(call_id=Y) without a result 鈥?orphan.
    let mut messages = vec![
        tool_use_msg("X", "Read", false),
        tool_use_msg("Y", "Bash", true),
        tool_result_msg("X", "ok"),
    ];

    close_orphan_claude_tool_calls(&mut messages);

    let by_call: std::collections::HashMap<&str, &ChatMessage> = messages
        .iter()
        .filter_map(|m| m.tool_call_id.as_deref().map(|id| (id, m)))
        .collect();
    // X already had its is_loading set to false by the helper merge.
    assert_eq!(by_call["X"].is_loading, Some(false));
    // Y had no output 鈫?forced to false by the orphan sweeper.
    assert_eq!(by_call["Y"].is_loading, Some(false));
}

#[test]
fn close_orphan_claude_tool_calls_leaves_user_messages_alone() {
    let mut messages = vec![base_message(
        "u".to_string(),
        "user",
        "hi".to_string(),
        "2026-06-29T01:00:00Z".to_string(),
    )];
    close_orphan_claude_tool_calls(&mut messages);
    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[0].is_loading, None);
}

fn tool_use_msg(call_id: &str, name: &str, loading: bool) -> ChatMessage {
    let mut m = base_message(
        format!("claude-tool-{call_id}"),
        "tool",
        String::new(),
        "2026-06-29T01:00:00Z".to_string(),
    );
    m.tool_call_id = Some(call_id.to_string());
    m.tool_name = Some(name.to_string());
    m.is_loading = Some(loading);
    m.tool_input = Some(serde_json::json!({}));
    m
}

fn tool_result_msg(call_id: &str, output: &str) -> ChatMessage {
    let mut m = base_message(
        format!("claude-tool-result-{call_id}"),
        "tool",
        output.to_string(),
        "2026-06-29T01:00:01Z".to_string(),
    );
    m.tool_call_id = Some(call_id.to_string());
    m.tool_name = Some("tool_result".to_string());
    m.tool_data = Some(output.to_string());
    m.is_loading = Some(false);
    m
}

/// 写一�?���?`~/.claude/projects/<encoded>/<sid>.jsonl`, 验证
/// `claude_session_cwd` 能从 `cwd` 字�?读回原�? cwd�?这是
/// "重启产品�?IPC 入参 cwd 为空, 后�?兜底�?session 元数�?
/// 淇璺緞鐨勫洖褰掓祴璇曘€?
#[test]
fn claude_session_cwd_reads_cwd_field() {
    let tmp_root = tempdir_via_env();
    let encoded = encode_claude_project_dir(&tmp_root);
    let project_dir = tmp_root.join(".claude").join("projects").join(&encoded);
    std::fs::create_dir_all(&project_dir).expect("create project dir");
    let sid = "019ed38f-7c41-7b32-9c11-80a40788d6e3";
    let path = project_dir.join(format!("{sid}.jsonl"));
    std::fs::write(
            &path,
            format!("{}\n", serde_json::json!({
                "type": "user", "cwd": tmp_root, "message": {"role": "user", "content": "hi"},
                "sessionId": sid, "uuid": "u1"
            })),
        )
        .expect("write session jsonl");

    let cwd = with_claude_config_dir(tmp_root.join(".claude"), || {
        claude_session_cwd(sid).expect("read cwd")
    });
    let resolved = cwd.expect("cwd should be present");
    assert_eq!(resolved, tmp_root);
}

/// 没有任何 cwd 字�?�? 返回 None ── 而不�?��字�?串或兜底进程 cwd�?
#[test]
fn claude_session_cwd_returns_none_when_missing() {
    let tmp_root = tempdir_via_env();
    let encoded = encode_claude_project_dir(&tmp_root);
    let project_dir = tmp_root.join(".claude").join("projects").join(&encoded);
    std::fs::create_dir_all(&project_dir).expect("create project dir");
    let sid = "019ed38f-7c41-7b32-9c11-80a40788d6e4";
    let path = project_dir.join(format!("{sid}.jsonl"));
    std::fs::write(
            &path,
            format!(
                "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"hi\"}},\"sessionId\":\"{sid}\",\"uuid\":\"u2\"}}\n"
            ),
        )
        .expect("write session jsonl");

    let cwd = with_claude_config_dir(tmp_root.join(".claude"), || {
        claude_session_cwd(sid).expect("read cwd")
    });
    assert!(cwd.is_none());
}

fn tempdir_via_env() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "claude-history-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).expect("tempdir");
    dir
}

/// Claude Code CLI 的项�?��录编码方�?
///   /Users/rop/notes  鈫? -Users-rop-notes
/// 把所有非 ASCII 替换�?`-`, 但单元测�?fixture 用纯 ASCII �?��,
/// 实际反推不�?�?── 不需要完整�?�? �?�� path segment 拼成 dash-joined.
fn encode_claude_project_dir(path: &Path) -> String {
    format!("-{}", path.to_string_lossy().trim_start_matches('/').replace(['/', '\\', ':'], "-"))
}

fn with_claude_config_dir<T>(root: PathBuf, f: impl FnOnce() -> T) -> T {
    // Save & restore CLAUDE_CONFIG_DIR 閬垮厤姹℃煋鍏跺畠骞跺彂 test.
    // �?TEST_ENV_LOCK �?set/restore 与其它改 env 的测试互�?── 否则
    // save-restore 窗口�?find_claude_session_file �?��读到�?��发测�?        // 改写�?CLAUDE_CONFIG_DIR, 导致 session 文件找不�?(flaky)�?
    let _guard = crate::agent_external::acquire_test_env_lock();
    let prev = std::env::var_os("CLAUDE_CONFIG_DIR");
    std::env::set_var("CLAUDE_CONFIG_DIR", &root);
    let result = f();
    match prev {
        Some(v) => std::env::set_var("CLAUDE_CONFIG_DIR", v),
        None => std::env::remove_var("CLAUDE_CONFIG_DIR"),
    }
    result
}
