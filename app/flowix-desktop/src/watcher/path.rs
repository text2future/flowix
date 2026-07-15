//! 跨 watcher manager / filter 共享的路径归一工具。
//!
//! `MemoWatcher::mark_self_write` 和 `SelfWriteSuppressor` / `Debouncer`
//! 都用这里生成 HashMap key, 避免写盘端与 notify 端路径口径不一致。

use std::path::{Path, PathBuf};

/// 把 `Path` 归一到 `HashMap<PathBuf, _>` 查表口径。
///
/// 优先用 `dunce::canonicalize` 折叠 symlink / `\\?\` 前缀; 失败 (文件尚未
/// 创建 — 写盘前 mark 的常见情形) 退到"只 canonicalize 父目录, 再 join
/// 文件名", 父目录在 notebook 创建时已经存在, 这一步必然成功。即便父目录
/// canonicalize 也失败, 退回原 path 字符串, 至少不丢抑制 (退化到精确匹配)。
pub fn normalize_for_compare(path: &Path) -> PathBuf {
    if let Ok(canon) = dunce::canonicalize(path) {
        return canon;
    }
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        if let Ok(canon_parent) = dunce::canonicalize(parent) {
            return canon_parent.join(name);
        }
    }
    path.to_path_buf()
}
