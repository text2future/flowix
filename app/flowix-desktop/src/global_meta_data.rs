use serde_json::{Map, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

/// 全局元数据 KV 存储, 替代旧版 SQLite `app.db`。
///
/// 文件位置: `~/.flowix/global_meta_data.json`, 与 `preference.json` /
/// `flowix-ai-config.toml` / `notebook.json` 同目录。
///
/// 数据模型: 任意 string key → string value 的扁平映射。旧 SQLite 表
/// `app_state (key TEXT PK, value TEXT)` 本身就是 KV, 直接序列化为
/// JSON object 即可 — 完整保留原有调用方的 key 习惯(例如
/// `tag_order:<notebookId>`), 不破坏前端。
///
/// 写入采用 tmp + fsync + rename 原子化, 损坏的回退到空表并打印 warn。
pub struct GlobalMetaData {
    path: PathBuf,
    data: RwLock<Map<String, Value>>,
}

impl GlobalMetaData {
    pub fn new(path: PathBuf) -> std::io::Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let data = Self::read_from_disk(&path).unwrap_or_default();
        Ok(Self {
            path,
            data: RwLock::new(data),
        })
    }

    pub fn transient(path: PathBuf) -> Self {
        tracing::warn!(
            "global_meta_data is running in transient mode; writes to {} may fail",
            path.display()
        );
        Self {
            path,
            data: RwLock::new(Map::new()),
        }
    }

    /// 锁中毒 (panic held it) 时仍返回 guard, 避免单点 panic 拖垮 Tauri 进程。
    /// 我们的 setter 写入顺序 (内存先改, 再 flush) 让中毒概率极低。
    fn read_data(&self) -> RwLockReadGuard<'_, Map<String, Value>> {
        self.data.read().unwrap_or_else(|poisoned| {
            tracing::error!("global_meta_data lock poisoned, recovering");
            poisoned.into_inner()
        })
    }

    fn write_data(&self) -> RwLockWriteGuard<'_, Map<String, Value>> {
        self.data.write().unwrap_or_else(|poisoned| {
            tracing::error!("global_meta_data lock poisoned, recovering");
            poisoned.into_inner()
        })
    }

    fn read_from_disk(path: &PathBuf) -> Option<Map<String, Value>> {
        if !path.exists() {
            return None;
        }
        let content = fs::read_to_string(path).ok()?;
        match serde_json::from_str::<Map<String, Value>>(&content) {
            Ok(m) => Some(m),
            Err(e) => {
                tracing::warn!("global_meta_data.json parse error: {e}, falling back to empty");
                None
            }
        }
    }

    /// 原子写: tmp + fsync + 0o600 + rename + 0o600。与 user_config.rs 的
    /// atomic_write_json 同等保证 (崩溃时主文件不损坏, 权限仅本人可读写)。
    fn flush(&self, data: &Map<String, Value>) -> std::io::Result<()> {
        let content = serde_json::to_string_pretty(data)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        let tmp = self.path.with_extension("json.tmp");
        {
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&tmp)?;
            f.write_all(content.as_bytes())?;
            f.sync_all()?;
        }
        set_file_owner_only_perms(&tmp);
        fs::rename(&tmp, &self.path)?;
        set_file_owner_only_perms(&self.path);
        Ok(())
    }

    pub fn get(&self, key: &str) -> Option<String> {
        let data = self.read_data();
        data.get(key).map(|v| match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        })
    }

    pub fn get_all(&self) -> Vec<(String, String)> {
        let data = self.read_data();
        data.iter()
            .map(|(k, v)| (k.clone(), v.to_string()))
            .collect()
    }

    pub fn set(&self, key: &str, value: &str) {
        let mut data = self.write_data();
        data.insert(key.to_string(), Value::String(value.to_string()));
        if let Err(e) = self.flush(&data) {
            tracing::warn!("failed to write global_meta_data.json: {e}");
        }
    }

    pub fn delete(&self, key: &str) -> bool {
        let mut data = self.write_data();
        let removed = data.remove(key).is_some();
        if removed {
            if let Err(e) = self.flush(&data) {
                tracing::warn!("failed to write global_meta_data.json: {e}");
            }
        }
        removed
    }
}

#[cfg(unix)]
fn set_file_owner_only_perms(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::Permissions::from_mode(0o600);
    let _ = std::fs::set_permissions(path, perms);
}

#[cfg(not(unix))]
fn set_file_owner_only_perms(_path: &Path) {}
