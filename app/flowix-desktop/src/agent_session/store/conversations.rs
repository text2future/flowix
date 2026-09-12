//! Agent conversation instances, frozen working directories, and lifecycle cleanup.

use super::ThreadManager;
use crate::agent_session::error::ThreadError;
use crate::agent_session::types::{
    AgentConversationCursor, AgentConversationInstance, AgentConversationRole,
    AgentConversationSource, AgentConversationTypeCount, UpsertAgentConversationInstance,
};
use rusqlite::{params, OptionalExtension};
use std::path::PathBuf;
use std::sync::Arc;

fn sanitize_frontend_runtime_config(raw: Option<String>) -> Option<String> {
    let raw = raw?;
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Some(raw);
    };
    let removed = value
        .as_object_mut()
        .and_then(|object| object.remove("frozenCwd"))
        .is_some();
    if !removed {
        return Some(raw);
    }
    Some(serde_json::to_string(&value).unwrap_or(raw))
}

impl ThreadManager {
    pub async fn list_agent_conversation_instances(
        self: &Arc<Self>,
    ) -> Result<Vec<AgentConversationInstance>, ThreadError> {
        self.run_blocking(move |tm| tm.list_agent_conversation_instances_inner())
            .await
    }

    pub async fn list_agent_conversation_instances_page(
        self: &Arc<Self>,
        notebook_id: Option<String>,
        agent_type: Option<String>,
        cursor: Option<AgentConversationCursor>,
        limit: usize,
    ) -> Result<Vec<AgentConversationInstance>, ThreadError> {
        self.run_blocking(move |tm| {
            tm.list_agent_conversation_instances_page_inner(notebook_id, agent_type, cursor, limit)
        })
        .await
    }

