//! External runtime session mappings and normalized event log.

use super::{
    external_default_title, legacy_external_sessions, provider::ProviderThreadStore, ThreadManager,
};
use crate::agent_session::error::ThreadError;
use crate::agent_session::types::{
    AgentExternalEvent, ChatMessage, NewAgentExternalEvent, ThreadInfo, ThreadMessagesPage,
};
use crate::agent_types::AgentId;
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

const MAX_EXTERNAL_EVENTS_PER_THREAD: i64 = 10_000;
const EXTERNAL_HISTORY_TRUNCATED_JSON: &str = r#"{"kind":"history_truncated","version":1}"#;

#[derive(Default)]
struct ExternalEventMetadata {
    kind: Option<String>,
    run_id: Option<String>,
    source_sequence: Option<i64>,
    source_subsequence: Option<i64>,
}

impl ExternalEventMetadata {
    fn from_payload(payload: &str) -> Self {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
            return Self::default();
        };
        Self {
            kind: value
                .get("kind")
                .and_then(|value| value.as_str())
                .map(str::to_string),
            run_id: value
                .get("run_id")
                .and_then(|value| value.as_str())
                .map(str::to_string),
            source_sequence: value
                .get("source_sequence")
                .and_then(|value| value.as_i64()),
            source_subsequence: value
                .get("source_subsequence")
                .and_then(|value| value.as_i64()),
        }
    }
}

fn derive_external_event_key(runtime: &str, payload: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(payload).ok()?;
    let run_id = value.get("run_id").and_then(|v| v.as_str()).map(str::trim);
    let kind = value.get("kind").and_then(|v| v.as_str()).map(str::trim);
    let sequence = value
        .get("source_sequence")
        .and_then(serde_json::Value::as_u64);
    if let (Some(run_id), Some(kind), Some(sequence)) = (run_id, kind, sequence) {
        let subsequence = value
            .get("source_subsequence")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        return Some(format!(
            "{runtime}:{run_id}:{kind}:{sequence}:{subsequence}"
        ));
    }

    // Older adapters may not provide source sequence metadata. Hashing the
    // canonical payload still makes exact retries idempotent without merging
    // distinct events that merely share a run id or kind.
    let mut hasher = Sha256::new();
    hasher.update(payload.as_bytes());
    Some(format!("{runtime}:payload:{:x}", hasher.finalize()))
}

fn session_metadata_cwd(metadata: Option<&serde_json::Value>) -> Option<String> {
    let value = metadata?;
    value
        .get("cwd")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            value
                .get("metadata")
                .and_then(|metadata| metadata.get("cwd"))
                .and_then(serde_json::Value::as_str)
        })
        .or_else(|| {
            value
                .get("message")
                .and_then(|message| message.get("cwd"))
                .and_then(serde_json::Value::as_str)
        })
        .map(str::trim)
        .filter(|cwd| !cwd.is_empty())
        .map(str::to_string)
}

impl ThreadManager {
    /// Load all provider session bindings in one pass. This is used by
    /// provider-owned session lists to avoid doing a mapping query per ACP
    /// session while still supporting databases in the legacy migration phase.
    pub async fn list_external_session_bindings(
        self: &Arc<Self>,
        runtime: &str,
    ) -> Result<HashMap<String, String>, ThreadError> {
        let runtime = runtime.to_string();
        self.run_blocking(move |tm| {
            let conn = tm.lock_conn();
            let mut bindings = HashMap::new();
            if let Some(provider) = ProviderThreadStore::for_runtime(&runtime) {
                bindings.extend(provider.list_bindings(&conn)?);
            }
            for (external_id, thread_id) in
                legacy_external_sessions::list_bindings(&conn, &runtime)?
            {
                bindings.entry(external_id).or_insert(thread_id);
            }
            Ok(bindings)
        })
        .await
    }

