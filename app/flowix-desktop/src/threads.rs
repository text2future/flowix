use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

use crate::agent::AgentId;

/// 线程表操作错误。`Sqlite` 由 `#[from]` 自动覆盖所有 `rusqlite::Error` 调用点,
/// `NotFound` 由 `load_thread_llm_messages` 等显式构造, 上层 `?` 链路区分。
///
/// 显示风格: 复合变体 `Thread(#[from] ThreadError)` 会渲染成
/// `"thread error: thread database error: <rusqlite 错误>"` ── 三层前缀.
/// 嫌长可改 `#[error(transparent)]`, 但 v1 保持显式便于排查。
#[derive(Debug, thiserror::Error)]
pub enum ThreadError {
    #[error("thread database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("thread not found: {0}")]
    NotFound(String),
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadInfo {
    pub thread_id: String,
    pub agent_id: AgentId,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub llm_content: Option<String>,
    pub system_reminder_directory: Option<String>,
    pub timestamp: String,
    pub is_loading: Option<bool>,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub tool_data: Option<String>,
    pub tool_input: Option<serde_json::Value>,
    /// 助手消息关联的 tool_calls 数组 (OpenAI 格式 JSON, 单元素或多元素)。
    /// None 表示纯文本助手消息; Some(vec![...]) 表示该助手轮次同时发出了工具调用。
    /// 存储层用 serde_json::Value 以避免与 rllm 类型耦合。
    #[serde(default)]
    pub tool_calls: Option<serde_json::Value>,
    pub reasoning: Option<String>,
    pub is_completed: Option<bool>,
    pub is_collapsed: Option<bool>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub info: ThreadInfo,
    pub messages: Vec<ChatMessage>,
}

pub struct ThreadManager {
    conn: Mutex<Connection>,
}

impl ThreadManager {
    /// 测试用 fixture ── 不写磁盘, 用 `Connection::open_in_memory()` 建一个空库。
    /// `agent.rs::for_tests` 用它, 因为单元测试只验证 `AgentManager` 内部 HashMap
    /// 状态, 不真正读写 thread 库。
    ///
    /// PR-B 会把它升级成 `new_in_memory()` 并配合 `lock_conn` 助手把测试用与
    /// 生产用统一一份 migrations 初始化 (CREATE TABLE IF NOT EXISTS 兼容内存库)。
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
            ",
        )?;

        // 旧库一次性添加 tool_calls 列。新库 CREATE TABLE 已含, 这里会报
        // "duplicate column name", 吞掉即可。
        if let Err(e) = conn.execute("ALTER TABLE thread_messages ADD COLUMN tool_calls TEXT", []) {
            tracing::debug!("[ThreadManager] tool_calls migration: {}", e);
        }

        Ok(())
    }

    /// 加锁助手 ── 锁中毒 (panic held it) 时仍返回 guard, 不让单点 panic
    /// 拖垮整个进程。中毒意味着 in-memory 状态可能不一致, 但所有写入都先
    /// 落盘才更新内存, 这种窗口期极少。错误级别用 `tracing::error!` 与
    /// `user_config.rs` 保持一致 (不降级到 warn)。
    fn lock_conn(&self) -> std::sync::MutexGuard<'_, Connection> {
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
             WHERE agent_id != 'codex'
             ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(ThreadInfo {
                thread_id: row.get(0)?,
                agent_id: AgentId(row.get(1)?),
                title: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })?;

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

    /// 仅把 `is_loading = 0` 归位 ── 不动 `content` / `tool_data` / `tool_name`。
    /// 给 `IsLoadingGuard` 的 drop 用: 错误路径下我们只想解锁 UI 转圈, 不应
    /// 拿空串覆盖已经 (部分) 写入的工具结果。`update_tool_result` 在成功路径
    /// 上会写 0 顺便 `touch_thread` ── guard 走这条更窄的 UPDATE, 避免副作用
    /// 错配。也省一次 `touch_thread` (`now()` 写一次 thread meta), 防止
    /// 错误路径意外把 thread 顶到列表顶。
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

    /// 启动时一次性清理: 把所有 `is_loading = 1` 的行 (不限 role) 归零。
    ///
    /// 解决进程在 tool_use 行落盘后崩溃 / 被 SIGKILL / 强退的场景 ──
    /// 下次启动这些行的 `is_loading` 仍为 1, UI 加载历史时会看到"转圈
    /// 卡死"的工具行。批量归零不影响业务: 已经落盘的 tool_result 行的
    /// `is_loading` 早被正常路径写为 0, 不会受影响; 只有"还没等到
    /// tool_result 就被强杀"的孤儿行才命中。
    ///
    /// 同步版本 ── lib.rs::run() 在 tauri runtime 起来之前, 没法 await,
    /// 所以这里不 async。内部就是一个 SQLite UPDATE, 没有真实异步工作。
    /// 返回被更新的行数, 供 lib.rs 记 log 排查。
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

    pub async fn delete_thread(&self, thread_id: &str) -> Result<bool, ThreadError> {
        let conn = self.lock_conn();
        let deleted = conn.execute("DELETE FROM threads WHERE thread_id = ?1", [thread_id])?;
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
        // 把 SELECT 折叠到同一把 std::sync::MutexGuard 内 ── 原版用
        // `self.get_thread(...).await` 在 await 处跨越了 MutexGuard 的 drop,
        // 触发 !Send 错误。ThreadManager 内全是同步 rusqlite 调用, 不需要
        // 真的 await, 签名保留 async 是为上层接口一致。
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
}

fn opt_bool_to_int(value: Option<bool>) -> Option<i64> {
    value.map(|v| if v { 1 } else { 0 })
}

fn int_to_opt_bool(value: Option<i64>) -> Option<bool> {
    value.map(|v| v != 0)
}
