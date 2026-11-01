//! Static name rules shared by every scope that walks a notebook.
//!
//! 本模块只回答「这个名字长什么样」，不含任何口径判断：
//!
//! - 目录名单：[`EXCLUDED_DIRECTORY_NAMES`] 与 [`is_internal_directory_name`]
//! - 文件通配名单：[`HIDDEN_FILE_PATTERNS`] 与 [`matches_hidden_file_pattern`]
//!
//! 口径差异全部留在上层：`FileManagementPolicy`（读写校验 / 索引 / watcher）与
//! `tree_display`（「访问空间」里画不画这一行）。文件与文件夹的规则在这里就是
//! 两套独立名单，互不引用——不会出现「文件名命中一条规则，却把同名文件夹也
//! 一并带走」的情况。

use std::path::Path;

/// Directories that never join an index and never feed the notebook watcher.
/// Dependency trees, attachment storage and VCS internals are large, noisy and
/// never hold user notes. Both scopes read this single list, so the note index
/// and the watcher can no longer disagree about what counts as noise.
pub const EXCLUDED_DIRECTORY_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    "attachments",
    "attachments-cache",
    "bower_components",
    "__pycache__",
];

/// App-owned folders. They hold notebook configuration and generated plugin
/// output, so they stay out of the tree, every index and the watcher alike —
/// no visibility switch can bring them back.
pub(crate) fn is_internal_directory_name(name: &str) -> bool {
    matches!(name, ".flowix" | ".plugin-output")
}

/// 文件级通配黑名单：命中任意一条，这个**文件**就不会出现在文件树里。
///
/// 只作用于文件。文件夹走 `TreeVisibility::hides_directory`，所以 `.trash`
/// 这类点目录不会被 `.*` 误伤——这正是「文件规则与文件夹规则分开」的地方。
///
/// 扩展方式：往表里加一条通配即可（`*` 任意串、`?` 单字符、大小写不敏感），
/// 调用点不需要、也不允许再写文件名特判。
pub const HIDDEN_FILE_PATTERNS: &[&str] = &[
    // 点文件：`.index.yaml` / `.DS_Store` / `.gitignore` / `.env` ……
    // 集合索引 `.index.yaml` 由这一条覆盖：它是文件夹的元数据，不是文档。
    ".*",
    // 编辑器、同步客户端与系统残留
    "*~",
    "*.tmp",
    "*.swp",
    "*.bak",
    "*.lock",
    "Thumbs.db",
    "ehthumbs.db",
    "desktop.ini",
];

/// 单个文件名是否命中文件黑名单（含旧版媒体属性旁车）。
///
/// 大小写不敏感，因为 macOS / Windows 的文件名本身就不区分大小写。
pub fn matches_hidden_file_pattern(name: &str) -> bool {
    is_legacy_media_sidecar(name)
        || HIDDEN_FILE_PATTERNS
            .iter()
            .any(|pattern| glob_matches(pattern, name))
}

/// 旧版媒体属性旁车（`photo.png.yaml`）：扩展名是 yaml，去后缀后本身是媒体
/// 文件。通配表达不了「stem 是媒体类型」，所以留一个谓词，规则表只负责其余
/// 的纯名字模式。
fn is_legacy_media_sidecar(name: &str) -> bool {
    let path = Path::new(name);
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("yaml"))
        && path
            .file_stem()
            .is_some_and(|stem| super::media_kind_for_path(Path::new(stem)).is_some())
}

/// 极简 glob：`*` 匹配任意长度串，`?` 匹配单个字符，其余按字面、大小写不敏感。
///
/// 模式只用来匹配**单个文件名**，所以不对 `/` 做特殊处理。
pub fn glob_matches(pattern: &str, name: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().flat_map(char::to_lowercase).collect();
    let name: Vec<char> = name.chars().flat_map(char::to_lowercase).collect();
    glob_inner(&pattern, &name)
}

fn glob_inner(pattern: &[char], name: &[char]) -> bool {
    let Some((head, rest)) = pattern.split_first() else {
        return name.is_empty();
    };
    match head {
        '*' => (0..=name.len()).any(|skipped| glob_inner(rest, &name[skipped..])),
        '?' => !name.is_empty() && glob_inner(rest, &name[1..]),
        literal => name.first() == Some(literal) && glob_inner(rest, &name[1..]),
    }
}

#[cfg(test)]
mod tests {
    use super::{glob_matches, matches_hidden_file_pattern, HIDDEN_FILE_PATTERNS};

    #[test]
    fn glob_matches_literals_wildcards_and_case() {
        assert!(glob_matches("Thumbs.db", "thumbs.db"));
        assert!(glob_matches("*.tmp", "sheet.TMP"));
        assert!(!glob_matches("*.tmp", "sheet.tmp.bak"));
        assert!(glob_matches("*~", "note.md~"));
        assert!(glob_matches("?.md", "a.md"));
        assert!(!glob_matches("?.md", "ab.md"));
        assert!(glob_matches("*", "") && glob_matches("*", "anything"));
    }

    #[test]
    fn index_yaml_is_hidden_by_the_dotfile_pattern() {
        assert!(matches_hidden_file_pattern(".index.yaml"));
        assert!(matches_hidden_file_pattern(".INDEX.YAML"));
        assert!(matches_hidden_file_pattern(".DS_Store"));
        assert!(matches_hidden_file_pattern(".gitignore"));
    }

    #[test]
    fn ordinary_documents_and_collections_stay_visible() {
        assert!(!matches_hidden_file_pattern("note.md"));
        assert!(!matches_hidden_file_pattern("任务.index.yaml"));
        assert!(!matches_hidden_file_pattern("素材.lib.yaml"));
        assert!(!matches_hidden_file_pattern("plain.yaml"));
    }

    #[test]
    fn legacy_media_sidecars_are_noise() {
        assert!(matches_hidden_file_pattern("photo.png.yaml"));
        assert!(matches_hidden_file_pattern("clip.mp4.yaml"));
    }

    /// 名单本身不该混进任何目录名：目录有自己的一套规则，两边不共用。
    #[test]
    fn file_patterns_do_not_name_directories() {
        for directory in super::EXCLUDED_DIRECTORY_NAMES {
            assert!(
                !HIDDEN_FILE_PATTERNS.contains(directory),
                "{directory} belongs to the directory list, not the file patterns"
            );
        }
    }
}