    /// List only product-owned OpenCode threads. Session ids can temporarily
    /// appear in `threads` when an event arrives through a canonical UI id;
    /// those aliases must not become duplicate cards.
    pub async fn list_opencode_event_threads(
        self: &Arc<Self>,
    ) -> Result<Vec<ThreadInfo>, ThreadError> {
        self.run_blocking(move |tm| {
            let conn = tm.lock_conn();
            let mut stmt = conn.prepare(
                "SELECT t.thread_id, t.agent_id, t.title, t.created_at, t.updated_at
                 FROM threads t
                 WHERE t.agent_id = 'opencode'
                   AND NOT EXISTS (
                       SELECT 1 FROM thread_external_sessions s
                       WHERE s.runtime = 'opencode'
                         AND s.external_session_id = t.thread_id
                   )
                   AND NOT EXISTS (
                       SELECT 1 FROM threads_opencode s
                       WHERE s.external_id = t.thread_id
                   )
                 ORDER BY t.updated_at DESC",
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
        })
        .await
    }

    pub async fn get_external_session(
        self: &Arc<Self>,
        thread_id: &str,
        runtime: &str,
    ) -> Result<Option<String>, ThreadError> {
        let thread_id = thread_id.to_string();
        let runtime = runtime.to_string();
        self.run_blocking(move |tm| tm.get_external_session_inner(&thread_id, &runtime))
            .await
    }

    fn get_external_session_inner(
        &self,
        thread_id: &str,
        runtime: &str,
    ) -> Result<Option<String>, ThreadError> {
        let conn = self.lock_conn();
        find_external_session_in_conn(&conn, runtime, thread_id)
    }

    pub async fn find_thread_by_external_session(
        self: &Arc<Self>,
        external_session_id: &str,
        runtime: &str,
    ) -> Result<Option<String>, ThreadError> {
        let external_session_id = external_session_id.to_string();
        let runtime = runtime.to_string();
        self.run_blocking(move |tm| {
            tm.find_thread_by_external_session_inner(&external_session_id, &runtime)
        })
        .await
    }

    fn find_thread_by_external_session_inner(
        &self,
        external_session_id: &str,
        runtime: &str,
    ) -> Result<Option<String>, ThreadError> {
        let conn = self.lock_conn();
        find_product_thread_in_conn(&conn, runtime, external_session_id)
    }

    pub async fn upsert_external_session(
        self: &Arc<Self>,
        thread_id: &str,
        runtime: &str,
        external_session_id: &str,
        session_metadata: Option<serde_json::Value>,
    ) -> Result<(), ThreadError> {
        let thread_id = thread_id.to_string();
        let runtime = runtime.to_string();
        let external_session_id = external_session_id.to_string();
        self.run_blocking(move |tm| {
            tm.upsert_external_session_inner(
                &thread_id,
                &runtime,
                &external_session_id,
                session_metadata,
            )
        })
        .await
    }

    fn upsert_external_session_inner(
        &self,
        thread_id: &str,
        runtime: &str,
        external_session_id: &str,
        session_metadata: Option<serde_json::Value>,
    ) -> Result<(), ThreadError> {
        let now = chrono::Utc::now().timestamp_millis();
        let session_cwd = session_metadata_cwd(session_metadata.as_ref());
        let mut conn = self.lock_conn();
        let tx = conn.transaction()?;
        // A resumed process may report the canonical session id as its current
        // thread id. Reuse the existing product thread instead of attempting a
        // conflicting self-mapping for the same external session.
        let product_thread_id = find_product_thread_in_conn(&tx, runtime, external_session_id)?
            .unwrap_or_else(|| thread_id.to_string());
        let default_title = external_default_title(runtime);
        tx.execute(
            "INSERT OR IGNORE INTO threads (thread_id, agent_id, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![product_thread_id, runtime, default_title, now],
        )?;

        // Legacy callers may create `threads` rows without touching the new
        // index yet. Keep the additive migration safe by materializing the
        // corresponding index before inserting a provider binding.
        tx.execute(
            "INSERT OR IGNORE INTO agent_instances (
                id, agent, source, created_at, updated_at
             )
             SELECT i.instance_id, i.agent_type, i.source_kind, i.created_at, i.updated_at
             FROM agent_conversation_instances i
             WHERE i.thread_id = ?1",
            [product_thread_id.as_str()],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO agent_instances (
                id, agent, source, created_at, updated_at
             )
             SELECT 'legacy-' || t.thread_id, t.agent_id, 'dedicated', t.created_at, t.updated_at
             FROM threads t
             WHERE t.thread_id = ?1
               AND NOT EXISTS (
                   SELECT 1 FROM agent_conversation_instances i
                   WHERE i.thread_id = t.thread_id
               )",
            [product_thread_id.as_str()],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO threads_index (
                id, instance_id, title, created_at, updated_at
             )
             SELECT t.thread_id, COALESCE(i.instance_id, 'legacy-' || t.thread_id),
                    t.title, t.created_at, t.updated_at
             FROM threads t
             LEFT JOIN agent_conversation_instances i ON i.thread_id = t.thread_id
             WHERE t.thread_id = ?1",
            [product_thread_id.as_str()],
        )?;

        if let Some(provider) = ProviderThreadStore::for_runtime(runtime) {
            provider.upsert(
                &tx,
                &product_thread_id,
                external_session_id,
                session_cwd.as_deref(),
                session_metadata.as_ref(),
                now,
            )?;
        } else {
            return Err(ThreadError::NotFound(format!(
                "unsupported external runtime binding: {runtime}"
            )));
        }
        tx.execute(
            "UPDATE agent_conversation_instances
             SET frozen_cwd = COALESCE(?1, frozen_cwd),
                 updated_at = max(updated_at, ?2)
             WHERE thread_id IN (?3, ?4, ?5)",
            params![
                session_cwd,
                now,
                product_thread_id,
                thread_id,
                external_session_id
            ],
        )?;
        self.touch_thread(&tx, &product_thread_id, now)?;
        tx.commit()?;
        Ok(())
    }

