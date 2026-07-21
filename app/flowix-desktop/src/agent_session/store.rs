//! ThreadManager - single SQLite facade for thread, external-session,
//! conversation-instance, and external-event tables:
//!   1. threads / thread_messages  (chat thread + history)
//!   2. thread_external_sessions  (thread 閳?codex/claude/hermes session id)
//!   3. agent_conversation_instances (persona metadata)
//!   4. agent_external_events (external-agent stream event log)
//!
//! All tables share a single `Mutex<Connection>`, so this module
//! intentionally stays as one `impl ThreadManager` block 閳?splitting
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

const THREAD_DB_SCHEMA_VERSION: i64 = 1;
const MAX_EXTERNAL_EVENTS_PER_THREAD: i64 = 10_000;

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

impl ThreadManager {
    /// 濞村鐦悽?fixture 閳光偓閳光偓 娑撳秴鍟撶壕浣烘磸, 閻?`Connection::open_in_memory()` 瀵よ桨绔存稉顏嗏敄鎼存挶鈧?    /// `agent.rs::for_tests` 閻劌鐣? 閸ョ姳璐熼崡鏇炲帗濞村鐦崣顏堢崣鐠?`AgentManager` 閸愬懘鍎?HashMap
    /// 閻樿埖鈧? 娑撳秶婀″锝堫嚢閸?thread 鎼存挶鈧?
    #[cfg(test)]
    pub fn for_tests() -> Self {
        Self::new_in_memory().expect("in-memory migrations failed")
    }

