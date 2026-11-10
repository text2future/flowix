//! macOS Keychain 后端 ── `SecretBackend` 的平台实现。
//!
//! 为什么默认走 Keychain 而不是 SQLite：0600 的文件挡不住「以同一用户运行的
//! 其它进程」，而 Keychain 条目带 ACL，只有本应用（签名后）能无提示读取。
//! 云端 refresh token 与各家 API key 都在这条路径上，泄露即账号被接管。
//!
//! 仍在 SQLite（`DbBackend`）的场景：非 macOS 平台，以及迁移失败时的兜底
//! ——Keychain 不可用（企业 MDM 禁用、钥匙串拒绝访问）不能让登录挂掉，
//! 退回原行为。这也是模块文档「headless/CI 行为一致」约束的延续。

use super::{KeyBackend, SecretBackend, SecretStoreError, SecretString};

/// Keychain 里的 service 名，相当于命名空间；account 沿用 `<provider>::<account>`。
const SERVICE: &str = "flowix";

pub struct KeychainBackend;

impl KeychainBackend {
    pub fn new() -> Self {
        Self
    }

    fn entry(&self, account: &str) -> Result<keyring::Entry, SecretStoreError> {
        keyring::Entry::new(SERVICE, account)
            .map_err(|e| SecretStoreError::Platform(format!("keychain entry: {e}")))
    }
}

impl Default for KeychainBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretBackend for KeychainBackend {
    fn save(&self, account: &str, secret: &str) -> Result<(), SecretStoreError> {
        self.entry(account)?
            .set_password(secret)
            .map_err(|e| SecretStoreError::Platform(format!("keychain save: {e}")))
    }

    fn load(&self, account: &str) -> Result<Option<SecretString>, SecretStoreError> {
        match self.entry(account)?.get_password() {
            Ok(value) => Ok(Some(SecretString::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(SecretStoreError::Platform(format!("keychain load: {e}"))),
        }
    }

    fn delete(&self, account: &str) -> Result<bool, SecretStoreError> {
        match self.entry(account)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(e) => Err(SecretStoreError::Platform(format!("keychain delete: {e}"))),
        }
    }

    fn backend_name(&self) -> KeyBackend {
        KeyBackend::Keychain
    }
}