    pub async fn insert_agent_external_event(
        self: &Arc<Self>,
        event: NewAgentExternalEvent,
    ) -> Result<i64, ThreadError> {
        self.run_blocking(move |tm| tm.insert_agent_external_event_inner(event))
            .await
    }

    fn insert_agent_external_event_inner(
        &self,
        event: NewAgentExternalEvent,
    ) -> Result<i64, ThreadError> {
        let now = event
            .created_at
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
        let conn = self.lock_conn();
        let thread_id = event.thread_id.clone();
        let event_key = derive_external_event_key(&event.runtime, &event.normalized_json);
        let metadata = ExternalEventMetadata::from_payload(&event.normalized_json);
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
        self.ensure_simplified_thread_index(&conn, &thread_id)?;
        conn.execute(
            "INSERT OR IGNORE INTO agent_external_events (
                runtime, thread_id, event_key, event_kind, run_id,
                source_sequence, source_subsequence,
                normalized_json, raw_json, created_at
             ) VALUES (?1, ?2, NULLIF(?3, ''), ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                event.runtime.as_str(),
                event.thread_id.as_str(),
                event_key.as_deref(),
                metadata.kind.as_deref(),
                metadata.run_id.as_deref(),
                metadata.source_sequence,
                metadata.source_subsequence,
                event.normalized_json.as_str(),
                event.raw_json.as_deref(),
                now,
            ],
        )?;
        let id = conn.query_row(
            "SELECT id FROM agent_external_events
             WHERE runtime = ?1 AND thread_id = ?2
               AND ((?3 IS NOT NULL AND event_key = ?3) OR (?3 IS NULL AND id = last_insert_rowid()))
             ORDER BY id DESC LIMIT 1",
            params![
                event.runtime.as_str(),
                event.thread_id.as_str(),
                event_key.as_deref(),
            ],
            |row| row.get(0),
        )?;
        self.prune_agent_external_events_for_thread(&conn, &event.thread_id)?;
        Ok(id)
    }

    fn prune_agent_external_events_for_thread(
        &self,
        conn: &Connection,
        thread_id: &str,
    ) -> Result<(), ThreadError> {
        let deleted = conn.execute(
            "DELETE FROM agent_external_events
             WHERE thread_id = ?1
               AND normalized_json <> ?3
               AND id <= COALESCE((
                   SELECT id
                   FROM agent_external_events
                   WHERE thread_id = ?1 AND normalized_json <> ?3
                   ORDER BY id DESC
                   LIMIT 1 OFFSET ?2
               ), -1)",
            params![
                thread_id,
                MAX_EXTERNAL_EVENTS_PER_THREAD,
                EXTERNAL_HISTORY_TRUNCATED_JSON
            ],
        )?;
        if deleted > 0 {
            conn.execute(
                "INSERT INTO agent_external_events (
                    runtime, thread_id, event_kind, normalized_json, raw_json, created_at
                 )
                 SELECT agent_id, ?1, 'history_truncated', ?2, NULL, ?3
                 FROM threads
                 WHERE thread_id = ?1
                   AND NOT EXISTS (
                       SELECT 1
                       FROM agent_external_events
                       WHERE thread_id = ?1 AND normalized_json = ?2
                   )",
                params![
                    thread_id,
                    EXTERNAL_HISTORY_TRUNCATED_JSON,
                    chrono::Utc::now().timestamp_millis()
                ],
            )?;
        }
        Ok(())
    }

    pub async fn list_agent_external_events_by_thread(
        self: &Arc<Self>,
        thread_id: &str,
        after_id: Option<i64>,
        limit: i64,
    ) -> Result<Vec<AgentExternalEvent>, ThreadError> {
        let thread_id = thread_id.to_string();
        self.run_blocking(move |tm| {
            tm.list_agent_external_events_by_thread_inner(&thread_id, after_id, limit)
        })
        .await
    }

    fn list_agent_external_events_by_thread_inner(
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
                id, runtime, thread_id, event_key, normalized_json, raw_json, created_at
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

    fn row_to_external_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentExternalEvent> {
        Ok(AgentExternalEvent {
            id: row.get(0)?,
            runtime: row.get(1)?,
            thread_id: row.get(2)?,
            event_key: row.get(3)?,
            normalized_json: row.get(4)?,
            raw_json: row.get(5)?,
            created_at: row.get(6)?,
        })
    }

    /// Read OpenCode history in complete user-turn pages and materialize the
    /// compact snapshot events as display messages. `before_event_id` is the
    /// first user event id returned by the previous page.
    pub async fn get_opencode_event_messages_page(
        self: &Arc<Self>,
        thread_id: &str,
        before_event_id: Option<i64>,
        turn_limit: i64,
    ) -> Result<Option<ThreadMessagesPage>, ThreadError> {
        let thread_id = thread_id.to_string();
        self.run_blocking(move |tm| {
            if !tm.external_event_history_exists_inner("opencode", &thread_id)? {
                return Ok(None);
            }
            tm.get_external_event_messages_page_inner(
                "opencode",
                &thread_id,
                before_event_id,
                turn_limit,
            )
            .map(Some)
        })
        .await
    }

    pub async fn get_claude_event_messages_page(
        self: &Arc<Self>,
        thread_id: &str,
        before_event_id: Option<i64>,
        turn_limit: i64,
    ) -> Result<Option<ThreadMessagesPage>, ThreadError> {
        let thread_id = thread_id.to_string();
        self.run_blocking(move |tm| {
            if !tm.external_event_history_exists_inner("claude", &thread_id)? {
                return Ok(None);
            }
            tm.get_external_event_messages_page_inner(
                "claude",
                &thread_id,
                before_event_id,
                turn_limit,
            )
            .map(Some)
        })
        .await
    }

    pub async fn get_external_event_messages_page(
        self: &Arc<Self>,
        runtime: &str,
        thread_id: &str,
        before_event_id: Option<i64>,
        turn_limit: i64,
    ) -> Result<Option<ThreadMessagesPage>, ThreadError> {
        let runtime = runtime.to_string();
        let thread_id = thread_id.to_string();
        self.run_blocking(move |tm| {
            if !tm.external_event_history_exists_inner(&runtime, &thread_id)? {
                return Ok(None);
            }
            tm.get_external_event_messages_page_inner(
                &runtime,
                &thread_id,
                before_event_id,
                turn_limit,
            )
            .map(Some)
        })
        .await
    }

    fn external_event_history_exists_inner(
        &self,
        runtime: &str,
        thread_id: &str,
    ) -> Result<bool, ThreadError> {
        let conn = self.lock_conn();
        let product_thread_id = find_product_thread_in_conn(&conn, runtime, thread_id)?
            .unwrap_or_else(|| thread_id.to_string());
        let external_session_id =
            find_external_session_in_conn(&conn, runtime, &product_thread_id)?
                .unwrap_or_else(|| product_thread_id.clone());
        Ok(conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM agent_external_events
                WHERE thread_id IN (?1, ?2) AND runtime = ?3
             )",
            params![product_thread_id, external_session_id, runtime],
            |row| row.get(0),
        )?)
    }

    fn get_external_event_messages_page_inner(
        &self,
        runtime: &str,
        thread_id: &str,
        before_event_id: Option<i64>,
        turn_limit: i64,
    ) -> Result<ThreadMessagesPage, ThreadError> {
        let turn_limit = turn_limit.clamp(1, 50);
        let conn = self.lock_conn();
        let product_thread_id = find_product_thread_in_conn(&conn, runtime, thread_id)?
            .unwrap_or_else(|| thread_id.to_string());
        let external_session_id =
            find_external_session_in_conn(&conn, runtime, &product_thread_id)?
                .unwrap_or_else(|| product_thread_id.clone());
        let upper_bound = before_event_id.unwrap_or(i64::MAX);

        let mut turn_stmt = conn.prepare(
            "SELECT e.id FROM agent_external_events e
             WHERE e.thread_id IN (?1, ?2) AND e.runtime = ?3 AND e.id < ?4
               AND (
                   e.event_kind = 'user_message'
                   OR (
                       e.event_kind = 'stream_start'
                       AND NOT EXISTS (
                           SELECT 1 FROM agent_external_events u
                           WHERE u.thread_id IN (?1, ?2) AND u.runtime = ?3
                             AND u.event_kind = 'user_message'
                             AND u.run_id = e.run_id
                       )
                   )
               )
             ORDER BY e.id DESC LIMIT ?5",
        )?;
        let turn_ids = turn_stmt
            .query_map(
                params![
                    product_thread_id.as_str(),
                    external_session_id.as_str(),
                    runtime,
                    upper_bound,
                    turn_limit
                ],
                |row| row.get::<_, i64>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let Some(cutoff_id) = turn_ids.last().copied() else {
            return Ok(ThreadMessagesPage {
                messages: Vec::new(),
                oldest_sequence: None,
                has_more: false,
                snapshot_sequence: None,
                complete_turn_ids: None,
            });
        };

        let mut event_stmt = conn.prepare(
            "SELECT id, runtime, thread_id, event_key, normalized_json, raw_json, created_at
             FROM agent_external_events
             WHERE thread_id IN (?1, ?2) AND runtime = ?3
               AND id >= ?4 AND id < ?5
             ORDER BY id ASC",
        )?;
        let events = event_stmt
            .query_map(
                params![
                    product_thread_id.as_str(),
                    external_session_id.as_str(),
                    runtime,
                    cutoff_id,
                    upper_bound
                ],
                Self::row_to_external_event,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM agent_external_events e
                WHERE e.thread_id IN (?1, ?2) AND e.runtime = ?3 AND e.id < ?4
                  AND (
                      e.event_kind = 'user_message'
                      OR (
                          e.event_kind = 'stream_start'
                          AND NOT EXISTS (
                              SELECT 1 FROM agent_external_events u
                              WHERE u.thread_id IN (?1, ?2) AND u.runtime = ?3
                                AND u.event_kind = 'user_message'
                                AND u.run_id = e.run_id
                          )
                      )
                  )
             )",
            params![
                product_thread_id.as_str(),
                external_session_id.as_str(),
                runtime,
                cutoff_id
            ],
            |row| row.get::<_, bool>(0),
        )?;

        let messages = materialize_external_messages(events);
        Ok(ThreadMessagesPage {
            messages: if runtime == "deepseek-harness" {
                normalize_legacy_deepseek_thinking(messages)
            } else {
                messages
            },
            oldest_sequence: Some(cutoff_id),
            has_more,
            snapshot_sequence: None,
            complete_turn_ids: None,
        })
    }
}

