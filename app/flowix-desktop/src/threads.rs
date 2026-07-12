use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

use crate::agent::AgentId;

/// 绾跨▼琛ㄦ搷浣滈敊璇€俙Sqlite` 鐢?`#[from]` 鑷姩瑕嗙洊鎵€鏈?`rusqlite::Error` 璋冪敤鐐?
/// `NotFound` 鐢?`load_thread_llm_messages` 绛夋樉寮忔瀯閫? 涓婂眰 `?` 閾捐矾鍖哄垎銆?///
/// 鏄剧ず椋庢牸: 澶嶅悎鍙樹綋 `Thread(#[from] ThreadError)` 浼氭覆鏌撴垚
/// `"thread error: thread database error: <rusqlite 閿欒>"` 鈹€鈹€ 涓夊眰鍓嶇紑.
/// 瀚岄暱鍙敼 `#[error(transparent)]`, 浣?v1 淇濇寔鏄惧紡渚夸簬鎺掓煡銆?
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
    /// Per-thread 配置快照（JSON 字符串）。None = 未设置走全局 fallback；
    /// Some(json) = 锁定。后端只在 chat_stream 入口 upsert（懒写），
    /// UI 改控件不直接触发写盘，发消息时由前端把当前生效 config 随 IPC payload
    /// 一并送达 → 后端写入本字段。
    ///
    /// schema: [`RuntimeConfig`] 的序列化形式。serde 解析失败时静默回退 None。
    #[serde(default)]
    pub runtime_config: Option<String>,
}

