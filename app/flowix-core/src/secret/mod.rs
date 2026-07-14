//! 敏感凭据存储适配层 ── 把 API key / token 这类敏感信息存到本地 SQLite
//! 数据库 (`default.db`) 的 key-value 表里。
//!
//! ## 存储
//!
//! - 数据库文件: `<config_dir>/default.db` (生产环境 `~/.flowix/default.db`),
//!   与 `index.db` 同目录, 受 `~/.flowix` 目录 `0o700` 权限保护; unix 下
//!   db 文件本身再设一次 `0o600`。
//! - 表 `secret_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`, 通用
//!   key-value 形态, 未来可承载其它敏感 / 关键配置, 不止 API key。
//!
//! ## 设计目标
//!
//! - **跨进程共享**: desktop 进程与 `flowix-cli` sidecar 都指向同一份
//!   `default.db` 文件, 命中同一份 entry, 不需要在 IPC 里走 key。
//! - **可 mock**: 测试通过 [`SecretBackend`] trait 注入 `MockBackend`,
//!   不依赖真实磁盘 db。
//! - **无 OS 后端依赖**: 不再依赖 macOS Keychain / Windows CredMan /
//!   Linux Secret Service, headless Linux / CI 环境也能跑, 行为一致。
//!
//! ## 命名
//!
//! entry 名格式: `<provider_id>::<account>`,  例如:
//! - `openai_responses::default`
//! - `anthropic::default`
//! - `minimax_coding_plan::team_a`
//!
//! 单 provider 多 account 留作未来扩展, 现在 UI 只走 `"default"`。

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[cfg(test)]
use std::sync::Mutex;

/// SecretStore 错误类型 ── IPC 边界 `.map_err(String::from)` 转字符串返前端。
#[derive(Debug, Error)]
pub enum SecretStoreError {
    /// db 后端完全不可用 (目录建不了 / 文件打不开 / 权限拒绝)。
    /// 调用方应降级, 不阻塞主流程。
    #[error("secret db backend unavailable: {0}")]
    BackendUnavailable(String),

    /// db 调用本身失败 (sql / IO / 平台错)。
    #[error("secret db error: {0}")]
    Platform(String),
}

/// 后端探测结果 ── 给前端 UI 展示"用的是什么", 排查时也用得上。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyBackend {
    /// 本地 SQLite 数据库 (`default.db`)。统一后端, 全平台一致。
    Database,
    /// 后端不可用 (db 打不开)。store 仍能构造, 但 `save` / `load` 会返
    /// BackendUnavailable。
    Unavailable,
}

impl KeyBackend {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Database => "Database",
            Self::Unavailable => "Unavailable",
        }
    }
}

/// key 来源 ── 给 UI 提示用户"这条 key 在 db 里还是磁盘 plaintext 上"。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeySource {
    /// 来自 `default.db` 的 secret_kv 表
    Database,
    /// 来自 `~/.flowix/agent-config.toml` 老 plaintext (迁移中状态)
    Plaintext,
    /// 没找到
    None,
}

/// IPC 返回给前端的 key 状态 ── **不包含** 真实 key, 只含来源标记。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderKeyStatus {
    pub provider: String,
    pub source: KeySource,
    pub backend: KeyBackend,
}

/// 包裹 String 的最小"敏感字符串" ── 主要意图是标记 + Debug 防泄漏,
/// 真正的 zeroize-on-drop 需要 `zeroize` crate, 暂未引入。
#[derive(Clone)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(s: String) -> Self {
        Self(s)
    }

    /// 短暂暴露内部值 ── 调用方应尽快用完就 drop, 不长期持有。
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// 取出 owned String ── 仍然受 `SecretString` 的 Debug 保护。
    pub fn into_inner(self) -> String {
        self.0
    }
}

impl std::fmt::Debug for SecretString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 只打长度, 不打内容
        write!(f, "SecretString(<len={}>)", self.0.len())
    }
}

/// 凭据后端抽象 ── 测试可通过 `MockBackend` 注入, 不依赖真实磁盘 db。
pub trait SecretBackend: Send + Sync {
    fn save(&self, account: &str, secret: &str) -> Result<(), SecretStoreError>;
    fn load(&self, account: &str) -> Result<Option<SecretString>, SecretStoreError>;
    fn delete(&self, account: &str) -> Result<bool, SecretStoreError>;
    fn backend_name(&self) -> KeyBackend;
}

/// 真实 SQLite 后端 ── 持有 db 文件路径, 每次操作新开 connection。
///
/// 每次开连接而非长连接 + Mutex: secret 读写极低频 (配置 key 时才写),
/// 无锁更简单, 也避免 `Mutex<Connection>` 的中毒 / 重入问题。`PathBuf`
/// 本身 `Send + Sync`, 后端天然可跨线程共享。
///
/// 并发: rusqlite `Connection::open` 默认 busy_timeout=5000ms, 多连接并发
/// 写读遇锁自动等待而非立即 SQLITE_BUSY (实测 8 线程并发 0 busy)。
pub struct DbBackend {
    db_path: PathBuf,
}

impl DbBackend {
    pub fn new(db_path: impl AsRef<Path>) -> Self {
        Self {
            db_path: db_path.as_ref().to_path_buf(),
        }
    }

    /// 打开 (必要时创建) db 并确保 `secret_kv` 表存在。
    fn open(&self) -> Result<Connection, SecretStoreError> {
        if let Some(parent) = self.db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| SecretStoreError::BackendUnavailable(format!("create dir: {e}")))?;
        }
        let conn = Connection::open(&self.db_path)
            .map_err(|e| SecretStoreError::Platform(format!("open db: {e}")))?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS secret_kv (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            "#,
        )
        .map_err(|e| SecretStoreError::Platform(format!("init table: {e}")))?;
        // db 文件收紧到 0o600 (wal/shm 由 sqlite 按 umask 创建, 同机其他用户
        // 已被 0o700 目录挡住, 这里再锁主文件一层)。
        set_file_owner_only_perms(&self.db_path);
        Ok(conn)
    }
}

