//! SQLite-backed agent-session facade.
//!
//! `ThreadManager` owns the single connection and the blocking-task boundary.
//! Domain-specific SQL lives in child modules while every method continues to
//! operate on this same connection, preserving cross-table transaction semantics.

mod conversations;
mod external;
mod legacy_external_sessions;
mod messages;
mod provider;
mod threads;

pub(crate) use external::materialize_external_messages;

use rusqlite::{params, Connection, OptionalExtension};
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use super::error::ThreadError;

pub struct ThreadManager {
    conn: Mutex<Connection>,
    db_path: Option<PathBuf>,
}

fn external_default_title(runtime: &str) -> &'static str {
    match runtime {
        "claudecode" => "Claude Code session",
        "hermes" => "Hermes session",
        "opencode" => "OpenCode session",
        _ => "Codex session",
    }
}

impl ThreadManager {
    /// 娴�?�?��?fixture 鈹€鈹€ 涓嶅啓纾佺洏, �?`Connection::open_in_memory()` 寤轰竴涓┖搴撱�?    /// `agent.rs::for_tests` �?���? 鍥犱负鍗曞厓娴�?�?��獙�?`AgentManager` 鍐呴�?HashMap
    /// 鐘舵�? 涓嶇湡�?ｈ�?thread 搴撱�?
    #[cfg(test)]
    pub fn for_tests() -> Arc<ThreadManager> {
        Arc::new(Self::new_in_memory().expect("in-memory migrations failed"))
    }

    pub fn new(db_path: PathBuf) -> Result<Self, ThreadError> {
        let manager = Self::new_uninitialized(db_path)?;
        manager.initialize_storage()?;
        Ok(manager)
    }

    /// Defer disk access and schema initialization to the startup worker.
    pub fn new_uninitialized(db_path: PathBuf) -> Result<Self, ThreadError> {
        // Disk initialization belongs to the startup worker, including repair.
        let conn = Connection::open_in_memory()?;
        Ok(Self {
            conn: Mutex::new(conn),
            db_path: Some(db_path),
        })
    }

    pub fn initialize_storage(&self) -> Result<(), ThreadError> {
        let mut connection = self.lock_conn();
        let Some(path) = self.db_path.as_ref() else {
            return Self::run_migrations(&mut connection);
        };
        // Always reopen the disk path on retry. A failed attempt must never
        // turn the temporary connection into a successful in-memory store.
        let old = std::mem::replace(&mut *connection, Connection::open_in_memory()?);
        drop(old);
        let initialized = flowix_core::memo_file::with_corrupt_database_rebuild(path, || {
            let mut conn = Connection::open(path).map_err(std::io::Error::other)?;
            // A newer schema may contain user messages this binary cannot read.
            // Unsupported versions are not corruption and must not be rebuilt.
            Self::run_migrations(&mut conn).map_err(std::io::Error::other)?;
            Ok(conn)
        })
        .map_err(|error| ThreadError::Join(format!("initialize thread database: {error}")))?;
        *connection = initialized;
        Ok(())
    }

    /// Preserve healthy disk data on access or schema errors and use a fresh
    /// memory store for this session. Only confirmed file damage permits reset.
    pub fn initialize_runtime_storage(&self) -> Result<(), ThreadError> {
        if let Err(error) = self.initialize_storage() {
            tracing::warn!(%error, "thread disk initialization unavailable");
            if let Some(path) = self.db_path.as_ref() {
                if flowix_core::memo_file::database_file_is_corrupt(path).unwrap_or(false) {
                    flowix_core::memo_file::discard_database_for_runtime(path);
                    if self.initialize_storage().is_ok() {
                        return Ok(());
                    }
                }
            }
            tracing::warn!(
                "using a fresh memory thread database; original disk data retained when usable"
            );
            let mut connection = Connection::open_in_memory()?;
            Self::run_migrations(&mut connection)?;
            *self.lock_conn() = connection;
        }
        Ok(())
    }

