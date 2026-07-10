//! 路径范围 (path-scope) 工具 — 判断一个路径是否在某个被允许的根目录之下。
//!
//! 整个 app 有两类 scope 检查:
//! - **Tauri command 边界** (`commands.rs`) — UI/前端传入的 path 必须在已注册
//!   notebook 路径之内, 否则拒绝读写。允许在 `is_markdown_like` 后备 (任意 .md 文件)。
//! - **AI 工具调用边界** (`providers/tools/`) — 必须是 `registered_notebook_paths` 之一。
//!
//! 这两类共用同一组 `path_is_inside` / `canonical_existing_or_parent` 实现 ——
//! 之前 `commands.rs` 和 `providers/tools/mod.rs` 各自维护一份, 漂移风险高。
//! 现在统一在这里, 跨模块一处真源。

use std::path::{Path, PathBuf};

/// `fs::canonicalize` 需要路径已存在; 在写路径 (目标尚不存在) 上要回退到
/// parent 目录的 canonicalize + 拼回 file_name。
fn canonical_existing_or_parent(path: &Path) -> Option<PathBuf> {
    if path.exists() {
        return std::fs::canonicalize(path).ok();
    }

    let parent = path.parent()?;
    let canonical_parent = std::fs::canonicalize(parent).ok()?;
    Some(canonical_parent.join(path.file_name()?))
}

/// 路径包含判定: 在 canonicalize 之后做 `starts_with`。兼容
/// `path` / `root` 尚不存在 (写路径) 的情况。
pub fn path_is_inside(path: &Path, root: &Path) -> bool {
    let Some(path) = canonical_existing_or_parent(path) else {
        return false;
    };
    let Some(root) = canonical_existing_or_parent(root) else {
        return false;
    };
    path.starts_with(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inside_returns_true_for_subpath() {
        let tmp =
            std::env::temp_dir().join(format!("flowix-path-scope-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let sub = tmp.join("child");
        std::fs::create_dir_all(&sub).unwrap();
        let file = sub.join("note.md");
        std::fs::write(&file, "x").unwrap();
        assert!(path_is_inside(&file, &tmp));
    }

    #[test]
    fn inside_returns_false_for_sibling() {
        let tmp = std::env::temp_dir();
        let a = tmp.join(format!("flowix-ps-a-{}", std::process::id()));
        let b = tmp.join(format!("flowix-ps-b-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let file = a.join("note.md");
        std::fs::write(&file, "x").unwrap();
        assert!(!path_is_inside(&file, &b));
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn inside_works_for_nonexistent_target() {
        let tmp =
            std::env::temp_dir().join(format!("flowix-path-scope-future-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let future = tmp.join("not-yet-created.md");
        // 目标尚不存在 — 应回退到 parent canonicalize
        assert!(path_is_inside(&future, &tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