/// Resolve a provider session to the product thread. New Codex/DSH bindings
/// are authoritative; the legacy table remains a read fallback for databases
/// that have not yet been migrated or for Claude/OpenCode/Hermes.
pub(super) fn find_product_thread_in_conn(
    conn: &Connection,
    runtime: &str,
    external_session_id: &str,
) -> Result<Option<String>, ThreadError> {
    if let Some(provider) = ProviderThreadStore::for_runtime(runtime) {
        if let Some(thread_id) = provider.find_product_thread(conn, external_session_id)? {
            return Ok(Some(thread_id));
        }
    }
    legacy_external_sessions::find_product_thread(conn, runtime, external_session_id)
}

pub(super) fn find_external_session_in_conn(
    conn: &Connection,
    runtime: &str,
    thread_id: &str,
) -> Result<Option<String>, ThreadError> {
    if let Some(provider) = ProviderThreadStore::for_runtime(runtime) {
        if let Some(external_id) = provider.find_external_id(conn, thread_id)? {
            return Ok(Some(external_id));
        }
    }
    legacy_external_sessions::find_external_id(conn, runtime, thread_id)
}

pub(crate) fn materialize_external_messages(events: Vec<AgentExternalEvent>) -> Vec<ChatMessage> {
    let mut messages = Vec::new();
    let mut tool_indexes = HashMap::<String, usize>::new();
    let mut message_indexes = HashMap::<String, usize>::new();
    // Older DSH events reused `assistant:stream` across an assistant -> tool
    // -> assistant sequence. Keep a history-only cursor so those rows can be
    // split without changing the already-persisted event log.
    let mut dsh_pending_assistant_segment = HashSet::<String>::new();
    let mut dsh_assistant_segment_counts = HashMap::<String, usize>::new();
    let mut dsh_current_assistant_ids = HashMap::<String, String>::new();
    for event in events {
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(&event.normalized_json) else {
            continue;
        };
        let kind = payload.get("kind").and_then(serde_json::Value::as_str);
        let timestamp = chrono::DateTime::from_timestamp_millis(event.created_at)
            .unwrap_or_default()
            .to_rfc3339();
        let stable_message_id = payload
            .get("message_id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let message_id = stable_message_id
            .clone()
            .unwrap_or_else(|| format!("external-event-{}", event.id));
        match kind {
            Some("user_message") => {
                let raw_id = payload
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(&message_id)
                    .to_string();
                let id = external_run_scoped_id(&event.runtime, &payload, "user", &raw_id);
                let mut message = external_history_message(
                    id,
                    "user",
                    payload
                        .get("text")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    timestamp,
                );
                message.attachments = payload
                    .get("attachments")
                    .and_then(|value| serde_json::from_value(value.clone()).ok());
                messages.push(message);
            }
            Some("text") | Some("reasoning") => {
                let role = if kind == Some("reasoning") {
                    "reasoning"
                } else {
                    "assistant"
                };
                let mut message_id =
                    external_run_scoped_id(&event.runtime, &payload, role, &message_id);
                if event.runtime == "deepseek-harness" {
                    if let Some(run_key) = external_event_run_key(&event.runtime, &payload) {
                        let segment_key = format!("{run_key}:{message_id}");
                        let current_id = dsh_current_assistant_ids
                            .entry(segment_key.clone())
                            .or_insert_with(|| message_id.clone());
                        if dsh_pending_assistant_segment.remove(&run_key)
                            && message_indexes.contains_key(current_id)
                        {
                            let count = dsh_assistant_segment_counts
                                .entry(segment_key)
                                .and_modify(|value| *value += 1)
                                .or_insert(1);
                            *current_id = format!("{message_id}:segment:{count}");
                        }
                        message_id = current_id.clone();
                    }
                }
                let content = payload
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let content_mode = payload
                    .get("content_mode")
                    .and_then(serde_json::Value::as_str);
                let stable_key = stable_message_id.as_ref().map(|_| message_id.clone());
                let existing_index = stable_key
                    .as_ref()
                    .and_then(|key| message_indexes.get(key).copied());
                if let Some(index) = existing_index {
                    if content_mode == Some("snapshot") {
                        messages[index].content = content;
                    } else {
                        messages[index].content.push_str(&content);
                    }
                    messages[index].is_completed = Some(
                        payload
                            .get("message_phase")
                            .and_then(serde_json::Value::as_str)
                            == Some("completed"),
                    );
                    continue;
                }
                let mut message = external_history_message(message_id, role, content, timestamp);
                message.is_completed = Some(
                    payload
                        .get("message_phase")
                        .and_then(serde_json::Value::as_str)
                        == Some("completed"),
                );
                if let Some(key) = stable_key {
                    message_indexes.insert(key, messages.len());
                }
                messages.push(message);
            }
            Some("tool_call") => {
                if event.runtime == "deepseek-harness" {
                    if let Some(run_key) = external_event_run_key(&event.runtime, &payload) {
                        dsh_pending_assistant_segment.insert(run_key);
                    }
                }
                let raw_tool_call_id = payload
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(&message_id)
                    .to_string();
                let tool_call_id = external_run_scoped_id(
                    &event.runtime,
                    &payload,
                    "tool-call",
                    &raw_tool_call_id,
                );
                let tool_message_id = message_id.clone();
                let message_id =
                    external_run_scoped_id(&event.runtime, &payload, "tool", &tool_message_id);
                let mut message =
                    external_history_message(message_id, "tool", String::new(), timestamp);
                message.tool_call_id = Some(tool_call_id.clone());
                message.tool_name = payload
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string);
                message.tool_input = payload.get("input").cloned();
                message.is_loading = Some(true);
                message.is_completed = Some(false);
                // OpenCode can persist the initial tool_call and one or more
                // later tool_call updates (the latter commonly contains the
                // real input). Keep one history row per call, matching the
                // live reducer's update-in-place behavior.
                if let Some(index) = tool_indexes.get(&tool_call_id).copied() {
                    let existing = &mut messages[index];
                    if message.tool_name.is_some() {
                        existing.tool_name = message.tool_name;
                    }
                    if message.tool_input.is_some() {
                        existing.tool_input = message.tool_input;
                    }
                    existing.timestamp = message.timestamp;
                    existing.is_loading = message.is_loading;
                    existing.is_completed = message.is_completed;
                } else {
                    tool_indexes.insert(tool_call_id, messages.len());
                    messages.push(message);
                }
            }
            Some("tool_result") => {
                if event.runtime == "deepseek-harness" {
                    if let Some(run_key) = external_event_run_key(&event.runtime, &payload) {
                        dsh_pending_assistant_segment.insert(run_key);
                    }
                }
                let Some(raw_tool_call_id) = payload
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
                else {
                    continue;
                };
                let tool_call_id = external_run_scoped_id(
                    &event.runtime,
                    &payload,
                    "tool-call",
                    &raw_tool_call_id,
                );
                let result = payload.get("result").cloned().unwrap_or_default();
                let content = result
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| result.to_string());
                if let Some(index) = tool_indexes.get(&tool_call_id).copied() {
                    let message = &mut messages[index];
                    message.content = content.clone();
                    message.tool_data = Some(content);
                    message.is_loading = Some(false);
                    message.is_completed = Some(true);
                }
            }
            Some("error") => {
                let mut message = external_history_message(
                    message_id,
                    "assistant",
                    payload
                        .get("message")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    timestamp,
                );
                message.error_details = payload
                    .get("error_details")
                    .cloned()
                    .and_then(|details| serde_json::from_value(details).ok());
                messages.push(message);
            }
            _ => {}
        }
    }
    messages
}