    pub fn new_in_memory() -> Result<Self, ThreadError> {
        let mut conn = Connection::open_in_memory()?;
        Self::run_migrations(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            db_path: None,
        })
    }

    /// 鍔犻攣鍔╂�? 鈹€鈹€ 閿佷腑姣?(panic held it) 鏃朵粛杩斿洖 guard, 涓嶈鍗曠�?panic
    /// 闃绘柇鍚庣画璇�?啓銆傛�?鏈�?啓鍏ラ兘鍏堣惤鐩樺啀鏇存柊鍐�?��, 杩欑绐楀彛鏈熸�?��戙€?    /// 閿欒绾у埆鐢?`tracing::error!`, �?`user_config.rs` 淇濇寔涓�?���?��?
    pub(crate) fn lock_conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|poisoned| {
            tracing::error!("[ThreadManager] connection lock poisoned, recovering");
            poisoned.into_inner()
        })
    }

    /// Flush and truncate the WAL during graceful application shutdown.
    pub(crate) fn checkpoint_wal(&self) -> Result<(), ThreadError> {
        let conn = self.lock_conn();
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        Ok(())
    }

    /// 把同步 rusqlite 的工作丢到 tokio 阻塞线程池, 不卡 async worker。每个 async 公开
    /// 方法包一层 `_inner` 同步实现经此 helper 调度。`f` 与返回值须 Send + 'static
    /// (调用方负责把 `&str` 等 ref 参数先克隆成 owned 再 move 进闭包)。
    fn run_blocking<T, F>(
        self: &Arc<Self>,
        f: F,
    ) -> impl Future<Output = Result<T, ThreadError>> + Send
    where
        F: FnOnce(&ThreadManager) -> Result<T, ThreadError> + Send + 'static,
        T: Send + 'static,
    {
        let this = Arc::clone(self);
        async move {
            tokio::task::spawn_blocking(move || f(&this))
                .await
                .map_err(|e| ThreadError::Join(e.to_string()))?
        }
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
        conn.execute(
            "UPDATE threads_index SET updated_at = ?1 WHERE id = ?2",
            params![updated_at, thread_id],
        )?;
        Ok(())
    }

    /// Keep the simplified product index available while legacy thread
    /// callers are being migrated. This is intentionally idempotent and does
    /// not copy provider-owned state.
    pub(crate) fn ensure_simplified_thread_index(
        &self,
        conn: &Connection,
        thread_id: &str,
    ) -> Result<(), ThreadError> {
        let Some((agent, title, created_at, updated_at)) = conn
            .query_row(
                "SELECT agent_id, title, created_at, updated_at
                 FROM threads WHERE thread_id = ?1",
                [thread_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()?
        else {
            return Ok(());
        };

        let instance_id = conn
            .query_row(
                "SELECT instance_id FROM agent_conversation_instances
                 WHERE thread_id = ?1 ORDER BY updated_at DESC LIMIT 1",
                [thread_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_else(|| format!("legacy-{thread_id}"));

        conn.execute(
            "INSERT OR IGNORE INTO agent_instances (
                id, agent, source, created_at, updated_at
             ) VALUES (?1, ?2, 'dedicated', ?3, ?4)",
            params![instance_id, agent, created_at, updated_at],
        )?;
        conn.execute(
            "INSERT INTO threads_index (id, instance_id, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
                instance_id = excluded.instance_id,
                title = excluded.title,
                updated_at = excluded.updated_at",
            params![thread_id, instance_id, title, created_at, updated_at],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod storage_rebuild_tests {
    use super::*;

    #[test]
    fn runtime_thread_storage_recreates_even_when_backup_fails() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("thread.db");
        std::fs::write(&path, b"broken threads").unwrap();
        std::fs::write(temp.path().join("rebuild-backups"), b"blocked").unwrap();
        let manager = ThreadManager::new_uninitialized(path).unwrap();
        manager.initialize_runtime_storage().unwrap();
        assert_eq!(
            manager
                .lock_conn()
                .query_row("SELECT COUNT(*) FROM threads", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn runtime_future_thread_schema_is_preserved_instead_of_rebuilt() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("thread.db");
        let manager = ThreadManager::new(path.clone()).unwrap();
        manager.lock_conn().execute_batch("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('keep'); PRAGMA user_version=9999;").unwrap();
        manager.initialize_runtime_storage().unwrap();
        let original = Connection::open(path).unwrap();
        assert_eq!(
            original
                .query_row("SELECT value FROM retained", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "keep"
        );
        assert_eq!(
            original
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            9999
        );
        assert!(!temp.path().join("rebuild-backups").exists());
    }

    #[test]
    fn runtime_thread_storage_uses_memory_when_disk_creation_fails() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(format!("{}.db", "x".repeat(300)));
        let manager = ThreadManager::new_uninitialized(path).unwrap();
        manager.initialize_runtime_storage().unwrap();
        assert_eq!(
            manager
                .lock_conn()
                .query_row("SELECT COUNT(*) FROM threads", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn invalid_thread_database_is_backed_up_and_recreated() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("thread.db");
        std::fs::write(&path, b"invalid thread database").unwrap();
        let manager = ThreadManager::new(path).unwrap();
        manager.initialize_storage().unwrap();
        let count: i64 = manager
            .lock_conn()
            .query_row("SELECT COUNT(*) FROM threads", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        assert!(temp.path().join("rebuild-backups").exists());
    }

    #[test]
    fn completed_schema_marker_does_not_hide_missing_tables() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("thread.db");
        let manager = ThreadManager::new(path.clone()).unwrap();
        manager
            .lock_conn()
            .execute_batch("PRAGMA foreign_keys=OFF; DROP TABLE thread_messages;")
            .unwrap();
        assert!(manager.initialize_storage().is_err());
        manager.initialize_runtime_storage().unwrap();
        manager
            .lock_conn()
            .execute_batch("SELECT id FROM thread_messages LIMIT 0;")
            .unwrap();
        assert!(!temp.path().join("rebuild-backups").exists());
        let original = Connection::open(path).unwrap();
        assert!(original
            .prepare("SELECT id FROM thread_messages LIMIT 0")
            .is_err());
        assert!(original
            .prepare("SELECT thread_id FROM threads LIMIT 0")
            .is_ok());
    }
}
