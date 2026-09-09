use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

/// Legacy app-owned system metadata stored at `~/.flowix/boot/system.json`.
/// New notebook-scoped state is written through `read_notebook`/
/// `write_notebook` to `<notebook>/.flowix/system.json`.
pub struct SystemData {
    path: PathBuf,
    data: RwLock<SystemFile>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFile {
    #[serde(default)]
    pub tag: TagSystemData,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSystemData {
    #[serde(default)]
    pub notebooks: HashMap<String, NotebookTagSystemData>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookTagSystemData {
    #[serde(default)]
    pub hidden: Vec<String>,
    #[serde(default)]
    pub order: Vec<String>,
    #[serde(default)]
    pub layout: Vec<TagLayoutItem>,
    /// 置顶标签簿: parent fullPath → MRU 顺序的子 fullPath 列表。
    /// 空 key (`""`) 表示 root 级别。Vec 索引 0 = 最近置顶 = 渲染最前。
    /// 单一调用方 (`set_pinned_tags`) 负责整组写回, 以便 rename / delete /
    /// reparent 迁移时一次落盘。
    #[serde(default)]
    pub pinned_by_parent: HashMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagLayoutItem {
    pub id: String,
    pub parent_id: Option<String>,
}

impl SystemData {
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
            "system data is running in transient mode; writes to {} may fail",
            path.display()
        );
        Self {
            path,
            data: RwLock::new(SystemFile::default()),
        }
    }

    fn read_data(&self) -> RwLockReadGuard<'_, SystemFile> {
        self.data.read().unwrap_or_else(|poisoned| {
            tracing::error!("system data lock poisoned, recovering");
            poisoned.into_inner()
        })
    }

    fn write_data(&self) -> RwLockWriteGuard<'_, SystemFile> {
        self.data.write().unwrap_or_else(|poisoned| {
            tracing::error!("system data lock poisoned, recovering");
            poisoned.into_inner()
        })
    }

    fn read_from_disk(path: &PathBuf) -> Option<SystemFile> {
        if !path.exists() {
            return None;
        }
        let content = fs::read_to_string(path).ok()?;
        match serde_json::from_str::<SystemFile>(&content) {
            Ok(data) => Some(data),
            Err(e) => {
                tracing::warn!("system.json parse error: {e}, falling back to empty");
                None
            }
        }
    }

    fn flush(&self, data: &SystemFile) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
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

    /// Read notebook-scoped metadata from `<notebook>/.flowix/system.json`.
    /// A missing file is returned as `None`; callers may migrate legacy global
    /// state before creating it.
    pub fn read_notebook(root: &Path) -> std::io::Result<Option<SystemFile>> {
        let flowix = root.join(".flowix");
        if fs::symlink_metadata(&flowix)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!("Flowix directory is a symbolic link: {}", flowix.display()),
            ));
        }
        let path = flowix.join("system.json");
        if !path.exists() {
            return Ok(None);
        }
        let content = fs::read_to_string(&path)?;
        serde_json::from_str(&content)
            .map(Some)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
    }

    /// Atomically write notebook-scoped metadata to `<notebook>/.flowix`.
    pub fn write_notebook(root: &Path, data: &SystemFile) -> std::io::Result<()> {
        let flowix = root.join(".flowix");
        if fs::symlink_metadata(&flowix)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!("Flowix directory is a symbolic link: {}", flowix.display()),
            ));
        }
        fs::create_dir_all(&flowix)?;
        let path = flowix.join("system.json");
        let temporary = flowix.join("system.json.tmp");
        if fs::symlink_metadata(&temporary)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!(
                    "Notebook system temporary file is a symbolic link: {}",
                    temporary.display()
                ),
            ));
        }
        if fs::symlink_metadata(&path)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!(
                    "Notebook system file is a symbolic link: {}",
                    path.display()
                ),
            ));
        }
        let content = serde_json::to_string_pretty(data)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
        {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&temporary)?;
            file.write_all(content.as_bytes())?;
            file.sync_all()?;
        }
        set_file_owner_only_perms(&temporary);
        fs::rename(&temporary, &path)?;
        set_file_owner_only_perms(&path);
        Ok(())
    }

    pub fn get_tag_metadata(&self, notebook_id: &str) -> NotebookTagSystemData {
        let data = self.read_data();
        data.tag
            .notebooks
            .get(notebook_id)
            .cloned()
            .unwrap_or_default()
    }

    pub fn set_tag_layout(
        &self,
        notebook_id: &str,
        layout: Vec<TagLayoutItem>,
    ) -> std::io::Result<()> {
        let mut data = self.write_data();
        let notebook = data
            .tag
            .notebooks
            .entry(notebook_id.to_string())
            .or_default();
        notebook.order = layout.iter().map(|item| item.id.clone()).collect();
        notebook.layout = layout;
        self.flush(&data)
    }

    pub fn set_hidden_tags(&self, notebook_id: &str, hidden: Vec<String>) -> std::io::Result<()> {
        let mut data = self.write_data();
        let notebook = data
            .tag
            .notebooks
            .entry(notebook_id.to_string())
            .or_default();
        notebook.hidden = hidden;
        self.flush(&data)
    }

    /// 写回某 parent 下的 pinned 列表（MRU 顺序）。
    /// - `parent_id` 为 `None` 时使用 root 哨兵 `""`。
    /// - `pinned` 为空 Vec 时直接 `remove` 该 key，保持 `pinned_by_parent` 干净。
    pub fn set_pinned_tags(
        &self,
        notebook_id: &str,
        parent_id: Option<&str>,
        pinned: Vec<String>,
    ) -> std::io::Result<()> {
        let mut data = self.write_data();
        let notebook = data
            .tag
            .notebooks
            .entry(notebook_id.to_string())
            .or_default();
        let key = parent_id.unwrap_or("").to_string();
        if pinned.is_empty() {
            notebook.pinned_by_parent.remove(&key);
        } else {
            notebook.pinned_by_parent.insert(key, pinned);
        }
        self.flush(&data)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notebook_system_data_round_trips_under_flowix() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notebook");
        fs::create_dir_all(&root).unwrap();
        let mut notebooks = HashMap::new();
        notebooks.insert(
            "nb-1".to_string(),
            NotebookTagSystemData {
                hidden: vec!["tag/hidden".to_string()],
                ..Default::default()
            },
        );
        let file = SystemFile {
            tag: TagSystemData { notebooks },
        };
        SystemData::write_notebook(&root, &file).unwrap();
        let loaded = SystemData::read_notebook(&root).unwrap().unwrap();
        assert_eq!(loaded.tag.notebooks["nb-1"].hidden, ["tag/hidden"]);
    }

    #[cfg(unix)]
    #[test]
    fn notebook_system_rejects_flowix_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notebook");
        let target = temp.path().join("target");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&target).unwrap();
        std::os::unix::fs::symlink(&target, root.join(".flowix")).unwrap();
        assert!(SystemData::write_notebook(&root, &SystemFile::default()).is_err());
    }
}
