//! Display scope for the «访问空间» file tree.
//!
//! 展示口径与访问口径是两件事，刻意分模块：
//!
//! - **访问口径**（[`super::FileManagementPolicy`]）回答「这个路径能不能读写、
//!   进不进索引、要不要监听」。集合索引文件 `.index.yaml` 在访问口径下必须
//!   放行——集合的读取、重命名、恢复全靠它。
//! - **展示口径**（本模块）只回答「这一行画不画」，不参与任何校验。
//!   同一个 `.index.yaml` 在这里被隐藏：它是文件夹的元数据，不是一篇文档。
//!
//! 展示口径内部，文件与文件夹也是两条独立规则：文件查
//! [`super::file_rules::HIDDEN_FILE_PATTERNS`] 通配表，文件夹查
//! [`TreeVisibility::hides_directory`]，互不引用。

use std::path::{Component, Path};

use super::file_rules::{
    is_internal_directory_name, matches_hidden_file_pattern, EXCLUDED_DIRECTORY_NAMES,
};

/// Display-only visibility switches for the file tree («访问空间»). They are
/// driven by the global `boot/preference.json` and must never be consulted by
/// access checks, the indexes or the watcher: [`super::FileManagementPolicy`]
/// stays the single authority for those scopes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TreeVisibility {
    /// Show dot-prefixed folders (`.trash`, `.obsidian`, ...).
    pub show_hidden: bool,
    /// Show the system folders listed in [`EXCLUDED_DIRECTORY_NAMES`].
    pub show_system: bool,
}

impl Default for TreeVisibility {
    /// Both switches default to on, which preserves the tree's long-standing
    /// behaviour of listing every folder that exists on disk.
    fn default() -> Self {
        Self {
            show_hidden: true,
            show_system: true,
        }
    }
}

impl TreeVisibility {
    /// 文件夹规则。应用内部目录（`.flowix` / `.plugin-output`）永远隐藏，
    /// 两个开关只管点目录与黑名单目录。
    pub fn hides_directory(&self, name: &str) -> bool {
        is_internal_directory_name(name)
            || (!self.show_hidden && name.starts_with('.'))
            || (!self.show_system && EXCLUDED_DIRECTORY_NAMES.contains(&name))
    }

    /// 单层列举的唯一判定入口：文件夹走目录规则，文件走通配表。
    ///
    /// `is_dir` 必须由调用方从文件系统类型得出，不要用名字猜——一个叫
    /// `.index.yaml` 的目录应当按目录规则展示，而不是被文件通配带走。
    pub fn hides_entry(&self, name: &str, is_dir: bool) -> bool {
        if is_dir {
            self.hides_directory(name)
        } else {
            matches_hidden_file_pattern(name)
        }
    }

    /// 多级相对路径的判定：逐级祖先按目录规则，末段按文件规则。
    ///
    /// 用于「从索引里取出一批资源，再对齐文件树」的场景（文档列表、工作文档
    /// 列表）。单层列举请直接用 [`Self::hides_entry`]，别为了走这条路径去猜
    /// 末段类型。
    pub fn hides_file_path(&self, relative: &Path) -> bool {
        let mut components = relative.components().peekable();
        while let Some(component) = components.next() {
            let Component::Normal(name) = component else {
                return true;
            };
            let name = name.to_string_lossy();
            if components.peek().is_none() {
                return matches_hidden_file_pattern(&name);
            }
            if self.hides_directory(&name) {
                return true;
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::TreeVisibility;

    #[test]
    fn collection_index_file_is_never_a_tree_row() {
        let visibility = TreeVisibility::default();
        assert!(visibility.hides_entry(".index.yaml", false));
        assert!(visibility.hides_entry(".INDEX.YAML", false));
        assert!(!visibility.hides_entry("note.md", false));
        assert!(!visibility.hides_entry("任务.index.yaml", false));
    }

    /// 同名目录不受文件规则影响：`.index.yaml` 若是文件夹，按文件夹规则走。
    #[test]
    fn a_directory_never_inherits_file_patterns() {
        let visibility = TreeVisibility::default();
        assert!(!visibility.hides_entry(".index.yaml", true));
        assert!(!visibility.hides_entry(".trash", true));
        assert!(!visibility.hides_entry("node_modules", true));
    }

    #[test]
    fn switches_only_affect_directories() {
        let hidden_off = TreeVisibility { show_hidden: false, show_system: true };
        assert!(hidden_off.hides_entry(".trash", true));
        assert!(!hidden_off.hides_entry("node_modules", true));
        let system_off = TreeVisibility { show_hidden: true, show_system: false };
        assert!(system_off.hides_entry("node_modules", true));
        assert!(!system_off.hides_entry(".trash", true));
        // 文件没有开关：点文件永远不展示。
        assert!(hidden_off.hides_entry(".index.yaml", false));
        assert!(system_off.hides_entry(".env", false));
        assert!(!system_off.hides_entry("note.md", false));
    }

    #[test]
    fn app_internal_directories_are_always_hidden() {
        let visibility = TreeVisibility::default();
        assert!(visibility.hides_entry(".flowix", true));
        assert!(visibility.hides_entry(".plugin-output", true));
    }

    #[test]
    fn relative_paths_check_ancestors_and_the_last_segment() {
        let visibility = TreeVisibility::default();
        assert!(!visibility.hides_file_path(Path::new("notes/note.md")));
        assert!(visibility.hides_file_path(Path::new("notes/.index.yaml")));
        assert!(visibility.hides_file_path(Path::new(".flowix/view-preferences.json")));
        assert!(visibility.hides_file_path(Path::new("node_modules/.index.yaml")));
    }
}
