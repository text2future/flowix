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

use crate::agent::AgentId;
use super::error::ThreadError;
use super::types::*;

pub struct ThreadManager {
    conn: Mutex<Connection>,
}

impl ThreadManager {
    /// 娴嬭瘯鐢?fixture 鈹€鈹€ 涓嶅啓纾佺洏, 鐢?`Connection::open_in_memory()` 寤轰竴涓┖搴撱€?    /// `agent.rs::for_tests` 鐢ㄥ畠, 鍥犱负鍗曞厓娴嬭瘯鍙獙璇?`AgentManager` 鍐呴儴 HashMap
    /// 鐘舵€? 涓嶇湡姝ｈ鍐?thread 搴撱€?    ///
    /// PR-B 浼氭妸瀹冨崌绾ф垚 `new_in_memory()` 骞堕厤鍚?`lock_conn` 鍔╂墜鎶婃祴璇曠敤涓?
    /// 鐢熶骇鐢ㄧ粺涓€涓€浠?migrations 鍒濆鍖?(CREATE TABLE IF NOT EXISTS 鍏煎鍐呭瓨搴?銆?
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

        // 鏃у簱涓€娆℃€ф坊鍔?tool_calls 鍒椼€傛柊搴?CREATE TABLE 宸插惈, 杩欓噷浼氭姤
        // "duplicate column name", 鍚炴帀鍗冲彲銆?
        if let Err(e) = conn.execute("ALTER TABLE thread_messages ADD COLUMN tool_calls TEXT", []) {
            tracing::debug!("[ThreadManager] tool_calls migration: {}", e);
        }
        if let Err(e) = conn.execute(
            "ALTER TABLE agent_conversation_instances ADD COLUMN runtime_config TEXT",
            [],
        ) {
            tracing::debug!("[ThreadManager] instance runtime_config migration: {e}");
        }
        for column in [
            "input_tokens INTEGER",
            "model_id TEXT",
            "cached_input_tokens INTEGER",
            "output_tokens INTEGER",
            "reasoning_output_tokens INTEGER",
            "total_tokens INTEGER",
            "model_context_window INTEGER",
            "codex_plan_type TEXT",
            "codex_used_percent REAL",
            "codex_resets_at INTEGER",
            "last_run_at INTEGER",
        ] {
            if let Err(e) = conn.execute(
                &format!("ALTER TABLE agent_conversation_run_state ADD COLUMN {column}"),
                [],
            ) {
                tracing::debug!("[ThreadManager] run usage migration {column}: {}", e);
            }
        }
        // New nested-JSON columns for v1.x usage / status_info consolidation.
        // Backfill from legacy columns happens in [`Self::backfill_agent_conversation_run_state_json`]
        // after schema migration — old rows still have token values in the
        // legacy INTEGER/TEXT columns which we read once and squash into JSON.
        for column in ["usage_json TEXT", "status_info_json TEXT"] {
            if let Err(e) = conn.execute(
                &format!("ALTER TABLE agent_conversation_run_state ADD COLUMN {column}"),
                [],
            ) {
                tracing::debug!("[ThreadManager] run json migration {column}: {}", e);
            }
        }
        Self::backfill_agent_conversation_run_state_json(&conn);