    pub fn new(db_path: PathBuf) -> Result<Self, ThreadError> {
        let mut conn = Connection::open(db_path)?;
        Self::run_migrations(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn new_in_memory() -> Result<Self, ThreadError> {
        let mut conn = Connection::open_in_memory()?;
        Self::run_migrations(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn run_migrations(conn: &mut Connection) -> Result<(), ThreadError> {
        conn.execute_batch(
            "
            -- WAL lets high-frequency external-CLI event writes proceed
            -- concurrently with history reads, instead of blocking readers.
            -- `synchronous = NORMAL` is safe under WAL and the common choice.
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
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
                external_session_id TEXT NOT NULL,
                session_metadata_json TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (thread_id, runtime),
                UNIQUE (runtime, external_session_id),
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

            DROP TABLE IF EXISTS agent_conversation_run_state;

            CREATE TABLE IF NOT EXISTS agent_external_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                runtime TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                normalized_json TEXT NOT NULL,
                raw_json TEXT,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
            );
            ",
        )?;

        Self::migrate_agent_external_events_table(conn)?;
        conn.execute_batch(
            "
            CREATE INDEX IF NOT EXISTS idx_agent_external_events_thread
                ON agent_external_events(thread_id, id);
            ",
        )?;

        // `threads.title` is the product title. Older builds kept a useful
        // title only on the card instance while external threads were inserted
        // as the literal "Codex Session" (including Claude rows). Repair that
        // split-brain state idempotently, then align every bound card snapshot
        // with the thread title.
        conn.execute_batch(
            "
            UPDATE threads
            SET title = (
                SELECT i.title
                FROM agent_conversation_instances i
                WHERE i.thread_id = threads.thread_id
                  AND trim(i.title) <> ''
                  AND lower(trim(i.title)) NOT IN (
                      'codex session',
                      'claude code session',
                      'hermes session'
                  )
                ORDER BY i.updated_at DESC
                LIMIT 1
            )
            WHERE lower(trim(title)) IN (
                'codex session',
                'claude code session',
                'hermes session'
            )
              AND EXISTS (
                SELECT 1
                FROM agent_conversation_instances i
                WHERE i.thread_id = threads.thread_id
                  AND trim(i.title) <> ''
                  AND lower(trim(i.title)) NOT IN (
                      'codex session',
                      'claude code session',
                      'hermes session'
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

        Self::migrate_external_thread_identity(conn)?;
        conn.pragma_update(None, "user_version", THREAD_DB_SCHEMA_VERSION)?;

        Ok(())
    }

    fn migrate_agent_external_events_table(conn: &mut Connection) -> Result<(), ThreadError> {
        let mut stmt = conn.prepare("PRAGMA table_info(agent_external_events)")?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        let has_column = |name: &str| columns.iter().any(|column| column == name);
        let needs_rebuild = !has_column("runtime")
            || !has_column("normalized_json")
            || columns.iter().any(|column| {
                matches!(
                    column.as_str(),
                    "instance_id"
                        | "run_id"
                        | "external_session_id"
                        | "sequence"
                        | "kind"
                        | "role"
                        | "message_id"
                        | "tool_call_id"
                        | "agent_type"
                        | "payload_json"
                )
            });
        drop(stmt);
        if !needs_rebuild {
            return Ok(());
        }

        let id_expr = if has_column("id") { "id" } else { "rowid" };
        let runtime_expr = if has_column("runtime") {
            "COALESCE(runtime, '')"
        } else if has_column("agent_type") {
            "COALESCE(agent_type, '')"
        } else {
            "''"
        };
        let thread_id_expr = if has_column("thread_id") {
            "COALESCE(thread_id, '')"
        } else {
            "''"
        };
        let normalized_json_expr = if has_column("normalized_json") {
            "COALESCE(normalized_json, '{}')"
        } else if has_column("payload_json") {
            "COALESCE(payload_json, '{}')"
        } else {
            "'{}'"
        };
        let raw_json_expr = if has_column("raw_json") {
            "raw_json"
        } else {
            "NULL"
        };
        let created_at_expr = if has_column("created_at") {
            "COALESCE(created_at, CAST(strftime('%s','now') AS INTEGER) * 1000)"
        } else {
            "CAST(strftime('%s','now') AS INTEGER) * 1000"
        };

        let tx = conn.transaction()?;
        tx.execute_batch(&format!(
            "
            ALTER TABLE agent_external_events RENAME TO agent_external_events_legacy;

            CREATE TABLE agent_external_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                runtime TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                normalized_json TEXT NOT NULL,
                raw_json TEXT,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
            );

            INSERT INTO agent_external_events (
                id, runtime, thread_id, normalized_json, raw_json, created_at
            )
            SELECT
                {id_expr},
                {runtime_expr},
                {thread_id_expr},
                {normalized_json_expr},
                {raw_json_expr},
                {created_at_expr}
            FROM agent_external_events_legacy
            WHERE EXISTS (
                SELECT 1
                FROM threads t
                WHERE t.thread_id = {thread_id_expr}
            )
            ORDER BY {id_expr} ASC;

            DROP TABLE agent_external_events_legacy;
            ",
        ))?;
        tx.commit()?;
        Ok(())
    }

    fn migrate_external_thread_identity(conn: &mut Connection) -> Result<(), ThreadError> {
        let tx = conn.transaction()?;
        tx.execute_batch(
            "
            DROP TABLE IF EXISTS temp.external_session_aliases;
            CREATE TEMP TABLE external_session_aliases AS
            SELECT
                s.thread_id AS local_thread_id,
                s.runtime AS runtime,
                s.external_session_id AS external_session_id,
                COALESCE(s.session_metadata_json, (
                    SELECT self.session_metadata_json
                    FROM thread_external_sessions self
                    WHERE self.thread_id = s.external_session_id
                      AND self.runtime = s.runtime
                      AND self.external_session_id = s.external_session_id
                    LIMIT 1
                )) AS session_metadata_json,
                s.created_at AS created_at,
                s.updated_at AS updated_at
            FROM thread_external_sessions s
            WHERE s.external_session_id IS NOT NULL
              AND s.external_session_id <> ''
              AND s.thread_id <> s.external_session_id
              AND NOT EXISTS (
                  SELECT 1
                  FROM thread_external_sessions newer
                  WHERE newer.external_session_id = s.external_session_id
                    AND newer.runtime = s.runtime
                    AND newer.thread_id <> newer.external_session_id
                    AND (
                        newer.updated_at > s.updated_at
                        OR (
                            newer.updated_at = s.updated_at
                            AND newer.thread_id > s.thread_id
                        )
                    )
              );

            INSERT OR IGNORE INTO threads (
                thread_id, agent_id, title, created_at, updated_at
            )
            SELECT
                a.local_thread_id,
                c.agent_id,
                c.title,
                min(c.created_at, a.created_at),
                max(c.updated_at, a.updated_at)
            FROM external_session_aliases a
            JOIN threads c ON c.thread_id = a.external_session_id;

            UPDATE threads
            SET title = (
                    SELECT c.title
                    FROM external_session_aliases a
                    JOIN threads c ON c.thread_id = a.external_session_id
                    WHERE a.local_thread_id = threads.thread_id
                      AND lower(trim(c.title)) NOT IN (
                          'codex session',
                          'claude code session',
                          'hermes session'
                      )
                    LIMIT 1
                ),
                updated_at = max(updated_at, (
                    SELECT c.updated_at
                    FROM external_session_aliases a
                    JOIN threads c ON c.thread_id = a.external_session_id
                    WHERE a.local_thread_id = threads.thread_id
                    LIMIT 1
                ))
            WHERE lower(trim(title)) IN (
                    'codex session',
                    'claude code session',
                    'hermes session'
                )
              AND EXISTS (
                  SELECT 1
                  FROM external_session_aliases a
                  JOIN threads c ON c.thread_id = a.external_session_id
                  WHERE a.local_thread_id = threads.thread_id
                    AND lower(trim(c.title)) NOT IN (
                        'codex session',
                        'claude code session',
                        'hermes session'
                    )
              );

            UPDATE agent_conversation_instances
            SET thread_id = (
                    SELECT a.local_thread_id
                    FROM external_session_aliases a
                    WHERE a.external_session_id = agent_conversation_instances.thread_id
                    LIMIT 1
                ),
                title = COALESCE((
                    SELECT t.title
                    FROM external_session_aliases a
                    JOIN threads t ON t.thread_id = a.local_thread_id
                    WHERE a.external_session_id = agent_conversation_instances.thread_id
                    LIMIT 1
                ), title),
                updated_at = max(updated_at, (
                    SELECT t.updated_at
                    FROM external_session_aliases a
                    JOIN threads t ON t.thread_id = a.local_thread_id
                    WHERE a.external_session_id = agent_conversation_instances.thread_id
                    LIMIT 1
                ))
            WHERE thread_id IN (
                SELECT external_session_id FROM external_session_aliases
            );

            UPDATE agent_external_events
            SET thread_id = (
                    SELECT a.local_thread_id
                    FROM external_session_aliases a
                    WHERE a.external_session_id = agent_external_events.thread_id
                    LIMIT 1
                )
            WHERE thread_id IN (
                SELECT external_session_id FROM external_session_aliases
            );

            DELETE FROM threads
            WHERE thread_id IN (
                SELECT external_session_id FROM external_session_aliases
            );

            ALTER TABLE thread_external_sessions RENAME TO thread_external_sessions_legacy;

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

            INSERT OR REPLACE INTO thread_external_sessions (
                thread_id, runtime, external_session_id, session_metadata_json, created_at, updated_at
            )
            SELECT
                a.local_thread_id,
                a.runtime,
                a.external_session_id,
                a.session_metadata_json,
                a.created_at,
                a.updated_at
            FROM external_session_aliases a
            WHERE EXISTS (
                SELECT 1 FROM threads t WHERE t.thread_id = a.local_thread_id
            );

            DROP TABLE thread_external_sessions_legacy;
            DROP TABLE IF EXISTS temp.external_session_aliases;
            ",
        )?;
        tx.commit()?;
        Ok(())
    }

    /// 閸旂娀鏀ｉ崝鈺傚 閳光偓閳光偓 闁夸椒鑵戝В?(panic held it) 閺冩湹绮涙潻鏂挎礀 guard, 娑撳秷顔€閸楁洜鍋?panic
    /// 闂冪粯鏌囬崥搴ｇ敾鐠囪鍟撻妴鍌涘閺堝鍟撻崗銉╁厴閸忓牐鎯ら惄妯哄晙閺囧瓨鏌婇崘鍛摠, 鏉╂瑧顫掔粣妤€褰涢張鐔哥€亸鎴欌偓?    /// 闁挎瑨顕ょ痪褍鍩嗛悽?`tracing::error!`, 娑?`user_config.rs` 娣囨繃瀵旀稉鈧懛娣偓?    
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

    pub async fn list_external_threads(
        &self,
        runtime: &str,
    ) -> Result<Vec<ThreadInfo>, ThreadError> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT t.thread_id, t.agent_id, t.title, t.created_at, t.updated_at
             FROM threads t
             WHERE t.agent_id = ?1
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

    /// Layer 4: 閸掑棝銆夐崝鐘烘祰 thread 閸樺棗褰?閳光偓閳光偓 娑撳秴鍟€娑撯偓濞?SELECT 閸忋劑鍎? 閹?sequence DESC
    /// 閸欐牗娓舵潻?`limit` 閺? 閸?Rust 娓?reverse 閸?ASC 鏉╂柨娲栭妴淇檅efore_sequence`:
    ///   - None: 閸欐牗娓舵潻?`limit` 閺?(妫ｆ牗顐兼潻娑樺弳 thread)
    ///   - Some(s): 閸?sequence < s 閻ㄥ嫭娓舵潻?`limit` 閺?(閻劍鍩涢崥鎴滅瑐濠婃艾濮╅崝鐘烘祰閺囧瓨妫崢鍡楀蕉)
    ///
    /// 鏉╂柨娲?`(messages, oldest_sequence, has_more)`:
    ///   - oldest_sequence: 閺堫剚澹掗張鈧弮鈺€绔撮弶锛勬畱 sequence, 閻劋缍旀稉瀣╃妞?cursor
    ///   - has_more: 閺勵垰鎯佹潻妯绘箒閺囧瓨妫惃鍕坊閸?    ///
    /// 娑撳秷绻戦崶?ThreadInfo閵嗗倸澧犵粩?loadThread 閸欘垰顦查悽?thread_list 缂傛挸鐡ㄩ柌宀€娈?title閵?    /// 鏉╂瑩鍣锋稉鎾存暈 messages 閸掑棝銆? 娣囨繃瀵旈崡鏇氱閼卞矁鐭楅妴?    
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
        session_metadata: Option<serde_json::Value>,
    ) -> Result<(), ThreadError> {
        let now = chrono::Utc::now().timestamp_millis();
        let session_metadata_json = session_metadata.map(|v| v.to_string());
        let mut conn = self.lock_conn();
        let tx = conn.transaction()?;
        let default_title = external_default_title(runtime);
        tx.execute(
            "INSERT OR IGNORE INTO threads (thread_id, agent_id, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![thread_id, runtime, default_title, now],
        )?;

        let title = tx
            .query_row(
                "SELECT title FROM threads WHERE thread_id = ?1",
                [thread_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_else(|| default_title.to_string());

        tx.execute(
            "INSERT INTO thread_external_sessions (
                thread_id, runtime, external_session_id, session_metadata_json, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(thread_id, runtime) DO UPDATE SET
                external_session_id = excluded.external_session_id,
                session_metadata_json = excluded.session_metadata_json,
                updated_at = excluded.updated_at",
            params![
                thread_id,
                runtime,
                external_session_id,
                session_metadata_json,
                now
            ],
        )?;
        tx.execute(
            "UPDATE agent_conversation_instances
             SET title = ?1, updated_at = max(updated_at, ?2)
             WHERE thread_id = ?3 AND title <> ?1",
            params![title, now, thread_id],
        )?;
        self.touch_thread(&tx, thread_id, now)?;
        tx.commit()?;
        Ok(())
    }

    pub async fn insert_agent_external_event(
        &self,
        event: NewAgentExternalEvent,
    ) -> Result<i64, ThreadError> {
        let now = event
            .created_at
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
        let conn = self.lock_conn();
        let thread_id = event.thread_id.clone();
        conn.execute(
            "INSERT OR IGNORE INTO threads (thread_id, agent_id, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![
                thread_id.as_str(),
                event.runtime.as_str(),
                external_default_title(&event.runtime),
                now,
            ],
        )?;
        conn.execute(
            "INSERT INTO agent_external_events (
                runtime, thread_id, normalized_json, raw_json, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                event.runtime.as_str(),
                event.thread_id.as_str(),
                event.normalized_json.as_str(),
                event.raw_json.as_deref(),
                now,
            ],
        )?;
        let id = conn.last_insert_rowid();
        self.prune_agent_external_events_for_thread(&conn, &event.thread_id)?;
        Ok(id)
    }

    fn prune_agent_external_events_for_thread(
        &self,
        conn: &Connection,
        thread_id: &str,
    ) -> Result<(), ThreadError> {
        conn.execute(
            "DELETE FROM agent_external_events
             WHERE thread_id = ?1
               AND id NOT IN (
                   SELECT id
                   FROM agent_external_events
                   WHERE thread_id = ?1
                   ORDER BY id DESC
                   LIMIT ?2
               )",
            params![thread_id, MAX_EXTERNAL_EVENTS_PER_THREAD],
        )?;
        Ok(())
    }

    pub async fn list_agent_external_events_by_thread(
        &self,
        thread_id: &str,
        after_id: Option<i64>,
        limit: i64,
    ) -> Result<Vec<AgentExternalEvent>, ThreadError> {
        let limit = limit.clamp(1, 1000);
        let after_id = after_id.unwrap_or(0);
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT
                id, runtime, thread_id, normalized_json, raw_json, created_at
             FROM agent_external_events
             WHERE thread_id = ?1 AND id > ?2
             ORDER BY id ASC
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(
            params![thread_id, after_id, limit],
            Self::row_to_external_event,
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub async fn list_agent_conversation_instances(
        &self,
    ) -> Result<Vec<AgentConversationInstance>, ThreadError> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT
                i.instance_id, i.agent_type, i.title, i.thread_id, i.runtime_config,
                i.source_kind, i.source_document_path, i.source_memo_id,
                i.role_memo_id, i.role_name, i.created_at, i.updated_at
             FROM agent_conversation_instances i
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
                i.role_memo_id, i.role_name, i.created_at, i.updated_at
             FROM agent_conversation_instances i
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
                i.role_memo_id, i.role_name, i.created_at, i.updated_at
             FROM agent_conversation_instances i
             WHERE i.thread_id = ?1
             ORDER BY i.updated_at DESC
             LIMIT 1",
            [thread_id],
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
                    i.role_memo_id, i.role_name, i.created_at, i.updated_at
                 FROM agent_conversation_instances i
                 WHERE i.instance_id = ?1",
                [instance_id.as_str()],
                Self::row_to_agent_conversation_instance,
            )
            .optional()?;
        instance.ok_or_else(|| ThreadError::NotFound(instance_id))
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
        tx.execute("DROP TABLE IF EXISTS temp.thread_delete_ids", [])?;
        tx.execute(
            "CREATE TEMP TABLE thread_delete_ids (thread_id TEXT PRIMARY KEY)",
            [],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO thread_delete_ids (thread_id) VALUES (?1)",
            [thread_id],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO thread_delete_ids (thread_id)
             SELECT thread_id
             FROM thread_external_sessions
             WHERE external_session_id = ?1",
            [thread_id],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO thread_delete_ids (thread_id)
             SELECT s2.thread_id
             FROM thread_external_sessions s1
             JOIN thread_external_sessions s2
               ON s2.runtime = s1.runtime
              AND s2.external_session_id = s1.external_session_id
             WHERE s1.thread_id = ?1",
            [thread_id],
        )?;
        tx.execute(
            "DELETE FROM agent_conversation_instances
             WHERE thread_id IN (SELECT thread_id FROM thread_delete_ids)",
            [],
        )?;
        tx.execute(
            "DELETE FROM agent_external_events
             WHERE thread_id IN (SELECT thread_id FROM thread_delete_ids)",
            [],
        )?;
        let deleted = tx.execute(
            "DELETE FROM threads
             WHERE thread_id IN (SELECT thread_id FROM thread_delete_ids)",
            [],
        )?;
        tx.execute("DROP TABLE IF EXISTS temp.thread_delete_ids", [])?;
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
        let target_thread_id = tx
            .query_row(
                "SELECT thread_id
                 FROM thread_external_sessions
                 WHERE external_session_id = ?1
                 ORDER BY updated_at DESC LIMIT 1",
                [thread_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_else(|| thread_id.to_string());
        tx.execute(
            "INSERT INTO threads (thread_id, agent_id, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(thread_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at",
            params![target_thread_id, agent_id.0, title, now],
        )?;
        tx.execute(
            "UPDATE agent_conversation_instances SET title = ?1, updated_at = max(updated_at, ?2)
             WHERE thread_id = ?3",
            params![title, now, target_thread_id],
        )?;
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

    fn row_to_external_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentExternalEvent> {
        Ok(AgentExternalEvent {
            id: row.get(0)?,
            runtime: row.get(1)?,
            thread_id: row.get(2)?,
            normalized_json: row.get(3)?,
            raw_json: row.get(4)?,
            created_at: row.get(5)?,
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
        Ok(AgentConversationInstance {
            instance_id: row.get(0)?,
            agent_type: row.get(1)?,
            title: row.get(2)?,
            thread_id: row.get(3)?,
            runtime_config: row.get(4)?,
            source,
            role,
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
