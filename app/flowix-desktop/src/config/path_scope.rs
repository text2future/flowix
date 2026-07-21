//! 璺緞鑼冨洿 (path-scope) 宸ュ叿 鈥?鍒ゆ柇涓€涓矾寰勬槸鍚﹀湪鏌愪釜琚厑璁哥殑鏍圭洰褰曚箣涓嬨€?//!
//! 鏁翠釜 app 鏈変袱绫?scope 妫€鏌?
//! - **Tauri command 杈圭晫** (`commands.rs`) 鈥?UI/鍓嶇浼犲叆鐨?path 蹇呴』鍦ㄥ凡娉ㄥ唽
//!   notebook 璺緞涔嬪唴, 鍚﹀垯鎷掔粷璇诲啓銆傚厑璁稿湪 `is_markdown_like` 鍚庡 (浠绘剰 .md 鏂囦欢)銆?//! - **AI 宸ュ叿璋冪敤杈圭晫** (`providers/tools/`) 鈥?蹇呴』鏄?`registered_notebook_paths` 涔嬩竴銆?//!
//! 杩欎袱绫诲叡鐢ㄥ悓涓€缁?`path_is_inside` / `canonical_existing_or_parent` 瀹炵幇 鈥斺€?//! 涔嬪墠 `commands.rs` 鍜?`providers/tools/mod.rs` 鍚勮嚜缁存姢涓€浠? 婕傜Щ椋庨櫓楂樸€?//! 鐜板湪缁熶竴鍦ㄨ繖閲? 璺ㄦā鍧椾竴澶勭湡婧愩€?
use std::path::{Path, PathBuf};

/// `fs::canonicalize` 闇€瑕佽矾寰勫凡瀛樺湪; 鍦ㄥ啓璺緞 (鐩爣灏氫笉瀛樺湪) 涓婅鍥為€€鍒?/// parent 鐩綍鐨?canonicalize + 鎷煎洖 file_name銆?
fn canonical_existing_or_parent(path: &Path) -> Option<PathBuf> {
    if path.exists() {
        return std::fs::canonicalize(path).ok();
    }

    let parent = path.parent()?;
    let canonical_parent = std::fs::canonicalize(parent).ok()?;
    Some(canonical_parent.join(path.file_name()?))
}

/// 璺緞鍖呭惈鍒ゅ畾: 鍦?canonicalize 涔嬪悗鍋?`starts_with`銆傚吋瀹?/// `path` / `root` 灏氫笉瀛樺湪 (鍐欒矾寰? 鐨勬儏鍐点€?
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
        // 鐩爣灏氫笉瀛樺湪 鈥?搴斿洖閫€鍒?parent canonicalize
        assert!(path_is_inside(&future, &tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