        Ok(())
    }

    /// One-time migration: read legacy per-column values from
    /// `agent_conversation_run_state` and squash them into the new
    /// `usage_json` / `status_info_json` columns. Idempotent — only fills
    /// rows where `usage_json IS NULL` so re-running after partial failure
    /// doesn't overwrite fresher data.
    fn backfill_agent_conversation_run_state_json(conn: &Connection) {
        let mut stmt = match conn.prepare(
            "SELECT instance_id, input_tokens, cached_input_tokens, output_tokens,
                    reasoning_output_tokens, total_tokens, model_context_window,
                    codex_plan_type, codex_used_percent, codex_resets_at
             FROM agent_conversation_run_state
             WHERE usage_json IS NULL",
        ) {
            Ok(stmt) => stmt,
            Err(e) => {
                tracing::debug!("[ThreadManager] backfill prepare: {e}");
                return;
            }
        };

        let rows: Vec<(
            String,
            Option<i64>,
            Option<i64>,
            Option<i64>,
            Option<i64>,
            Option<i64>,
            Option<i64>,
            Option<String>,
            Option<f64>,
            Option<i64>,
        )> = match stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<f64>>(8)?,
                row.get::<_, Option<i64>>(9)?,
            ))
        }) {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(e) => {
                tracing::debug!("[ThreadManager] backfill query: {e}");
                return;
            }
        };

        for (
            instance_id,
            input,
            cached,
            output,
            reasoning,
            total,
            ctx_window,
            plan_type,
            used_pct,
            resets_at,
        ) in rows
        {
            let usage = crate::agent::UsageInfo {
                input_tokens: input.and_then(|v| u32::try_from(v).ok()),
                cached_input_tokens: cached.and_then(|v| u32::try_from(v).ok()),
                output_tokens: output.and_then(|v| u32::try_from(v).ok()),
                reasoning_output_tokens: reasoning.and_then(|v| u32::try_from(v).ok()),
                total_tokens: total.and_then(|v| u32::try_from(v).ok()),
                model_context_window: ctx_window.and_then(|v| u32::try_from(v).ok()),
            };
            let status_info = crate::agent::StatusInfo {
                codex_plan_type: plan_type,
                codex_used_percent: used_pct,
                codex_resets_at: resets_at,
            };

            // Only write usage_json if at least one token field has a value.
            let usage_json = if usage.input_tokens.is_some()
                || usage.cached_input_tokens.is_some()
                || usage.output_tokens.is_some()
                || usage.reasoning_output_tokens.is_some()
                || usage.total_tokens.is_some()
                || usage.model_context_window.is_some()
            {
                serde_json::to_string(&usage).ok()
            } else {
                None
            };

            let status_info_json = if status_info.codex_plan_type.is_some()
                || status_info.codex_used_percent.is_some()
                || status_info.codex_resets_at.is_some()
            {
                serde_json::to_string(&status_info).ok()
            } else {
                None
            };

            if let Err(e) = conn.execute(
                "UPDATE agent_conversation_run_state
                 SET usage_json = ?1, status_info_json = ?2
                 WHERE instance_id = ?3",
                params![usage_json, status_info_json, instance_id],
            ) {
                tracing::debug!("[ThreadManager] backfill write: {e}");
            }
        }
    }

    /// 鍔犻攣鍔╂墜 鈹€鈹€ 閿佷腑姣?(panic held it) 鏃朵粛杩斿洖 guard, 涓嶈鍗曠偣 panic
    /// 鎷栧灝鏁翠釜杩涚▼銆備腑姣掓剰鍛崇潃 in-memory 鐘舵€佸彲鑳戒笉涓€鑷?
    /// 浣嗘墍鏈夊啓鍏ラ兘鍏堣惤鐩樻墠鏇存柊鍐呭瓨, 杩欑绐楀彛鏈熸瀬灏戙€?
    /// 閿欒绾у埆鐢?`tracing::error!`, 涓?`user_config.rs` 淇濇寔涓€鑷淬€?
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

    /// Layer 4: 鍒嗛〉鍔犺浇 thread 鍘嗗彶 鈹€鈹€ 涓嶅啀涓€娆?SELECT 鍏ㄩ儴, 鎸?sequence DESC
    /// 鍙栨渶杩?`limit` 鏉? 鍦?Rust 渚?reverse 鍥?ASC 杩斿洖. `before_sequence`:
    ///   - None: 鍙栨渶杩?`limit` 鏉?(棣栨杩涘叆 thread)
    ///   - Some(s): 鍙?sequence < s 鐨勬渶杩?`limit` 鏉?(鐢ㄦ埛鍚戜笂婊氬姞杞芥洿鏃?
    ///
    /// 杩斿洖 `(messages, oldest_sequence, has_more)`:
    ///   - oldest_sequence: 鏈壒鏈€鏃╀竴鏉＄殑 sequence (鎴?None 鑻ユ湰鎵逛负绌?, 鐢ㄤ綔涓嬩竴椤?cursor
    ///   - has_more: 鏄惁杩樻湁鏇存棭鐨勫巻鍙?(鐢ㄦ湰鎵?oldest 涔嬪墠杩樻湁鍑犳潯鍒ゆ柇)
    ///
    /// 涓嶈繑鍥?ThreadInfo (閭ｉ儴鍒嗕粛璧?get_thread 鍏ㄩ噺 鈹€鈹€ 浣嗗疄闄呬笂 ThreadInfo
    /// 鍦?thread_list 缂撳瓨閲? 鍓嶇 loadThread 璧?list 鍙?title 鍗冲彲涓嶅繀鍐嶆煡).
    /// 杩欓噷涓撳績鍋?messages 鍒嗛〉, 鍗曚竴鑱岃矗.
    pub async fn get_thread_messages_page(
        &self,
        thread_id: &str,
        before_sequence: Option<i64>,
        limit: i64,
    ) -> Result<ThreadMessagesPage, ThreadError> {
        // 涓婁笅鏂囬檺鍒? limit 鍗″湪 [1, 1000] 闃插尽鎬у厹搴? 閬垮厤鍓嶇璇紶 0 鎴栧法澶у€?
        let limit = limit.clamp(1, 1000);
        let conn = self.lock_conn();

        // DESC + LIMIT 鍙栨渶杩?N 鏉?鈹€鈹€ (thread_id, sequence) 澶嶅悎绱㈠紩瑕嗙洊,
        // 鍗曟鏌ヨ鍗冲彲瀹氫綅, 鏃犻渶 OFFSET 鎵弿.
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

        // 鍙嶈浆涓?ASC 缁欏墠绔?(鍓嶇 messages 鎸夋椂闂撮『搴忔帓鍒?.
        let oldest_sequence = messages.last().map(|(_, seq)| *seq); // DESC 鎺掑簭鏃舵渶鍚庝竴涓槸鏈€灏?sequence
        let mut messages_asc: Vec<ChatMessage> = messages.into_iter().map(|(m, _)| m).collect();
        messages_asc.reverse();

        // has_more: 鐪?oldest_sequence 涔嬪墠杩樻湁娌℃湁鏁版嵁. 鍗?COUNT(*) 鏋佸揩
        // (澶嶅悎绱㈠紩瑕嗙洊, 涓嶈 row body).
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

    /// 浠呮妸 `is_loading = 0` 褰掍綅 鈹€鈹€ 涓嶅姩 `content` / `tool_data` / `tool_name`銆?    /// 缁?`IsLoadingGuard` 鐨?drop 鐢? 閿欒璺緞涓嬫垜浠彧鎯宠В閿?UI 杞湀, 涓嶅簲
    /// 鎷跨┖涓茶鐩栧凡缁?(閮ㄥ垎) 鍐欏叆鐨勫伐鍏风粨鏋溿€俙update_tool_result` 鍦ㄦ垚鍔熻矾寰?    /// 涓婁細鍐?0 椤轰究 `touch_thread` 鈹€鈹€ guard 璧拌繖鏉℃洿绐勭殑 UPDATE, 閬垮厤鍓綔鐢?    /// 閿欓厤銆備篃鐪佷竴娆?`touch_thread` (`now()` 鍐欎竴娆?thread meta), 闃叉
    /// 閿欒璺緞鎰忓鎶?thread 椤跺埌鍒楄〃椤躲€?
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

    /// 鍚姩鏃朵竴娆℃€ф竻鐞? 鎶婃墍鏈?`is_loading = 1` 鐨勮 (涓嶉檺 role) 褰掗浂銆?    ///
    /// 瑙ｅ喅杩涚▼鍦?tool_use 琛岃惤鐩樺悗宕╂簝 / 琚?SIGKILL / 寮洪€€鐨勫満鏅?鈹€鈹€
    /// 涓嬫鍚姩杩欎簺琛岀殑 `is_loading` 浠嶄负 1, UI 鍔犺浇鍘嗗彶鏃朵細鐪嬪埌"杞湀
    /// 鍗℃"鐨勫伐鍏疯銆傛壒閲忓綊闆朵笉褰卞搷涓氬姟: 宸茬粡钀界洏鐨?tool_result 琛岀殑
    /// `is_loading` 鏃╄姝ｅ父璺緞鍐欎负 0, 涓嶄細鍙楀奖鍝? 鍙湁"杩樻病绛夊埌
    /// tool_result 灏辫寮烘潃"鐨勫鍎胯鎵嶅懡涓€?    ///
    /// 鍚屾鐗堟湰 鈹€鈹€ lib.rs::run() 鍦?tauri runtime 璧锋潵涔嬪墠, 娌℃硶 await,
    /// 鎵€浠ヨ繖閲屼笉 async銆傚唴閮ㄥ氨鏄竴涓?SQLite UPDATE, 娌℃湁鐪熷疄寮傛宸ヤ綔銆?
    /// 杩斿洖琚洿鏂扮殑琛屾暟, 渚?lib.rs 璁?log 鎺掓煡銆?
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
        let conn = self.lock_conn();
        conn.execute(
            "INSERT OR IGNORE INTO threads (thread_id, agent_id, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![thread_id, runtime, "Codex Session", now],
        )?;
        conn.execute(
            "INSERT INTO thread_external_sessions (
                thread_id, runtime, external_session_id, metadata, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(thread_id, runtime) DO UPDATE SET
                external_session_id = excluded.external_session_id,
                metadata = excluded.metadata,
                updated_at = excluded.updated_at",
            params![thread_id, runtime, external_session_id, metadata, now],
        )?;
        self.touch_thread(&conn, thread_id, now)?;
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
    ) -> Result<Option<ThreadInfo>, ThreadError> {
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.lock_conn();
        let updated = conn.execute(
            "UPDATE threads SET title = ?1, updated_at = ?2 WHERE thread_id = ?3",
            params![title, now, thread_id],
        )?;
        if updated == 0 {
            return Ok(None);
        }
        // 鎶?SELECT 鎶樺彔鍒板悓涓€鎶?std::sync::MutexGuard 鍐?鈹€鈹€ 鍘熺増鐢?        // `self.get_thread(...).await` 鍦?await 澶勮法瓒婁簡 MutexGuard 鐨?drop,
        // 瑙﹀彂 !Send 閿欒銆俆hreadManager 鍐呭叏鏄悓姝?rusqlite 璋冪敤, 涓嶉渶瑕?
        // 鐪熺殑 await, 绛惧悕淇濈暀 async 鏄负涓婂眰鎺ュ彛涓€鑷淬€?
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

    /// Layer 4: 涓?`row_to_message` 鍚屽舰, 浣?SELECT 澶氬彇浜?sequence 鍒?    /// (column 15). 鍒嗛〉 SQL 鐢ㄨ繖涓増鏈嬁鍥?sequence 浠ユ瀯閫?oldest_sequence
    /// cursor; 鍏跺畠璺緞鐢?`row_to_message` 涓嶅彉.
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
