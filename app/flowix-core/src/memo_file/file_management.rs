use std::path::{Component, Path};

use serde::{Deserialize, Serialize};

/// Notebook-local exceptions to default exclusions. All paths use `/` and
/// are relative to the notebook root.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileManagementPolicy {
    #[serde(default)]
    pub included_paths: Vec<String>,
    /// Explicit paths hidden from the notebook file tree, including folders
    /// with descendants that should also remain hidden.
    #[serde(default)]
    pub hidden_paths: Vec<String>,
    /// Folder subtrees that remain visible in the notebook but are skipped by
    /// the Markdown note index.
    #[serde(default)]
    pub excluded_index_paths: Vec<String>,
}

impl FileManagementPolicy {
    fn is_always_excluded_name(name: &str) -> bool {
        matches!(name, ".flowix" | ".plugin-output")
    }

    fn is_excluded_directory_name(name: &str) -> bool {
        matches!(
            name,
            ".git"
                | "node_modules"
                | "attachments"
                | "attachments-cache"
                | "bower_components"
                | "__pycache__"
        ) || (name.starts_with('.') && !Self::is_user_visible_hidden_directory(name))
    }

    /// Dot-prefixed folders that users commonly work with directly. Other
    /// dot-prefixed directories are treated as application or tool internals.
    fn is_user_visible_hidden_directory(name: &str) -> bool {
        matches!(
            name,
            ".agent"
                | ".agents"
                | ".codex"
                | ".claude"
                | ".dsh"
                | ".opencode"
                | ".hermes"
                | ".continue"
                | ".aider"
                | ".roo"
                | ".amazonq"
                | ".gemini"
                | ".qwen"
                | ".kiro"
                | ".amp"
                | ".goose"
                | ".crush"
                | ".factory"
                | ".junie"
                | ".github"
                | ".gitlab"
                | ".vscode"
                | ".idea"
                | ".obsidian"
                | ".husky"
                | ".devcontainer"
                | ".changeset"
                | ".storybook"
                | ".cursor"
                | ".windsurf"
                | ".zed"
                | ".config"
                | ".circleci"
                | ".buildkite"
                | ".docker"
                | ".run"
                | ".fleet"
                | ".settings"
                | ".project"
        )
    }

    pub fn is_locked_name(name: &str) -> bool {
        matches!(name, ".flowix" | ".plugin-output") || name.eq_ignore_ascii_case(".index.yaml")
    }

    pub fn from_notebook_root(root: &Path) -> Self {
        std::fs::read(root.join(".flowix/view-preferences.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|value| value.get("fileManagement").cloned())
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default()
    }

    pub fn is_ignored(&self, path: &Path) -> bool {
        let mut relative = String::new();
        let components: Vec<_> = path.components().collect();
        for (index, component) in components.iter().enumerate() {
            let Component::Normal(name) = component else { return true; };
            let name = name.to_string_lossy();
            if !relative.is_empty() { relative.push('/'); }
            relative.push_str(&name);
            if Self::is_always_excluded_name(&name) {
                return true;
            }
            if index + 1 < components.len()
                && Self::is_excluded_directory_name(&name)
                && !self.included_paths.iter().any(|included| included == &relative)
            {
                return true;
            }
        }

        let Some(name) = path.file_name() else { return true; };
        let name = name.to_string_lossy();
        let legacy_media_sidecar = Path::new(name.as_ref())
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("yaml"))
            && Path::new(name.as_ref())
                .file_stem()
                .is_some_and(|stem| super::media_kind_for_path(Path::new(stem)).is_some());
        let ignored_file = name.starts_with('.')
            || name.eq_ignore_ascii_case(".index.yaml")
            || legacy_media_sidecar
            || matches!(name.as_ref(), "Thumbs.db" | "ehthumbs.db" | "desktop.ini")
            || name.ends_with(".tmp")
            || name.ends_with(".swp")
            || name.ends_with(".bak")
            || name.ends_with(".lock")
            || name.ends_with('~');
        ignored_file && !self.included_paths.iter().any(|included| included == &relative)
    }

    /// Evaluate a path known to represent a directory, including removed
    /// directory paths that no longer exist on disk.
    pub fn is_ignored_directory(&self, relative: &Path) -> bool {
        let mut key = String::new();
        for component in relative.components() {
            let Component::Normal(name) = component else { return true; };
            let name = name.to_string_lossy();
            if !key.is_empty() { key.push('/'); }
            key.push_str(&name);
            if Self::is_always_excluded_name(&name) {
                return true;
            }
            if Self::is_excluded_directory_name(&name)
                && !self.included_paths.iter().any(|included| included == &key)
            {
                return true;
            }
        }
        false
    }

    /// Evaluate file exclusions and excluded directory names against an
    /// existing notebook path. The relative path is always scoped to `root`.
    pub fn is_ignored_at(&self, root: &Path, relative: &Path) -> bool {
        let mut current = root.to_path_buf();
        current.push(relative);
        if std::fs::symlink_metadata(&current).is_ok_and(|metadata| metadata.is_dir()) {
            return self.is_ignored_directory(relative);
        }
        self.is_ignored(relative)
    }

    /// Return whether a path should be omitted from the notebook file tree.
    pub fn is_tree_hidden_at(&self, root: &Path, relative: &Path) -> bool {
        if self.is_ignored_at(root, relative) { return true; }
        self.is_configured_hidden(relative)
    }

    /// Return whether a directory should be omitted from the notebook file
    /// tree, even if the directory has already been removed from disk.
    pub fn is_tree_hidden_directory(&self, relative: &Path) -> bool {
        self.is_ignored_directory(relative) || self.is_configured_hidden(relative)
    }

    fn is_configured_hidden(&self, relative: &Path) -> bool {
        let key = relative.to_string_lossy().replace('\\', "/");
        self.hidden_paths.iter().any(|hidden| {
            key == hidden.as_str()
                || key.strip_prefix(hidden.as_str()).is_some_and(|suffix| suffix.starts_with('/'))
        })
    }

    /// Return whether a relative path belongs to a folder subtree excluded
    /// from the note index. This does not hide the path from the file tree.
    pub fn is_index_excluded_at(&self, root: &Path, relative: &Path) -> bool {
        let default_policy = FileManagementPolicy::default();
        if default_policy.is_ignored_at(root, relative) {
            return true;
        }
        if self.excluded_index_paths.iter().any(|excluded| excluded.is_empty()) {
            return true;
        }
        let key = relative.to_string_lossy().replace('\\', "/");
        self.excluded_index_paths.iter().any(|excluded| {
            key == excluded.as_str()
                || key.strip_prefix(excluded.as_str()).is_some_and(|suffix| suffix.starts_with('/'))
        })
    }

    /// Resolve index participation independently from tree visibility.
    pub fn is_index_ignored_at(&self, root: &Path, relative: &Path) -> bool {
        self.is_ignored_at(root, relative) || self.is_index_excluded_at(root, relative)
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
