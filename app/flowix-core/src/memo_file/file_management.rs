use std::path::{Component, Path};

use super::file_rules::{
    is_internal_directory_name, matches_hidden_file_pattern, EXCLUDED_DIRECTORY_NAMES,
};

/// The built-in access rules: what may be read, written, indexed and watched.
///
/// 这是**访问口径**，不是展示口径。「访问空间」里画不画某一行由
/// [`super::tree_display::TreeVisibility`] 决定，两者刻意分开：
/// `.index.yaml` 在这里必须放行（集合的读写、重命名与恢复都靠它），在展示
/// 口径里则作为文件夹元数据被隐藏。
///
/// The former notebook-local `fileManagement` overrides (user-configured index
/// exclusions in `.flowix/view-preferences.json`) have been removed; this type
/// now carries only static rules, but stays a type so every scope check keeps a
/// single entry point. The `defaultCreateFolder` preference that lives in the
/// same file is unrelated to the policy and is handled by the note-creation
/// layer.
#[derive(Debug, Clone, Default)]
pub struct FileManagementPolicy;

impl FileManagementPolicy {
    /// Directory names skipped by every index and by the watcher: app
    /// internals, all dot-prefixed folders and [`EXCLUDED_DIRECTORY_NAMES`].
    /// This is the strict scope only; the tree's own row filter lives in
    /// [`super::tree_display`].
    fn is_excluded_directory_name(name: &str) -> bool {
        is_internal_directory_name(name)
            || name.starts_with('.')
            || EXCLUDED_DIRECTORY_NAMES.contains(&name)
    }

    pub fn is_locked_name(name: &str) -> bool {
        is_internal_directory_name(name) || name.eq_ignore_ascii_case(".index.yaml")
    }

    /// Kept for call-site stability: the policy no longer reads any
    /// notebook-local configuration file.
    pub fn from_notebook_root(_root: &Path) -> Self {
        Self
    }

    /// Lenient access scope: only app internals and file noise are hidden, so
    /// every folder that exists on disk stays browsable and every collection
    /// file stays readable. **Not** the tree's display filter — that one is
    /// [`super::tree_display::TreeVisibility::hides_entry`], which additionally
    /// drops `.index.yaml`.
    pub fn is_tree_hidden_at(&self, root: &Path, relative: &Path) -> bool {
        self.is_hidden_for(root, Self::scope_anchor(relative), false)
    }

    /// Lenient access scope for a directory that may already be gone from disk.
    pub fn is_tree_hidden_directory(&self, relative: &Path) -> bool {
        Self::is_hidden_directory_for(relative, false)
    }

    /// Index and watcher scope for a path resolved against `root`. Every index
    /// and the watcher share this entry point, so they cannot disagree about
    /// what is monitorable.
    pub fn is_index_hidden_at(&self, root: &Path, relative: &Path) -> bool {
        let anchor = Self::scope_anchor(relative);
        self.is_hidden_for(root, anchor, true)
    }

    /// Index and watcher scope for a path already known to be a directory,
    /// including directories that no longer exist on disk.
    pub fn is_index_hidden_directory(&self, relative: &Path) -> bool {
        Self::is_hidden_directory_for(relative, true)
    }

