//! `RawFsEvent` — `notify` 跨平台 `Event` 的薄抽象。
//!
//! 目的: 让下游 Filter / Processor 不直接依赖 `notify::Event` / `EventKind`
//! 类型 (这俩跨平台签名经常变, 比如 `ModifyKind` 嵌套), 同时保留必要的
//! 元信息 (path, kind 大类, 时间戳) 给后续做去重 / 防抖 / 业务分派。
//!
//! 设计取舍:
//! - 不做完整事件克隆, `path` 是 `PathBuf` (小) + `kind` 枚举 (1 字节),
//!   整体 < 256 字节, 可走 `mpsc::channel` 高频发送。
//! - `time` 用 `Instant` 而非 `SystemTime` (watcher 内部比对都基于
//!   monotonic clock)。
//! - 不携带 `notify::EventAttributes` — 当前过滤规则用不到, 后续真需要
//!   再加 `attrs: BitFlags<u8>` 兼容位。

use std::path::PathBuf;
use std::time::Instant;

/// 事件大类 — 比 `notify::EventKind` 简单, 业务只关心这 4 类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FsEventKind {
    Create,
    Modify,
    Remove,
    Other,
}

impl FsEventKind {
    pub fn from_notify(kind: &notify::EventKind) -> Self {
        use notify::event::{ModifyKind, RenameMode};
        use notify::EventKind::*;
        match kind {
            Create(_) => Self::Create,
            Remove(_) => Self::Remove,
            Modify(ModifyKind::Name(RenameMode::To)) => Self::Create, // rename 视同 create
            Modify(ModifyKind::Name(RenameMode::From)) => Self::Remove, // rename 视同 remove
            Modify(_) => Self::Modify,
            _ => Self::Other,
        }
    }
}

/// 单条文件系统事件 — watcher → filter pipeline 的标准输入。
///
/// `time` 预留供 filter 之后加 metrics / 路径防涪的 monotonic clock 记号
/// (当前未使用, 允许 dead_code 避免重复添加者)。
///
/// **rename 检测不再依赖 inode_tracker** (Plan A 的 Win32 file_index 走 NTFS,
/// 仅在 NTFS 上有效, FAT32 / exFAT / 网络盘退化)。重构成
/// **frontmatter-key-first**: processor 读磁盘 frontmatter 的 `key` 字段
/// 直接作为 id 真源, fs::rename 拆出的 From + To 两条事件中 To 事件读到的
/// key 跟旧 entry 的 id 一致 → rename_memo_file 自动保留 id 改 entry.filename。
///
/// 跨平台行为统一 — 不再需要 inode / file_index / volume_serial 这些 OS
/// 层元数据, 在 NTFS / FAT32 / exFAT / 网络盘 / symlink / 跨卷 上行为一致。
#[derive(Debug, Clone)]
pub struct RawFsEvent {
    pub kind: FsEventKind,
    pub path: PathBuf,
    #[allow(dead_code)]
    pub time: Instant,
}

impl RawFsEvent {
    /// 构造一个事件 — watcher 端无需额外 metadata, processor 自己读磁盘。
    pub fn new(kind: FsEventKind, path: PathBuf) -> Self {
        Self {
            kind,
            path,
            time: Instant::now(),
        }
    }
}

/// `Filter::decide()` 的返回值 — `Pass` 放行, `Drop` 拒绝 (带原因便于
/// metrics), `PassMutated` 放行但替换事件 (例如路径规范化后)。
/// `PassMutated` 作为预留 API 保留, 未来 filter 需要修改事件字段 (如
/// 路径规范化) 时会走。
#[derive(Debug, Clone)]
pub enum FilterDecision {
    Pass,
    #[allow(dead_code)]
    PassMutated(RawFsEvent),
    Drop {
        reason: DropReason,
    },
}

/// 拒绝原因 — 既给 metrics 分类, 也给日志 / 调试面板。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DropReason {
    /// 扩展名不在白名单
    ExtensionMismatch,
    /// 路径命中 skip_dirs / skip_files 黑名单
    PathBlacklisted,
    /// 隐藏文件 (`.xxx`), `watch_hidden = false`
    PathNotWhitelisted,
    /// `.metadata/` 等内部目录
    MetadataDirectory,
    /// 后端自写抑制
    SelfWriteSuppressed,
    /// 150ms 同路径防抖
    Debounced,
    /// 文件超过 `max_file_size`
    FileTooLarge,
}

impl DropReason {
    /// 简短标签, 用于 tracing::debug
    pub fn label(&self) -> &'static str {
        match self {
            Self::ExtensionMismatch => "ext-mismatch",
            Self::PathBlacklisted => "path-blacklisted",
            Self::PathNotWhitelisted => "path-not-whitelisted",
            Self::MetadataDirectory => "metadata-dir",
            Self::SelfWriteSuppressed => "self-write",
            Self::Debounced => "debounced",
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
