//! Notebook storage and Markdown file operations.
//!
//! Markdown files own note content. The rebuildable path projection in each
//! notebook's `.flowix/notebook.db` addresses notes by relative path. Legacy
//! memo-ID records and APIs remain for callers that have not migrated yet;
//! new Note writes do not stamp those IDs into Markdown frontmatter or filenames.
//!
//! - `frontmatter` parses and edits authored YAML metadata.
//! - `note_index` maintains the path-keyed Note projection and path operations;
//!   it discards the old rebuildable `v2_*` projection schema on first use.
//! - `index_store` maintains legacy memo-ID records and related metadata.
//! - `ops` contains legacy CRUD and reconciliation operations.
//! - `versions` stores history currently keyed by internal memo ID.
//!
//! `MemoIndexEntry::filename` contains the disk filename, including `.md`.
//! Nested notes also carry a notebook-relative path; resolve that path against
//! the notebook root when accessing the file.

use std::path::PathBuf;
use std::{fs::OpenOptions, io};

/// memo id 随机段使用的字符集 — `[0-9a-z]` 36 个字符 (小写字母 + 数字)。
///
/// nanoid's default alphabet includes `_` and `-`; legacy memo IDs use only
/// lowercase letters and digits. New IDs contain [`MEMO_ID_LENGTH`] characters.
pub const MEMO_ID_ALPHABET: [char; 36] = [
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i',
    'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
];
pub const MEMO_ID_LENGTH: usize = 8;

mod content;
mod derivation;
mod file_management;
mod file_io;
pub(crate) mod frontmatter;
mod index_store;
mod internal_migration;
mod media_resource;
mod migration;
mod notebook;
mod notebook_registry;
mod onboarding;
mod ops;
mod registration;
pub(crate) mod time;
pub mod types;
mod note_index;
mod versions;

pub use note_index::{
    NoteEntry, NoteIndexReconcileReport, NotePropertyMigrationReport, NoteSearchHit,
    NoteTodoMigrationReport, NoteWriteOutcome,
};

// 公开 API re-export — 跟旧 `memo_file.rs` 的 pub use 边界一致。
pub use derivation::{
    apply_derived_memo_fields, ensure_todo_ids_in_content, extract_agent_threads_from_body,
    extract_title_and_preview, extract_todos_from_body, normalize_search_tag_filter,
    normalize_tag_path, tag_path_matches_filter,
};
pub use file_io::{
    atomic_create_bytes, atomic_write_bytes, filesystem_identity, rename_file_noclobber,
    FileWriteOutcome, MergedFileWriteOutcome,
};
pub use file_management::{default_create_folder_for_notebook, FileManagementPolicy};
pub use frontmatter::{
    build_md_content, extract_body_content, extract_document_metadata, extract_frontmatter_key,
    extract_frontmatter_properties, is_system_frontmatter_key, merge_frontmatter,
    normalize_document_tags, normalize_markdown_encoding_boundaries, replace_frontmatter_tags,
    DocumentMetadata, FrontmatterMetadataError, MergeOverrides, CANONICAL_FRONTMATTER_KEY,
    LEGACY_FRONTMATTER_KEY, SYSTEM_FRONTMATTER_KEYS,
};
pub use index_store::{MemoContentCommit, MemoContentRevision};
pub use internal_migration::{NotebookInternalMigrationReport, NOTEBOOK_INTERNAL_MIGRATION_KEY};
pub use media_resource::{media_kind_for_path, MediaResource, MediaResourceKind, MediaResourcePage};
pub use migration::{DataMigrationReport, NotebookMigrationReport, LATEST_DATA_MIGRATION_VERSION};
pub use ops::{
    base_filename, filename_from_notebook_relative_path, is_ignored_notebook_relative_path,
    notebook_path_from_relative, notebook_relative_path, resolve_filename_conflict,
    resolve_relative_filename_conflict, sanitize_filename_component, IsMd,
};
pub use types::{
    AgentThreadItem, DeleteTagReport, Memo, MemoColor, MemoIndexEntry, MemoIndexFile, MemoLocation,
    MemoMetadataFile, MemoTag, MemoTodoEntry, MemoVersionCleanupReport, MoveTagReport, NoteColor,
    Notebook, NotebookConfig, NotebookManifest, NotebookSetupJob, NotebookSetupJobStatus,
    NotebookSetupReport,
    PathTodoEntry, ReconcileReport, TodoItem,
};
pub use versions::{
    MemoVersionManifest, MemoVersionMeta, MemoVersionSource, PathArchiveSummary, PathVersionMeta, MEMO_AUTO_VERSION_INTERVAL_MS,
    MEMO_ORPHAN_VERSION_RETENTION, MEMO_VERSION_LIMIT,
};

