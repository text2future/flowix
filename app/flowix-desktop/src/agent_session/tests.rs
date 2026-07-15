#[cfg(test)]
mod tests {
    use crate::agent_session::store::ThreadManager;
    use crate::agent_session::types::ChatMessage;
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
        assert_eq!(page.oldest_sequence, Some(16)); // msg-15 鏄 16 鏉?(sequence 浠?1 璧?
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
}
