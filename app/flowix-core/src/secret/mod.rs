//! 敏感凭据存储适配层 ── 把 API key / token 这类敏感信息存到本地。
//!
//! ## 存储
//!
//! - All platforms: SQLite `secret_kv` values are encrypted with AES-256-GCM.
//!   The random database key is stored beside the database in a separate
//!   file with restricted permissions; no operating-system credential store is consulted.
//!   Legacy plaintext rows are encrypted in place on first access.
//!   Database backups must include the accompanying `.key` file. A process
//!   that can read both files can decrypt the secrets; this protects database
//!   copies without the key, not against other processes of the same user.
//!
//! ## 设计目标
//!
//! - **可 mock**: 测试通过 [`SecretBackend`] trait 注入 `MockBackend`,
//!   不依赖真实磁盘数据库或凭据服务。
//! - **迁移幂等**: 旧明文行在事务中就地加密。
//!
//! ## 命名
//!
//! entry 名格式: `<provider_id>::<account>`,  例如:
//! - `openai_responses::default`
//! - `anthropic::default`
//! - `minimax_coding_plan::team_a`
//!
//! 单 provider 多 account 留作未来扩展, 现在 UI 只走 `"default"`。

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
use std::{
    fs::OpenOptions,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

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
    /// SQLite 数据库；`secret_kv` 中的值使用 AES-256-GCM 加密。
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

/// key 来源 ── 给 UI 提示用户"这条 key 在加密 db 里还是旧磁盘 plaintext 上"。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeySource {
    /// 来自 SQLite `secret_kv` 表（AES-256-GCM 密文）。
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

/// 加密 SQLite 后端 ── 持有 db 文件路径, 每次操作新开 connection。
///
/// 每次开连接而非长连接 + Mutex: secret 读写极低频 (配置 key 时才写),
/// 无锁更简单, 也避免 `Mutex<Connection>` 的中毒 / 重入问题。`PathBuf`
/// 本身 `Send + Sync`, 后端天然可跨线程共享。
///
/// 并发: rusqlite `Connection::open` 默认 busy_timeout=5000ms, 多连接并发
/// 写读遇锁自动等待而非立即 SQLITE_BUSY (实测 8 线程并发 0 busy)。
pub struct DbBackend {
    db_path: PathBuf,
    key_path: PathBuf,
    rebuild_on_error: bool,
}

const ENCRYPTION_KEY_BYTES: usize = 32;
const ENCRYPTION_KEY_FILE_BYTES: u64 = ENCRYPTION_KEY_BYTES as u64;
const ENCRYPTED_SECRET_PREFIX: &str = "flowix-secret:v1:";
const AES_GCM_NONCE_BYTES: usize = 12;
const AES_GCM_TAG_BYTES: usize = 16;
const KEY_CHECK_ACCOUNT: &str = "flowix-secret-key-check-v1";
const KEY_CHECK_VALUE: &str = "flowix-secret-key-valid";

impl DbBackend {
    pub fn new(db_path: impl AsRef<Path>) -> Self {
        let db_path = db_path.as_ref().to_path_buf();
        Self {
            key_path: sidecar_key_path(&db_path),
            db_path,
            rebuild_on_error: true,
        }
    }

    /// Open a SQLite secret table inside an authoritative database.
    /// Initialization errors are returned without replacing the database file.
    pub fn new_shared_database(db_path: impl AsRef<Path>) -> Self {
        let db_path = db_path.as_ref().to_path_buf();
        Self {
            key_path: sidecar_key_path(&db_path),
            db_path,
            rebuild_on_error: false,
        }
    }

    /// 打开 (必要时创建) db 并确保 `secret_kv` 表存在。
    fn open(&self) -> Result<Connection, SecretStoreError> {
        if let Some(parent) = self.db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| SecretStoreError::BackendUnavailable(format!("create dir: {e}")))?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(false)
                .mode(0o600)
                .open(&self.db_path)
                .map_err(|error| {
                    SecretStoreError::BackendUnavailable(format!("create private db: {error}"))
                })?;
        }
        if self.db_path.exists() {
            set_file_owner_only_perms(&self.db_path)?;
        }
        let initialize = || {
            let conn = Connection::open(&self.db_path).map_err(std::io::Error::other)?;
            conn.busy_timeout(std::time::Duration::from_secs(10))
                .map_err(std::io::Error::other)?;
            conn.execute_batch(
                "PRAGMA secure_delete = ON;
                CREATE TABLE IF NOT EXISTS secret_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS secret_store_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                SELECT key, value FROM secret_kv LIMIT 0;",
            )
            .map_err(std::io::Error::other)?;
            Ok(conn)
        };
        let mut conn = if self.rebuild_on_error {
            crate::memo_file::with_database_rebuild(&self.db_path, initialize)
        } else {
            initialize()
        }
        .map_err(|error| {
            SecretStoreError::Platform(format!("initialize secret database: {error}"))
        })?;
        set_file_owner_only_perms(&self.db_path)?;
        let key = self.encryption_key(&conn)?;
        ensure_encrypted(&mut conn, &key).map_err(SecretStoreError::Platform)?;
        verify_encryption_key(&conn, &key).map_err(SecretStoreError::BackendUnavailable)?;
        if let Err(error) = cleanup_legacy_wal(&conn) {
            tracing::debug!(%error, "legacy secret WAL cleanup deferred");
        }
        Ok(conn)
    }

    fn encryption_key(
        &self,
        conn: &Connection,
    ) -> Result<[u8; ENCRYPTION_KEY_BYTES], SecretStoreError> {
        load_or_create_encryption_key(&self.key_path, conn)
            .map_err(SecretStoreError::BackendUnavailable)
    }
}

