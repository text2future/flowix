//! 笔记 / 笔记本存储层 — 后端 memo index / todo metadata / .md 磁盘 IO 的总入口。
//!
//! ## v3 模块拆分 (2026/06 重构)
//!
//! - [`mod@types`]       — 公开 DTO (Memo / Notebook / TodoItem / MemoTag /
//!                         NotebookConfig / MemoIndexFile / MemoIndexEntry /
//!                         MemoTodoEntry / MemoMetadataFile)
//! - [`mod@frontmatter`] — YAML frontmatter 解析 (`extract_body_content`)
//! - [`mod@derivation`]  — 派生字段 (preview / tags / todos) 提取
//! - [`mod@time`]        — 列表过滤 (thisWeek / thisMonth) 用的时间边界
//! - [`mod@notebook`]    — notebook registry SQLite IO
//! - [`mod@index_store`]  — `memo index` / `todo metadata` IO + sync 维护
//! - [`mod@content`]     — .md 文件读取 + 列表过滤 (只读 API)
//! - [`mod@ops`]         — Memo CRUD 原语 (`create_memo` / `rename_memo` /
//!                         `write_memo` / `delete_memo` / `register_*` /
//!                         `reconcile_with_disk` / `reconcile_with_disk_bidirectional` /
//!                         `reload_memo_from_disk`)
//! - [`mod@registration`] — 占位, 实现全部在 [`mod@ops`]
//!
//! ## v3 — `filename` 作为磁盘文件名
//!
//! 物理文件: `<notebook>/<filename>.md` (`filename` 即 memo index entry.filename,
//! 含 `.md` 后缀)。
//!
//! - id 仍由 6 位 nanoid (`MEMO_ID_ALPHABET` 字符集) 生成, 存 memo index 内部
//!   key / 深链 / noteReference 节点, **不再出现在物理文件名**。
//! - 同 title 冲突时自动追加 `-1` / `-2` / ... 后缀。
//! - memo index 始终是全量索引的真源, 任何写路径最终都过 [`mod@ops`] 的原语。
//! - `Memo` / `MemoIndexEntry` 都无 `path` 字段; 物理路径运行时拼
//!   `get_memo_base() + filename`。

use std::path::PathBuf;
use std::{fs::OpenOptions, io};

/// memo id 随机段使用的字符集 — `[0-9a-z]` 36 个字符 (小写字母 + 数字)。
///
/// 字符集约束: nanoid 默认 `SAFE` 含 `_` `-` 两种特殊字符, 显式锁定为
/// 纯字母+数字。36 字符 × 6 位 ≈ 21.7 亿种, 碰撞余量仍够。
pub const MEMO_ID_ALPHABET: [char; 36] = [
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i',
    'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
];
pub const MEMO_ID_LENGTH: usize = 8;

mod content;
mod derivation;
pub(crate) mod frontmatter;
mod index_store;
mod notebook;
mod onboarding;
mod ops;
mod registration;
mod time;
pub mod types;
mod versions;

// 公开 API re-export — 跟旧 `memo_file.rs` 的 pub use 边界一致。
pub use derivation::{
    apply_derived_memo_fields, extract_agent_threads_from_body, extract_tags_from_body,
    extract_title_and_preview, extract_todos_from_body,
};
pub use frontmatter::{
    build_md_content, extract_body_content, extract_frontmatter_key,
    extract_frontmatter_properties, merge_frontmatter, MergeOverrides,
};
pub use ops::{
    atomic_write_bytes, base_filename, resolve_filename_conflict, sanitize_filename_component, IsMd,
};
pub use types::{
    AgentThreadItem, Memo, MemoColor, MemoIndexEntry, MemoIndexFile, MemoLocation,
    MemoMetadataFile, MemoTag, MemoTodoEntry, Notebook, NotebookConfig, ReconcileReport, TodoItem,
};
pub use versions::{
    MemoVersionManifest, MemoVersionMeta, MemoVersionSource, MEMO_AUTO_VERSION_INTERVAL_MS,
    MEMO_VERSION_LIMIT,
};

/// 笔记本目录 / 笔记文件的存储管理。
///
/// 字段:
/// - `config_dir`: 用户配置目录 (`~/.flowix/`). 笔记本注册表 + memo index
///   + todo metadata 都存放在 `<config_dir>/index.db` 关联的 SQLite 文件里
///   (分别走 [`MemoFile::get_index_db_path`] / `<notebook>/.metadata/` 派生)。
/// - `current_notebook_id`: 当前活跃 notebook id, `None` 表示走默认。
/// - `index_cache`: 当前 notebook memo index 的内存缓存。读路径先查询 SQLite
///   `memo_index_state.last_updated`，只有版本一致才复用，保证其他进程写入可见。
///   写路径 ([`MemoFile::write_index`] / `_locked` 系列) 在 DB 写入成功后回填。
///   切 notebook 时由 [`Self::set_current_notebook`] 失效。
///   `std::sync::RwLock` 而非裸 `Option`, 因为读路径常在 `&self` 调用栈上
///   (写路径持外层 `RwLock<MemoFile>` 写锁, 读路径持外层读锁; 都需要绕过
///   借用检查写入 cache 字段)。
/// - `notebook_configs_cache`: notebook registry 的最近读取镜像；registry 读取始终
///   查询 SQLite，避免长驻 MCP 与 Desktop 之间出现过期 notebook 配置。
pub struct MemoFile {
    config_dir: PathBuf,
    current_notebook_id: Option<String>,
    /// memo index / todo metadata 跨线程 RMW 互斥锁。
    ///
    /// 写路径 (创建/改名/写 body/删除/注册/对账) 持此锁跨
    /// "rename 物理文件 + 写 memo index" 全过程, 串行化 RMW。
    /// `std::sync::Mutex` 不可重入, 内部 _locked 变体跳过自拿锁。
    current_index_io: std::sync::Mutex<()>,
    /// Memo index 内存缓存。`None` = 未加载 / 已失效；命中前会校验 DB 版本。
    index_cache: std::sync::RwLock<Option<MemoIndexFile>>,
    /// Notebook registry 最近读取镜像。`None` = 未加载。
    notebook_configs_cache: std::sync::RwLock<Option<Vec<NotebookConfig>>>,
}

pub(crate) struct CrossProcessWriteGuard {
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
            config_dir: PathBuf::new(),
            current_notebook_id: None,
            current_index_io: std::sync::Mutex::new(()),
            index_cache: std::sync::RwLock::new(None),
            notebook_configs_cache: std::sync::RwLock::new(None),
        }
    }
}

impl MemoFile {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            config_dir,
            current_notebook_id: None,
            current_index_io: std::sync::Mutex::new(()),
            index_cache: std::sync::RwLock::new(None),
            notebook_configs_cache: std::sync::RwLock::new(None),
        }
    }

    pub(crate) fn acquire_cross_process_write_lock(&self) -> io::Result<CrossProcessWriteGuard> {
        std::fs::create_dir_all(&self.config_dir)?;
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(self.config_dir.join(".memo-write.lock"))?;
        fs2::FileExt::lock_exclusive(&file)?;
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
        if let Ok(mut g) = self.notebook_configs_cache.write() {
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

    /// `.metadata/` 目录绝对路径 — 内部 `memo index` / `todo metadata` 所在地。
    pub fn get_metadata_dir(&self) -> PathBuf {
        self.get_memo_base().join(".metadata")
    }
}

#[cfg(test)]
mod tests;
