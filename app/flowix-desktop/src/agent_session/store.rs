//! ThreadManager — single SQLite facade for three tables:
//!   1. threads / thread_messages  (chat thread + history)
//!   2. thread_external_sessions  (thread ↔ codex/claude/hermes session id)
//!   3. agent_conversation_instances / _run_state (persona + run metadata)
//!
//! All three share a single `Mutex<Connection>`, so this module
//! intentionally stays as one `impl ThreadManager` block — splitting
//! per-table would break the cross-table transaction in
//! `delete_thread_with_agent_conversations` and force every method
//! to plumb `&Connection` through the public API. The implementation
//! is grouped into sections via `// === ... ===` comment headers
//! instead.

use rusqlite::{params, Connection, OptionalExtension};
use std::path::PathBuf;
use std::sync::Mutex;

use super::error::ThreadError;
use super::types::*;
use crate::agent_types::AgentId;

pub struct ThreadManager {
    conn: Mutex<Connection>,
}

fn external_default_title(runtime: &str) -> &'static str {
    match runtime {
        "claude" => "Claude Code session",
        "hermes" => "Hermes session",
        _ => "Codex session",
    }
}

fn is_default_external_title(title: &str) -> bool {
    matches!(
        title.trim().to_lowercase().as_str(),
        "codex session"
            | "codex 会话"
            | "claude code session"
            | "claude code 会话"
            | "hermes session"
    )
}

impl ThreadManager {
    /// 测试用 fixture ── 不写磁盘, 用 `Connection::open_in_memory()` 建一个空库。
    /// `agent.rs::for_tests` 用它, 因为单元测试只验证 `AgentManager` 内部 HashMap
    /// 状态, 不真正读写 thread 库。
    #[cfg(test)]
    pub fn for_tests() -> Self {
        Self::new_in_memory().expect("in-memory migrations failed")
    }