impl SecretBackend for DbBackend {
    fn save(&self, account: &str, secret: &str) -> Result<(), SecretStoreError> {
        let conn = self.open()?;
        conn.execute(
            "INSERT OR REPLACE INTO secret_kv (key, value) VALUES (?1, ?2)",
            params![account, secret],
        )
        .map_err(|e| SecretStoreError::Platform(format!("upsert: {e}")))?;
        Ok(())
    }

    fn load(&self, account: &str) -> Result<Option<SecretString>, SecretStoreError> {
        let conn = self.open()?;
        let value: Option<String> = conn
            .query_row(
                "SELECT value FROM secret_kv WHERE key = ?1",
                params![account],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| SecretStoreError::Platform(format!("query: {e}")))?;
        Ok(value.map(SecretString::new))
    }

    fn delete(&self, account: &str) -> Result<bool, SecretStoreError> {
        let conn = self.open()?;
        let affected = conn
            .execute("DELETE FROM secret_kv WHERE key = ?1", params![account])
            .map_err(|e| SecretStoreError::Platform(format!("delete: {e}")))?;
        Ok(affected > 0)
    }

    fn backend_name(&self) -> KeyBackend {
        KeyBackend::Database
    }
}

/// SecretStore ── 凭据存储抽象的总入口, 持有后端实例。
///
/// 用法:
/// ```ignore
/// let store = SecretStore::new("~/.flowix/default.db");
/// store.save("openai_responses::default", "sk-...")?;
/// let key = store.load("openai_responses::default")?.unwrap();
/// ```
pub struct SecretStore {
    backend: Box<dyn SecretBackend>,
}

impl SecretStore {
    /// 构造真实 SQLite 后端的 SecretStore ── db 路径由调用方 (UserConfigStore)
    /// 按 config_dir 派生 (`~/.flowix/default.db`), desktop / CLI 共用。
    pub fn new(db_path: impl AsRef<Path>) -> Self {
        Self {
            backend: Box::new(DbBackend::new(db_path)),
        }
    }

    /// 注入自定义后端 ── 主要给测试用, 也给未来"无 db 时切加密文件"留接口。
    pub fn with_backend(backend: Box<dyn SecretBackend>) -> Self {
        Self { backend }
    }

    pub fn backend(&self) -> KeyBackend {
        self.backend.backend_name()
    }

    pub fn save(&self, account: &str, secret: &str) -> Result<(), SecretStoreError> {
        if account.is_empty() {
            return Err(SecretStoreError::Platform("empty account".into()));
        }
        if secret.is_empty() {
            return Err(SecretStoreError::Platform("empty secret".into()));
        }
        self.backend.save(account, secret)
    }

    pub fn load(&self, account: &str) -> Result<Option<SecretString>, SecretStoreError> {
        self.backend.load(account)
    }

    pub fn delete(&self, account: &str) -> Result<bool, SecretStoreError> {
        self.backend.delete(account)
    }

    /// 仅探测 db 里有没有这条 entry ── 不读出值, 用于"是否配置过"的 UI 状态。
    pub fn exists(&self, account: &str) -> bool {
        self.backend
            .load(account)
            .map(|o| o.is_some())
            .unwrap_or(false)
    }
}

/// 把 (provider, account) 拼成 entry 名 ── 唯一来源, 避免散落各处的格式不统一。
pub fn entry_name(provider: &str, account: &str) -> String {
    format!("{provider}::{account}")
}

#[cfg(unix)]
fn set_file_owner_only_perms(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn set_file_owner_only_perms(_path: &Path) {}

// ============================================
// 测试 ── MockBackend + SecretStore 单测
// ============================================

#[cfg(test)]
pub mod tests;

#[cfg(test)]
pub struct MockBackend {
    /// account -> secret
    pub store: Mutex<std::collections::HashMap<String, String>>,
    pub backend_kind: KeyBackend,
    /// 强制让 save/load 返 BackendUnavailable, 用来测试降级路径
    pub fail_unavailable: bool,
}

#[cfg(test)]
impl MockBackend {
    pub fn new(kind: KeyBackend) -> Self {
        Self {
            store: Mutex::new(Default::default()),
            backend_kind: kind,
            fail_unavailable: false,
        }
    }
}

#[cfg(test)]
impl SecretBackend for MockBackend {
    fn save(&self, account: &str, secret: &str) -> Result<(), SecretStoreError> {
        if self.fail_unavailable {
            return Err(SecretStoreError::BackendUnavailable("mock".into()));
        }
        self.store
            .lock()
            .unwrap()
            .insert(account.to_string(), secret.to_string());
        Ok(())
    }

    fn load(&self, account: &str) -> Result<Option<SecretString>, SecretStoreError> {
        if self.fail_unavailable {
            return Err(SecretStoreError::BackendUnavailable("mock".into()));
        }
        Ok(self
            .store
            .lock()
            .unwrap()
            .get(account)
            .cloned()
            .map(SecretString::new))
    }

    fn delete(&self, account: &str) -> Result<bool, SecretStoreError> {
        if self.fail_unavailable {
            return Err(SecretStoreError::BackendUnavailable("mock".into()));
        }
        Ok(self.store.lock().unwrap().remove(account).is_some())
    }

    fn backend_name(&self) -> KeyBackend {
        self.backend_kind
    }
}
