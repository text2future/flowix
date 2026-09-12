#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crate::agent_session::store::ThreadManager;
    use crate::agent_session::types::{
        AgentConversationCursor, AgentConversationSource, ChatMessage, NewAgentExternalEvent,
        UpsertAgentConversationInstance,
    };
    use crate::agent_types::AgentId;
    use rusqlite::params;

    fn make_message(id: &str, role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            id: id.to_string(),
            role: role.to_string(),
            message_type: None,
            content: content.to_string(),
            llm_content: None,
            system_reminder_directory: None,
            timestamp: "2026-06-21T00:00:00Z".to_string(),
            is_loading: None,
            tool_call_id: None,
            tool_name: None,
            tool_data: None,
            tool_input: None,
            tool_call: None,
            tool_result: None,
            tool_calls: None,
            reasoning: None,
            is_completed: None,
            error_details: None,
            is_collapsed: None,
            codex_turn_id: None,
            turn_duration_ms: None,
            source_sequence: None,
        }
    }

    async fn seed_thread(manager: &Arc<ThreadManager>, thread_id: &str, n_messages: usize) {
        manager
            .create_thread(AgentId("test-agent".to_string()), "test thread".to_string())
            .await
            .expect("create_thread");
        // create_thread already creates a default thread_id; overwrite it here
        // so pagination assertions can use stable ids.
        {
            let conn = manager.lock_conn();
            conn.execute(
                "INSERT OR REPLACE INTO threads (thread_id, agent_id, title, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![thread_id, "test-agent", "test thread", 0_i64, 0_i64],
            )
            .unwrap();
        }
        for i in 0..n_messages {
            manager
                .add_message(
                    thread_id,
                    make_message(&format!("msg-{i}"), "user", &format!("body {i}")),
                )
                .await
                .expect("add_message");
        }
    }

    async fn seed_conversation(
        manager: &Arc<ThreadManager>,
        instance_id: &str,
        agent_type: &str,
        notebook_id: Option<&str>,
        updated_at: i64,
    ) {
        manager
            .upsert_agent_conversation_instance(UpsertAgentConversationInstance {
                instance_id: instance_id.to_string(),
                agent_type: agent_type.to_string(),
                initial_title: instance_id.to_string(),
                thread_id: Some(format!("thread-{instance_id}")),
                runtime_config: None,
                source: AgentConversationSource {
                    kind: "dedicated".to_string(),
                    document_path: None,
                    memo_id: None,
                    notebook_id: notebook_id.map(str::to_string),
                },
                role: None,
                created_at: Some(updated_at),
                updated_at: Some(updated_at),
            })
            .await
            .expect("seed conversation");
    }

    #[tokio::test]
    async fn page_returns_latest_n_when_before_is_none() {
        let manager = ThreadManager::for_tests();
        seed_thread(&manager, "t1", 25).await;

        let page = manager
            .get_thread_messages_page("t1", None, 10)
            .await
            .expect("page");

        assert_eq!(page.messages.len(), 10);
        // Returned in ASC order: first is msg-15, last is msg-24.
        assert_eq!(page.messages.first().unwrap().id, "msg-15");
        assert_eq!(page.messages.last().unwrap().id, "msg-24");
        assert!(
            page.has_more,
            "25 rows, latest 10 returned, 15 older rows remain"
        );
        assert_eq!(page.oldest_sequence, Some(16)); // msg-15 鏄�?16 �?(sequence �?1 �?
    }

    #[tokio::test]
    async fn page_cursor_walks_backward() {
        let manager = ThreadManager::for_tests();
        seed_thread(&manager, "t2", 25).await;

        let first = manager
            .get_thread_messages_page("t2", None, 10)
            .await
            .unwrap();
        let cursor = first.oldest_sequence.unwrap();

        let second = manager
            .get_thread_messages_page("t2", Some(cursor), 10)
            .await
            .unwrap();

        assert_eq!(second.messages.len(), 10);
        assert_eq!(second.messages.first().unwrap().id, "msg-5");
        assert_eq!(second.messages.last().unwrap().id, "msg-14");
        assert!(
            second.has_more,
            "after loading 20 rows, 5 older rows remain"
        );
    }

    #[tokio::test]
    async fn page_reaches_top_marks_has_more_false() {
        let manager = ThreadManager::for_tests();
        seed_thread(&manager, "t3", 8).await;

        let page = manager
            .get_thread_messages_page("t3", None, 10)
            .await
            .unwrap();

        assert_eq!(page.messages.len(), 8);
        assert!(!page.has_more, "鍏ㄩ儴鎷夊畬灏辨病鏈夋洿鏃╁巻鍙?");
        assert_eq!(page.oldest_sequence, Some(1));
    }

    #[tokio::test]
    async fn page_empty_thread_returns_empty() {
        let manager = ThreadManager::for_tests();
        {
            let conn = manager.lock_conn();
            conn.execute(
                "INSERT INTO threads (thread_id, agent_id, title, created_at, updated_at)
                 VALUES ('t4', 'test-agent', 'empty', 0, 0)",
                [],
            )
            .unwrap();
        }

        let page = manager
            .get_thread_messages_page("t4", None, 10)
            .await
            .unwrap();
        assert!(page.messages.is_empty());
        assert!(!page.has_more);
        assert_eq!(page.oldest_sequence, None);
    }

    #[tokio::test]
    async fn page_limit_clamp() {
        let manager = ThreadManager::for_tests();
        seed_thread(&manager, "t5", 5).await;

        // limit=0 should clamp to 1.
        let page = manager
            .get_thread_messages_page("t5", None, 0)
            .await
            .unwrap();
        assert_eq!(page.messages.len(), 1);

        // limit > 1000 should clamp to 1000; this fixture only has 5 rows.
        let page = manager
            .get_thread_messages_page("t5", None, 10_000)
            .await
            .unwrap();
        assert_eq!(page.messages.len(), 5);
    }

    #[tokio::test]
    async fn conversation_page_filters_and_walks_stable_cursor() {
        let manager = ThreadManager::for_tests();
        seed_conversation(&manager, "i-4", "codex", Some("nb-a"), 400).await;
        seed_conversation(&manager, "i-3", "codex", Some("nb-a"), 300).await;
        seed_conversation(&manager, "i-2", "claude", Some("nb-a"), 300).await;
        seed_conversation(&manager, "i-1", "codex", Some("nb-b"), 200).await;
        seed_conversation(&manager, "i-0", "codex", None, 100).await;

        let first = manager
            .list_agent_conversation_instances_page(Some("nb-a".to_string()), None, None, 2)
            .await
            .expect("first conversation page");
        assert_eq!(
            first
                .iter()
                .map(|item| item.instance_id.as_str())
                .collect::<Vec<_>>(),
            vec!["i-4", "i-3"]
        );

        let second = manager
            .list_agent_conversation_instances_page(
                Some("nb-a".to_string()),
                None,
                Some(AgentConversationCursor {
                    updated_at: first[1].updated_at,
                    instance_id: first[1].instance_id.clone(),
                }),
                2,
            )
            .await
            .expect("second conversation page");
        assert_eq!(
            second
                .iter()
                .map(|item| item.instance_id.as_str())
                .collect::<Vec<_>>(),
            vec!["i-2"]
        );

        let filtered = manager
            .list_agent_conversation_instances_page(
                Some("nb-a".to_string()),
                Some("codex".to_string()),
                None,
                10,
            )
            .await
            .expect("filtered conversation page");
        assert_eq!(
            filtered
                .iter()
                .map(|item| item.instance_id.as_str())
                .collect::<Vec<_>>(),
            vec!["i-4", "i-3"]
        );
    }

    #[tokio::test]
    async fn ensure_thread_creates_once_and_preserves_existing_title() {
        let manager = ThreadManager::for_tests();
        let first = manager
            .ensure_thread(
                "gemini-local-1",
                AgentId("gemini".to_string()),
                "first title".to_string(),
            )
            .await
            .unwrap();
        assert_eq!(first.thread_id, "gemini-local-1");
        assert_eq!(first.agent_id.0, "gemini");
        assert_eq!(first.title, "first title");

        let second = manager
            .ensure_thread(
                "gemini-local-1",
                AgentId("gemini".to_string()),
                "second title".to_string(),
            )
            .await
            .unwrap();
        assert_eq!(second.title, "first title");
    }

    #[tokio::test]
    async fn external_session_keeps_product_thread_as_primary_key() {
        let manager = ThreadManager::for_tests();
        manager
            .update_title(
                "codex-local-card-1",
                "Product database title".to_string(),
                AgentId("codex".to_string()),
            )
            .await
            .unwrap();

        manager
            .upsert_external_session(
                "codex-local-card-1",
                "codex",
                "019f-test-canonical-session",
                None,
            )
            .await
            .unwrap();

        assert!(manager
            .get_thread_info("019f-test-canonical-session")
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            manager
                .get_external_session("codex-local-card-1", "codex")
                .await
                .unwrap()
                .as_deref(),
            Some("019f-test-canonical-session")
        );
        manager
            .upsert_agent_conversation_instance(UpsertAgentConversationInstance {
                instance_id: "inst-codex-session".to_string(),
                agent_type: "codex".to_string(),
                initial_title: "Product database title".to_string(),
                thread_id: Some("codex-local-card-1".to_string()),
                runtime_config: None,
                source: AgentConversationSource {
                    kind: "dedicated".to_string(),
                    document_path: None,
                    memo_id: None,
                    notebook_id: None,
                },
                role: None,
                created_at: None,
                updated_at: None,
            })
            .await
            .unwrap();
        let instance = manager
            .get_agent_conversation_instance("inst-codex-session")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            instance.session_id.as_deref(),
            Some("019f-test-canonical-session")
        );
        let listed = manager.list_external_threads("codex").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].thread_id, "codex-local-card-1");
        assert_eq!(listed[0].title, "Product database title");
    }

    #[tokio::test]
    async fn frozen_cwd_round_trips_outside_frontend_runtime_config() {
        let manager = ThreadManager::for_tests();
        manager
            .upsert_agent_conversation_instance(UpsertAgentConversationInstance {
                instance_id: "inst-frozen-cwd".to_string(),
                agent_type: "claude".to_string(),
                initial_title: "frozen cwd test".to_string(),
                thread_id: Some("thread-frozen-cwd".to_string()),
                runtime_config: Some(
                    r#"{"workspaceSnapshot":{"cwd":"/old"},"model":{"key":"sonnet"}}"#.to_string(),
                ),
                source: AgentConversationSource {
                    kind: "thread-card".to_string(),
                    document_path: None,
                    memo_id: None,
                    notebook_id: None,
                },
                role: None,
                created_at: None,
                updated_at: None,
            })
            .await
            .unwrap();

        // First turn: no frozen cwd yet.
        assert!(manager
            .read_frozen_cwd("thread-frozen-cwd")
            .await
            .unwrap()
            .is_none());

        // Freeze a cwd.
        let cwd = std::path::PathBuf::from("/tmp/flowix-frozen-cwd");
        manager
            .upsert_frozen_cwd("thread-frozen-cwd", &cwd)
            .await
            .unwrap();

        // Subsequent turn: frozen cwd reads back.
        assert_eq!(
            manager
                .read_frozen_cwd("thread-frozen-cwd")
                .await
                .unwrap()
                .as_deref(),
            Some(cwd.as_path())
        );

        // Other runtime_config fields the frontend persisted are preserved,
        // while the backend-owned cwd lives in its dedicated column.
        let instance = manager
            .find_agent_conversation_by_thread_id("thread-frozen-cwd")
            .await
            .unwrap()
            .unwrap();
        let rc: serde_json::Value =
            serde_json::from_str(instance.runtime_config.as_deref().unwrap()).unwrap();
        assert_eq!(rc["workspaceSnapshot"]["cwd"], "/old");
        assert_eq!(rc["model"]["key"], "sonnet");
        assert!(rc.get("frozenCwd").is_none());
        assert_eq!(
            instance.frozen_cwd.as_deref(),
            Some("/tmp/flowix-frozen-cwd")
        );

        // A stale frontend upsert replaces runtime_config but cannot clear the
        // server-owned cwd column.
        manager
            .upsert_agent_conversation_instance(UpsertAgentConversationInstance {
                instance_id: "inst-frozen-cwd".to_string(),
                agent_type: "claude".to_string(),
                initial_title: "frontend refresh".to_string(),
                thread_id: Some("thread-frozen-cwd".to_string()),
                runtime_config: Some(
                    r#"{"model":{"key":"opus"},"frozenCwd":"/stale/frontend"}"#.to_string(),
                ),
                source: AgentConversationSource {
                    kind: "thread-card".to_string(),
                    document_path: None,
                    memo_id: None,
                    notebook_id: None,
                },
                role: None,
                created_at: None,
                updated_at: None,
            })
            .await
            .unwrap();
        assert_eq!(
            manager
                .read_frozen_cwd("thread-frozen-cwd")
                .await
                .unwrap()
                .as_deref(),
            Some(cwd.as_path())
        );
        let refreshed = manager
            .find_agent_conversation_by_thread_id("thread-frozen-cwd")
            .await
            .unwrap()
            .unwrap();
        let refreshed_config: serde_json::Value =
            serde_json::from_str(refreshed.runtime_config.as_deref().unwrap()).unwrap();
        assert!(refreshed_config.get("frozenCwd").is_none());
    }

    #[tokio::test]
    async fn stale_conversation_upsert_cannot_overwrite_newer_state() {
        let manager = ThreadManager::for_tests();
        let input = |title: &str, updated_at: i64| UpsertAgentConversationInstance {
            instance_id: "inst-versioned-upsert".to_string(),
            agent_type: "deepseek-harness".to_string(),
            initial_title: title.to_string(),
            thread_id: Some("thread-versioned-upsert".to_string()),
            runtime_config: None,
            source: AgentConversationSource {
                kind: "thread-card".to_string(),
                document_path: None,
                memo_id: None,
                notebook_id: None,
            },
            role: None,
            created_at: Some(1),
            updated_at: Some(updated_at),
        };

        manager
            .upsert_agent_conversation_instance(input("newest", 200))
            .await
            .unwrap();
        let returned = manager
            .upsert_agent_conversation_instance(input("stale", 100))
            .await
            .unwrap();

        assert_eq!(returned.thread_title.as_deref(), Some("newest"));
        assert_eq!(returned.updated_at, 200);
    }

    #[tokio::test]
    async fn external_session_binding_atomically_reconciles_authoritative_cwd() {
        let manager = ThreadManager::for_tests();
        manager
            .update_title(
                "claude-local-cwd",
                "Claude cwd".to_string(),
                AgentId("claude".to_string()),
            )
            .await
            .unwrap();
        manager
            .upsert_agent_conversation_instance(UpsertAgentConversationInstance {
                instance_id: "inst-claude-cwd".to_string(),
                agent_type: "claude".to_string(),
                initial_title: "Claude cwd".to_string(),
                thread_id: Some("claude-local-cwd".to_string()),
                runtime_config: None,
                source: AgentConversationSource {
                    kind: "thread-card".to_string(),
                    document_path: None,
                    memo_id: None,
                    notebook_id: None,
                },
                role: None,
                created_at: None,
                updated_at: None,
            })
            .await
            .unwrap();
        manager
            .upsert_frozen_cwd("claude-local-cwd", std::path::Path::new("/wrong/notebook"))
            .await
            .unwrap();

        let sid = "e3c89515-4fdc-4952-becc-3988179cc89e";
        manager
            .upsert_external_session(
                "claude-local-cwd",
                "claude",
                sid,
                Some(serde_json::json!({ "cwd": "/project/flowix-main" })),
            )
            .await
            .unwrap();
        // A resumed process reports its canonical id as thread_id. This must
        // update the existing product mapping rather than violate its UNIQUE
        // external-session constraint.
        manager
            .upsert_external_session(
                sid,
                "claude",
                sid,
                Some(serde_json::json!({ "cwd": "/project/flowix-main" })),
            )
            .await
            .unwrap();

        for identity in ["claude-local-cwd", sid] {
            assert_eq!(
                manager.read_frozen_cwd(identity).await.unwrap().as_deref(),
                Some(std::path::Path::new("/project/flowix-main"))
            );
        }
        assert_eq!(
            manager
                .find_thread_by_external_session(sid, "claude")
                .await
                .unwrap()
                .as_deref(),
            Some("claude-local-cwd")
        );
    }

    #[tokio::test]
    async fn renaming_external_session_id_updates_product_thread() {
        let manager = ThreadManager::for_tests();
        manager
            .update_title(
                "codex-local-card-2",
                "Initial title".to_string(),
                AgentId("codex".to_string()),
            )
            .await
            .unwrap();
        manager
            .upsert_external_session(
                "codex-local-card-2",
                "codex",
                "019f-test-canonical-rename",
                None,
            )
            .await
            .unwrap();

        manager
            .update_title(
                "019f-test-canonical-rename",
                "Renamed in product".to_string(),
                AgentId("codex".to_string()),
            )
            .await
            .unwrap();

        let local = manager
            .get_thread_info("codex-local-card-2")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(local.title, "Renamed in product");
        assert!(manager
            .get_thread_info("019f-test-canonical-rename")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn agent_external_events_store_payloads_and_page_by_thread_id() {
        let manager = ThreadManager::for_tests();
        let first = NewAgentExternalEvent {
            runtime: "test-runtime".to_string(),
            thread_id: "thread-1".to_string(),
            normalized_json: r#"{"kind":"text","run_id":"run-1","source_sequence":3,"source_subsequence":1,"text":"hello"}"#.to_string(),
            raw_json: Some(r#"{"type":"event_msg"}"#.to_string()),
            created_at: Some(100),
        };
        let second = NewAgentExternalEvent {
            normalized_json: r#"{"kind":"tool_call","id":"call-1"}"#.to_string(),
            created_at: Some(101),
            ..first.clone()
        };

        let id1 = manager
            .insert_agent_external_event(first.clone())
            .await
            .expect("insert first event");
        let duplicate_id = manager
            .insert_agent_external_event(first)
            .await
            .expect("deduplicate first event");
        let id2 = manager
            .insert_agent_external_event(second)
            .await
            .expect("insert second event");

        assert!(id1 > 0);
        assert_eq!(duplicate_id, id1);
        assert!(id2 > id1);

        let all = manager
            .list_agent_external_events_by_thread("thread-1", None, 10)
            .await
            .expect("list all events");
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, id1);
        assert_eq!(all[1].id, id2);
        assert_eq!(
            all[1].normalized_json,
            r#"{"kind":"tool_call","id":"call-1"}"#
        );
        assert_eq!(all[0].raw_json.as_deref(), Some(r#"{"type":"event_msg"}"#));
        let structured = manager
            .lock_conn()
            .query_row(
                "SELECT event_kind, run_id, source_sequence, source_subsequence
                 FROM agent_external_events WHERE id = ?1",
                [id1],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                    ))
                },
            )
            .expect("read structured event metadata");
        assert_eq!(
            structured,
            (
                Some("text".to_string()),
                Some("run-1".to_string()),
                Some(3),
                Some(1),
            )
        );

        let delta = manager
            .list_agent_external_events_by_thread("thread-1", Some(id1), 10)
            .await
            .expect("list delta events");
        assert_eq!(delta.len(), 1);
        assert_eq!(delta[0].id, id2);
    }

    #[tokio::test]
    async fn opencode_compact_events_page_by_complete_turn_and_session_id() {
        let manager = ThreadManager::for_tests();
        let thread_id = "opencode-local-card-page";
        let session_id = "ses-opencode-page";
        manager
            .upsert_external_session(thread_id, "opencode", session_id, None)
            .await
            .unwrap();
        let payloads = [
            r#"{"kind":"user_message","id":"user-1","text":"question 1"}"#,
            r#"{"kind":"reasoning","message_id":"reasoning-1","message_phase":"completed","content_mode":"snapshot","text":"thought 1"}"#,
            r#"{"kind":"text","message_id":"assistant-1","message_phase":"completed","content_mode":"snapshot","text":"answer 1"}"#,
            r#"{"kind":"stream_end"}"#,
            r#"{"kind":"user_message","id":"user-2","text":"question 2"}"#,
            r#"{"kind":"tool_call","id":"call-2","name":"read","input":{"filePath":"/tmp/a"}}"#,
            r#"{"kind":"tool_result","id":"call-2","name":"read","result":{"content":"ok"}}"#,
            r#"{"kind":"text","message_id":"assistant-2","message_phase":"completed","content_mode":"snapshot","text":"answer 2"}"#,
            r#"{"kind":"stream_end"}"#,
        ];
        for (index, payload) in payloads.iter().enumerate() {
            manager
                .insert_agent_external_event(NewAgentExternalEvent {
                    runtime: "opencode".to_string(),
                    // Reproduce the refresh bug: the first turn is owned by the
                    // local thread, while the next turn was written using the
                    // resolved session id.
                    thread_id: if index < 4 { thread_id } else { session_id }.to_string(),
                    normalized_json: payload.to_string(),
                    raw_json: None,
                    created_at: Some(100 + index as i64),
                })
                .await
                .unwrap();
        }
        let latest = manager
            .get_opencode_event_messages_page(session_id, None, 1)
            .await
            .unwrap()
            .expect("database events should be preferred");
        assert_eq!(
            latest
                .messages
                .iter()
                .map(|message| message.role.as_str())
                .collect::<Vec<_>>(),
            vec!["user", "tool", "assistant"]
        );
        assert_eq!(latest.messages[1].tool_call_id.as_deref(), Some("call-2"));
        assert_eq!(latest.messages[1].is_loading, Some(false));
        assert!(latest.has_more);

        let older = manager
            .get_opencode_event_messages_page(session_id, latest.oldest_sequence, 1)
            .await
            .unwrap()
            .expect("database events should be preferred");
        assert_eq!(
            older
                .messages
                .iter()
                .map(|message| message.content.as_str())
                .collect::<Vec<_>>(),
            vec!["question 1", "thought 1", "answer 1"]
        );
        assert!(!older.has_more);

        let latest_from_local_id = manager
            .get_opencode_event_messages_page(thread_id, None, 1)
            .await
            .unwrap()
            .expect("database events should be preferred");
        assert_eq!(latest_from_local_id.messages[0].content, "question 2");

        let listed = manager.list_opencode_event_threads().await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].thread_id, thread_id);

        let empty = ThreadManager::for_tests()
            .get_opencode_event_messages_page("missing-opencode-session", None, 10)
            .await
            .unwrap();
        assert!(
            empty.is_none(),
            "empty events must select external fallback"
        );
    }

    #[tokio::test]
    async fn external_error_details_survive_history_materialization() {
        let manager = ThreadManager::for_tests();
        let thread_id = "opencode-error-details";
        for (index, payload) in [
            r#"{"kind":"user_message","id":"user-1","text":"hello","run_id":"run-1"}"#,
            r#"{"kind":"error","message_id":"msg:opencode:run-1:error:error","message":"rate limited","run_id":"run-1","error_details":{"category":"rate_limited","status_code":429,"request_id":"req-1","retry_after":"60","source":"runtime","retryable":true}}"#,
            r#"{"kind":"stream_end","run_id":"run-1"}"#,
        ]
        .iter()
        .enumerate()
        {
            manager
                .insert_agent_external_event(NewAgentExternalEvent {
                    runtime: "opencode".to_string(),
                    thread_id: thread_id.to_string(),
                    normalized_json: payload.to_string(),
                    raw_json: None,
                    created_at: Some(200 + index as i64),
                })
                .await
                .unwrap();
        }

        let page = manager
            .get_opencode_event_messages_page(thread_id, None, 10)
            .await
            .unwrap()
            .expect("external history should exist");
        let details = page.messages[1]
            .error_details
            .as_ref()
            .expect("error details should survive reload");
        assert_eq!(details.category, "rate_limited");
        assert_eq!(details.status_code, Some(429));
        assert_eq!(details.request_id.as_deref(), Some("req-1"));
        assert_eq!(details.retry_after.as_deref(), Some("60"));
        assert!(details.retryable);
    }

    #[tokio::test]
    async fn claude_event_page_materializes_snapshots_and_merges_deltas() {
        let manager = ThreadManager::for_tests();
        let thread_id = "claude-local-card-page";
        let payloads = [
            r#"{"kind":"user_message","id":"user-1","text":"inspect"}"#,
            r#"{"kind":"reasoning","message_id":"reasoning-run-1","message_phase":"updated","content_mode":"delta","text":"think "}"#,
            r#"{"kind":"reasoning","message_id":"reasoning-run-1","message_phase":"completed","content_mode":"delta","text":"carefully"}"#,
            r#"{"kind":"tool_call","id":"call-1","name":"Read","input":{"file_path":"/tmp/a"}}"#,
            r#"{"kind":"tool_result","id":"call-1","name":"Read","result":{"content":"ok"}}"#,
            r#"{"kind":"text","message_id":"assistant-1","message_phase":"completed","content_mode":"snapshot","text":"done"}"#,
            r#"{"kind":"stream_end"}"#,
        ];
        for (index, payload) in payloads.iter().enumerate() {
            manager
                .insert_agent_external_event(NewAgentExternalEvent {
                    runtime: "claude".to_string(),
                    thread_id: thread_id.to_string(),
                    normalized_json: payload.to_string(),
                    raw_json: None,
                    created_at: Some(200 + index as i64),
                })
                .await
                .unwrap();
        }

        let page = manager
            .get_claude_event_messages_page(thread_id, None, 10)
            .await
            .unwrap()
            .expect("database history should win when a complete user turn exists");
        assert_eq!(page.messages.len(), 4);
        assert_eq!(page.messages[1].role, "reasoning");
        assert_eq!(page.messages[1].content, "think carefully");
        assert_eq!(page.messages[2].tool_call_id.as_deref(), Some("call-1"));
        assert_eq!(page.messages[2].is_loading, Some(false));
        assert_eq!(page.messages[3].content, "done");

        let empty = ThreadManager::for_tests()
            .get_claude_event_messages_page("missing-session", None, 10)
            .await
            .unwrap();
        assert!(
            empty.is_none(),
            "empty database history must use rollout fallback"
        );

        let legacy = ThreadManager::for_tests();
        for (index, payload) in [
            r#"{"kind":"stream_start","run_id":"legacy-run"}"#,
            r#"{"kind":"text","run_id":"legacy-run","text":"legacy answer"}"#,
            r#"{"kind":"stream_end","run_id":"legacy-run"}"#,
        ]
        .iter()
        .enumerate()
        {
            legacy
                .insert_agent_external_event(NewAgentExternalEvent {
                    runtime: "claude".to_string(),
                    thread_id: "legacy-claude".to_string(),
                    normalized_json: payload.to_string(),
                    raw_json: None,
                    created_at: Some(300 + index as i64),
                })
                .await
                .unwrap();
        }
        let legacy_page = legacy
            .get_claude_event_messages_page("legacy-claude", None, 10)
            .await
            .unwrap()
            .expect("non-empty legacy events must not use rollout fallback");
        assert_eq!(legacy_page.messages[0].content, "legacy answer");
    }

    #[tokio::test]
    async fn deepseek_harness_history_normalizes_legacy_think_text() {
        let manager = ThreadManager::for_tests();
        let thread_id = "deepseek-harness-legacy-think";
        let payloads = [
            r#"{"kind":"user_message","id":"user-1","text":"inspect","run_id":"run-1"}"#,
            r#"{"kind":"text","message_id":"msg:deepseek-harness:run-1:assistant:stream","content_mode":"delta","text":"<think>plan carefully</think>answer","run_id":"run-1"}"#,
            r#"{"kind":"stream_end","run_id":"run-1"}"#,
        ];
        for (index, payload) in payloads.iter().enumerate() {
            manager
                .insert_agent_external_event(NewAgentExternalEvent {
                    runtime: "deepseek-harness".to_string(),
                    thread_id: thread_id.to_string(),
                    normalized_json: payload.to_string(),
                    raw_json: None,
                    created_at: Some(400 + index as i64),
                })
                .await
                .unwrap();
        }

        let page = manager
            .get_external_event_messages_page("deepseek-harness", thread_id, None, 10)
            .await
            .unwrap()
            .expect("database history should materialize");
        assert_eq!(
            page.messages
                .iter()
                .map(|message| (message.role.as_str(), message.content.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("user", "inspect"),
                ("reasoning", "plan carefully"),
                ("assistant", "answer"),
            ]
        );
    }

    #[tokio::test]
    async fn deepseek_harness_history_splits_legacy_assistant_segments_after_tools() {
        let manager = ThreadManager::for_tests();
        let thread_id = "deepseek-harness-legacy-tool-boundary";
        let payloads = [
            r#"{"kind":"user_message","id":"user-1","text":"inspect","run_id":"run-1"}"#,
            r#"{"kind":"text","message_id":"msg:deepseek-harness:run-1:assistant:stream","content_mode":"delta","text":"before","run_id":"run-1"}"#,
            r#"{"kind":"tool_call","id":"call-1","message_id":"msg:deepseek-harness:run-1:tool:call-1","name":"shell","input":{"command":"pwd"},"run_id":"run-1"}"#,
            r#"{"kind":"tool_result","id":"call-1","message_id":"msg:deepseek-harness:run-1:tool:call-1","name":"shell","result":"ok","run_id":"run-1"}"#,
            r#"{"kind":"text","message_id":"msg:deepseek-harness:run-1:assistant:stream","content_mode":"delta","text":"after","run_id":"run-1"}"#,
            r#"{"kind":"stream_end","run_id":"run-1"}"#,
        ];
        for (index, payload) in payloads.iter().enumerate() {
            manager
                .insert_agent_external_event(NewAgentExternalEvent {
                    runtime: "deepseek-harness".to_string(),
                    thread_id: thread_id.to_string(),
                    normalized_json: payload.to_string(),
                    raw_json: None,
                    created_at: Some(500 + index as i64),
                })
                .await
                .unwrap();
        }

        let page = manager
            .get_external_event_messages_page("deepseek-harness", thread_id, None, 10)
            .await
            .unwrap()
            .expect("database history should materialize");
        assert_eq!(
            page.messages
                .iter()
                .map(|message| (message.role.as_str(), message.content.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("user", "inspect"),
                ("assistant", "before"),
                ("tool", "ok"),
                ("assistant", "after"),
            ]
        );
        assert_ne!(page.messages[1].id, page.messages[3].id);
    }

    #[tokio::test]
    async fn agent_external_event_pruning_persists_truncation_sentinel() {
        let manager = ThreadManager::for_tests();
        let thread_id = "thread-pruned-history";
        {
            let mut conn = manager.lock_conn();
            let tx = conn.transaction().expect("start seed transaction");
            tx.execute(
                "INSERT INTO threads (thread_id, agent_id, title, created_at, updated_at)
                 VALUES (?1, 'claude', 'Claude thread', 1, 1)",
                [thread_id],
            )
            .expect("seed thread");
            {
                let mut insert = tx
                    .prepare(
                        "INSERT INTO agent_external_events (
                            runtime, thread_id, normalized_json, raw_json, created_at
                         ) VALUES ('claude', ?1, ?2, NULL, ?3)",
                    )
                    .expect("prepare event insert");
                for index in 0..10_000_i64 {
                    insert
                        .execute(params![
                            thread_id,
                            format!(r#"{{"kind":"text","index":{index}}}"#),
                            index,
                        ])
                        .expect("seed event");
                }
            }
            tx.commit().expect("commit seeded events");
        }

        manager
            .insert_agent_external_event(NewAgentExternalEvent {
                runtime: "claude".to_string(),
                thread_id: thread_id.to_string(),
                normalized_json: r#"{"kind":"stream_end"}"#.to_string(),
                raw_json: None,
                created_at: Some(10_001),
            })
            .await
            .expect("insert event that triggers pruning");

        let conn = manager.lock_conn();
        let ordinary_count: i64 = conn
            .query_row(
                "SELECT count(*) FROM agent_external_events
                 WHERE thread_id = ?1
                   AND normalized_json <> '{\"kind\":\"history_truncated\",\"version\":1}'",
                [thread_id],
                |row| row.get(0),
            )
            .expect("count ordinary events");
        let sentinel_count: i64 = conn
            .query_row(
                "SELECT count(*) FROM agent_external_events
                 WHERE thread_id = ?1
                   AND normalized_json = '{\"kind\":\"history_truncated\",\"version\":1}'",
                [thread_id],
                |row| row.get(0),
            )
            .expect("count sentinel events");
        assert_eq!(ordinary_count, 10_000);
        assert_eq!(sentinel_count, 1);
    }

    #[tokio::test]
    async fn opencode_compact_event_history_uses_standard_bounded_retention() {
        let manager = ThreadManager::for_tests();
        let thread_id = "thread-opencode-complete-history";
        {
            let mut conn = manager.lock_conn();
            let tx = conn.transaction().expect("start seed transaction");
            tx.execute(
                "INSERT INTO threads (thread_id, agent_id, title, created_at, updated_at)
                 VALUES (?1, 'opencode', 'OpenCode thread', 1, 1)",
                [thread_id],
            )
            .expect("seed thread");
            {
                let mut insert = tx
                    .prepare(
                        "INSERT INTO agent_external_events (
                            runtime, thread_id, normalized_json, raw_json, created_at
                         ) VALUES ('opencode', ?1, ?2, NULL, ?3)",
                    )
                    .expect("prepare event insert");
                for index in 0..10_000_i64 {
                    insert
                        .execute(params![
                            thread_id,
                            format!(r#"{{"kind":"text","index":{index}}}"#),
                            index,
                        ])
                        .expect("seed event");
                }
            }
            tx.commit().expect("commit seeded events");
        }

        manager
            .insert_agent_external_event(NewAgentExternalEvent {
                runtime: "opencode".to_string(),
                thread_id: thread_id.to_string(),
                normalized_json: r#"{"kind":"stream_end"}"#.to_string(),
                raw_json: None,
                created_at: Some(10_001),
            })
            .await
            .expect("append compact OpenCode event");

        let conn = manager.lock_conn();
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM agent_external_events WHERE thread_id = ?1",
                [thread_id],
                |row| row.get(0),
            )
            .expect("count OpenCode events");
        let sentinel_count: i64 = conn
            .query_row(
                "SELECT count(*) FROM agent_external_events
                 WHERE thread_id = ?1
                   AND normalized_json = '{\"kind\":\"history_truncated\",\"version\":1}'",
                [thread_id],
                |row| row.get(0),
            )
            .expect("count truncation sentinels");
        assert_eq!(count, 10_001);
        assert_eq!(sentinel_count, 1);
    }

    #[tokio::test]
    async fn agent_external_events_migration_fills_missing_optional_columns() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("thread.db");
        {
            let conn = rusqlite::Connection::open(&db_path).expect("open legacy db");
            conn.execute_batch(
                "
                CREATE TABLE threads (
                    thread_id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE agent_external_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    agent_type TEXT NOT NULL,
                    thread_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                INSERT INTO threads VALUES (
                    'thread-legacy', 'codex', 'Legacy thread', 1, 1
                );
                INSERT INTO agent_external_events (
                    id, agent_type, thread_id, kind, created_at
                ) VALUES (
                    7, 'codex', 'thread-legacy', 'text', 123
                );
                ",
            )
            .expect("seed legacy table");
        }

        let manager = Arc::new(ThreadManager::new(db_path).expect("migrate legacy db"));
        let events = manager
            .list_agent_external_events_by_thread("thread-legacy", None, 10)
            .await
            .expect("list migrated events");

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, 7);
        assert_eq!(events[0].runtime, "codex");
        assert_eq!(events[0].thread_id, "thread-legacy");
        assert_eq!(events[0].normalized_json, "{}");
        assert_eq!(events[0].raw_json, None);
        assert_eq!(events[0].created_at, 123);
    }

    #[tokio::test]
    async fn event_metadata_migration_backfills_structured_columns() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("thread.db");
        {
            let conn = rusqlite::Connection::open(&db_path).expect("open legacy db");
            conn.execute_batch(
                r#"
                CREATE TABLE threads (
                    thread_id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE agent_external_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    runtime TEXT NOT NULL,
                    thread_id TEXT NOT NULL,
                    event_key TEXT,
                    normalized_json TEXT NOT NULL,
                    raw_json TEXT,
                    created_at INTEGER NOT NULL
                );
                INSERT INTO threads VALUES ('metadata-thread', 'claude', 'Metadata', 1, 1);
                INSERT INTO agent_external_events (
                    runtime, thread_id, normalized_json, created_at
                ) VALUES (
                    'claude', 'metadata-thread',
                    '{"kind":"text","run_id":"run-7","source_sequence":8,"source_subsequence":2}',
                    10
                );
                "#,
            )
            .expect("seed pre-structured event schema");
        }

        let manager = ThreadManager::new(db_path).expect("migrate event metadata");
        let conn = manager.lock_conn();
        let metadata = conn
            .query_row(
                "SELECT event_kind, run_id, source_sequence, source_subsequence
                 FROM agent_external_events WHERE thread_id = 'metadata-thread'",
                [],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                    ))
                },
            )
            .expect("read backfilled event metadata");
        assert_eq!(
            metadata,
            (
                Some("text".to_string()),
                Some("run-7".to_string()),
                Some(8),
                Some(2),
            )
        );
    }

    #[tokio::test]
    async fn migrations_set_thread_db_user_version() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("thread.db");
        let manager = ThreadManager::new(db_path.clone()).expect("migrate db");
        drop(manager);

        let conn = rusqlite::Connection::open(&db_path).expect("open migrated db");
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(
            version,
            crate::agent_session::migrations::THREAD_DB_SCHEMA_VERSION
        );
    }

    #[test]
    fn current_schema_skips_historical_event_backfill() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("thread.db");
        drop(ThreadManager::new(db_path.clone()).expect("create current database"));

        let conn = rusqlite::Connection::open(&db_path).expect("open current database");
        conn.execute(
            "INSERT INTO threads (thread_id, agent_id, title, created_at, updated_at)
             VALUES ('current-version-thread', 'codex', 'Current', 1, 1)",
            [],
        )
        .expect("insert thread");
        conn.execute(
            "INSERT INTO agent_external_events (
                runtime, thread_id, event_kind, normalized_json, created_at
             ) VALUES (
                'codex', 'current-version-thread', NULL, '{\"kind\":\"text\"}', 1
             )",
            [],
        )
        .expect("insert sentinel event");
        drop(conn);

        drop(ThreadManager::new(db_path.clone()).expect("reopen current database"));

        let conn = rusqlite::Connection::open(&db_path).expect("inspect current database");
        let event_kind: Option<String> = conn
            .query_row(
                "SELECT event_kind FROM agent_external_events
                 WHERE thread_id = 'current-version-thread'",
                [],
                |row| row.get(0),
            )
            .expect("read sentinel event");
        assert_eq!(
            event_kind, None,
            "current schemas must skip legacy backfills"
        );
    }

    #[test]
    fn newer_thread_schema_is_rejected() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("thread.db");
        let conn = rusqlite::Connection::open(&db_path).expect("open database");
        conn.pragma_update(
            None,
            "user_version",
            crate::agent_session::migrations::THREAD_DB_SCHEMA_VERSION + 1,
        )
        .expect("set future schema version");
        drop(conn);

        let error = match ThreadManager::new(db_path) {
            Ok(_) => panic!("future schema must be rejected"),
            Err(error) => error,
        };
        assert!(matches!(
            error,
            crate::agent_session::error::ThreadError::UnsupportedSchemaVersion {
                found,
                supported
            } if found == supported + 1
        ));
    }

    #[tokio::test]
    async fn legacy_claude_binding_is_backfilled_without_moving_events() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("thread.db");
        let manager = Arc::new(ThreadManager::new(db_path.clone()).expect("create database"));
        manager
            .ensure_thread(
                "claude-legacy-thread",
                AgentId("claude".to_string()),
                "Claude legacy".to_string(),
            )
            .await
            .expect("create Claude product thread");
        drop(manager);

        let conn = rusqlite::Connection::open(&db_path).expect("open database");
        conn.execute(
            "INSERT INTO thread_external_sessions (
                thread_id, runtime, external_session_id, session_metadata_json,
                created_at, updated_at
             ) VALUES (?1, 'claude', ?2, ?3, 1, 2)",
            rusqlite::params![
                "claude-legacy-thread",
                "claude-legacy-session",
                r#"{"cwd":"/legacy/project"}"#
            ],
        )
        .expect("seed legacy Claude binding");
        conn.pragma_update(
            None,
            "user_version",
            crate::agent_session::migrations::THREAD_DB_SCHEMA_VERSION - 1,
        )
        .expect("mark database as pre-provider-branch schema");
        drop(conn);

        let migrated = Arc::new(ThreadManager::new(db_path).expect("rerun migrations"));
        assert_eq!(
            migrated
                .get_external_session("claude-legacy-thread", "claude")
                .await
                .expect("read migrated Claude binding")
                .as_deref(),
            Some("claude-legacy-session")
        );
        let conn = migrated.lock_conn();
        let provider: (String, Option<String>) = conn
            .query_row(
                "SELECT external_id, project_path FROM threads_claude
                 WHERE thread_id = 'claude-legacy-thread'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read Claude provider branch");
        assert_eq!(
            provider,
            (
                "claude-legacy-session".to_string(),
                Some("/legacy/project".to_string())
            )
        );
        let event_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_external_events
                 WHERE thread_id = 'claude-legacy-thread'",
                [],
                |row| row.get(0),
            )
            .expect("count Claude events");
        assert_eq!(
            event_count, 0,
            "binding migration must not synthesize events"
        );
    }

    #[tokio::test]
    async fn simplified_thread_tables_backfill_and_track_provider_ids() {
        let manager = ThreadManager::for_tests();
        manager
            .ensure_thread(
                "thread-simplified-index",
                AgentId("codex".to_string()),
                "Simplified thread".to_string(),
            )
            .await
            .expect("create product thread");

        manager
            .upsert_external_session(
                "thread-simplified-index",
                "codex",
                "codex-provider-id",
                None,
            )
            .await
            .expect("bind codex provider thread");
        manager
            .upsert_external_session(
                "thread-simplified-index",
                "deepseek-harness",
                "dsh-provider-id",
                None,
            )
            .await
            .expect("bind dsh provider session");
        manager
            .upsert_external_session(
                "thread-simplified-index",
                "opencode",
                "opencode-provider-id",
                None,
            )
            .await
            .expect("bind opencode provider session");
        manager
            .upsert_external_session(
                "thread-simplified-index",
                "hermes",
                "hermes-provider-id",
                None,
            )
            .await
            .expect("bind hermes provider session");
        manager
            .upsert_external_session(
                "thread-simplified-index",
                "claude",
                "claude-provider-id",
                Some(serde_json::json!({ "cwd": "/workspace/claude" })),
            )
            .await
            .expect("bind claude provider session");
        manager
            .insert_agent_external_event(NewAgentExternalEvent {
                runtime: "claude".to_string(),
                thread_id: "thread-simplified-index".to_string(),
                normalized_json: r#"{"kind":"text","run_id":"claude-run","text":"hello"}"#
                    .to_string(),
                raw_json: None,
                created_at: Some(50),
            })
            .await
            .expect("persist product-owned Claude event");

        let conn = manager.lock_conn();
        let index: (String, String) = conn
            .query_row(
                "SELECT id, title FROM threads_index WHERE id = ?1",
                ["thread-simplified-index"],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read simplified thread index");
        assert_eq!(
            index,
            (
                "thread-simplified-index".to_string(),
                "Simplified thread".to_string()
            )
        );

        let codex_id: String = conn
            .query_row(
                "SELECT external_id FROM threads_codex WHERE thread_id = ?1",
                ["thread-simplified-index"],
                |row| row.get(0),
            )
            .expect("read codex binding");
        assert_eq!(codex_id, "codex-provider-id");

        let dsh_id: String = conn
            .query_row(
                "SELECT external_id FROM threads_dsh WHERE thread_id = ?1",
                ["thread-simplified-index"],
                |row| row.get(0),
            )
            .expect("read dsh binding");
        assert_eq!(dsh_id, "dsh-provider-id");

        let opencode_id: String = conn
            .query_row(
                "SELECT external_id FROM threads_opencode WHERE thread_id = ?1",
                ["thread-simplified-index"],
                |row| row.get(0),
            )
            .expect("read opencode binding");
        assert_eq!(opencode_id, "opencode-provider-id");

        let hermes_id: String = conn
            .query_row(
                "SELECT external_id FROM threads_hermes WHERE thread_id = ?1",
                ["thread-simplified-index"],
                |row| row.get(0),
            )
            .expect("read hermes binding");
        assert_eq!(hermes_id, "hermes-provider-id");

        let claude: (String, Option<String>) = conn
            .query_row(
                "SELECT external_id, project_path FROM threads_claude WHERE thread_id = ?1",
                ["thread-simplified-index"],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read claude binding");
        assert_eq!(
            claude,
            (
                "claude-provider-id".to_string(),
                Some("/workspace/claude".to_string())
            )
        );
        let claude_event_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_external_events
                 WHERE runtime = 'claude' AND thread_id = ?1",
                ["thread-simplified-index"],
                |row| row.get(0),
            )
            .expect("count product-owned Claude events");
        assert_eq!(claude_event_count, 1);

        let legacy_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM thread_external_sessions
                 WHERE thread_id = ?1 AND runtime IN (
                    'codex', 'deepseek-harness', 'opencode', 'hermes', 'claude'
                 )",
                ["thread-simplified-index"],
                |row| row.get(0),
            )
            .expect("count legacy provider bindings");
        assert_eq!(
            legacy_count, 0,
            "provider bindings should no longer be double-written"
        );
        drop(conn);

        assert_eq!(
            manager
                .find_thread_by_external_session("codex-provider-id", "codex")
                .await
                .expect("resolve codex provider id")
                .as_deref(),
            Some("thread-simplified-index")
        );
        assert_eq!(
            manager
                .get_external_session("thread-simplified-index", "claude")
                .await
                .expect("resolve claude provider id")
                .as_deref(),
            Some("claude-provider-id")
        );
        assert_eq!(
            manager
                .get_external_session("thread-simplified-index", "deepseek-harness")
                .await
                .expect("resolve dsh provider id")
                .as_deref(),
            Some("dsh-provider-id")
        );
        assert_eq!(
            manager
                .find_thread_by_external_session("opencode-provider-id", "opencode")
                .await
                .expect("resolve opencode provider id")
                .as_deref(),
            Some("thread-simplified-index")
        );
    }

    #[tokio::test]
    async fn binding_a_real_instance_replaces_the_temporary_dedicated_instance() {
        let manager = ThreadManager::for_tests();
        manager
            .ensure_thread(
                "thread-instance-replacement",
                AgentId("codex".to_string()),
                "Instance replacement".to_string(),
            )
            .await
            .expect("create product thread");

        manager
            .upsert_agent_conversation_instance(UpsertAgentConversationInstance {
                instance_id: "instance-real".to_string(),
                agent_type: "codex".to_string(),
                initial_title: "Instance replacement".to_string(),
                thread_id: Some("thread-instance-replacement".to_string()),
                runtime_config: None,
                source: AgentConversationSource {
                    kind: "thread-card".to_string(),
                    document_path: None,
                    memo_id: None,
                    notebook_id: None,
                },
                role: None,
                created_at: None,
                updated_at: None,
            })
            .await
            .expect("bind real instance");

        let instances = manager
            .list_agent_conversation_instances()
            .await
            .expect("list instances");
        assert_eq!(instances.len(), 1);
        assert_eq!(instances[0].instance_id, "instance-real");

        let conn = manager.lock_conn();
        let indexed_instance: String = conn
            .query_row(
                "SELECT instance_id FROM threads_index WHERE id = ?1",
                ["thread-instance-replacement"],
                |row| row.get(0),
            )
            .expect("read index owner");
        assert_eq!(indexed_instance, "instance-real");
        let temporary_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_instances WHERE id = ?1",
                ["legacy-thread-instance-replacement"],
                |row| row.get(0),
            )
            .expect("count temporary instance");
        assert_eq!(temporary_count, 0);
    }

    #[tokio::test]
    async fn deleting_an_instance_preserves_its_product_thread_and_provider_binding() {
        let manager = ThreadManager::for_tests();
        manager
            .upsert_agent_conversation_instance(UpsertAgentConversationInstance {
                instance_id: "instance-delete".to_string(),
                agent_type: "codex".to_string(),
                initial_title: "Delete instance".to_string(),
                thread_id: Some("thread-delete-instance".to_string()),
                runtime_config: None,
                source: AgentConversationSource {
                    kind: "thread-card".to_string(),
                    document_path: None,
                    memo_id: None,
                    notebook_id: None,
                },
                role: None,
                created_at: None,
                updated_at: None,
            })
            .await
            .expect("create instance");
        manager
            .upsert_external_session(
                "thread-delete-instance",
                "codex",
                "codex-delete-instance",
                None,
            )
            .await
            .expect("bind provider thread");

        assert!(manager
            .delete_agent_conversation_instance("instance-delete")
            .await
            .expect("delete instance"));
        assert!(manager
            .get_thread_info("thread-delete-instance")
            .await
            .expect("read product thread")
            .is_some());
        assert_eq!(
            manager
                .get_external_session("thread-delete-instance", "codex")
                .await
                .expect("read provider binding")
                .as_deref(),
            Some("codex-delete-instance")
        );
    }

    #[test]
    fn migration_adds_missing_external_session_metadata_column() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("thread.db");
        {
            let conn = rusqlite::Connection::open(&db_path).expect("open legacy db");
            conn.execute_batch(
                "
                CREATE TABLE threads (
                    thread_id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE thread_external_sessions (
                    thread_id TEXT NOT NULL,
                    runtime TEXT NOT NULL,
                    external_session_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (thread_id, runtime),
                    UNIQUE (runtime, external_session_id)
                );
                ",
            )
            .expect("seed legacy external-session table");
        }

        let manager = ThreadManager::new(db_path).expect("migrate legacy db");
        let conn = manager.lock_conn();
        let columns = conn
            .prepare("PRAGMA table_info(thread_external_sessions)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(columns
            .iter()
            .any(|column| column == "session_metadata_json"));
    }

    #[tokio::test]
    async fn migration_backfills_dedicated_frozen_cwd_from_legacy_json() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("thread.db");
        {
            let conn = rusqlite::Connection::open(&db_path).expect("open legacy db");
            conn.execute_batch(
                r#"
                CREATE TABLE agent_conversation_instances (
                    instance_id TEXT PRIMARY KEY,
                    agent_type TEXT NOT NULL,
                    title TEXT NOT NULL,
                    thread_id TEXT,
                    runtime_config TEXT,
                    source_kind TEXT NOT NULL DEFAULT 'thread-card',
                    source_document_path TEXT,
                    source_memo_id TEXT,
                    source_notebook_id TEXT,
                    role_memo_id TEXT,
                    role_name TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE threads (
                    thread_id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                INSERT INTO threads (thread_id, agent_id, title, created_at, updated_at) VALUES
                    ('thread-legacy-frozen', 'claude', 'legacy', 1, 1),
                    ('thread-snapshot-fallback', 'claude', 'snapshot', 1, 1);
                INSERT INTO agent_conversation_instances (
                    instance_id, agent_type, title, thread_id, runtime_config,
                    source_kind, source_notebook_id, created_at, updated_at
                ) VALUES
                    ('legacy-frozen', 'claude', 'legacy', 'thread-legacy-frozen',
                     '{"frozenCwd":"/legacy/frozen","workspaceSnapshot":{"cwd":"/snapshot/ignored"}}',
                     'thread-card', 'notebook-legacy', 1, 1),
                    ('snapshot-fallback', 'claude', 'snapshot', 'thread-snapshot-fallback',
                     '{"workspaceSnapshot":{"cwd":"/snapshot/recovered"}}',
                     'thread-card', 'notebook-snapshot', 1, 1);
                "#,
            )
            .expect("seed legacy conversation table");
        }

        let manager = Arc::new(ThreadManager::new(db_path).expect("migrate legacy db"));
        let legacy = manager
            .find_agent_conversation_by_thread_id("thread-legacy-frozen")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(legacy.frozen_cwd.as_deref(), Some("/legacy/frozen"));
        assert_eq!(
            legacy.source.notebook_id.as_deref(),
            Some("notebook-legacy")
        );
        let legacy_config: serde_json::Value =
            serde_json::from_str(legacy.runtime_config.as_deref().unwrap()).unwrap();
        assert!(legacy_config.get("frozenCwd").is_none());

        let recovered = manager
            .find_agent_conversation_by_thread_id("thread-snapshot-fallback")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(recovered.frozen_cwd.as_deref(), Some("/snapshot/recovered"));
        assert_eq!(
            recovered.source.notebook_id.as_deref(),
            Some("notebook-snapshot")
        );
    }

    #[tokio::test]
    async fn external_event_insert_creates_missing_product_thread() {
        let manager = ThreadManager::for_tests();
        manager
            .insert_agent_external_event(NewAgentExternalEvent {
                runtime: "test-runtime".to_string(),
                thread_id: "external-event-first".to_string(),
                normalized_json: r#"{"kind":"text"}"#.to_string(),
                raw_json: None,
                created_at: Some(1),
            })
            .await
            .unwrap();

        let thread = manager
            .get_thread_info("external-event-first")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(thread.agent_id.0, "test-runtime");
    }

    #[tokio::test]
    async fn external_event_log_is_pruned_per_thread() {
        let manager = ThreadManager::for_tests();
        {
            let mut conn = manager.lock_conn();
            let tx = conn.transaction().expect("start seed transaction");
            tx.execute(
                "INSERT INTO threads (thread_id, agent_id, title, created_at, updated_at)
                 VALUES ('external-pruned-events', 'test-runtime', 'External thread', 0, 0)",
                [],
            )
            .expect("seed thread");
            {
                let mut insert = tx
                    .prepare(
                        "INSERT INTO agent_external_events (
                            runtime, thread_id, normalized_json, raw_json, created_at
                         ) VALUES ('test-runtime', 'external-pruned-events', ?1, NULL, ?2)",
                    )
                    .expect("prepare event insert");
                for i in 0..10_000_i64 {
                    insert
                        .execute(params![format!(r#"{{"kind":"text","i":{i}}}"#), i])
                        .expect("seed event");
                }
            }
            tx.commit().expect("commit seeded events");
        }

        for i in 10_000..10_005 {
            manager
                .insert_agent_external_event(NewAgentExternalEvent {
                    runtime: "test-runtime".to_string(),
                    thread_id: "external-pruned-events".to_string(),
                    normalized_json: format!(r#"{{"kind":"text","i":{i}}}"#),
                    raw_json: None,
                    created_at: Some(i),
                })
                .await
                .unwrap();
        }

        let conn = manager.lock_conn();
        // 排除 prune 追加的 history_truncated marker (非真实 event), 验证保留的最新 10000 条 real event。
        let (count, min_created_at, max_created_at): (i64, i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), MIN(created_at), MAX(created_at)
                 FROM agent_external_events
                 WHERE thread_id = 'external-pruned-events'
                   AND normalized_json <> ?1",
                params![r#"{"kind":"history_truncated","version":1}"#],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(count, 10_000);
        assert_eq!(min_created_at, 5);
        assert_eq!(max_created_at, 10_004);
    }

    #[tokio::test]
    async fn external_identity_migration_folds_canonical_thread_into_product_thread() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("thread.db");
        {
            let conn = rusqlite::Connection::open(&db_path).expect("open legacy db");
            conn.execute_batch(
                "
                CREATE TABLE threads (
                    thread_id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE thread_external_sessions (
                    thread_id TEXT NOT NULL,
                    runtime TEXT NOT NULL,
                    external_session_id TEXT,
                    session_metadata_json TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (thread_id, runtime),
                    FOREIGN KEY(thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
                );
                CREATE TABLE agent_conversation_instances (
                    instance_id TEXT PRIMARY KEY,
                    agent_type TEXT NOT NULL,
                    title TEXT NOT NULL,
                    thread_id TEXT,
                    runtime_config TEXT,
                    source_kind TEXT NOT NULL DEFAULT 'thread-card',
                    source_document_path TEXT,
                    source_memo_id TEXT,
                    role_memo_id TEXT,
                    role_name TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE agent_external_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    runtime TEXT NOT NULL,
                    thread_id TEXT NOT NULL,
                    normalized_json TEXT NOT NULL,
                    raw_json TEXT,
                    created_at INTEGER NOT NULL
                );
                INSERT INTO threads VALUES
                    ('codex-local-card-3', 'codex', 'Codex session', 1, 1),
                    ('019f-test-canonical-migrate', 'codex', 'Migrated title', 2, 9);
                INSERT INTO thread_external_sessions VALUES
                    ('codex-local-card-3', 'codex', '019f-test-canonical-migrate', '{\"alias\":true}', 3, 4),
                    ('019f-test-canonical-migrate', 'codex', '019f-test-canonical-migrate', '{\"self\":true}', 5, 6);
                INSERT INTO agent_conversation_instances (
                    instance_id, agent_type, title, thread_id, runtime_config,
                    source_kind, source_document_path, source_memo_id,
                    role_memo_id, role_name, created_at, updated_at
                ) VALUES (
                    'instance-1', 'codex', 'Migrated title',
                    '019f-test-canonical-migrate', NULL,
                    'thread-card', NULL, NULL, NULL, NULL, 7, 8
                );
                INSERT INTO agent_external_events (
                    id, runtime, thread_id, normalized_json, raw_json, created_at
                ) VALUES
                    (11, 'codex', '019f-test-canonical-migrate', '{\"kind\":\"canonical\"}', NULL, 11),
                    (12, 'codex', 'codex-local-card-3', '{\"kind\":\"local\"}', NULL, 12);
                ",
            )
            .expect("seed legacy identity tables");
        }

        let manager = Arc::new(ThreadManager::new(db_path).expect("migrate db"));

        assert!(manager
            .get_thread_info("019f-test-canonical-migrate")
            .await
            .unwrap()
            .is_none());
        let local = manager
            .get_thread_info("codex-local-card-3")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(local.title, "Migrated title");
        assert_eq!(
            manager
                .get_external_session("codex-local-card-3", "codex")
                .await
                .unwrap()
                .as_deref(),
            Some("019f-test-canonical-migrate")
        );
        assert_eq!(
            manager
                .find_thread_by_external_session("019f-test-canonical-migrate", "codex")
                .await
                .unwrap()
                .as_deref(),
            Some("codex-local-card-3")
        );
        let instances = manager.list_agent_conversation_instances().await.unwrap();
        assert_eq!(instances.len(), 1);
        assert_eq!(
            instances[0].thread_id.as_deref(),
            Some("codex-local-card-3")
        );
        let events = manager
            .list_agent_external_events_by_thread("codex-local-card-3", None, 10)
            .await
            .unwrap();
        assert_eq!(events.len(), 2);
        assert!(events
            .iter()
            .all(|event| event.thread_id == "codex-local-card-3"));
        let listed = manager.list_external_threads("codex").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].thread_id, "codex-local-card-3");
    }

    #[tokio::test]
    async fn external_identity_migration_deduplicates_instances_before_canonicalizing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("thread.db");
        {
            let conn = rusqlite::Connection::open(&db_path).expect("open db");
            conn.execute_batch(
                "
                PRAGMA foreign_keys = ON;
                CREATE TABLE threads (
                    thread_id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE thread_external_sessions (
                    thread_id TEXT NOT NULL,
                    runtime TEXT NOT NULL,
                    external_session_id TEXT NOT NULL,
                    session_metadata_json TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (thread_id, runtime),
                    UNIQUE (runtime, external_session_id),
                    FOREIGN KEY(thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
                );
                CREATE TABLE agent_conversation_instances (
                    instance_id TEXT PRIMARY KEY,
                    agent_type TEXT NOT NULL,
                    thread_id TEXT,
                    runtime_config TEXT,
                    frozen_cwd TEXT,
                    source_kind TEXT NOT NULL DEFAULT 'thread-card',
                    source_document_path TEXT,
                    source_memo_id TEXT,
                    role_memo_id TEXT,
                    role_name TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    FOREIGN KEY(thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
                );
                CREATE INDEX idx_agent_conversation_thread
                    ON agent_conversation_instances(thread_id);
                CREATE UNIQUE INDEX idx_agent_conversation_thread_unique
                    ON agent_conversation_instances(thread_id)
                    WHERE thread_id IS NOT NULL;
                CREATE TABLE agent_external_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    runtime TEXT NOT NULL,
                    thread_id TEXT NOT NULL,
                    event_key TEXT,
                    normalized_json TEXT NOT NULL,
                    raw_json TEXT,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY(thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
                );
                INSERT INTO threads VALUES
                    ('codex-local-thread', 'codex', 'Local title', 1, 9),
                    ('codex-provider-thread', 'codex', 'Provider title', 2, 10);
                INSERT INTO thread_external_sessions VALUES
                    ('codex-local-thread', 'codex', 'codex-provider-thread', NULL, 1, 10);
                INSERT INTO agent_conversation_instances VALUES
                    ('local-instance', 'codex', 'codex-local-thread', NULL, NULL,
                     'thread-card', NULL, NULL, NULL, NULL, 1, 10),
                    ('provider-instance', 'codex', 'codex-provider-thread', NULL, NULL,
                     'thread-card', NULL, 'memo-1', NULL, NULL, 2, 10);
                ",
            )
            .expect("seed duplicate identity records");
        }

        let manager = Arc::new(ThreadManager::new(db_path).expect("migrate duplicate identities"));
        let instances = manager.list_agent_conversation_instances().await.unwrap();

        assert_eq!(instances.len(), 1);
        assert_eq!(instances[0].instance_id, "provider-instance");
        assert_eq!(
            instances[0].thread_id.as_deref(),
            Some("codex-local-thread")
        );
        assert_eq!(instances[0].source.memo_id.as_deref(), Some("memo-1"));
    }

    #[tokio::test]
    async fn deleting_external_thread_removes_session_mapping_and_events() {
        let manager = ThreadManager::for_tests();
        manager
            .upsert_external_session("codex-local-delete", "codex", "019f-delete-session", None)
            .await
            .unwrap();
        manager
            .insert_agent_external_event(NewAgentExternalEvent {
                runtime: "test-runtime".to_string(),
                thread_id: "codex-local-delete".to_string(),
                normalized_json: r#"{"kind":"text"}"#.to_string(),
                raw_json: None,
                created_at: Some(1),
            })
            .await
            .unwrap();

        assert!(manager
            .delete_thread_with_agent_conversations("codex-local-delete")
            .await
            .unwrap());
        assert!(manager
            .get_external_session("codex-local-delete", "codex")
            .await
            .unwrap()
            .is_none());
        assert!(manager
            .list_agent_external_events_by_thread("codex-local-delete", None, 10)
            .await
            .unwrap()
            .is_empty());
    }
}