/// Older DSH runs could receive reasoning as ordinary text wrapped in
/// `<think>...</think>` (some OpenAI-compatible providers do this instead of
/// sending `reasoning_content`). Convert those already-persisted rows so a
/// history reload does not change the message's visual role.
fn normalize_legacy_deepseek_thinking(messages: Vec<ChatMessage>) -> Vec<ChatMessage> {
    let mut normalized = Vec::with_capacity(messages.len());
    for message in messages {
        if message.role != "assistant"
            || (!message.content.contains("<think>") && !message.content.contains("</think>"))
        {
            normalized.push(message);
            continue;
        }

        let segments = split_legacy_thinking_text(&message.content);
        let mut reasoning_index = 0usize;
        let mut text_index = 0usize;
        for (is_reasoning, content) in segments {
            if content.is_empty() {
                continue;
            }
            let mut segment = message.clone();
            segment.content = content;
            if is_reasoning {
                segment.role = "reasoning".to_string();
                segment.id = format!("{}:reasoning:{reasoning_index}", message.id);
                segment.is_completed = Some(true);
                reasoning_index += 1;
            } else {
                segment.role = "assistant".to_string();
                segment.id = if text_index == 0 {
                    message.id.clone()
                } else {
                    format!("{}:text:{text_index}", message.id)
                };
                text_index += 1;
            }
            normalized.push(segment);
        }
    }
    normalized
}

