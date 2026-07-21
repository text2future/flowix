#[cfg(test)]
mod tests {
    use crate::agent_session::store::ThreadManager;
    use crate::agent_session::types::{ChatMessage, NewAgentExternalEvent};
    use crate::agent_types::AgentId;
    use rusqlite::params;

    fn make_message(id: &str, role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            id: id.to_string(),
            role: role.to_string(),
            content: content.to_string(),
            llm_content: None,
            system_reminder_directory: None,
            timestamp: "2026-06-21T00:00:00Z".to_string(),
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

    async fn seed_thread(manager: &ThreadManager, thread_id: &str, n_messages: usize) {
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
        assert_eq!(page.oldest_sequence, Some(16)); // msg-15 閺勵垳顑?16 閺?(sequence 娴?1 鐠?
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
        assert!(
            !page.has_more,
            "閸忋劑鍎撮幏澶婄暚鐏忚鲸鐥呴張澶嬫纯閺冣晛宸婚崣?"
        );
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
        let listed = manager.list_external_threads("codex").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].thread_id, "codex-local-card-1");
        assert_eq!(listed[0].title, "Product database title");
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
            runtime: "codex".to_string(),
            thread_id: "thread-1".to_string(),
            normalized_json: r#"{"kind":"text","text":"hello"}"#.to_string(),
            raw_json: Some(r#"{"type":"event_msg"}"#.to_string()),
            created_at: Some(100),
        };
        let second = NewAgentExternalEvent {
            normalized_json: r#"{"kind":"tool_call","id":"call-1"}"#.to_string(),
            created_at: Some(101),
            ..first.clone()
        };

        let id1 = manager
            .insert_agent_external_event(first)
            .await
            .expect("insert first event");
        let id2 = manager
            .insert_agent_external_event(second)
            .await
            .expect("insert second event");

        assert!(id1 > 0);
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

        let delta = manager
            .list_agent_external_events_by_thread("thread-1", Some(id1), 10)
            .await
            .expect("list delta events");
        assert_eq!(delta.len(), 1);
        assert_eq!(delta[0].id, id2);
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

        let manager = ThreadManager::new(db_path).expect("migrate legacy db");
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
    async fn migrations_set_thread_db_user_version() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("thread.db");
        let manager = ThreadManager::new(db_path.clone()).expect("migrate db");
        drop(manager);

        let conn = rusqlite::Connection::open(&db_path).expect("open migrated db");
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(version, 1);
    }

    #[tokio::test]
    async fn external_event_insert_creates_missing_product_thread() {
        let manager = ThreadManager::for_tests();
        manager
            .insert_agent_external_event(NewAgentExternalEvent {
                runtime: "codex".to_string(),
                thread_id: "codex-event-first".to_string(),
                normalized_json: r#"{"kind":"text"}"#.to_string(),
                raw_json: None,
                created_at: Some(1),
            })
            .await
            .unwrap();

        let thread = manager
            .get_thread_info("codex-event-first")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(thread.agent_id.0, "codex");
    }

    #[tokio::test]
    async fn external_event_log_is_pruned_per_thread() {
        let manager = ThreadManager::for_tests();
        for i in 0..10_005 {
            manager
                .insert_agent_external_event(NewAgentExternalEvent {
                    runtime: "codex".to_string(),
                    thread_id: "codex-pruned-events".to_string(),
                    normalized_json: format!(r#"{{"kind":"text","i":{i}}}"#),
                    raw_json: None,
                    created_at: Some(i),
                })
                .await
                .unwrap();
        }

        let conn = manager.lock_conn();
        let (count, min_created_at, max_created_at): (i64, i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), MIN(created_at), MAX(created_at)
                 FROM agent_external_events
                 WHERE thread_id = 'codex-pruned-events'",
                [],
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

        let manager = ThreadManager::new(db_path).expect("migrate db");

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
    async fn deleting_external_thread_removes_session_mapping_and_events() {
        let manager = ThreadManager::for_tests();
        manager
            .upsert_external_session("codex-local-delete", "codex", "019f-delete-session", None)
            .await
            .unwrap();
        manager
            .insert_agent_external_event(NewAgentExternalEvent {
                runtime: "codex".to_string(),
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