    pub fn new(db_path: PathBuf) -> Result<Self, ThreadError> {
        let conn = Connection::open(db_path)?;
        Self::run_migrations(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn new_in_memory() -> Result<Self, ThreadError> {
        let conn = Connection::open_in_memory()?;
        Self::run_migrations(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn run_migrations(conn: &Connection) -> Result<(), ThreadError> {
        conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS threads (
                thread_id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                title TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS thread_messages (
                id TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                llm_content TEXT,
                system_reminder_directory TEXT,
                timestamp TEXT NOT NULL,
                is_loading INTEGER,
                tool_call_id TEXT,
                tool_name TEXT,
                tool_data TEXT,
                tool_input TEXT,
                tool_calls TEXT,
                reasoning TEXT,
                is_completed INTEGER,
                is_collapsed INTEGER,
                sequence INTEGER NOT NULL,
                FOREIGN KEY(thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_sequence
                ON thread_messages(thread_id, sequence);

            CREATE TABLE IF NOT EXISTS thread_external_sessions (
                thread_id TEXT NOT NULL,
                runtime TEXT NOT NULL,
                external_session_id TEXT,
                metadata TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (thread_id, runtime),
                FOREIGN KEY(thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS agent_conversation_instances (
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

            CREATE INDEX IF NOT EXISTS idx_agent_conversation_thread
                ON agent_conversation_instances(thread_id);

            CREATE TABLE IF NOT EXISTS agent_conversation_run_state (
                instance_id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                status TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                ended_at INTEGER,
                current_tool TEXT,
                model TEXT,
                model_id TEXT,
                reasoning_effort TEXT,
                last_run_at INTEGER,
                reason TEXT,
                usage_json TEXT,
                status_info_json TEXT,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY(instance_id)
                    REFERENCES agent_conversation_instances(instance_id)
                    ON DELETE CASCADE
            );
            ",
        )?;

        // `threads.title` is the canonical product title. Older builds kept a
        // useful title only on the card instance while external threads were
        // inserted as the literal "Codex Session" (including Claude rows).
        // Repair that split-brain state idempotently, then align every bound
        // card snapshot with the canonical thread title.
        conn.execute_batch(
            "
            UPDATE threads
            SET title = (
                SELECT i.title
                FROM agent_conversation_instances i
                WHERE i.thread_id = threads.thread_id
                  AND trim(i.title) <> ''
                  AND lower(trim(i.title)) NOT IN (
                      'codex session', 'codex 会话',
                      'claude code session', 'claude code 会话'
                  )
                ORDER BY i.updated_at DESC
                LIMIT 1
            )
            WHERE lower(trim(title)) IN (
                'codex session', 'codex 会话',
                'claude code session', 'claude code 会话'
            )
              AND EXISTS (
                SELECT 1
                FROM agent_conversation_instances i
                WHERE i.thread_id = threads.thread_id
                  AND trim(i.title) <> ''
                  AND lower(trim(i.title)) NOT IN (
                      'codex session', 'codex 会话',
                      'claude code session', 'claude code 会话'
                  )
              );

            UPDATE agent_conversation_instances
            SET title = (
                    SELECT t.title FROM threads t
                    WHERE t.thread_id = agent_conversation_instances.thread_id
                ),
                updated_at = max(updated_at, (
                    SELECT t.updated_at FROM threads t
                    WHERE t.thread_id = agent_conversation_instances.thread_id
                ))
            WHERE thread_id IS NOT NULL
              AND EXISTS (
                  SELECT 1 FROM threads t
                  WHERE t.thread_id = agent_conversation_instances.thread_id
                    AND t.title <> agent_conversation_instances.title
              );
            ",
        )?;

        Ok(())
    }

    /// 加锁助手 ── 锁中毒 (panic held it) 时仍返回 guard, 不让单点 panic
    /// 阻断后续读写。所有写入都先落盘再更新内存, 这种窗口期极少。
    /// 错误级别用 `tracing::error!`, 与 `user_config.rs` 保持一致。
    pub(crate) fn lock_conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|poisoned| {
            tracing::error!("[ThreadManager] connection lock poisoned, recovering");
            poisoned.into_inner()
        })
    }

    pub async fn list_threads(&self) -> Result<Vec<ThreadInfo>, ThreadError> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT thread_id, agent_id, title, created_at, updated_at
             FROM threads
             WHERE agent_id = 'default'
             ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], Self::row_to_thread_info)?;

        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub async fn list_threads_by_agent(
        &self,
        agent_id: &str,
    ) -> Result<Vec<ThreadInfo>, ThreadError> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT thread_id, agent_id, title, created_at, updated_at
             FROM threads
             WHERE agent_id = ?1
             ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([agent_id], Self::row_to_thread_info)?;

        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Product-owned external conversations only. Alias rows such as
    /// `codex-local-*` remain in SQLite so an old document can resolve its
    /// session id, but are excluded from the visible conversation list.
    pub async fn list_external_threads(
        &self,
        runtime: &str,
    ) -> Result<Vec<ThreadInfo>, ThreadError> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT t.thread_id, t.agent_id, t.title, t.created_at, t.updated_at
             FROM threads t
             WHERE t.agent_id = ?1
               AND NOT EXISTS (
                   SELECT 1
                   FROM thread_external_sessions s
                   WHERE s.thread_id = t.thread_id
                     AND s.runtime = ?1
                     AND s.external_session_id IS NOT NULL
                     AND s.external_session_id <> t.thread_id
               )
             ORDER BY t.updated_at DESC",
        )?;
        let rows = stmt.query_map([runtime], Self::row_to_thread_info)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub async fn create_thread(
        &self,
        agent_id: AgentId,
        title: String,
    ) -> Result<ThreadInfo, ThreadError> {
        let now = chrono::Utc::now().timestamp_millis();
        let thread_id = format!("thread_{}", now);

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

        Ok(info)
    }

    pub async fn ensure_thread(
        &self,
        thread_id: &str,
        agent_id: AgentId,
        title: String,
    ) -> Result<ThreadInfo, ThreadError> {
        if let Some(thread) = self.get_thread_info(thread_id).await? {
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

        Ok(self
            .get_thread_info_with_conn(&conn, thread_id)?
            .unwrap_or(info))
    }

    pub async fn get_thread(&self, thread_id: &str) -> Result<Option<Thread>, ThreadError> {
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
        &self,
        thread_id: &str,
    ) -> Result<Option<ThreadInfo>, ThreadError> {
        let conn = self.lock_conn();
        self.get_thread_info_with_conn(&conn, thread_id)
    }

    /// Layer 4: 分页加载 thread 历史 ── 不再一次 SELECT 全部, 按 sequence DESC
    /// 取最近 `limit` 条, 在 Rust 侧 reverse 回 ASC 返回。`before_sequence`:
    ///   - None: 取最近 `limit` 条 (首次进入 thread)
    ///   - Some(s): 取 sequence < s 的最近 `limit` 条 (用户向上滚动加载更早历史)
    ///
    /// 返回 `(messages, oldest_sequence, has_more)`:
    ///   - oldest_sequence: 本批最早一条的 sequence, 用作下一页 cursor
    ///   - has_more: 是否还有更早的历史
    ///
    /// 不返回 ThreadInfo。前端 loadThread 可复用 thread_list 缓存里的 title。
    /// 这里专注 messages 分页, 保持单一职责。
    pub async fn get_thread_messages_page(
        &self,
        thread_id: &str,
        before_sequence: Option<i64>,
        limit: i64,
    ) -> Result<ThreadMessagesPage, ThreadError> {
        // Clamp defensively to avoid frontend mistakes such as 0 or huge limits.
        let limit = limit.clamp(1, 1000);
        let conn = self.lock_conn();

        // DESC + LIMIT uses the (thread_id, sequence) composite index and avoids OFFSET scans.
        let messages: Vec<(ChatMessage, i64)> = match before_sequence {
            Some(before) => {
                let mut stmt = conn.prepare(
                    "SELECT id, role, content, llm_content, system_reminder_directory, timestamp,
                            is_loading, tool_call_id, tool_name, tool_data, tool_input, tool_calls, reasoning,
                            is_completed, is_collapsed, sequence
                     FROM thread_messages
                     WHERE thread_id = ?1 AND sequence < ?2
                     ORDER BY sequence DESC LIMIT ?3",
                )?;
                let rows = stmt.query_map(
                    params![thread_id, before, limit],
                    Self::row_to_message_with_seq,
                )?;
                rows.collect::<Result<Vec<_>, _>>()?
            }
            None => {
                let mut stmt = conn.prepare(
                    "SELECT id, role, content, llm_content, system_reminder_directory, timestamp,
                            is_loading, tool_call_id, tool_name, tool_data, tool_input, tool_calls, reasoning,
                            is_completed, is_collapsed, sequence
                     FROM thread_messages
                     WHERE thread_id = ?1
                     ORDER BY sequence DESC LIMIT ?2",
                )?;
                let rows =
                    stmt.query_map(params![thread_id, limit], Self::row_to_message_with_seq)?;
                rows.collect::<Result<Vec<_>, _>>()?
            }
        };

        // Reverse back to ASC for the frontend. In DESC order, the last row has the oldest sequence.
        let oldest_sequence = messages.last().map(|(_, seq)| *seq);
        let mut messages_asc: Vec<ChatMessage> = messages.into_iter().map(|(m, _)| m).collect();
        messages_asc.reverse();

        // has_more: check whether rows exist before oldest_sequence. COUNT is index-covered.
        let has_more = if let Some(oldest) = oldest_sequence {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM thread_messages WHERE thread_id = ?1 AND sequence < ?2",
                params![thread_id, oldest],
                |row| row.get(0),
            )?;
            count > 0
        } else {
            false
        };

        Ok(ThreadMessagesPage {
            messages: messages_asc,
            oldest_sequence,
            has_more,
        })
    }

    pub async fn add_message(
        &self,
        thread_id: &str,
        message: ChatMessage,
    ) -> Result<(), ThreadError> {
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.lock_conn();
        let sequence: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM thread_messages WHERE thread_id = ?1",
            [thread_id],
            |row| row.get(0),
        )?;

        conn.execute(
            "INSERT INTO thread_messages (
                id, thread_id, role, content, llm_content, system_reminder_directory, timestamp,
                is_loading, tool_call_id, tool_name, tool_data, tool_input, tool_calls, reasoning,
                is_completed, is_collapsed, sequence
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                message.id,
                thread_id,
                message.role,
                message.content,
                message.llm_content,
                message.system_reminder_directory,
                message.timestamp,
                opt_bool_to_int(message.is_loading),
                message.tool_call_id,
                message.tool_name,
                message.tool_data,
                message.tool_input.map(|v| v.to_string()),
                message.tool_calls.as_ref().map(|v| v.to_string()),
                message.reasoning,
                opt_bool_to_int(message.is_completed),
                opt_bool_to_int(message.is_collapsed),
                sequence,
            ],
        )?;
        self.touch_thread(&conn, thread_id, now)?;
        Ok(())
    }

    pub async fn update_tool_result(
        &self,
        thread_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        result_content: &str,
    ) -> Result<(), ThreadError> {
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE thread_messages
             SET content = ?1, tool_data = ?1, tool_name = ?2, is_loading = 0
             WHERE thread_id = ?3 AND role = 'tool' AND tool_call_id = ?4",
            params![result_content, tool_name, thread_id, tool_call_id],
        )?;
        self.touch_thread(&conn, thread_id, now)?;
        Ok(())
    }

    /// Only reset `is_loading = 0`; do not touch `content` / `tool_data` / `tool_name`.
    /// Used by `IsLoadingGuard` on error paths to unlock the UI spinner without
    /// overwriting a partially written tool result or bumping thread metadata.
    pub async fn clear_tool_loading(
        &self,
        thread_id: &str,
        tool_call_id: &str,
    ) -> Result<(), ThreadError> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE thread_messages SET is_loading = 0
             WHERE thread_id = ?1 AND role = 'tool' AND tool_call_id = ?2",
            params![thread_id, tool_call_id],
        )?;
        Ok(())
    }

    /// Startup cleanup: reset all `is_loading = 1` rows, regardless of role.
    ///
    /// This handles crashes after a tool_use row was persisted but before its
    /// tool_result arrived. The synchronous version is intentional: startup calls
    /// this before the Tauri runtime is available, and the work is a single SQLite UPDATE.
    /// Returns the affected row count for startup logging.
    pub fn clear_all_loading(&self) -> Result<u64, ThreadError> {
        let conn = self.lock_conn();
        let n = conn.execute(
            "UPDATE thread_messages SET is_loading = 0 WHERE is_loading = 1",
            [],
        )?;
        Ok(n as u64)
    }

    /// Overwrite the `tool_calls` JSON column of an existing message.
    /// Used by the agent's recovery loop to sanitize malformed
    /// `function.arguments` strings in place rather than delete-and-reinsert
    /// (which would disturb the message's `sequence` and confuse the
    /// reload on the next round). Returns true if the row was found and
    /// updated.
    pub async fn update_message_tool_calls(
        &self,
        thread_id: &str,
        message_id: &str,
        tool_calls_json: &serde_json::Value,
    ) -> Result<bool, ThreadError> {
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.lock_conn();
        let updated = conn.execute(
            "UPDATE thread_messages SET tool_calls = ?1
             WHERE thread_id = ?2 AND id = ?3",
            params![tool_calls_json.to_string(), thread_id, message_id],
        )?;
        if updated > 0 {
            self.touch_thread(&conn, thread_id, now)?;
        }
        Ok(updated > 0)
    }

    /// Update an assistant checkpoint in place. The Flowix agent uses this
    /// when a stream is interrupted after some text has already reached the
    /// UI: the partial assistant row is first inserted, then later marked
    /// completed or promoted to an assistant+tool_calls row if the resumed
    /// turn asks for a tool.
    pub async fn update_assistant_checkpoint(
        &self,
        thread_id: &str,
        message_id: &str,
        content: &str,
        is_completed: Option<bool>,
        tool_calls_json: Option<&serde_json::Value>,
        reasoning: Option<&str>,
    ) -> Result<bool, ThreadError> {
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.lock_conn();
        let updated = if let Some(tool_calls_json) = tool_calls_json {
            conn.execute(
                "UPDATE thread_messages
                 SET content = ?1, is_completed = ?2, tool_calls = ?3, reasoning = COALESCE(?4, reasoning)
                 WHERE thread_id = ?5 AND id = ?6 AND role = 'assistant'",
                params![
                    content,
                    opt_bool_to_int(is_completed),
                    tool_calls_json.to_string(),
                    reasoning,
                    thread_id,
                    message_id,
                ],
            )?
        } else {
            conn.execute(
                "UPDATE thread_messages
                 SET content = ?1, is_completed = ?2, reasoning = COALESCE(?3, reasoning)
                 WHERE thread_id = ?4 AND id = ?5 AND role = 'assistant'",
                params![
                    content,
                    opt_bool_to_int(is_completed),
                    reasoning,
                    thread_id,
                    message_id,
                ],
            )?
        };
        if updated > 0 {
            self.touch_thread(&conn, thread_id, now)?;
        }
        Ok(updated > 0)
    }

    pub async fn get_external_session(
        &self,
        thread_id: &str,
        runtime: &str,
    ) -> Result<Option<String>, ThreadError> {
        let conn = self.lock_conn();
        let session = conn
            .query_row(
                "SELECT external_session_id
                 FROM thread_external_sessions
                 WHERE thread_id = ?1 AND runtime = ?2",
                params![thread_id, runtime],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        Ok(session)
    }

    pub async fn find_thread_by_external_session(
        &self,
        external_session_id: &str,
        runtime: &str,
    ) -> Result<Option<String>, ThreadError> {
        let conn = self.lock_conn();
        let thread_id = conn
            .query_row(
                "SELECT thread_id
                 FROM thread_external_sessions
                 WHERE external_session_id = ?1 AND runtime = ?2
                 ORDER BY updated_at DESC
                 LIMIT 1",
                params![external_session_id, runtime],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(thread_id)
    }

    pub async fn upsert_external_session(
        &self,
        thread_id: &str,
        runtime: &str,
        external_session_id: &str,
        metadata: Option<serde_json::Value>,
    ) -> Result<(), ThreadError> {
        let now = chrono::Utc::now().timestamp_millis();
        let metadata = metadata.map(|v| v.to_string());
        let mut conn = self.lock_conn();
        let tx = conn.transaction()?;
        let default_title = external_default_title(runtime);
        tx.execute(
            "INSERT OR IGNORE INTO threads (thread_id, agent_id, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![thread_id, runtime, default_title, now],
        )?;

        let local_title = tx
            .query_row(
                "SELECT title FROM threads WHERE thread_id = ?1",
                [thread_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_else(|| default_title.to_string());
        let canonical_existing = tx
            .query_row(
                "SELECT title FROM threads WHERE thread_id = ?1",
                [external_session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let canonical_title = match canonical_existing.as_deref() {
            Some(title) if !is_default_external_title(title) => title.to_string(),
            _ if !is_default_external_title(&local_title) => local_title.clone(),
            Some(title) => title.to_string(),
            None => default_title.to_string(),
        };
        tx.execute(
            "INSERT INTO threads (thread_id, agent_id, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(thread_id) DO UPDATE SET
                agent_id = excluded.agent_id,
                title = CASE
                    WHEN lower(trim(threads.title)) IN (
                        'codex session', 'codex 会话',
                        'claude code session', 'claude code 会话',
                        'hermes session'
                    ) THEN excluded.title
                    ELSE threads.title
                END,
                updated_at = excluded.updated_at",
            params![external_session_id, runtime, canonical_title, now],
        )?;

        tx.execute(
            "INSERT INTO thread_external_sessions (
                thread_id, runtime, external_session_id, metadata, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(thread_id, runtime) DO UPDATE SET
                external_session_id = excluded.external_session_id,
                metadata = excluded.metadata,
                updated_at = excluded.updated_at",
            params![thread_id, runtime, external_session_id, metadata, now],
        )?;
        tx.execute(
            "INSERT INTO thread_external_sessions (
                thread_id, runtime, external_session_id, metadata, created_at, updated_at
             ) VALUES (?1, ?2, ?1, ?3, ?4, ?4)
             ON CONFLICT(thread_id, runtime) DO UPDATE SET
                external_session_id = excluded.external_session_id,
                metadata = COALESCE(excluded.metadata, thread_external_sessions.metadata),
                updated_at = excluded.updated_at",
            params![external_session_id, runtime, metadata, now],
        )?;
        tx.execute(
            "UPDATE agent_conversation_instances
             SET thread_id = ?1, title = ?2, updated_at = ?3
             WHERE thread_id = ?4",
            params![external_session_id, canonical_title, now, thread_id],
        )?;
        tx.execute(
            "UPDATE agent_conversation_instances
             SET title = ?1, updated_at = max(updated_at, ?2)
             WHERE thread_id = ?3 AND title <> ?1",
            params![canonical_title, now, external_session_id],
        )?;
        self.touch_thread(&tx, thread_id, now)?;
        self.touch_thread(&tx, external_session_id, now)?;
        tx.commit()?;
        Ok(())
    }

    pub async fn list_agent_conversation_instances(
        &self,
    ) -> Result<Vec<AgentConversationInstance>, ThreadError> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT
                i.instance_id, i.agent_type, i.title, i.thread_id, i.runtime_config,
                i.source_kind, i.source_document_path, i.source_memo_id,
                i.role_memo_id, i.role_name, i.created_at, i.updated_at,
                r.run_id, r.status, r.started_at, r.ended_at, r.current_tool,
                r.model, r.model_id, r.reasoning_effort,
                r.last_run_at, r.reason, r.usage_json, r.status_info_json
             FROM agent_conversation_instances i
             LEFT JOIN agent_conversation_run_state r ON r.instance_id = i.instance_id
             ORDER BY i.updated_at DESC",
        )?;
        let rows = stmt.query_map([], Self::row_to_agent_conversation_instance)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub async fn get_agent_conversation_instance(
        &self,
        instance_id: &str,
    ) -> Result<Option<AgentConversationInstance>, ThreadError> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT
                i.instance_id, i.agent_type, i.title, i.thread_id, i.runtime_config,
                i.source_kind, i.source_document_path, i.source_memo_id,
                i.role_memo_id, i.role_name, i.created_at, i.updated_at,
                r.run_id, r.status, r.started_at, r.ended_at, r.current_tool,
                r.model, r.model_id, r.reasoning_effort,
                r.last_run_at, r.reason, r.usage_json, r.status_info_json
             FROM agent_conversation_instances i
             LEFT JOIN agent_conversation_run_state r ON r.instance_id = i.instance_id
             WHERE i.instance_id = ?1",
            [instance_id],
            Self::row_to_agent_conversation_instance,
        )
        .optional()
        .map_err(ThreadError::from)
    }

    pub async fn find_agent_conversation_by_thread_id(
        &self,
        thread_id: &str,
    ) -> Result<Option<AgentConversationInstance>, ThreadError> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT
                i.instance_id, i.agent_type, i.title, i.thread_id, i.runtime_config,
                i.source_kind, i.source_document_path, i.source_memo_id,
                i.role_memo_id, i.role_name, i.created_at, i.updated_at,
                r.run_id, r.status, r.started_at, r.ended_at, r.current_tool,
                r.model, r.model_id, r.reasoning_effort,
                r.last_run_at, r.reason, r.usage_json, r.status_info_json
             FROM agent_conversation_instances i
             LEFT JOIN agent_conversation_run_state r ON r.instance_id = i.instance_id
             WHERE i.thread_id = ?1
             ORDER BY i.updated_at DESC
             LIMIT 1",
            [thread_id],
            Self::row_to_agent_conversation_instance,
        )
        .optional()
        .map_err(ThreadError::from)
    }

    pub async fn find_agent_conversation_by_run_id(
        &self,
        run_id: &str,
    ) -> Result<Option<AgentConversationInstance>, ThreadError> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT
                i.instance_id, i.agent_type, i.title, i.thread_id, i.runtime_config,
                i.source_kind, i.source_document_path, i.source_memo_id,
                i.role_memo_id, i.role_name, i.created_at, i.updated_at,
                r.run_id, r.status, r.started_at, r.ended_at, r.current_tool,
                r.model, r.model_id, r.reasoning_effort,
                r.last_run_at, r.reason, r.usage_json, r.status_info_json
             FROM agent_conversation_instances i
             INNER JOIN agent_conversation_run_state r ON r.instance_id = i.instance_id
             WHERE r.run_id = ?1
             ORDER BY i.updated_at DESC
             LIMIT 1",
            [run_id],
            Self::row_to_agent_conversation_instance,
        )
        .optional()
        .map_err(ThreadError::from)
    }

    pub async fn upsert_agent_conversation_instance(
        &self,
        input: UpsertAgentConversationInstance,
    ) -> Result<AgentConversationInstance, ThreadError> {
        let instance_id = input.instance_id.clone();
        let now = chrono::Utc::now().timestamp_millis();
        let created_at = input.created_at.unwrap_or(now);
        let updated_at = input.updated_at.unwrap_or(now);
        let source_kind = if input.source.kind.trim().is_empty() {
            "thread-card".to_string()
        } else {
            input.source.kind
        };
        let role_memo_id = input.role.as_ref().and_then(|role| role.memo_id.clone());
        let role_name = input.role.as_ref().and_then(|role| role.name.clone());
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO agent_conversation_instances (
                instance_id, agent_type, title, thread_id,
                runtime_config, source_kind, source_document_path, source_memo_id,
                role_memo_id, role_name, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(instance_id) DO UPDATE SET
                agent_type = excluded.agent_type,
                title = excluded.title,
                thread_id = excluded.thread_id,
                runtime_config = excluded.runtime_config,
                source_kind = excluded.source_kind,
                source_document_path = excluded.source_document_path,
                source_memo_id = excluded.source_memo_id,
                role_memo_id = excluded.role_memo_id,
                role_name = excluded.role_name,
                updated_at = excluded.updated_at",
            params![
                input.instance_id,
                input.agent_type,
                input.title,
                input.thread_id,
                input.runtime_config,
                source_kind,
                input.source.document_path,
                input.source.memo_id,
                role_memo_id,
                role_name,
                created_at,
                updated_at,
            ],
        )?;
        let instance = conn
            .query_row(
                "SELECT
                    i.instance_id, i.agent_type, i.title, i.thread_id, i.runtime_config,
                    i.source_kind, i.source_document_path, i.source_memo_id,
                    i.role_memo_id, i.role_name, i.created_at, i.updated_at,
                    r.run_id, r.status, r.started_at, r.ended_at, r.current_tool,
                    r.model, r.model_id, r.reasoning_effort,
                    r.last_run_at, r.reason, r.usage_json, r.status_info_json
                 FROM agent_conversation_instances i
                 LEFT JOIN agent_conversation_run_state r ON r.instance_id = i.instance_id
                 WHERE i.instance_id = ?1",
                [instance_id.as_str()],
                Self::row_to_agent_conversation_instance,
            )
            .optional()?;
        instance.ok_or_else(|| ThreadError::NotFound(instance_id))
    }

    pub async fn upsert_agent_conversation_run_state(
        &self,
        instance_id: &str,
        run: AgentConversationRun,
    ) -> Result<(), ThreadError> {
        let now = chrono::Utc::now().timestamp_millis();
        let usage_json = run
            .usage
            .as_ref()
            .and_then(|u| serde_json::to_string(u).ok());
        let status_info_json = run
            .status_info
            .as_ref()
            .and_then(|s| serde_json::to_string(s).ok());
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO agent_conversation_run_state (
                instance_id, run_id, status, started_at, ended_at, current_tool,
                model, model_id, reasoning_effort,
                last_run_at, reason, usage_json, status_info_json, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(instance_id) DO UPDATE SET
                run_id = excluded.run_id,
                status = excluded.status,
                started_at = excluded.started_at,
                ended_at = excluded.ended_at,
                current_tool = excluded.current_tool,
                model = excluded.model,
                model_id = excluded.model_id,
                reasoning_effort = excluded.reasoning_effort,
                last_run_at = excluded.last_run_at,
                reason = excluded.reason,
                usage_json = excluded.usage_json,
                status_info_json = excluded.status_info_json,
                updated_at = excluded.updated_at",
            params![
                instance_id,
                run.run_id,
                run.status,
                run.started_at,
                run.ended_at,
                run.current_tool,
                run.model,
                run.model_id,
                run.reasoning_effort,
                run.last_run_at,
                run.reason,
                usage_json,
                status_info_json,
                now,
            ],
        )?;
        conn.execute(
            "UPDATE agent_conversation_instances SET updated_at = ?1 WHERE instance_id = ?2",
            params![now, instance_id],
        )?;
        Ok(())
    }

    pub async fn delete_agent_conversation_instance(
        &self,
        instance_id: &str,
    ) -> Result<bool, ThreadError> {
        let conn = self.lock_conn();
        let deleted = conn.execute(
            "DELETE FROM agent_conversation_instances WHERE instance_id = ?1",
            [instance_id],
        )?;
        Ok(deleted > 0)
    }

    pub async fn delete_agent_conversation_instances_for_thread(
        &self,
        thread_id: &str,
    ) -> Result<u64, ThreadError> {
        let conn = self.lock_conn();
        let deleted = conn.execute(
            "DELETE FROM agent_conversation_instances WHERE thread_id = ?1",
            [thread_id],
        )?;
        Ok(deleted as u64)
    }

    pub async fn delete_thread_with_agent_conversations(
        &self,
        thread_id: &str,
    ) -> Result<bool, ThreadError> {
        let mut conn = self.lock_conn();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM agent_conversation_instances WHERE thread_id = ?1",
            [thread_id],
        )?;
        let deleted = tx.execute("DELETE FROM threads WHERE thread_id = ?1", [thread_id])?;
        tx.commit()?;
        Ok(deleted > 0)
    }

    pub async fn update_title(
        &self,
        thread_id: &str,
        title: String,
        agent_id: AgentId,
    ) -> Result<Option<ThreadInfo>, ThreadError> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut conn = self.lock_conn();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO threads (thread_id, agent_id, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(thread_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at",
            params![thread_id, agent_id.0, title, now],
        )?;
        let canonical_id = tx
            .query_row(
                "SELECT external_session_id
                 FROM thread_external_sessions
                 WHERE thread_id = ?1 AND external_session_id IS NOT NULL
                 ORDER BY updated_at DESC LIMIT 1",
                [thread_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_else(|| thread_id.to_string());
        tx.execute(
            "UPDATE threads SET title = ?1, updated_at = ?2
             WHERE thread_id = ?3
                OR thread_id IN (
                    SELECT thread_id FROM thread_external_sessions
                    WHERE external_session_id = ?3
                )",
            params![title, now, canonical_id],
        )?;
        tx.execute(
            "UPDATE agent_conversation_instances SET title = ?1, updated_at = max(updated_at, ?2)
             WHERE thread_id = ?3
                OR thread_id IN (
                    SELECT thread_id FROM thread_external_sessions
                    WHERE external_session_id = ?3
                )",
            params![title, now, canonical_id],
        )?;
        // Keep SELECT inside the same std::sync::MutexGuard. ThreadManager uses
        // synchronous rusqlite calls internally; async signatures are kept for
        // upper-layer API consistency.
        let info = tx
            .query_row(
                "SELECT thread_id, agent_id, title, created_at, updated_at
                 FROM threads
                 WHERE thread_id = ?1",
                [&canonical_id],
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

    fn touch_thread(
        &self,
        conn: &Connection,
        thread_id: &str,
        updated_at: i64,
    ) -> Result<(), ThreadError> {
        conn.execute(
            "UPDATE threads SET updated_at = ?1 WHERE thread_id = ?2",
            params![updated_at, thread_id],
        )?;
        Ok(())
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

    fn row_to_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatMessage> {
        let tool_input_raw: Option<String> = row.get(10)?;
        let tool_calls_raw: Option<String> = row.get(11)?;
        Ok(ChatMessage {
            id: row.get(0)?,
            role: row.get(1)?,
            content: row.get(2)?,
            llm_content: row.get(3)?,
            system_reminder_directory: row.get(4)?,
            timestamp: row.get(5)?,
            is_loading: int_to_opt_bool(row.get(6)?),
            tool_call_id: row.get(7)?,
            tool_name: row.get(8)?,
            tool_data: row.get(9)?,
            tool_input: tool_input_raw.and_then(|raw| serde_json::from_str(&raw).ok()),
            tool_calls: tool_calls_raw.and_then(|raw| serde_json::from_str(&raw).ok()),
            reasoning: row.get(12)?,
            is_completed: int_to_opt_bool(row.get(13)?),
            is_collapsed: int_to_opt_bool(row.get(14)?),
        })
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

    /// Layer 4: same shape as `row_to_message`, but SELECT also returns the
    /// sequence column. Pagination uses it to build `oldest_sequence`; other
    /// paths keep using `row_to_message`.
    fn row_to_agent_conversation_instance(
        row: &rusqlite::Row<'_>,
    ) -> rusqlite::Result<AgentConversationInstance> {
        let source = AgentConversationSource {
            kind: row.get(5)?,
            document_path: row.get(6)?,
            memo_id: row.get(7)?,
        };
        let role_memo_id: Option<String> = row.get(8)?;
        let role_name: Option<String> = row.get(9)?;
        let role = if role_memo_id.is_some() || role_name.is_some() {
            Some(AgentConversationRole {
                memo_id: role_memo_id,
                name: role_name,
            })
        } else {
            None
        };
        let run_id: Option<String> = row.get(12)?;
        let run = if let Some(run_id) = run_id {
            let usage_json: Option<String> = row.get(21)?;
            let status_info_json: Option<String> = row.get(22)?;
            Some(AgentConversationRun {
                run_id,
                status: row.get(13)?,
                started_at: row.get(14)?,
                ended_at: row.get(15)?,
                current_tool: row.get(16)?,
                model: row.get(17)?,
                model_id: row.get(18)?,
                reasoning_effort: row.get(19)?,
                last_run_at: row.get(20)?,
                reason: row.get(23)?,
                usage: usage_json.and_then(|s| serde_json::from_str(&s).ok()),
                status_info: status_info_json.and_then(|s| serde_json::from_str(&s).ok()),
            })
        } else {
            None
        };

        Ok(AgentConversationInstance {
            instance_id: row.get(0)?,
            agent_type: row.get(1)?,
            title: row.get(2)?,
            thread_id: row.get(3)?,
            runtime_config: row.get(4)?,
            source,
            role,
            run,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
        })
    }

    fn row_to_message_with_seq(row: &rusqlite::Row<'_>) -> rusqlite::Result<(ChatMessage, i64)> {
        let message = Self::row_to_message(row)?;
        let sequence: i64 = row.get(15)?;
        Ok((message, sequence))
    }
}

fn opt_bool_to_int(value: Option<bool>) -> Option<i64> {
    value.map(|v| if v { 1 } else { 0 })
}

fn int_to_opt_bool(value: Option<i64>) -> Option<bool> {
    value.map(|v| v != 0)
}
