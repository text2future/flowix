use std::io;
use std::path::{Component, Path};
use std::time::UNIX_EPOCH;

use super::file_rules::{is_sync_file_noise, EXCLUDED_DIRECTORY_NAMES};

/// Files visible to cloud sync, before the sync protocol turns paths into keys.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotebookFileMetadata {
    pub display_path: String,
    pub size: u64,
    pub mtime_millis: i64,
}

/// A visible, notebook-relative directory. Empty directories are included;
/// app-private directories are not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotebookDirectoryMetadata {
    pub display_path: String,
    pub mtime_millis: i64,
}

/// Scan files and directories that are part of notebook content. This keeps
/// the file-only API available to callers that do not need empty folders.
pub fn scan_syncable_notebook_tree(
    root: &Path,
) -> io::Result<(Vec<NotebookFileMetadata>, Vec<NotebookDirectoryMetadata>)> {
    let mut pending = vec![root.to_path_buf()];
    let mut files = Vec::new();
    let mut directories = Vec::new();

    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory)? {
            let entry = entry?;
            let path = entry.path();
            let relative = match path.strip_prefix(root) {
                Ok(relative) => relative,
                Err(_) => continue,
            };
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                let syncable = is_syncable_notebook_directory_path(relative);
                // Traverse the private root only to reach its database subtree.
                if !syncable && relative != Path::new(".flowix") {
                    continue;
                }
                if syncable {
                    let display_path = relative
                        .components()
                        .map(|component| component.as_os_str().to_string_lossy())
                        .collect::<Vec<_>>()
                        .join("/");
                    let mtime_millis = entry
                        .metadata()?
                        .modified()
                        .ok()
                        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                        .map(|elapsed| elapsed.as_millis() as i64)
                        .unwrap_or(0);
                    directories.push(NotebookDirectoryMetadata {
                        display_path,
                        mtime_millis,
                    });
                }
                pending.push(path);
                continue;
            }
            if !kind.is_file() {
                continue;
            }

            if !is_syncable_notebook_file_path(relative) {
                continue;
            }

            let metadata = entry.metadata()?;
            let mtime_millis = metadata
                .modified()
                .ok()
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|elapsed| elapsed.as_millis() as i64)
                .unwrap_or(0);
            let display_path = relative
                .components()
                .map(|component| component.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            files.push(NotebookFileMetadata {
                display_path,
                size: metadata.len(),
                mtime_millis,
            });
        }
    }

    files.sort_by(|left, right| left.display_path.cmp(&right.display_path));
    directories.sort_by(|left, right| left.display_path.cmp(&right.display_path));
    Ok((files, directories))
}

/// Scan a notebook without following symlinks or reading file contents.
///
/// Hidden user content, collection definitions and attachments are syncable.
pub fn scan_syncable_notebook_files(root: &Path) -> io::Result<Vec<NotebookFileMetadata>> {
    scan_syncable_notebook_tree(root).map(|(files, _directories)| files)
}

/// Whether a notebook-relative directory belongs to synced notebook content.
/// The notebook root itself is not a directory marker; callers that inspect a
/// file at the root should handle its empty parent separately.
pub fn is_syncable_notebook_directory_path(relative: &Path) -> bool {
    if !is_contained_relative_path(relative) {
        return false;
    }
    let user_data = relative.starts_with(Path::new(".flowix/database"));
    relative.components().enumerate().all(|(index, component)| {
        let name = component.as_os_str().to_string_lossy();
        if index == 0 && name == ".flowix" {
            return user_data;
        }
        if name == ".flowix" || name == ".plugin-output" {
            return false;
        }
        if index == 0 && name == "attachments" {
            return true;
        }
        !EXCLUDED_DIRECTORY_NAMES.contains(&name.as_ref())
    })
}

/// Shared notebook content policy for both scanning and receiving.
pub fn is_syncable_notebook_file_path(relative: &Path) -> bool {
    if !is_contained_relative_path(relative) {
        return false;
    }

    let Some(name) = relative.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if is_sync_file_noise(name) {
        return false;
    }

    let parent = relative.parent().unwrap_or_else(|| Path::new(""));
    parent.as_os_str().is_empty() || is_syncable_notebook_directory_path(parent)
}

fn is_contained_relative_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

#[cfg(test)]
mod sync_path_tests {
    use super::{
        is_syncable_notebook_directory_path as directory, is_syncable_notebook_file_path as file,
    };
    use std::path::Path;

    #[test]
    fn sync_policy_includes_hidden_files_and_collection_definitions() {
        for path in [
            ".index.yaml",
            "notes/.index.yaml",
            "table.index.yaml",
            "collection.table.yaml",
            ".hidden.md",
            ".agents/skills/SKILL.md",
            "attachments/.hidden/image.png",
            ".flowix/database/.hidden.md",
        ] {
            assert!(file(Path::new(path)), "{path} should sync");
        }
        for path in [
            ".flowix/notebook.json",
            ".flowix/view-preferences.json",
            "notes/.DS_Store",
            ".git/config",
            "node_modules/a.js",
            "notes/a.tmp",
            ".hidden.tmp",
            "photo.png.yaml",
            "attachments/node_modules/a.js",
        ] {
            assert!(!file(Path::new(path)), "{path} must stay local");
        }
        assert!(directory(Path::new(".agents/skills")));
        assert!(directory(Path::new(".flowix/database")));
        assert!(!directory(Path::new(".flowix")));
        assert!(!directory(Path::new(".git")));
        assert!(!directory(Path::new("notes/../outside")));
    }
}