fn sidecar_key_path(db_path: &Path) -> PathBuf {
    let mut path = db_path.as_os_str().to_os_string();
    path.push(".key");
    PathBuf::from(path)
}

fn load_or_create_encryption_key(
    key_path: &Path,
    conn: &Connection,
) -> Result<[u8; ENCRYPTION_KEY_BYTES], String> {
    if let Some(parent) = key_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create key directory: {error}"))?;
    }

    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(key_path)
        .map_err(|error| format!("open encryption key file: {error}"))?;
    fs2::FileExt::lock_exclusive(&file)
        .map_err(|error| format!("lock encryption key file: {error}"))?;
    set_secret_key_permissions(key_path).map_err(|error| error.to_string())?;

    let length = file
        .metadata()
        .map_err(|error| format!("inspect encryption key file: {error}"))?
        .len();
    if length != ENCRYPTION_KEY_FILE_BYTES {
        if database_uses_encryption(conn)? {
            return Err("secret encryption key file is missing or invalid".into());
        }
        let mut key = [0; ENCRYPTION_KEY_BYTES];
        SystemRandom::new()
            .fill(&mut key)
            .map_err(|_| "generate encryption key failed".to_string())?;
        file.set_len(0)
            .and_then(|_| file.seek(SeekFrom::Start(0)).map(|_| ()))
            .map_err(|error| format!("initialize encryption key file: {error}"))?;
        file.write_all(&key)
            .map_err(|error| format!("write encryption key file: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("sync encryption key file: {error}"))?;
    }

    let mut key = [0; ENCRYPTION_KEY_BYTES];
    file.seek(SeekFrom::Start(0))
        .and_then(|_| file.read_exact(&mut key))
        .map_err(|error| format!("read encryption key file: {error}"))?;
    Ok(key)
}

fn database_uses_encryption(conn: &Connection) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM secret_store_metadata WHERE key = 'encryption_version')",
        [],
        |row| row.get(0),
    )
    .map_err(|error| format!("inspect encrypted secrets: {error}"))
}

fn encryption_version(conn: &Connection) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM secret_store_metadata WHERE key = 'encryption_version'",
        [],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| format!("read secret encryption version: {error}"))
}

fn ensure_encrypted(conn: &mut Connection, key: &[u8; ENCRYPTION_KEY_BYTES]) -> Result<(), String> {
    match encryption_version(conn)?.as_deref() {
        Some("1") => return Ok(()),
        Some(_) => return Err("unsupported secret encryption version".into()),
        None => {}
    }
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| format!("begin secret encryption migration: {error}"))?;
    let version = encryption_version(&tx)?;
    if let Some(version) = version {
        return if version == "1" {
            Ok(())
        } else {
            Err("unsupported secret encryption version".into())
        };
    }
    let rows = {
        let mut statement = tx
            .prepare("SELECT key, value FROM secret_kv ORDER BY key")
            .map_err(|error| format!("prepare secret encryption migration: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("read secret encryption migration rows: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("read secret encryption migration row: {error}"))?;
        rows
    };

    for (account, value) in rows {
        let encrypted = encrypt_secret(key, &account, &value)?;
        tx.execute(
            "UPDATE secret_kv SET value = ?1 WHERE key = ?2",
            params![encrypted, account],
        )
        .map_err(|error| format!("encrypt legacy secret row: {error}"))?;
    }
    let key_check = encrypt_secret(key, KEY_CHECK_ACCOUNT, KEY_CHECK_VALUE)?;
    tx.execute(
        "INSERT INTO secret_store_metadata (key, value) VALUES ('key_check', ?1)",
        [key_check],
    )
    .map_err(|error| format!("record secret encryption key check: {error}"))?;
    tx.execute(
        "INSERT INTO secret_store_metadata (key, value) VALUES ('encryption_version', '1')",
        [],
    )
    .map_err(|error| format!("record secret encryption version: {error}"))?;
    tx.execute(
        "INSERT INTO secret_store_metadata (key, value) VALUES ('legacy_wal_cleanup', 'pending')",
        [],
    )
    .map_err(|error| format!("record legacy WAL cleanup: {error}"))?;
    tx.commit()
        .map_err(|error| format!("commit secret encryption migration: {error}"))
}