fn split_legacy_thinking_text(value: &str) -> Vec<(bool, String)> {
    let mut segments = Vec::new();
    let mut rest = value;
    let mut reasoning = false;
    loop {
        let marker = if reasoning { "</think>" } else { "<think>" };
        let Some(index) = rest.find(marker) else {
            if !rest.is_empty() {
                segments.push((reasoning, rest.to_string()));
            }
            break;
        };
        if index > 0 {
            segments.push((reasoning, rest[..index].to_string()));
        }
        rest = &rest[index + marker.len()..];
        reasoning = !reasoning;
    }
    segments
}

fn external_run_scoped_id(
    runtime: &str,
    payload: &serde_json::Value,
    role: &str,
    item_id: &str,
) -> String {
    let run_id = payload
        .get("run_id")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty());
    if let Some(run_id) = run_id {
        return crate::agent_external::canonical_message_id(runtime, run_id, role, item_id);
    }
    item_id.to_string()
}

fn external_event_run_key(runtime: &str, payload: &serde_json::Value) -> Option<String> {
    payload
        .get("run_id")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(|run_id| format!("{runtime}:{run_id}"))
}

fn external_history_message(
    id: String,
    role: &str,
    content: String,
    timestamp: String,
) -> ChatMessage {
    ChatMessage {
        id,
        role: role.to_string(),
        message_type: None,
        content,
        llm_content: None,
        system_reminder_directory: None,
        timestamp,
        is_loading: None,
        tool_call_id: None,
        tool_name: None,
        tool_data: None,
        tool_input: None,
        tool_call: None,
        tool_result: None,
        tool_calls: None,
        reasoning: None,
        is_completed: Some(true),
        error_details: None,
        is_collapsed: None,
        codex_turn_id: None,
        turn_duration_ms: None,
        source_sequence: None,
        attachments: None,
    }
}