/// Per-thread 配置快照。所有字段都是 `Option`，区分三态：
///   - 字段缺失 / `None` → 未设置，走全局 fallback
///   - `Some(None)` → 显式清空（保留字段，但回到全局）
///   - `Some(Some(v))` → 锁定为 v
///
/// 读侧 chat_stream 入口会用 [`RuntimeConfig::effective_*`] 方法解析 JSON
/// 字符串并合成最终生效配置（thread 优先，缺失则用 user_payload / 全局 ai_config）。
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access: Option<AccessConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<FilesConfig>,
    /// 推理 effort("low" / "medium" / "high" / "xhigh") ── 与后端
    /// `AgentUserMessage.codex_reasoning_effort` 对应, chat_stream 入口
    /// 把它写到 message.codex_reasoning_effort 让 `codex_reasoning_effort_for_runtime`
    /// 读到。tool 三态同 model / access: None = 走全局。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// 工具白名单预留
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
    /// 主工作目录预留
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub key: String,
    /// 预留：speed / capability 标签，前端展示用
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessConfig {
    /// 沙箱模式：full-access / workspace-write / read-only
    pub sandbox: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesConfig {
    /// 主工作目录（path，单值）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    /// 启用目录列表（path 数组）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub folders: Vec<String>,
    /// 笔记本路径列表（path 数组，与 agent-access-store AgentAccessEntry.path 同语义）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notebooks: Vec<String>,
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
    /// 鍔╂墜娑堟伅鍏宠仈鐨?tool_calls 鏁扮粍 (OpenAI 鏍煎紡 JSON, 鍗曞厓绱犳垨澶氬厓绱?銆?
    /// None 琛ㄧず绾枃鏈姪鎵嬫秷鎭? Some(vec![...]) 琛ㄧず璇ュ姪鎵嬭疆娆″悓鏃跺彂鍑轰簡宸ュ叿璋冪敤銆?
    /// 瀛樺偍灞傜敤 serde_json::Value 浠ラ伩鍏嶄笌 rllm 绫诲瀷鑰﹀悎銆?
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

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversationSource {
    pub kind: String,
    pub document_path: Option<String>,
    pub memo_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversationRole {
    pub memo_id: Option<String>,
    pub name: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversationRun {
    pub run_id: String,
    pub status: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub current_tool: Option<String>,
    pub model: Option<String>,
    pub model_id: Option<String>,
    pub reasoning_effort: Option<String>,
    pub last_run_at: Option<i64>,
    pub reason: Option<String>,
    /// Nested token usage breakdown — see [`crate::agent::UsageInfo`].
    /// Stored as JSON in SQLite (`usage_json` column) so future fields can be
    /// added without a schema migration.
    pub usage: Option<crate::agent::UsageInfo>,
    /// Provider-specific status snapshot — see [`crate::agent::StatusInfo`].
    /// Stored as JSON in SQLite (`status_info_json` column).
    pub status_info: Option<crate::agent::StatusInfo>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversationInstance {
    pub instance_id: String,
    pub agent_type: String,
    pub title: String,
    pub thread_id: Option<String>,
    pub source: AgentConversationSource,
    pub role: Option<AgentConversationRole>,
    pub run: Option<AgentConversationRun>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertAgentConversationInstance {
    pub instance_id: String,
    pub agent_type: String,
    pub title: String,
    pub thread_id: Option<String>,
    pub source: AgentConversationSource,
    pub role: Option<AgentConversationRole>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
}

/// Layer 4: 鍒嗛〉鍔犺浇鐨勮繑鍥炵被鍨? 鍓嶇鐢?`oldest_sequence` 浣滀笅涓€椤?cursor,
/// `has_more` 鍐冲畾鏄惁鍦ㄩ《閮ㄦ樉绀?鍔犺浇鏇村"鎴栬嚜鍔?prefetch.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessagesPage {
    pub messages: Vec<ChatMessage>,
    /// 鏈壒鏈€鏃╀竴鏉℃秷鎭殑 sequence; None 琛ㄧず鏈壒涓虹┖ (thread 鏃犳秷鎭垨 before_sequence 宸插埌椤?.
    pub oldest_sequence: Option<i64>,
    /// 鏄惁杩樻湁鏇存棭鐨勫巻鍙? false 鏃跺墠绔仠姝?prefetch 椤堕儴.
    pub has_more: bool,
}

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
                updated_at INTEGER NOT NULL,
                runtime_config TEXT
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
        // threads.runtime_config: per-thread 配置快照 JSON 字符串。nullable,
        // 旧行自动 None → 走全局 fallback，零迁移风险。
        if let Err(e) = conn.execute("ALTER TABLE threads ADD COLUMN runtime_config TEXT", []) {
            tracing::debug!("[ThreadManager] runtime_config migration: {e}");
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
    fn lock_conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|poisoned| {
            tracing::error!("[ThreadManager] connection lock poisoned, recovering");
            poisoned.into_inner()
        })
    }

    pub async fn list_threads(&self) -> Result<Vec<ThreadInfo>, ThreadError> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT thread_id, agent_id, title, created_at, updated_at, runtime_config
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
            "SELECT thread_id, agent_id, title, created_at, updated_at, runtime_config
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
            runtime_config: None,
        };

        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO threads (thread_id, agent_id, title, created_at, updated_at, runtime_config)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                info.thread_id,
                info.agent_id.0,
                info.title,
                info.created_at,
                info.updated_at,
                info.runtime_config
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
            runtime_config: None,
        };

        let conn = self.lock_conn();
        conn.execute(
            "INSERT OR IGNORE INTO threads (thread_id, agent_id, title, created_at, updated_at, runtime_config)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                info.thread_id,
                info.agent_id.0,
                info.title,
                info.created_at,
                info.updated_at,
                info.runtime_config
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
                "SELECT thread_id, agent_id, title, created_at, updated_at, runtime_config
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
                        runtime_config: row.get::<_, Option<String>>(5)?,
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
                i.instance_id, i.agent_type, i.title, i.thread_id,
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
                i.instance_id, i.agent_type, i.title, i.thread_id,
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
                i.instance_id, i.agent_type, i.title, i.thread_id,
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
                i.instance_id, i.agent_type, i.title, i.thread_id,
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
                source_kind, source_document_path, source_memo_id, role_memo_id, role_name,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(instance_id) DO UPDATE SET
                agent_type = excluded.agent_type,
                title = excluded.title,
                thread_id = excluded.thread_id,
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
                    i.instance_id, i.agent_type, i.title, i.thread_id,
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
                "SELECT thread_id, agent_id, title, created_at, updated_at, runtime_config
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
                        runtime_config: row.get::<_, Option<String>>(5)?,
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

    /// 写入/覆盖 thread 的 runtime_config 快照（JSON 字符串）。
    ///
    /// 写时机：仅 chat_stream 入口（懒写）；UI 改控件不调此方法。
    /// 接收 raw JSON 字符串而非 `RuntimeConfig` 结构 → 避免双层序列化，
    /// 也让前端可以传"半成品"（比如只改 model 不带 access）原样落盘。
    ///
    /// 若 thread 不存在返回 ThreadError::NotFound ── chat_stream 入口
    /// 走 ensure_thread 先保证行存在再写。
    pub async fn upsert_runtime_config(
        &self,
        thread_id: &str,
        config_json: &str,
    ) -> Result<(), ThreadError> {
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.lock_conn();
        let updated = conn.execute(
            "UPDATE threads SET runtime_config = ?1, updated_at = ?2 WHERE thread_id = ?3",
            params![config_json, now, thread_id],
        )?;
        if updated == 0 {
            return Err(ThreadError::NotFound(thread_id.to_string()));
        }
        Ok(())
    }

    /// 读取 thread 的 runtime_config（JSON 字符串形式）。
    /// 供前端启动 / 切 thread 时拉持久态作为 UI 控件初值。
    pub async fn get_runtime_config(&self, thread_id: &str) -> Result<Option<String>, ThreadError> {
        let conn = self.lock_conn();
        // `optional()` 把 Result<Option<String>, _> 转成 Option<Result<_, _>>。
        // 第一个 `?` 抛错后剩下 Option<Option<String>> ── None = 行不存在,
        // Some(None) = 行存在但 runtime_config 列是 NULL。
        let raw = conn
            .query_row(
                "SELECT runtime_config FROM threads WHERE thread_id = ?1",
                [thread_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(ThreadError::from)?
            .flatten();
        // 规范化：空字符串视同 None（避免上游意外写入空 JSON）
        Ok(raw.filter(|s| !s.is_empty()))
    }

    fn get_thread_info_with_conn(
        &self,
        conn: &Connection,
        thread_id: &str,
    ) -> Result<Option<ThreadInfo>, ThreadError> {
        Ok(conn
            .query_row(
                "SELECT thread_id, agent_id, title, created_at, updated_at, runtime_config
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
                        runtime_config: row.get::<_, Option<String>>(5)?,
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
            // runtime_config 列 nullable ── 用 Option<String> 类型断言拿到 NULL。
            runtime_config: row.get::<_, Option<String>>(5)?,
        })
    }

    /// Layer 4: 涓?`row_to_message` 鍚屽舰, 浣?SELECT 澶氬彇浜?sequence 鍒?    /// (column 15). 鍒嗛〉 SQL 鐢ㄨ繖涓増鏈嬁鍥?sequence 浠ユ瀯閫?oldest_sequence
    /// cursor; 鍏跺畠璺緞鐢?`row_to_message` 涓嶅彉.
    fn row_to_agent_conversation_instance(
        row: &rusqlite::Row<'_>,
    ) -> rusqlite::Result<AgentConversationInstance> {
        let source = AgentConversationSource {
            kind: row.get(4)?,
            document_path: row.get(5)?,
            memo_id: row.get(6)?,
        };
        let role_memo_id: Option<String> = row.get(7)?;
        let role_name: Option<String> = row.get(8)?;
        let role = if role_memo_id.is_some() || role_name.is_some() {
            Some(AgentConversationRole {
                memo_id: role_memo_id,
                name: role_name,
            })
        } else {
            None
        };
        let run_id: Option<String> = row.get(11)?;
        let run = if let Some(run_id) = run_id {
            let usage_json: Option<String> = row.get(20)?;
            let status_info_json: Option<String> = row.get(21)?;
            Some(AgentConversationRun {
                run_id,
                status: row.get(12)?,
                started_at: row.get(13)?,
                ended_at: row.get(14)?,
                current_tool: row.get(15)?,
                model: row.get(16)?,
                model_id: row.get(17)?,
                reasoning_effort: row.get(18)?,
                last_run_at: row.get(19)?,
                reason: row.get(22)?,
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
            source,
            role,
            run,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
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

#[cfg(test)]
mod tests {
    use super::*;

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
        // 娉ㄦ剰: create_thread 宸茬粡鐢?default 瀹炵幇鐢熸垚 thread_id, 杩欓噷瑕嗙洊.
        // 绠€鍖栨祴璇? 鐢ㄧ洿鎺?SQL 鎻掑叆鎺у埗 thread_id.
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
        // ASC 鎺掑簭 鈹€鈹€ 鏈€鍚庝竴鏉″簲鏄?msg-24, 绗竴鏉″簲鏄?msg-15.
        assert_eq!(page.messages.first().unwrap().id, "msg-15");
        assert_eq!(page.messages.last().unwrap().id, "msg-24");
        assert!(
            page.has_more,
            "25 鏉℃暟鎹彇鏈€杩?10 鏉? 杩樻湁 15 鏉℃湭鎷?"
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
        assert!(second.has_more, "鎷変簡 20 鏉¤繕鍓?5 鏉?");
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

        // limit=0 搴旇 clamp 鍒?1
        let page = manager
            .get_thread_messages_page("t5", None, 0)
            .await
            .unwrap();
        assert_eq!(page.messages.len(), 1);

        // limit > 1000 搴旇 clamp 鍒?1000 (杩欓噷鍙湁 5 鏉℃暟鎹? 瀹為檯杩斿洖 5)
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

    // ── Phase 4: per-thread runtime_config 持久化测试 ──
    // 覆盖: 写入 → 读回 → 跨 thread 隔离 → 缺 thread 时 NotFound

    #[tokio::test]
    async fn upsert_runtime_config_round_trip() {
        let manager = ThreadManager::for_tests();
        seed_thread(&manager, "cfg-t1", 0).await;

        // 未写时读 → None
        assert_eq!(
            manager.get_runtime_config("cfg-t1").await.unwrap(),
            None,
            "fresh thread should not have runtime_config",
        );

        // 写入
        let cfg_json = r#"{"model":{"key":"gpt-5.5"},"access":{"sandbox":"full-access"},"files":{"workspace":"/tmp/a","folders":["/tmp/a"],"notebooks":[]}}"#;
        manager
            .upsert_runtime_config("cfg-t1", cfg_json)
            .await
            .expect("upsert");

        // 读回一致
        let read_back = manager
            .get_runtime_config("cfg-t1")
            .await
            .unwrap()
            .expect("config should be present after upsert");
        assert_eq!(read_back, cfg_json);

        // 解析为 RuntimeConfig 校验字段
        let parsed: RuntimeConfig = serde_json::from_str(&read_back).expect("parse RuntimeConfig");
        assert_eq!(parsed.model.as_ref().unwrap().key, "gpt-5.5");
        assert_eq!(parsed.access.as_ref().unwrap().sandbox, "full-access",);
        assert_eq!(
            parsed.files.as_ref().unwrap().workspace.as_deref(),
            Some("/tmp/a"),
        );
        assert_eq!(parsed.files.as_ref().unwrap().folders, vec!["/tmp/a"]);
    }

    #[tokio::test]
    async fn runtime_config_isolated_per_thread() {
        let manager = ThreadManager::for_tests();
        // 直接 INSERT OR REPLACE 跳过 seed_thread 的 create_thread ──
        // 避免同毫秒 timestamp 撞 key。
        {
            let conn = manager.lock_conn();
            for tid in ["iso-a", "iso-b"] {
                conn.execute(
                    "INSERT OR REPLACE INTO threads (thread_id, agent_id, title, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![tid, "test-agent", "iso test", 0_i64, 0_i64],
                )
                .unwrap();
            }
        }

        manager
            .upsert_runtime_config("iso-a", r#"{"model":{"key":"A"}}"#)
            .await
            .unwrap();
        manager
            .upsert_runtime_config("iso-b", r#"{"model":{"key":"B"}}"#)
            .await
            .unwrap();

        let a = manager.get_runtime_config("iso-a").await.unwrap().unwrap();
        let b = manager.get_runtime_config("iso-b").await.unwrap().unwrap();
        assert!(a.contains(r#""key":"A""#));
        assert!(b.contains(r#""key":"B""#));
        assert!(!a.contains(r#""key":"B""#));
        assert!(!b.contains(r#""key":"A""#));
    }

    #[tokio::test]
    async fn upsert_runtime_config_unknown_thread_returns_not_found() {
        let manager = ThreadManager::for_tests();
        let err = manager
            .upsert_runtime_config("ghost", r#"{"model":{"key":"X"}}"#)
            .await
            .expect_err("should fail");
        match err {
            ThreadError::NotFound(id) => assert_eq!(id, "ghost"),
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn get_runtime_config_treats_empty_string_as_none() {
        let manager = ThreadManager::for_tests();
        seed_thread(&manager, "empty-cfg", 0).await;
        manager
            .upsert_runtime_config("empty-cfg", "")
            .await
            .expect("upsert empty");

        let read = manager.get_runtime_config("empty-cfg").await.unwrap();
        // 空字符串视同 None ── `chat_stream` 入口对 message.thread_runtime_config
        // 做 trim().is_empty() 过滤, 这里是 SQL 层 normalize, 防止上游意外写入空 JSON。
        assert_eq!(read, None);
    }

    #[tokio::test]
    async fn upsert_overrides_previous_config() {
        let manager = ThreadManager::for_tests();
        seed_thread(&manager, "ovr", 0).await;

        manager
            .upsert_runtime_config("ovr", r#"{"model":{"key":"OLD"}}"#)
            .await
            .unwrap();
        manager
            .upsert_runtime_config("ovr", r#"{"model":{"key":"NEW"}}"#)
            .await
            .unwrap();

        let read = manager.get_runtime_config("ovr").await.unwrap().unwrap();
        assert!(read.contains(r#""key":"NEW""#));
        assert!(!read.contains(r#""key":"OLD""#));
    }
}