/// WAL files may retain old pages after the transaction. Keep a persistent
/// marker until a complete checkpoint and truncation succeeds; active readers
/// can defer it, so make this attempt non-blocking and retry on a later open.
fn cleanup_legacy_wal(conn: &Connection) -> Result<(), String> {
    let pending: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM secret_store_metadata WHERE key = 'legacy_wal_cleanup')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("read legacy WAL cleanup state: {error}"))?;
    if !pending {
        return Ok(());
    }
    conn.busy_timeout(std::time::Duration::ZERO)
        .map_err(|error| format!("set WAL cleanup timeout: {error}"))?;
    let checkpoint: rusqlite::Result<(i64, i64, i64)> =
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        });
    let restore = conn.busy_timeout(std::time::Duration::from_secs(10));
    restore.map_err(|error| format!("restore database timeout: {error}"))?;
    let (busy, _, _) = checkpoint.map_err(|error| format!("checkpoint legacy WAL: {error}"))?;
    if busy != 0 {
        return Err("legacy WAL checkpoint is busy".into());
    }
    conn.execute(
        "DELETE FROM secret_store_metadata WHERE key = 'legacy_wal_cleanup'",
        [],
    )
    .map_err(|error| format!("complete legacy WAL cleanup: {error}"))?;
    Ok(())
}

fn verify_encryption_key(
    conn: &Connection,
    key: &[u8; ENCRYPTION_KEY_BYTES],
) -> Result<(), String> {
    let check: String = conn
        .query_row(
            "SELECT value FROM secret_store_metadata WHERE key = 'key_check'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("read secret encryption key check: {error}"))?;
    if decrypt_secret(key, KEY_CHECK_ACCOUNT, &check)? != KEY_CHECK_VALUE {
        return Err("secret encryption key check failed".into());
    }
    Ok(())
}

fn encrypt_secret(
    key_bytes: &[u8; ENCRYPTION_KEY_BYTES],
    account: &str,
    secret: &str,
) -> Result<String, String> {
    let key = aead::UnboundKey::new(&aead::AES_256_GCM, key_bytes)
        .map_err(|_| "AES-256-GCM key initialization failed".to_string())?;
    let key = aead::LessSafeKey::new(key);
    let mut nonce_bytes = [0; AES_GCM_NONCE_BYTES];
    SystemRandom::new()
        .fill(&mut nonce_bytes)
        .map_err(|_| "generate encryption nonce failed".to_string())?;
    let mut ciphertext = secret.as_bytes().to_vec();
    key.seal_in_place_append_tag(
        aead::Nonce::assume_unique_for_key(nonce_bytes),
        aead::Aad::from(account.as_bytes()),
        &mut ciphertext,
    )
    .map_err(|_| "AES-256-GCM encryption failed".to_string())?;

    let mut payload = Vec::with_capacity(nonce_bytes.len() + ciphertext.len());
    payload.extend_from_slice(&nonce_bytes);
    payload.extend_from_slice(&ciphertext);
    Ok(format!(
        "{ENCRYPTED_SECRET_PREFIX}{}",
        STANDARD.encode(payload)
    ))
}

fn decrypt_secret(
    key_bytes: &[u8; ENCRYPTION_KEY_BYTES],
    account: &str,
    stored: &str,
) -> Result<String, String> {
    let encoded = stored
        .strip_prefix(ENCRYPTED_SECRET_PREFIX)
        .ok_or_else(|| "secret database contains an unencrypted value".to_string())?;
    let mut payload = STANDARD
        .decode(encoded)
        .map_err(|_| "secret database value is malformed".to_string())?;
    if payload.len() < AES_GCM_NONCE_BYTES + AES_GCM_TAG_BYTES {
        return Err("secret database value is too short".into());
    }
    let nonce_bytes: [u8; AES_GCM_NONCE_BYTES] = payload[..AES_GCM_NONCE_BYTES]
        .try_into()
        .map_err(|_| "secret database nonce is malformed".to_string())?;
    let key = aead::UnboundKey::new(&aead::AES_256_GCM, key_bytes)
        .map_err(|_| "AES-256-GCM key initialization failed".to_string())?;
    let key = aead::LessSafeKey::new(key);
    let plaintext = key
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce_bytes),
            aead::Aad::from(account.as_bytes()),
            &mut payload[AES_GCM_NONCE_BYTES..],
        )
        .map_err(|_| "secret authentication failed".to_string())?;
    String::from_utf8(plaintext.to_vec())
        .map_err(|_| "decrypted secret is not valid UTF-8".to_string())
}