    /// `.index.yaml` describes the folder that contains it, so access checks
    /// resolve to that folder instead of the dot-file noise rule. A root-level
    /// `.index.yaml` resolves to the notebook root, which is always visible.
    /// Callers must not special-case this file name again.
    ///
    /// 注意这个豁免只属于访问口径。展示口径（[`super::tree_display`]）不走
    /// 这里，`.index.yaml` 在树里由文件通配 `.*` 隐藏。
    fn scope_anchor(relative: &Path) -> &Path {
        let is_folder_descriptor = relative
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(".index.yaml"));
        match (is_folder_descriptor, relative.parent()) {
            (true, Some(parent)) => parent,
            _ => relative,
        }
    }

    fn is_hidden_for(&self, root: &Path, relative: &Path, for_index: bool) -> bool {
        let mut current = root.to_path_buf();
        current.push(relative);
        if std::fs::symlink_metadata(&current).is_ok_and(|metadata| metadata.is_dir()) {
            return Self::is_hidden_directory_for(relative, for_index);
        }
        self.is_hidden_path_for(relative, for_index)
    }

    fn is_hidden_path_for(&self, relative: &Path, for_index: bool) -> bool {
        let components: Vec<_> = relative.components().collect();
        for (index, component) in components.iter().enumerate() {
            let Component::Normal(name) = component else { return true; };
            if index + 1 == components.len() {
                break;
            }
            if Self::skips_directory_name(&name.to_string_lossy(), for_index) {
                return true;
            }
        }

        let Some(name) = relative.file_name() else { return true; };
        matches_hidden_file_pattern(&name.to_string_lossy())
    }

    fn is_hidden_directory_for(relative: &Path, for_index: bool) -> bool {
        for component in relative.components() {
            let Component::Normal(name) = component else { return true; };
            if Self::skips_directory_name(&name.to_string_lossy(), for_index) {
                return true;
            }
        }
        false
    }

    /// `for_index` selects the strict rule; the lenient access scope only drops
    /// app internals.
    fn skips_directory_name(name: &str, for_index: bool) -> bool {
        if for_index {
            Self::is_excluded_directory_name(name)
        } else {
            is_internal_directory_name(name)
        }
    }
}

/// Read and validate the notebook-local default parent folder used when a
/// note creation command does not specify a destination. An empty preference
/// means the notebook root.
pub fn default_create_folder_for_notebook(root: &Path) -> Result<Option<String>, String> {
    let preferences_path = root.join(".flowix/view-preferences.json");
    let bytes = match std::fs::read(&preferences_path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::read(root.join(".flowix/notebook.json")).ok()
        }
        Err(_) => None,
    };
    let folder = bytes
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| {
            value
                .get("defaultCreateFolder")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        });
    let Some(folder) = folder else {
        return Ok(None);
    };
    let trimmed = folder.trim_matches('/');
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.contains('\\') || trimmed.contains('\0') {
        return Err("INVALID_NOTEBOOK_FOLDER_PREFERENCE".to_string());
    }
    let path = Path::new(trimmed);
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("INVALID_NOTEBOOK_FOLDER_PREFERENCE".to_string());
    }
    Ok(Some(path.to_string_lossy().replace('\\', "/")))
}

/// Rebase the notebook-relative default create folder after the directory it
/// points at was renamed or moved.
///
/// The preference is stored as a notebook-relative path, so a rename leaves it
/// dangling and note creation silently falls back to the notebook root. A
/// rename of an ancestor directory moves the whole subtree, so the suffix below
/// the moved directory has to be preserved. Returns `None` when the preference
/// is unaffected, which keeps unrelated renames from rewriting the file.
pub fn rebase_default_create_folder_path(
    current: &str,
    previous_relative: &str,
    next_relative: &str,
) -> Option<String> {
    let current = current.trim_matches('/');
    let previous = previous_relative.trim_matches('/');
    let next = next_relative.trim_matches('/');
    if current.is_empty() || previous.is_empty() || next.is_empty() {
        return None;
    }
    if current == previous {
        return Some(next.to_string());
    }
    let suffix = current.strip_prefix(previous)?.strip_prefix('/')?;
    if suffix.is_empty() {
        return None;
    }
    Some(format!("{next}/{suffix}"))
}

#[cfg(test)]
mod rebase_default_create_folder_path_tests {
    use super::rebase_default_create_folder_path as rebase;

    #[test]
    fn rebases_the_default_folder_itself() {
        assert_eq!(rebase("笔记", "笔记", "Notes").as_deref(), Some("Notes"));
    }

    #[test]
    fn rebases_descendants_of_a_renamed_ancestor() {
        assert_eq!(
            rebase("笔记/子目录", "笔记", "Notes").as_deref(),
            Some("Notes/子目录")
        );
        assert_eq!(
            rebase("笔记/子/孙", "笔记/子", "笔记/苗").as_deref(),
            Some("笔记/苗/孙")
        );
    }

    #[test]
    fn ignores_unrelated_or_sibling_paths() {
        assert_eq!(rebase("笔记/子", "笔记/子/孙", "x"), None);
        assert_eq!(rebase("笔记2", "笔记", "Notes"), None);
        assert_eq!(rebase("其他", "笔记", "Notes"), None);
        assert_eq!(rebase("", "笔记", "Notes"), None);
        assert_eq!(rebase("笔记", "笔记", ""), None);
    }
}
