//! `RawFsEvent` —`notify` 跨平�?`Event` 的薄抽象�?//!
//! �?��: 让下�?Filter / Processor 不直接依�?`notify::Event` / `EventKind`
//! 类型 (这俩跨平台�?名经常变, 比�? `ModifyKind` 嵌�?), 同时保留必�?�?//! 元信�?(path, kind 大类, 时间�? 给后�?��去重 / 防抖 / 业务分派�?//!
//! 璁捐鍙栬垗:
//! - 不做完整事件克隆, `path` �?`PathBuf` (�? + `kind` 枚举 (1 字节),
//!   整体 < 256 字节, �?�� `mpsc::channel` 高�?发送�?//! - `time` �?`Instant` 而非 `SystemTime` (watcher 内部比�?都基�?//!   monotonic clock)�?//! - 不携�?`notify::EventAttributes` —当前过滤规则用不�? 后续真需�?//!   再加 `attrs: BitFlags<u8>` 兼�?位�?
use std::path::PathBuf;
use std::time::Instant;

/// 事件大类 —�?`notify::EventKind` 简�? 业务�?��心这 4 类�?
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FsEventKind {
    Create,
    Modify,
    Remove,
    /// A directory was created, removed, moved, or renamed. Child events are
    /// not reliable across watcher backends, so this triggers reconciliation.
    DirectoryChange,
    Other,
}

impl FsEventKind {
    pub fn from_notify(kind: &notify::EventKind) -> Self {
        use notify::event::{ModifyKind, RenameMode};
        use notify::EventKind::*;
        match kind {
            Create(_) => Self::Create,
            Remove(_) => Self::Remove,
            Modify(ModifyKind::Name(RenameMode::To)) => Self::Create, // rename 瑙嗗悓 create
            Modify(ModifyKind::Name(RenameMode::From)) => Self::Remove, // rename 瑙嗗悓 remove
            Modify(_) => Self::Modify,
            _ => Self::Other,
        }
    }
}

/// 单条文件系统事件 —watcher �?filter pipeline 的标准输入�?///
/// `time` 预留�?filter 之后�?metrics / �?��防涪�?monotonic clock 记号
/// (当前�?���? 允�? dead_code 避免重�?添加�?�?///
/// **rename 检测不再依�?inode_tracker** (Plan A �?Win32 file_index �?NTFS,
/// 仅在 NTFS 上有�? FAT32 / exFAT / 网络盘退�?。重构成
/// **frontmatter-key-first**: processor 读�?�?frontmatter �?`key` 字�?
/// 直接作为 id 真源, fs::rename 拆出�?From + To 两条事件�?To 事件读到�?/// key 跟旧 entry �?id 一�?�?rename_memo_file �?��保留 id �?entry.filename�?///
/// 跨平台�?为统一 —不再需�?inode / file_index / volume_serial 这些 OS
/// 层元数据, �?NTFS / FAT32 / exFAT / 网络�?/ symlink / 跨卷 上�?为一致�?
#[derive(Debug, Clone)]
pub struct RawFsEvent {
    pub kind: FsEventKind,
    pub path: PathBuf,
    #[allow(dead_code)]
    pub time: Instant,
}

impl RawFsEvent {
    /// 构造一�?���?—watcher �?��需额�? metadata, processor �?��读�?盘�?
    pub fn new(kind: FsEventKind, path: PathBuf) -> Self {
        Self {
            kind,
            path,
            time: Instant::now(),
        }
    }
}

/// `Filter::decide()` 的返回�?—`Pass` 放�?, `Drop` 拒绝 (带原因便�?/// metrics), `PassMutated` 放�?但替�?���?(例�?�?��规范化后)�?/// `PassMutated` 作为预留 API 保留, �?�� filter 需要修改事件字�?(�?/// �?��规范�? 时会走�?
#[derive(Debug, Clone)]
pub enum FilterDecision {
    Pass,
    #[allow(dead_code)]
    PassMutated(RawFsEvent),
    Drop {
        reason: DropReason,
    },
}

/// 拒绝原因 —既给 metrics 分类, 也给日志 / 调试面板�?
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DropReason {
    /// 鎵╁睍鍚嶄笉鍦ㄧ櫧鍚嶅崟
    ExtensionMismatch,
    /// �?��命中 skip_dirs / skip_files 黑名�?
    PathBlacklisted,
    /// 闅愯棌鏂囦欢 (`.xxx`), `watch_hidden = false`
    PathNotWhitelisted,
    /// `.metadata/` 等内部目�?
    MetadataDirectory,
    /// 鏂囦欢瓒呰繃 `max_file_size`
    FileTooLarge,
}

impl DropReason {
    /// 简�?���? 用于 tracing::debug
    pub fn label(&self) -> &'static str {
        match self {
            Self::ExtensionMismatch => "ext-mismatch",
            Self::PathBlacklisted => "path-blacklisted",
            Self::PathNotWhitelisted => "path-not-whitelisted",
            Self::MetadataDirectory => "metadata-dir",
            Self::FileTooLarge => "file-too-large",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{ModifyKind, RenameMode};

    #[test]
    fn kind_classification() {
        assert_eq!(
            FsEventKind::from_notify(&notify::EventKind::Create(notify::event::CreateKind::File)),
            FsEventKind::Create
        );
        assert_eq!(
            FsEventKind::from_notify(&notify::EventKind::Remove(notify::event::RemoveKind::File)),
            FsEventKind::Remove
        );
        assert_eq!(
            FsEventKind::from_notify(&notify::EventKind::Modify(ModifyKind::Data(
                notify::event::DataChange::Content
            ))),
            FsEventKind::Modify
        );
        assert_eq!(
            FsEventKind::from_notify(&notify::EventKind::Modify(ModifyKind::Name(RenameMode::To))),
            FsEventKind::Create
        );
        assert_eq!(
            FsEventKind::from_notify(&notify::EventKind::Modify(ModifyKind::Name(
                RenameMode::From
            ))),
            FsEventKind::Remove
        );
        assert_eq!(
            FsEventKind::from_notify(&notify::EventKind::Access(notify::event::AccessKind::Open(
                notify::event::AccessMode::Read
            ))),
            FsEventKind::Other
        );
    }
}