impl SecretBackend for DbBackend {
    fn save(&self, account: &str, secret: &str) -> Result<(), SecretStoreError> {
        let conn = self.open()?;
        let key = self.encryption_key(&conn)?;
        verify_encryption_key(&conn, &key).map_err(SecretStoreError::BackendUnavailable)?;
        let encrypted = encrypt_secret(&key, account, secret)
            .map_err(|error| SecretStoreError::Platform(format!("encrypt secret: {error}")))?;
        conn.execute(
            "INSERT OR REPLACE INTO secret_kv (key, value) VALUES (?1, ?2)",
            params![account, encrypted],
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
        value
            .map(|stored| {
                let key = self.encryption_key(&conn)?;
                verify_encryption_key(&conn, &key).map_err(SecretStoreError::BackendUnavailable)?;
                decrypt_secret(&key, account, &stored)
                    .map(SecretString::new)
                    .map_err(|error| SecretStoreError::Platform(format!("decrypt secret: {error}")))
            })
            .transpose()
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
/// let store = SecretStore::new("~/.flowix/db/default.db");
/// store.save("openai_responses::default", "sk-...")?;
/// let key = store.load("openai_responses::default")?.unwrap();
/// ```
pub struct SecretStore {
    backend: Box<dyn SecretBackend>,
}

impl SecretStore {
    /// 构造凭据后端 ── db 路径由调用方 (UserConfigStore) 按 config_dir 派生
    /// (`~/.flowix/db/default.db`)。
    ///
    /// Construct an encrypted SQLite-backed store on every platform.
    pub fn new(db_path: impl AsRef<Path>) -> Self {
        Self::new_database(db_path)
    }

    /// Construct an encrypted SQLite-backed store without consulting platform defaults.
    pub fn new_database(db_path: impl AsRef<Path>) -> Self {
        Self {
            backend: Box::new(DbBackend::new(db_path)),
        }
    }

    /// Construct an SQLite-backed store inside an existing authoritative
    /// database. Unlike `new_database`, an initialization error never triggers
    /// a whole-file rebuild.
    pub fn new_shared_database(db_path: impl AsRef<Path>) -> Self {
        Self {
            backend: Box::new(DbBackend::new_shared_database(db_path)),
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
fn set_file_owner_only_perms(path: &Path) -> Result<(), SecretStoreError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|error| {
        SecretStoreError::BackendUnavailable(format!("set private db permissions: {error}"))
    })
}

#[cfg(unix)]
fn set_secret_key_permissions(path: &Path) -> Result<(), SecretStoreError> {
    set_file_owner_only_perms(path)
}

#[cfg(windows)]
fn set_secret_key_permissions(path: &Path) -> Result<(), SecretStoreError> {
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
            },
            SetFileSecurityW, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
        },
    };

    // Protected DACL: the file owner and SYSTEM retain access; inherited ACEs
    // cannot grant other users access. Apply before writing any key bytes.
    let descriptor_text: Vec<u16> = "D:P(A;;FA;;;OW)(A;;FA;;;SY)"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let filename: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut descriptor = ptr::null_mut();
    let converted = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            descriptor_text.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        )
    };
    if converted == 0 {
        return Err(SecretStoreError::BackendUnavailable(format!(
            "create key security descriptor: {}",
            std::io::Error::last_os_error()
        )));
    }
    let result = unsafe {
        SetFileSecurityW(
            filename.as_ptr(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor,
        )
    };
    let error = (result == 0).then(std::io::Error::last_os_error);
    unsafe {
        LocalFree(descriptor.cast());
    }
    if let Some(error) = error {
        return Err(SecretStoreError::BackendUnavailable(format!(
            "set private key permissions: {error}"
        )));
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn set_secret_key_permissions(_path: &Path) -> Result<(), SecretStoreError> {
    Err(SecretStoreError::BackendUnavailable(
        "private key file permissions are unsupported on this platform".into(),
    ))
}

#[cfg(not(unix))]
fn set_file_owner_only_perms(_path: &Path) -> Result<(), SecretStoreError> {
    Ok(())
}

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

#[cfg(test)]
mod storage_rebuild_tests {
    use super::*;

    #[test]
    fn invalid_secret_database_is_preserved_before_creating_empty_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("default.db");
        std::fs::write(&path, b"invalid credential database").unwrap();
        let backend = DbBackend::new(path);
        assert!(backend.load("missing-account").unwrap().is_none());
        backend.save("new-account", "new-value").unwrap();
        assert!(backend.load("new-account").unwrap().is_some());
        assert!(temp.path().join("rebuild-backups").exists());
    }
}
