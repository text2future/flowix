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
    #[serde(default)]
    pub legacy_skip_dirs: Vec<String>,
    #[serde(default)]
    pub legacy_skip_files: Vec<String>,
    #[serde(default)]
    pub legacy_watcher_migrated: bool,
}

fn wildcard_match(pattern: &str, name: &str) -> bool {
    let (pattern, name) = (pattern.as_bytes(), name.as_bytes());
    let (mut p, mut n, mut star, mut retry) = (0, 0, None, 0);
    while n < name.len() {
        if p < pattern.len() && pattern[p] == name[n] { p += 1; n += 1; }
        else if p < pattern.len() && pattern[p] == b'*' { star = Some(p); p += 1; retry = n; }
        else if let Some(position) = star { p = position + 1; retry += 1; n = retry; }
        else { return false; }
    }
    while p < pattern.len() && pattern[p] == b'*' { p += 1; }
    p == pattern.len()
}

impl FileManagementPolicy {
    pub fn matches_legacy_entry(&self, absolute: &Path) -> bool {
        let Some(name) = absolute.file_name().map(|name| name.to_string_lossy()) else { return false; };
        self.legacy_skip_dirs.iter().any(|skip| skip == name.as_ref())
            || std::fs::symlink_metadata(absolute).is_ok_and(|metadata| metadata.is_file())
                && self.legacy_skip_files.iter().any(|pattern| wildcard_match(pattern, &name))
    }

    pub fn is_locked_name(name: &str) -> bool {
        matches!(name, ".flowix" | ".plugin-output")
    }

    pub fn has_hidden_attribute(path: &Path) -> bool {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            return std::fs::symlink_metadata(path)
                .is_ok_and(|metadata| metadata.file_attributes() & 0x2 != 0);
        }
        #[cfg(not(windows))]
        { let _ = path; false }
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
            if matches!(name.as_ref(), ".flowix" | ".plugin-output") {
                return true;
            }
            let is_last = index + 1 == components.len();
            let notebook_agents_file = name.as_ref() == "AGENTS.md";
            let legacy_media_sidecar = is_last
                && Path::new(name.as_ref()).extension().is_some_and(|extension| extension.eq_ignore_ascii_case("yaml"))
                && Path::new(name.as_ref()).file_stem().is_some_and(|stem| super::media_kind_for_path(Path::new(stem)).is_some());
            let ignored_name = notebook_agents_file
                || name.starts_with('.')
                || matches!(name.as_ref(), "attachments" | "attachments-cache" | "node_modules" | "bower_components" | "__pycache__")
                || self.legacy_skip_dirs.iter().any(|skip| skip == name.as_ref())
                || legacy_media_sidecar
                || (is_last && (matches!(name.as_ref(), "Thumbs.db" | "ehthumbs.db" | "desktop.ini")
                    || name.ends_with(".tmp") || name.ends_with(".swp") || name.ends_with(".bak")
                    || name.ends_with(".lock") || name.ends_with('~')));
            if ignored_name && !self.included_paths.iter().any(|included| included == &relative) {
                return true;
            }
        }
        false
    }

    /// Evaluate the same policy against filesystem hidden attributes as well
    /// as names. The relative path is always scoped to `root`.
    pub fn is_ignored_at(&self, root: &Path, relative: &Path) -> bool {
        if self.is_ignored(relative) { return true; }
        let key = relative.to_string_lossy().replace('\\', "/");
        let file = root.join(relative);
        if !self.included_paths.iter().any(|included| included == &key)
            && std::fs::symlink_metadata(&file).is_ok_and(|metadata| metadata.is_file())
        {
            let name = relative.file_name().unwrap_or_default().to_string_lossy();
            if self.legacy_skip_files.iter().any(|pattern| wildcard_match(pattern, &name)) { return true; }
        }
        let mut current = root.to_path_buf();
        let mut key = String::new();
        for component in relative.components() {
            let Component::Normal(name) = component else { return true; };
            current.push(name);
            if !key.is_empty() { key.push('/'); }
            key.push_str(&name.to_string_lossy());
            if Self::has_hidden_attribute(&current)
                && !self.included_paths.iter().any(|included| included == &key)
            { return true; }
        }
        false
    }

    /// Return whether a path should be omitted from the notebook file tree.
    pub fn is_tree_hidden_at(&self, root: &Path, relative: &Path) -> bool {
        if self.is_ignored_at(root, relative) { return true; }
        let key = relative.to_string_lossy().replace('\\', "/");
        self.hidden_paths.iter().any(|hidden| {
            key == hidden.as_str()
                || key.strip_prefix(hidden.as_str()).is_some_and(|suffix| suffix.starts_with('/'))
        })
    }

    /// Return whether a relative path belongs to a folder subtree excluded
    /// from the note index. This does not hide the path from the file tree.
    pub fn is_index_excluded_at(&self, root: &Path, relative: &Path) -> bool {
        let is_root_agents = relative.components().count() == 1
            && relative.file_name().is_some_and(|name| name.to_string_lossy() == "AGENTS.md");
        let default_policy = FileManagementPolicy::default();
        if !is_root_agents
            && (default_policy.is_ignored_at(root, relative)
                || self.matches_legacy_entry(&root.join(relative)))
        {
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

    /// Resolve index participation independently from tree visibility. The
    /// notebook root AGENTS.md is special: it can be indexed even while its
    /// tree display remains hidden by default.
    pub fn is_index_ignored_at(&self, root: &Path, relative: &Path) -> bool {
        let is_root_agents = relative.components().count() == 1
            && relative.file_name().is_some_and(|name| name.to_string_lossy() == "AGENTS.md");
        if is_root_agents {
            self.is_index_excluded_at(root, relative)
        } else {
            self.is_ignored_at(root, relative) || self.is_index_excluded_at(root, relative)
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