/// Compatibility storage façade over notebook registry, Note catalog, media,
/// revisions and Memo-ID records. Domain implementations live in separate
/// modules; `NotebookRegistry` owns the device-local registry path and cache.
///
/// 字段:
/// - `registry`: 用户配置目录 (`~/.flowix/`) 下的设备级笔记本注册表。
/// - Note 投影、兼容 memo-ID 数据和媒体属性位于
///   `<notebook>/.flowix/notebook.db`。
/// - `current_notebook_id`: 当前活跃 notebook id, `None` 表示走默认。
/// - `index_cache`: 当前 notebook 兼容 memo-ID 列表的内存缓存。读路径先查询 SQLite
///   `memo_index_state.last_updated`，只有版本一致才复用，保证其他进程写入可见。
///   写路径 ([`MemoFile::write_index`] / `_locked` 系列) 在 DB 写入成功后回填。
///   切 notebook 时由 [`Self::set_current_notebook`] 失效。
///   `std::sync::RwLock` 而非裸 `Option`, 因为读路径常在 `&self` 调用栈上
///   (写路径持外层 `RwLock<MemoFile>` 写锁, 读路径持外层读锁; 都需要绕过
///   借用检查写入 cache 字段)。
pub struct MemoFile {
    registry: notebook_registry::NotebookRegistry,
    current_notebook_id: Option<String>,
    /// memo index / todo metadata 跨线程 RMW 互斥锁。
    ///
    /// 写路径 (创建/改名/写 body/删除/注册/对账) 持此锁跨
    /// "rename 物理文件 + 写 memo index" 全过程, 串行化 RMW。
    /// `std::sync::Mutex` 不可重入, 内部 _locked 变体跳过自拿锁。
    current_index_io: std::sync::Mutex<()>,
    /// Memo index 内存缓存。`None` = 未加载 / 已失效；命中前会校验 DB 版本。
    index_cache: std::sync::RwLock<Option<MemoIndexFile>>,
}

pub struct CrossProcessWriteGuard {
    file: std::fs::File,
}

impl Drop for CrossProcessWriteGuard {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.file);
    }
}

impl Default for MemoFile {
    fn default() -> Self {
        Self {
            registry: notebook_registry::NotebookRegistry::new(PathBuf::new()),
            current_notebook_id: None,
            current_index_io: std::sync::Mutex::new(()),
            index_cache: std::sync::RwLock::new(None),
        }
    }
}

impl MemoFile {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            registry: notebook_registry::NotebookRegistry::new(config_dir),
            current_notebook_id: None,
            current_index_io: std::sync::Mutex::new(()),
            index_cache: std::sync::RwLock::new(None),
        }
    }

    pub fn file_management_policy(&self, notebook_id: &str) -> FileManagementPolicy {
        self.get_notebook_config_by_id(notebook_id)
            .map(|notebook| FileManagementPolicy::from_notebook_root(std::path::Path::new(&notebook.path)))
            .unwrap_or_default()
    }

    pub fn acquire_cross_process_write_lock(&self) -> io::Result<CrossProcessWriteGuard> {
        std::fs::create_dir_all(&self.registry.config_dir)?;
        const LOCK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
        const RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(self.registry.config_dir.join(".memo-write.lock"))?;
        let started = std::time::Instant::now();
        loop {
            match fs2::FileExt::try_lock_exclusive(&file) {
                Ok(()) => break,
                // Windows reports ERROR_LOCK_VIOLATION rather than WouldBlock.
                // Compare fs2's platform-specific contention code before failing.
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock
                        || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
                {
                    if started.elapsed() >= LOCK_TIMEOUT {
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            format!(
                                "timed out waiting for memo write lock after {} ms",
                                LOCK_TIMEOUT.as_millis()
                            ),
                        ));
                    }
                    std::thread::sleep(RETRY_INTERVAL);
                }
                Err(error) => return Err(error),
            }
        }
        Ok(CrossProcessWriteGuard { file })
    }

    pub fn set_current_notebook(&mut self, id: Option<String>) {
        // 切 notebook 时 DB 查询上下文会变, 旧 cache
        // 不再有效, 必须失效。 同 id 重复设置 (steady state) 时
        // cache 仍然有效, 这里用 `get_mut` 拿到独占访问再判断, 避免无谓清空。
        if self.current_notebook_id != id {
            *self.index_cache.get_mut().expect("index_cache poisoned") = None;
        }
        self.current_notebook_id = id;
    }

    /// 强制清空所有内存缓存。下次 `read_index` / `read_notebook_configs` 走
    /// 磁盘重新加载。 主要用于测试 (e.g. 外部直接 `fs::write` 改 disk 后
    /// 模拟"应用外编辑"); 生产路径不应该需要这个 ── 进程内所有
    /// memo index / notebook registry 写都过 [`Self::write_index`] /
    /// [`Self::write_notebook_configs`], cache 自动同步。
    pub fn invalidate_caches(&self) {
        if let Ok(mut g) = self.index_cache.write() {
            *g = None;
        }
        if let Ok(mut g) = self.registry.configs_cache.write() {
            *g = None;
        }
    }

    /// 返回当前 notebook id (不读磁盘, 不解析 config).
    pub fn current_notebook_id_value(&self) -> Option<String> {
        self.current_notebook_id.clone()
    }

    /// 解析当前 notebook 目录 — 优先用 `current_notebook_id` 对应的 config,
    /// 否则走 `get_default_notebook_path`。
    pub fn get_memo_base(&self) -> PathBuf {
        if let Some(ref notebook_id) = self.current_notebook_id {
            if let Some(config) = self.get_notebook_config_by_id(notebook_id) {
                return PathBuf::from(&config.path);
            }
        }
        self.get_default_notebook_path()
    }

    /// Notebook-local Flowix data root: `<notebook>/.flowix/`.
    pub fn get_flowix_dir(&self) -> PathBuf {
        self.get_memo_base().join(".flowix")
    }

    /// Notebook-local version history root: `<notebook>/.flowix/versions/`.
    pub fn get_versions_dir(&self) -> PathBuf {
        self.get_flowix_dir().join("versions")
    }

    /// Notebook-local plugin output root for a validated plugin id.
    pub fn get_plugin_dir(&self, plugin_id: &str) -> PathBuf {
        self.get_flowix_dir().join("plugin").join(plugin_id)
    }

}

#[cfg(test)]
mod tests;
