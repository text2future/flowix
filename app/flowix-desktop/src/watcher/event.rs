//! `RawFsEvent` 鈥?`notify` 璺ㄥ钩鍙?`Event` 鐨勮杽鎶借薄銆?//!
//! 鐩殑: 璁╀笅娓?Filter / Processor 涓嶇洿鎺ヤ緷璧?`notify::Event` / `EventKind`
//! 绫诲瀷 (杩欎咯璺ㄥ钩鍙扮鍚嶇粡甯稿彉, 姣斿 `ModifyKind` 宓屽), 鍚屾椂淇濈暀蹇呰鐨?//! 鍏冧俊鎭?(path, kind 澶х被, 鏃堕棿鎴? 缁欏悗缁仛鍘婚噸 / 闃叉姈 / 涓氬姟鍒嗘淳銆?//!
//! 璁捐鍙栬垗:
//! - 涓嶅仛瀹屾暣浜嬩欢鍏嬮殕, `path` 鏄?`PathBuf` (灏? + `kind` 鏋氫妇 (1 瀛楄妭),
//!   鏁翠綋 < 256 瀛楄妭, 鍙蛋 `mpsc::channel` 楂橀鍙戦€併€?//! - `time` 鐢?`Instant` 鑰岄潪 `SystemTime` (watcher 鍐呴儴姣斿閮藉熀浜?//!   monotonic clock)銆?//! - 涓嶆惡甯?`notify::EventAttributes` 鈥?褰撳墠杩囨护瑙勫垯鐢ㄤ笉鍒? 鍚庣画鐪熼渶瑕?//!   鍐嶅姞 `attrs: BitFlags<u8>` 鍏煎浣嶃€?
use std::path::PathBuf;
use std::time::Instant;

/// 浜嬩欢澶х被 鈥?姣?`notify::EventKind` 绠€鍗? 涓氬姟鍙叧蹇冭繖 4 绫汇€?
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
            Modify(ModifyKind::Name(RenameMode::To)) => Self::Create, // rename 瑙嗗悓 create
            Modify(ModifyKind::Name(RenameMode::From)) => Self::Remove, // rename 瑙嗗悓 remove
            Modify(_) => Self::Modify,
            _ => Self::Other,
        }
    }
}

/// 鍗曟潯鏂囦欢绯荤粺浜嬩欢 鈥?watcher 鈫?filter pipeline 鐨勬爣鍑嗚緭鍏ャ€?///
/// `time` 棰勭暀渚?filter 涔嬪悗鍔?metrics / 璺緞闃叉丢鐨?monotonic clock 璁板彿
/// (褰撳墠鏈娇鐢? 鍏佽 dead_code 閬垮厤閲嶅娣诲姞鑰?銆?///
/// **rename 妫€娴嬩笉鍐嶄緷璧?inode_tracker** (Plan A 鐨?Win32 file_index 璧?NTFS,
/// 浠呭湪 NTFS 涓婃湁鏁? FAT32 / exFAT / 缃戠粶鐩橀€€鍖?銆傞噸鏋勬垚
/// **frontmatter-key-first**: processor 璇荤鐩?frontmatter 鐨?`key` 瀛楁
/// 鐩存帴浣滀负 id 鐪熸簮, fs::rename 鎷嗗嚭鐨?From + To 涓ゆ潯浜嬩欢涓?To 浜嬩欢璇诲埌鐨?/// key 璺熸棫 entry 鐨?id 涓€鑷?鈫?rename_memo_file 鑷姩淇濈暀 id 鏀?entry.filename銆?///
/// 璺ㄥ钩鍙拌涓虹粺涓€ 鈥?涓嶅啀闇€瑕?inode / file_index / volume_serial 杩欎簺 OS
/// 灞傚厓鏁版嵁, 鍦?NTFS / FAT32 / exFAT / 缃戠粶鐩?/ symlink / 璺ㄥ嵎 涓婅涓轰竴鑷淬€?
#[derive(Debug, Clone)]
pub struct RawFsEvent {
    pub kind: FsEventKind,
    pub path: PathBuf,
    #[allow(dead_code)]
    pub time: Instant,
}

impl RawFsEvent {
    /// 鏋勯€犱竴涓簨浠?鈥?watcher 绔棤闇€棰濆 metadata, processor 鑷繁璇荤鐩樸€?
    pub fn new(kind: FsEventKind, path: PathBuf) -> Self {
        Self {
            kind,
            path,
            time: Instant::now(),
        }
    }
}

/// `Filter::decide()` 鐨勮繑鍥炲€?鈥?`Pass` 鏀捐, `Drop` 鎷掔粷 (甯﹀師鍥犱究浜?/// metrics), `PassMutated` 鏀捐浣嗘浛鎹簨浠?(渚嬪璺緞瑙勮寖鍖栧悗)銆?/// `PassMutated` 浣滀负棰勭暀 API 淇濈暀, 鏈潵 filter 闇€瑕佷慨鏀逛簨浠跺瓧娈?(濡?/// 璺緞瑙勮寖鍖? 鏃朵細璧般€?
#[derive(Debug, Clone)]
pub enum FilterDecision {
    Pass,
    #[allow(dead_code)]
    PassMutated(RawFsEvent),
    Drop {
        reason: DropReason,
    },
}

/// 鎷掔粷鍘熷洜 鈥?鏃㈢粰 metrics 鍒嗙被, 涔熺粰鏃ュ織 / 璋冭瘯闈㈡澘銆?
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DropReason {
    /// 鎵╁睍鍚嶄笉鍦ㄧ櫧鍚嶅崟
    ExtensionMismatch,
    /// 璺緞鍛戒腑 skip_dirs / skip_files 榛戝悕鍗?
    PathBlacklisted,
    /// 闅愯棌鏂囦欢 (`.xxx`), `watch_hidden = false`
    PathNotWhitelisted,
    /// `.metadata/` 绛夊唴閮ㄧ洰褰?
    MetadataDirectory,
    /// 鍚庣鑷啓鎶戝埗
    SelfWriteSuppressed,
    /// 150ms 鍚岃矾寰勯槻鎶?
    Debounced,
    /// 鏂囦欢瓒呰繃 `max_file_size`
    FileTooLarge,
}

impl DropReason {
    /// 绠€鐭爣绛? 鐢ㄤ簬 tracing::debug
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
