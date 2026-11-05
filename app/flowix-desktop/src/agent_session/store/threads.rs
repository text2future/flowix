//! Thread CRUD and title management.

use super::external::find_product_thread_in_conn;
use super::ThreadManager;
use crate::agent_session::error::ThreadError;
use crate::agent_session::types::{Thread, ThreadInfo};
use crate::agent_types::AgentId;
use rusqlite::{params, Connection, OptionalExtension};
use std::sync::Arc;

impl ThreadManager {
    pub async fn list_threads(self: &Arc<Self>) -> Result<Vec<ThreadInfo>, ThreadError> {
        self.run_blocking(move |tm| tm.list_threads_inner()).await
    }

    fn list_threads_inner(&self) -> Result<Vec<ThreadInfo>, ThreadError> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT ti.id, i.agent, ti.title, ti.created_at, ti.updated_at
             FROM threads_index ti
             JOIN agent_instances i ON i.id = ti.instance_id
             WHERE i.agent = 'default'
             ORDER BY ti.updated_at DESC",
        )?;
        let rows = stmt.query_map([], Self::row_to_thread_info)?;

        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub async fn list_threads_by_agent(
        self: &Arc<Self>,
        agent_id: &str,
    ) -> Result<Vec<ThreadInfo>, ThreadError> {
        let agent_id = agent_id.to_string();
        self.run_blocking(move |tm| tm.list_threads_by_agent_inner(&agent_id))
            .await
    }

    fn list_threads_by_agent_inner(&self, agent_id: &str) -> Result<Vec<ThreadInfo>, ThreadError> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT ti.id, i.agent, ti.title, ti.created_at, ti.updated_at
             FROM threads_index ti
             JOIN agent_instances i ON i.id = ti.instance_id
             WHERE i.agent = ?1
             ORDER BY ti.updated_at DESC",
        )?;
        let rows = stmt.query_map([agent_id], Self::row_to_thread_info)?;

        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub async fn list_external_threads(
        self: &Arc<Self>,
        runtime: &str,
    ) -> Result<Vec<ThreadInfo>, ThreadError> {
        let runtime = runtime.to_string();
        self.run_blocking(move |tm| tm.list_external_threads_inner(&runtime))
            .await
    }

    fn list_external_threads_inner(&self, runtime: &str) -> Result<Vec<ThreadInfo>, ThreadError> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT ti.id, i.agent, ti.title, ti.created_at, ti.updated_at
             FROM threads_index ti
             JOIN agent_instances i ON i.id = ti.instance_id
             WHERE i.agent = ?1
             ORDER BY ti.updated_at DESC",
        )?;
        let rows = stmt.query_map([runtime], Self::row_to_thread_info)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub async fn create_thread(
        self: &Arc<Self>,
        agent_id: AgentId,
        title: String,
    ) -> Result<ThreadInfo, ThreadError> {
        self.run_blocking(move |tm| tm.create_thread_inner(agent_id, title))
            .await
    }

    fn create_thread_inner(
        &self,
        agent_id: AgentId,
        title: String,
    ) -> Result<ThreadInfo, ThreadError> {
        let now = chrono::Utc::now().timestamp_millis();
        let thread_id = format!("thread_{}", uuid::Uuid::new_v4());

        let info = ThreadInfo {
            thread_id: thread_id.clone(),
            agent_id,
            title,
            created_at: now,
            updated_at: now,
        };

        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO threads (thread_id, agent_id, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                info.thread_id,
                info.agent_id.0,
                info.title,
                info.created_at,
                info.updated_at
            ],
        )?;
        self.ensure_simplified_thread_index(&conn, &info.thread_id)?;

        Ok(info)
    }

    pub async fn ensure_thread(
        self: &Arc<Self>,
        thread_id: &str,
        agent_id: AgentId,
        title: String,
    ) -> Result<ThreadInfo, ThreadError> {
        let thread_id = thread_id.to_string();
        self.run_blocking(move |tm| tm.ensure_thread_inner(&thread_id, agent_id, title))
            .await
    }

    fn ensure_thread_inner(
        &self,
        thread_id: &str,
        agent_id: AgentId,
        title: String,
    ) -> Result<ThreadInfo, ThreadError> {
        // Internal call redirected to the sync `_inner` (the async wrapper would
        // require `&Arc<Self>`, unavailable here where `self: &ThreadManager`).
        if let Some(thread) = self.get_thread_info_inner(thread_id)? {
            let conn = self.lock_conn();
            self.ensure_simplified_thread_index(&conn, thread_id)?;
            return Ok(thread);
        }

        let now = chrono::Utc::now().timestamp_millis();
        let info = ThreadInfo {
            thread_id: thread_id.to_string(),
            agent_id,
            title,
            created_at: now,
            updated_at: now,
        };

        let conn = self.lock_conn();
        conn.execute(
            "INSERT OR IGNORE INTO threads (thread_id, agent_id, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                info.thread_id,
                info.agent_id.0,
                info.title,
                info.created_at,
                info.updated_at
            ],
        )?;
        self.ensure_simplified_thread_index(&conn, thread_id)?;

        Ok(self
            .get_thread_info_with_conn(&conn, thread_id)?
            .unwrap_or(info))
    }

    pub async fn get_thread(
        self: &Arc<Self>,
        thread_id: &str,
    ) -> Result<Option<Thread>, ThreadError> {
        let thread_id = thread_id.to_string();
        self.run_blocking(move |tm| tm.get_thread_inner(&thread_id))
            .await
    }

    fn get_thread_inner(&self, thread_id: &str) -> Result<Option<Thread>, ThreadError> {
        let conn = self.lock_conn();
        let info = conn
            .query_row(
                "SELECT thread_id, agent_id, title, created_at, updated_at
                 FROM threads
                 WHERE thread_id = ?1",
                [thread_id],
                |row| {
                    Ok(ThreadInfo {
                        thread_id: row.get(0)?,
                        agent_id: AgentId(row.get(1)?),
                        title: row.get(2)?,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
                },
            )
            .optional()?;

        let Some(info) = info else {
            return Ok(None);
        };

        let mut stmt = conn.prepare(
            "SELECT id, role, content, llm_content, system_reminder_directory, timestamp,
                    is_loading, tool_call_id, tool_name, tool_data, tool_input, tool_calls, reasoning,
                    is_completed, is_collapsed
             FROM thread_messages
             WHERE thread_id = ?1
             ORDER BY sequence ASC",
        )?;
        let rows = stmt.query_map([thread_id], Self::row_to_message)?;
        let messages = rows.collect::<Result<Vec<_>, _>>()?;

        Ok(Some(Thread { info, messages }))
    }

    pub async fn get_thread_info(
        self: &Arc<Self>,
        thread_id: &str,
    ) -> Result<Option<ThreadInfo>, ThreadError> {
        let thread_id = thread_id.to_string();
        self.run_blocking(move |tm| tm.get_thread_info_inner(&thread_id))
            .await
    }

    fn get_thread_info_inner(&self, thread_id: &str) -> Result<Option<ThreadInfo>, ThreadError> {
        let conn = self.lock_conn();
        self.get_thread_info_with_conn(&conn, thread_id)
    }
    pub async fn update_title(
        self: &Arc<Self>,
        thread_id: &str,
        title: String,
        agent_id: AgentId,
    ) -> Result<Option<ThreadInfo>, ThreadError> {
        let thread_id = thread_id.to_string();
        self.run_blocking(move |tm| tm.update_title_inner(&thread_id, title, agent_id))
            .await
    }

    fn update_title_inner(
        &self,
        thread_id: &str,
        title: String,
        agent_id: AgentId,
    ) -> Result<Option<ThreadInfo>, ThreadError> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut conn = self.lock_conn();
        let tx = conn.transaction()?;
        let target_thread_id = find_product_thread_in_conn(&tx, agent_id.0.as_str(), thread_id)?
            .unwrap_or_else(|| thread_id.to_string());
        tx.execute(
            "INSERT INTO threads (thread_id, agent_id, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(thread_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at",
            params![target_thread_id, agent_id.0, title, now],
        )?;
        tx.execute(
            "UPDATE agent_conversation_instances SET updated_at = max(updated_at, ?1)
             WHERE thread_id = ?2",
            params![now, target_thread_id],
        )?;
        self.ensure_simplified_thread_index(&tx, &target_thread_id)?;
        // Keep SELECT inside the same std::sync::MutexGuard. ThreadManager uses
        // synchronous rusqlite calls internally; async signatures are kept for
        // upper-layer API consistency.
        let info = tx
            .query_row(
                "SELECT thread_id, agent_id, title, created_at, updated_at
                 FROM threads
                 WHERE thread_id = ?1",
                [&target_thread_id],
                |row| {
                    Ok(ThreadInfo {
                        thread_id: row.get(0)?,
                        agent_id: AgentId(row.get(1)?),
                        title: row.get(2)?,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
                },
            )
            .optional()?;
        tx.commit()?;
        Ok(info)
    }
    fn get_thread_info_with_conn(
        &self,
        conn: &Connection,
        thread_id: &str,
    ) -> Result<Option<ThreadInfo>, ThreadError> {
        Ok(conn
            .query_row(
                "SELECT thread_id, agent_id, title, created_at, updated_at
                 FROM threads
                 WHERE thread_id = ?1",
                [thread_id],
                |row| {
                    Ok(ThreadInfo {
                        thread_id: row.get(0)?,
                        agent_id: AgentId(row.get(1)?),
                        title: row.get(2)?,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
                },
            )
            .optional()?)
    }
    fn row_to_thread_info(row: &rusqlite::Row<'_>) -> rusqlite::Result<ThreadInfo> {
        Ok(ThreadInfo {
            thread_id: row.get(0)?,
            agent_id: AgentId(row.get(1)?),
            title: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
        })
    }
}
