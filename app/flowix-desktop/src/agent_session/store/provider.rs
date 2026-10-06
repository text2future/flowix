//! Provider-owned thread branches.
//!
//! `threads_index` owns product identity. Each table selected here is the
//! aggregate root for one runtime's durable session identity and future
//! provider-specific state. Claude events deliberately remain in the product
//! journal (`agent_external_events`), not in `threads_claude`.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};

use crate::agent_session::error::ThreadError;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ProviderThreadStore {
    Codex,
    Dsh,
    OpenCode,
    Hermes,
    Claude,
    Pi,
}

impl ProviderThreadStore {
    pub(super) fn for_runtime(runtime: &str) -> Option<Self> {
        match runtime {
            "codex" => Some(Self::Codex),
            "deepseek-harness" => Some(Self::Dsh),
            "opencode" => Some(Self::OpenCode),
            "hermes" => Some(Self::Hermes),
            "claude" => Some(Self::Claude),
            "pi" => Some(Self::Pi),
            _ => None,
        }
    }

    const fn table(self) -> &'static str {
        match self {
            Self::Codex => "threads_codex",
            Self::Dsh => "threads_dsh",
            Self::OpenCode => "threads_opencode",
            Self::Hermes => "threads_hermes",
            Self::Claude => "threads_claude",
            Self::Pi => "threads_pi",
        }
    }

    pub(super) fn list_bindings(
        self,
        conn: &Connection,
    ) -> Result<HashMap<String, String>, ThreadError> {
        let sql = format!(
            "SELECT external_id, thread_id FROM {} ORDER BY thread_id",
            self.table()
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        Ok(rows.collect::<Result<HashMap<_, _>, _>>()?)
    }

    pub(super) fn find_product_thread(
        self,
        conn: &Connection,
        external_id: &str,
    ) -> Result<Option<String>, ThreadError> {
        let sql = format!(
            "SELECT thread_id FROM {} WHERE external_id = ?1 LIMIT 1",
            self.table()
        );
        Ok(conn
            .query_row(&sql, [external_id], |row| row.get(0))
            .optional()?)
    }

    pub(super) fn find_external_id(
        self,
        conn: &Connection,
        thread_id: &str,
    ) -> Result<Option<String>, ThreadError> {
        let sql = format!(
            "SELECT external_id FROM {} WHERE thread_id = ?1",
            self.table()
        );
        Ok(conn
            .query_row(&sql, [thread_id], |row| row.get(0))
            .optional()?)
    }

    pub(super) fn upsert(
        self,
        conn: &Connection,
        thread_id: &str,
        external_id: &str,
        project_path: Option<&str>,
        session_metadata: Option<&serde_json::Value>,
        now: i64,
    ) -> Result<(), ThreadError> {
        let sql = format!(
            "INSERT INTO {} (thread_id, external_id) VALUES (?1, ?2) \
             ON CONFLICT(thread_id) DO UPDATE SET external_id = excluded.external_id",
            self.table()
        );
        conn.execute(&sql, params![thread_id, external_id])?;
        if self == Self::Claude {
            conn.execute(
                "UPDATE threads_claude
                 SET project_path = COALESCE(?1, project_path),
                     last_reconciled_at = ?2
                 WHERE thread_id = ?3",
                params![project_path, now, thread_id],
            )?;
        } else if self == Self::Pi {
            let session_file = session_metadata
                .and_then(|metadata| metadata.get("sessionFile"))
                .and_then(serde_json::Value::as_str);
            let cwd = session_metadata
                .and_then(|metadata| metadata.get("cwd"))
                .and_then(serde_json::Value::as_str);
            conn.execute(
                "UPDATE threads_pi
                 SET session_file = COALESCE(?1, session_file),
                     cwd = COALESCE(?2, cwd)
                 WHERE thread_id = ?3",
                params![session_file, cwd, thread_id],
            )?;
        }
        Ok(())
    }
}