    fn list_agent_conversation_instances_page_inner(
        &self,
        notebook_id: Option<String>,
        agent_type: Option<String>,
        cursor: Option<AgentConversationCursor>,
        limit: usize,
    ) -> Result<Vec<AgentConversationInstance>, ThreadError> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT
                i.id, i.agent, ti.title, ti.id, i.config_json,
                legacy.frozen_cwd, i.source, i.document_path, i.memo_id,
                i.role_memo_id, i.role_name, i.created_at, i.updated_at, i.notebook_id,
                COALESCE(
                    CASE i.agent
                        WHEN 'codex' THEN (SELECT external_id FROM threads_codex WHERE thread_id = ti.id)
                        WHEN 'deepseek-harness' THEN (SELECT external_id FROM threads_dsh WHERE thread_id = ti.id)
                        WHEN 'opencode' THEN (SELECT external_id FROM threads_opencode WHERE thread_id = ti.id)
                        WHEN 'hermes' THEN (SELECT external_id FROM threads_hermes WHERE thread_id = ti.id)
                        WHEN 'claude' THEN (SELECT external_id FROM threads_claude WHERE thread_id = ti.id)
                    END,
                    (SELECT external_session_id FROM thread_external_sessions
                     WHERE thread_id = ti.id AND runtime = i.agent)
                )
             FROM agent_instances i
             LEFT JOIN threads_index ti ON ti.instance_id = i.id
             LEFT JOIN agent_conversation_instances legacy ON legacy.instance_id = i.id
             WHERE (?1 IS NULL OR i.notebook_id = ?1)
               AND (?2 IS NULL OR i.agent = ?2)
               AND (
                   ?3 IS NULL
                   OR i.updated_at < ?3
                   OR (i.updated_at = ?3 AND i.id < ?4)
               )
               AND NOT (
                 i.agent = 'opencode'
                 AND ti.id GLOB 'ses_*'
                 AND i.id = 'legacy-' || ti.id
                 AND legacy.instance_id IS NULL
             )
             ORDER BY i.updated_at DESC, i.id DESC
             LIMIT ?5",
        )?;
        let rows = stmt.query_map(
            params![
                notebook_id,
                agent_type,
                cursor.as_ref().map(|value| value.updated_at),
                cursor.as_ref().map(|value| value.instance_id.as_str()),
                limit as i64,
            ],
            Self::row_to_agent_conversation_instance,
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub async fn list_agent_conversation_type_counts_by_notebook(
        self: &Arc<Self>,
        notebook_id: Option<String>,
    ) -> Result<Vec<AgentConversationTypeCount>, ThreadError> {
        self.run_blocking(move |tm| {
            let conn = tm.lock_conn();
            let mut stmt = conn.prepare(
                "SELECT i.agent, COUNT(*)
                 FROM agent_instances i
                 LEFT JOIN threads_index ti ON ti.instance_id = i.id
                 LEFT JOIN agent_conversation_instances legacy ON legacy.instance_id = i.id
                 WHERE (?1 IS NULL OR i.notebook_id = ?1)
                   AND NOT (
                       i.agent = 'opencode'
                       AND ti.id GLOB 'ses_*'
                       AND i.id = 'legacy-' || ti.id
                       AND legacy.instance_id IS NULL
                   )
                 GROUP BY i.agent",
            )?;
            let rows = stmt.query_map(params![notebook_id], |row| {
                Ok(AgentConversationTypeCount {
                    agent_type: row.get(0)?,
                    count: row.get::<_, i64>(1)? as usize,
                })
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await
    }

    fn list_agent_conversation_instances_inner(
        &self,
    ) -> Result<Vec<AgentConversationInstance>, ThreadError> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT
                i.id, i.agent, ti.title, ti.id, i.config_json,
                legacy.frozen_cwd, i.source, i.document_path, i.memo_id,
                i.role_memo_id, i.role_name, i.created_at, i.updated_at, i.notebook_id,
                COALESCE(
                    CASE i.agent
                        WHEN 'codex' THEN (SELECT external_id FROM threads_codex WHERE thread_id = ti.id)
                        WHEN 'deepseek-harness' THEN (SELECT external_id FROM threads_dsh WHERE thread_id = ti.id)
                        WHEN 'opencode' THEN (SELECT external_id FROM threads_opencode WHERE thread_id = ti.id)
                        WHEN 'hermes' THEN (SELECT external_id FROM threads_hermes WHERE thread_id = ti.id)
                        WHEN 'claude' THEN (SELECT external_id FROM threads_claude WHERE thread_id = ti.id)
                    END,
                    (SELECT external_session_id FROM thread_external_sessions
                     WHERE thread_id = ti.id AND runtime = i.agent)
                )
             FROM agent_instances i
             LEFT JOIN threads_index ti ON ti.instance_id = i.id
             LEFT JOIN agent_conversation_instances legacy ON legacy.instance_id = i.id
             WHERE NOT (
                 i.agent = 'opencode'
                 AND ti.id GLOB 'ses_*'
                 AND i.id = 'legacy-' || ti.id
                 AND legacy.instance_id IS NULL
             )
             ORDER BY i.updated_at DESC",
        )?;
        let rows = stmt.query_map([], Self::row_to_agent_conversation_instance)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Count conversation instances scoped to a notebook for the sidebar badge.
    ///
    /// A selected notebook only counts conversations explicitly assigned to it.
    /// `None` counts the whole table.
    pub async fn count_agent_conversation_instances_by_notebook(
        self: &Arc<Self>,
        notebook_id: Option<String>,
    ) -> Result<usize, ThreadError> {
        self.run_blocking(move |tm| {
            tm.count_agent_conversation_instances_by_notebook_inner(notebook_id)
        })
        .await
    }

    fn count_agent_conversation_instances_by_notebook_inner(
        &self,
        notebook_id: Option<String>,
    ) -> Result<usize, ThreadError> {
        let conn = self.lock_conn();
        let count = conn.query_row(
            "SELECT COUNT(*)
             FROM agent_instances i
             LEFT JOIN threads_index ti ON ti.instance_id = i.id
             LEFT JOIN agent_conversation_instances legacy ON legacy.instance_id = i.id
             WHERE (?1 IS NULL OR i.notebook_id = ?1)
               AND NOT (
                   i.agent = 'opencode'
                   AND ti.id GLOB 'ses_*'
                   AND i.id = 'legacy-' || ti.id
                   AND legacy.instance_id IS NULL
               )",
            params![notebook_id],
            |row| row.get::<_, i64>(0),
        )?;
        Ok(count as usize)
    }

    pub async fn get_agent_conversation_instance(
        self: &Arc<Self>,
        instance_id: &str,
    ) -> Result<Option<AgentConversationInstance>, ThreadError> {
        let instance_id = instance_id.to_string();
        self.run_blocking(move |tm| tm.get_agent_conversation_instance_inner(&instance_id))
            .await
    }

    fn get_agent_conversation_instance_inner(
        &self,
        instance_id: &str,
    ) -> Result<Option<AgentConversationInstance>, ThreadError> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT
                i.id, i.agent, ti.title, ti.id, i.config_json,
                legacy.frozen_cwd, i.source, i.document_path, i.memo_id,
                i.role_memo_id, i.role_name, i.created_at, i.updated_at, i.notebook_id,
                COALESCE(
                    CASE i.agent
                        WHEN 'codex' THEN (SELECT external_id FROM threads_codex WHERE thread_id = ti.id)
                        WHEN 'deepseek-harness' THEN (SELECT external_id FROM threads_dsh WHERE thread_id = ti.id)
                        WHEN 'opencode' THEN (SELECT external_id FROM threads_opencode WHERE thread_id = ti.id)
                        WHEN 'hermes' THEN (SELECT external_id FROM threads_hermes WHERE thread_id = ti.id)
                        WHEN 'claude' THEN (SELECT external_id FROM threads_claude WHERE thread_id = ti.id)
                    END,
                    (SELECT external_session_id FROM thread_external_sessions
                     WHERE thread_id = ti.id AND runtime = i.agent)
                )
             FROM agent_instances i
             LEFT JOIN threads_index ti ON ti.instance_id = i.id
             LEFT JOIN agent_conversation_instances legacy ON legacy.instance_id = i.id
             WHERE i.id = ?1",
            [instance_id],
            Self::row_to_agent_conversation_instance,
        )
        .optional()
        .map_err(ThreadError::from)
    }

    pub async fn find_agent_conversation_by_thread_id(
        self: &Arc<Self>,
        thread_id: &str,
    ) -> Result<Option<AgentConversationInstance>, ThreadError> {
        let thread_id = thread_id.to_string();
        self.run_blocking(move |tm| tm.find_agent_conversation_by_thread_id_inner(&thread_id))
            .await
    }

    fn find_agent_conversation_by_thread_id_inner(
        &self,
        thread_id: &str,
    ) -> Result<Option<AgentConversationInstance>, ThreadError> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT
                i.id, i.agent, ti.title, ti.id, i.config_json,
                legacy.frozen_cwd, i.source, i.document_path, i.memo_id,
                i.role_memo_id, i.role_name, i.created_at, i.updated_at, i.notebook_id,
                COALESCE(
                    CASE i.agent
                        WHEN 'codex' THEN (SELECT external_id FROM threads_codex WHERE thread_id = ti.id)
                        WHEN 'deepseek-harness' THEN (SELECT external_id FROM threads_dsh WHERE thread_id = ti.id)
                        WHEN 'opencode' THEN (SELECT external_id FROM threads_opencode WHERE thread_id = ti.id)
                        WHEN 'hermes' THEN (SELECT external_id FROM threads_hermes WHERE thread_id = ti.id)
                        WHEN 'claude' THEN (SELECT external_id FROM threads_claude WHERE thread_id = ti.id)
                    END,
                    (SELECT external_session_id FROM thread_external_sessions
                     WHERE thread_id = ti.id AND runtime = i.agent)
                )
             FROM agent_instances i
             JOIN threads_index ti ON ti.instance_id = i.id
             LEFT JOIN agent_conversation_instances legacy ON legacy.instance_id = i.id
             WHERE ti.id = ?1
             ORDER BY i.updated_at DESC
             LIMIT 1",
            [thread_id],
            Self::row_to_agent_conversation_instance,
        )
        .optional()
        .map_err(ThreadError::from)
    }

    pub async fn upsert_agent_conversation_instance(
        self: &Arc<Self>,
        input: UpsertAgentConversationInstance,
    ) -> Result<AgentConversationInstance, ThreadError> {
        self.run_blocking(move |tm| tm.upsert_agent_conversation_instance_inner(input))
            .await
    }

    fn upsert_agent_conversation_instance_inner(
        &self,
        input: UpsertAgentConversationInstance,
    ) -> Result<AgentConversationInstance, ThreadError> {
        let instance_id = input.instance_id.clone();
        let runtime_config = sanitize_frontend_runtime_config(input.runtime_config);
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
        let mut conn = self.lock_conn();
        let tx = conn.transaction()?;
        let previous_thread_id = tx
            .query_row(
                "SELECT id FROM threads_index WHERE instance_id = ?1",
                [input.instance_id.as_str()],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(thread_id) = input.thread_id.as_deref() {
            let existing_owner = tx
                .query_row(
                    "SELECT instance_id FROM agent_conversation_instances
                     WHERE thread_id = ?1 AND instance_id <> ?2
                     LIMIT 1",
                    params![thread_id, input.instance_id.as_str()],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if existing_owner.is_some() {
                return Err(ThreadError::ConversationThreadConflict {
                    thread_id: thread_id.to_string(),
                    instance_id: input.instance_id,
                });
            }
            // External-agent cards can bind to a temporary product thread id
            // before the first event arrives. Create the product row here so
            // the 1:1 foreign key remains valid without making the frontend
            // perform a second race-prone write.
            tx.execute(
                "INSERT OR IGNORE INTO threads (
                    thread_id, agent_id, title, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    thread_id,
                    input.agent_type.as_str(),
                    input.initial_title.as_str(),
                    created_at,
                    updated_at,
                ],
            )?;
        }
        tx.execute(
            "INSERT INTO agent_conversation_instances (
                instance_id, agent_type, thread_id,
                runtime_config, source_kind, source_document_path, source_memo_id, source_notebook_id,
                role_memo_id, role_name, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(instance_id) DO UPDATE SET
                agent_type = excluded.agent_type,
                thread_id = excluded.thread_id,
                runtime_config = excluded.runtime_config,
                source_kind = excluded.source_kind,
                source_document_path = excluded.source_document_path,
                source_memo_id = excluded.source_memo_id,
                source_notebook_id = excluded.source_notebook_id,
                role_memo_id = excluded.role_memo_id,
                role_name = excluded.role_name,
                updated_at = excluded.updated_at
              WHERE excluded.updated_at >= agent_conversation_instances.updated_at",
            params![
                input.instance_id,
                input.agent_type,
                input.thread_id,
                runtime_config,
                source_kind,
                input.source.document_path,
                input.source.memo_id,
                input.source.notebook_id,
                role_memo_id,
                role_name,
                created_at,
                updated_at,
            ],
        )?;

        // Phase 2 compatibility write: the simplified instance/index tables
        // mirror only product-owned fields. Keep this transaction aligned with
        // the legacy representation until all callers have moved to the new
        // repository methods.
        tx.execute(
            "INSERT INTO agent_instances (
                id, agent, config_json, source, document_path, memo_id,
                notebook_id, role_memo_id, role_name, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET
                agent = excluded.agent,
                config_json = excluded.config_json,
                source = excluded.source,
                document_path = excluded.document_path,
                memo_id = excluded.memo_id,
                notebook_id = excluded.notebook_id,
                role_memo_id = excluded.role_memo_id,
                role_name = excluded.role_name,
                updated_at = excluded.updated_at
              WHERE excluded.updated_at >= agent_instances.updated_at",
            params![
                input.instance_id,
                input.agent_type.as_str(),
                runtime_config,
                source_kind,
                input.source.document_path,
                input.source.memo_id,
                input.source.notebook_id,
                role_memo_id,
                role_name,
                created_at,
                updated_at,
            ],
        )?;
        if let Some(previous_thread_id) = previous_thread_id.as_deref() {
            if input.thread_id.as_deref() != Some(previous_thread_id) {
                let legacy_instance_id = format!("legacy-{previous_thread_id}");
                tx.execute(
                    "INSERT OR IGNORE INTO agent_instances (
                        id, agent, source, created_at, updated_at
                     )
                     SELECT ?1, agent_id, 'dedicated', created_at, updated_at
                     FROM threads WHERE thread_id = ?2",
                    params![legacy_instance_id, previous_thread_id],
                )?;
                tx.execute(
                    "UPDATE threads_index SET instance_id = ?1 WHERE id = ?2",
                    params![legacy_instance_id, previous_thread_id],
                )?;
            }
        }
        if let Some(thread_id) = input.thread_id.as_deref() {
            let index_owner = tx
                .query_row(
                    "SELECT instance_id FROM threads_index WHERE id = ?1",
                    [thread_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if let Some(index_owner) = index_owner {
                if index_owner != input.instance_id && index_owner != format!("legacy-{thread_id}")
                {
                    return Err(ThreadError::ConversationThreadConflict {
                        thread_id: thread_id.to_string(),
                        instance_id: input.instance_id,
                    });
                }
            }
            tx.execute(
                "UPDATE threads_index SET instance_id = ?1 WHERE id = ?2",
                params![input.instance_id, thread_id],
            )?;
            tx.execute(
                "INSERT OR IGNORE INTO threads_index (id, instance_id, title, created_at, updated_at)
                 SELECT thread_id, ?1, title, created_at, updated_at
                 FROM threads WHERE thread_id = ?2",
                params![input.instance_id, thread_id],
            )?;
            let legacy_instance_id = format!("legacy-{thread_id}");
            if legacy_instance_id != input.instance_id {
                tx.execute(
                    "DELETE FROM agent_instances WHERE id = ?1",
                    [legacy_instance_id],
                )?;
            }
        }
        let instance = tx
            .query_row(
                "SELECT
                    i.id, i.agent, ti.title, ti.id, i.config_json,
                    legacy.frozen_cwd, i.source, i.document_path, i.memo_id,
                    i.role_memo_id, i.role_name, i.created_at, i.updated_at, i.notebook_id,
                    COALESCE(
                        CASE i.agent
                            WHEN 'codex' THEN (SELECT external_id FROM threads_codex WHERE thread_id = ti.id)
                            WHEN 'deepseek-harness' THEN (SELECT external_id FROM threads_dsh WHERE thread_id = ti.id)
                            WHEN 'opencode' THEN (SELECT external_id FROM threads_opencode WHERE thread_id = ti.id)
                            WHEN 'hermes' THEN (SELECT external_id FROM threads_hermes WHERE thread_id = ti.id)
                            WHEN 'claude' THEN (SELECT external_id FROM threads_claude WHERE thread_id = ti.id)
                        END,
                        (SELECT external_session_id FROM thread_external_sessions
                         WHERE thread_id = ti.id AND runtime = i.agent)
                    )
                 FROM agent_instances i
                 LEFT JOIN threads_index ti ON ti.instance_id = i.id
                 LEFT JOIN agent_conversation_instances legacy ON legacy.instance_id = i.id
                 WHERE i.id = ?1",
                [instance_id.as_str()],
                Self::row_to_agent_conversation_instance,
            )
            .optional()?;
        tx.commit()?;
        instance.ok_or_else(|| ThreadError::NotFound(instance_id))
    }

    /// Read the backend-owned working directory for a conversation.
    ///
    /// The lookup accepts either the product thread id or its external session
    /// id, so frontend session reconciliation cannot change cwd ownership.
    pub async fn read_frozen_cwd(
        self: &Arc<Self>,
        thread_id: &str,
    ) -> Result<Option<PathBuf>, ThreadError> {
        let thread_id = thread_id.to_string();
        self.run_blocking(move |tm| tm.read_frozen_cwd_inner(&thread_id))
            .await
    }

    fn read_frozen_cwd_inner(&self, thread_id: &str) -> Result<Option<PathBuf>, ThreadError> {
        let conn = self.lock_conn();
        let frozen_cwd = conn
            .query_row(
                "SELECT i.frozen_cwd
                 FROM agent_conversation_instances i
                 WHERE i.thread_id = ?1
                    OR i.thread_id IN (
                        SELECT s.thread_id FROM thread_external_sessions s
                        WHERE s.external_session_id = ?1
                    )
                    OR i.thread_id IN (
                        SELECT s.external_session_id FROM thread_external_sessions s
                        WHERE s.thread_id = ?1
                    )
                    OR i.thread_id IN (
                        SELECT c.external_id FROM threads_codex c WHERE c.thread_id = ?1
                        UNION ALL
                        SELECT d.external_id FROM threads_dsh d WHERE d.thread_id = ?1
                        UNION ALL
                       SELECT o.external_id FROM threads_opencode o WHERE o.thread_id = ?1
                       UNION ALL
                       SELECT h.external_id FROM threads_hermes h WHERE h.thread_id = ?1
                       UNION ALL
                       SELECT cl.external_id FROM threads_claude cl WHERE cl.thread_id = ?1
                    )
                    OR i.thread_id IN (
                        SELECT c.thread_id FROM threads_codex c WHERE c.external_id = ?1
                        UNION ALL
                        SELECT d.thread_id FROM threads_dsh d WHERE d.external_id = ?1
                        UNION ALL
                       SELECT o.thread_id FROM threads_opencode o WHERE o.external_id = ?1
                       UNION ALL
                       SELECT h.thread_id FROM threads_hermes h WHERE h.external_id = ?1
                       UNION ALL
                       SELECT cl.thread_id FROM threads_claude cl WHERE cl.external_id = ?1
                    )
                 ORDER BY CASE WHEN i.thread_id = ?1 THEN 0 ELSE 1 END,
                          i.updated_at DESC
                 LIMIT 1",
                [thread_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        Ok(frozen_cwd.map(PathBuf::from))
    }

    /// Persist `cwd` as the frozen working directory for a conversation.
    ///
    /// Called once on the first turn after the runtime-specific resolver picks
    /// a concrete directory; subsequent turns read it back via `read_frozen_cwd`
    /// and skip resolution, so the cwd never drifts mid-conversation.
    pub async fn upsert_frozen_cwd(
        self: &Arc<Self>,
        thread_id: &str,
        cwd: &std::path::Path,
    ) -> Result<(), ThreadError> {
        let thread_id = thread_id.to_string();
        let cwd = cwd.to_path_buf();
        self.run_blocking(move |tm| tm.upsert_frozen_cwd_inner(&thread_id, &cwd))
            .await
    }

    fn upsert_frozen_cwd_inner(
        &self,
        thread_id: &str,
        cwd: &std::path::Path,
    ) -> Result<(), ThreadError> {
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.lock_conn();
        let updated = conn.execute(
            "UPDATE agent_conversation_instances
             SET frozen_cwd = ?1, updated_at = max(updated_at, ?2)
             WHERE instance_id = (
                 SELECT i.instance_id
                 FROM agent_conversation_instances i
                 WHERE i.thread_id = ?3
                    OR i.thread_id IN (
                        SELECT s.thread_id FROM thread_external_sessions s
                        WHERE s.external_session_id = ?3
                    )
                    OR i.thread_id IN (
                        SELECT s.external_session_id FROM thread_external_sessions s
                        WHERE s.thread_id = ?3
                    )
                    OR i.thread_id IN (
                        SELECT c.external_id FROM threads_codex c WHERE c.thread_id = ?3
                        UNION ALL
                        SELECT d.external_id FROM threads_dsh d WHERE d.thread_id = ?3
                        UNION ALL
                 SELECT o.external_id FROM threads_opencode o WHERE o.thread_id = ?3
                 UNION ALL
                 SELECT h.external_id FROM threads_hermes h WHERE h.thread_id = ?3
                 UNION ALL
                 SELECT cl.external_id FROM threads_claude cl WHERE cl.thread_id = ?3
                    )
                    OR i.thread_id IN (
                        SELECT c.thread_id FROM threads_codex c WHERE c.external_id = ?3
                        UNION ALL
                        SELECT d.thread_id FROM threads_dsh d WHERE d.external_id = ?3
                        UNION ALL
                 SELECT o.thread_id FROM threads_opencode o WHERE o.external_id = ?3
                 UNION ALL
                 SELECT h.thread_id FROM threads_hermes h WHERE h.external_id = ?3
                 UNION ALL
                 SELECT cl.thread_id FROM threads_claude cl WHERE cl.external_id = ?3
                    )
                 ORDER BY CASE WHEN i.thread_id = ?3 THEN 0 ELSE 1 END,
                          i.updated_at DESC
                 LIMIT 1
             )",
            params![cwd.to_string_lossy(), now, thread_id],
        )?;
        if updated == 0 {
            return Err(ThreadError::NotFound(thread_id.to_string()));
        }
        Ok(())
    }

    pub async fn delete_agent_conversation_instance(
        self: &Arc<Self>,
        instance_id: &str,
    ) -> Result<bool, ThreadError> {
        let instance_id = instance_id.to_string();
        self.run_blocking(move |tm| tm.delete_agent_conversation_instance_inner(&instance_id))
            .await
    }

    fn delete_agent_conversation_instance_inner(
        &self,
        instance_id: &str,
    ) -> Result<bool, ThreadError> {
        let mut conn = self.lock_conn();
        let tx = conn.transaction()?;
        let thread_id = tx
            .query_row(
                "SELECT id FROM threads_index WHERE instance_id = ?1",
                [instance_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(thread_id) = thread_id.as_deref() {
            let legacy_instance_id = format!("legacy-{thread_id}");
            tx.execute(
                "INSERT OR IGNORE INTO agent_instances (
                    id, agent, source, created_at, updated_at
                 )
                 SELECT ?1, agent_id, 'dedicated', created_at, updated_at
                 FROM threads WHERE thread_id = ?2",
                params![legacy_instance_id, thread_id],
            )?;
            tx.execute(
                "UPDATE threads_index SET instance_id = ?1 WHERE id = ?2",
                params![legacy_instance_id, thread_id],
            )?;
        }
        let deleted = tx.execute(
            "DELETE FROM agent_conversation_instances WHERE instance_id = ?1",
            [instance_id],
        )?;
        tx.execute("DELETE FROM agent_instances WHERE id = ?1", [instance_id])?;
        tx.commit()?;
        Ok(deleted > 0)
    }

    pub async fn delete_agent_conversation_instances_for_thread(
        self: &Arc<Self>,
        thread_id: &str,
    ) -> Result<u64, ThreadError> {
        let thread_id = thread_id.to_string();
        self.run_blocking(move |tm| {
            tm.delete_agent_conversation_instances_for_thread_inner(&thread_id)
        })
        .await
    }

    fn delete_agent_conversation_instances_for_thread_inner(
        &self,
        thread_id: &str,
    ) -> Result<u64, ThreadError> {
        let mut conn = self.lock_conn();
        let tx = conn.transaction()?;
        let instance_id = tx
            .query_row(
                "SELECT instance_id FROM threads_index WHERE id = ?1",
                [thread_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let legacy_instance_id = format!("legacy-{thread_id}");
        tx.execute(
            "INSERT OR IGNORE INTO agent_instances (
                id, agent, source, created_at, updated_at
             )
             SELECT ?1, agent_id, 'dedicated', created_at, updated_at
             FROM threads WHERE thread_id = ?2",
            params![legacy_instance_id, thread_id],
        )?;
        tx.execute(
            "UPDATE threads_index SET instance_id = ?1 WHERE id = ?2",
            params![legacy_instance_id, thread_id],
        )?;
        let deleted = tx.execute(
            "DELETE FROM agent_conversation_instances WHERE thread_id = ?1",
            [thread_id],
        )?;
        if let Some(instance_id) = instance_id {
            if instance_id != legacy_instance_id {
                tx.execute("DELETE FROM agent_instances WHERE id = ?1", [instance_id])?;
            }
        }
        tx.commit()?;
        Ok(deleted as u64)
    }

    pub async fn delete_thread_with_agent_conversations(
        self: &Arc<Self>,
        thread_id: &str,
    ) -> Result<bool, ThreadError> {
        let thread_id = thread_id.to_string();
        self.run_blocking(move |tm| tm.delete_thread_with_agent_conversations_inner(&thread_id))
            .await
    }

    fn delete_thread_with_agent_conversations_inner(
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
             SELECT thread_id FROM threads_codex WHERE external_id = ?1
             UNION ALL
             SELECT thread_id FROM threads_dsh WHERE external_id = ?1
             UNION ALL
             SELECT thread_id FROM threads_opencode WHERE external_id = ?1
             UNION ALL
             SELECT thread_id FROM threads_hermes WHERE external_id = ?1
             UNION ALL
             SELECT thread_id FROM threads_claude WHERE external_id = ?1",
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
        tx.execute(
            "DELETE FROM agent_instances
             WHERE id IN (
                 SELECT instance_id FROM threads_index
                 WHERE id IN (SELECT thread_id FROM thread_delete_ids)
             )",
            [],
        )?;
        // Provider branches and the product index have independent ownership.
        // Delete the index explicitly for rows not covered by the instance
        // cascade; branch rows then follow their foreign-key cascades.
        tx.execute(
            "DELETE FROM threads_index
             WHERE id IN (SELECT thread_id FROM thread_delete_ids)",
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

    fn row_to_agent_conversation_instance(
        row: &rusqlite::Row<'_>,
    ) -> rusqlite::Result<AgentConversationInstance> {
        let source = AgentConversationSource {
            kind: row.get(6)?,
            document_path: row.get(7)?,
            memo_id: row.get(8)?,
            notebook_id: row.get(13)?,
        };
        let role_memo_id: Option<String> = row.get(9)?;
        let role_name: Option<String> = row.get(10)?;
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
            thread_title: row.get(2)?,
            thread_id: row.get(3)?,
            session_id: row.get(14)?,
            runtime_config: row.get(4)?,
            frozen_cwd: row.get(5)?,
            source,
            role,
            created_at: row.get(11)?,
            updated_at: row.get(12)?,
        })
    }
}
