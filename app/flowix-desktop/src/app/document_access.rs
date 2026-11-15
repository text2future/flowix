use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

#[derive(Default)]
pub struct DocumentAccess {
    paths: RwLock<HashSet<(String, PathBuf)>>,
    directories: RwLock<HashSet<(String, PathBuf)>>,
    generations: RwLock<HashMap<String, u64>>,
    references: RwLock<HashSet<PathBuf>>,
    references_file: Option<PathBuf>,
}

impl DocumentAccess {
    pub fn new(config_dir: &Path) -> Self {
        let name = if option_env!("FLOWIX_DEV_MODE") == Some("1") {
            "file-references.dev.json"
        } else {
            "file-references.json"
        };
        let file = config_dir.join("boot").join(name);
        let references = match std::fs::read(&file) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
                tracing::warn!(%error, "cannot read retained file references");
                HashSet::new()
            }),
            Err(error) => {
                if error.kind() != io::ErrorKind::NotFound {
                    tracing::warn!(%error, "cannot read retained file references");
                }
                HashSet::new()
            }
        };
        Self {
            references: RwLock::new(references),
            references_file: Some(file),
            ..Self::default()
        }
    }

    /// The caller supplies an already canonical path.
    pub(crate) fn has_retained_file_reference(&self, path: &Path) -> bool {
        self.references
            .read()
            .is_ok_and(|references| references.contains(path))
    }

    /// The caller must authorize this exact file before retaining its reference.
    pub(crate) fn retain_file_reference(&self, path: &Path) -> io::Result<PathBuf> {
        let path = existing_file(path).ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "referenced file is unavailable")
        })?;
        let mut references = self
            .references
            .write()
            .map_err(|_| io::Error::other("file references lock is poisoned"))?;
        if !references.contains(&path) {
            let mut next = references.clone();
            next.insert(path.clone());
            if let Some(file) = &self.references_file {
                let mut paths = next.iter().collect::<Vec<_>>();
                paths.sort();
                let json = serde_json::to_string_pretty(&paths)?;
                crate::config::user::atomic_write_json(file, &json)?;
            }
            *references = next;
        }
        Ok(path)
    }

    pub fn grant(&self, window: &str, path: &Path) -> bool {
        self.grant_for_generation(window, self.generation(window), path)
    }

    pub fn generation(&self, window: &str) -> u64 {
        self.generations
            .read()
            .map(|values| *values.get(window).unwrap_or(&0))
            .unwrap_or(u64::MAX)
    }

    pub fn grant_for_generation(&self, window: &str, generation: u64, path: &Path) -> bool {
        let Ok(generations) = self.generations.read() else {
            return false;
        };
        if *generations.get(window).unwrap_or(&0) != generation {
            return false;
        }
        let Some(path) = existing_file(path) else {
            return false;
        };
        let Ok(mut paths) = self.paths.write() else {
            return false;
        };
        paths.insert((window.to_string(), path));
        true
    }

    pub fn grant_directory_for_generation(
        &self,
        window: &str,
        generation: u64,
        path: &Path,
    ) -> bool {
        let Ok(generations) = self.generations.read() else {
            return false;
        };
        if *generations.get(window).unwrap_or(&0) != generation {
            return false;
        }
        let Some(path) = existing_directory(path) else {
            return false;
        };
        let Ok(mut directories) = self.directories.write() else {
            return false;
        };
        directories.insert((window.to_string(), path));
        true
    }

    pub fn contains(&self, window: &str, path: &Path) -> bool {
        if self.generations.read().is_err() {
            return false;
        }
        let Some(path) = existing_path(path) else {
            return false;
        };
        let file_granted = path.is_file()
            && self
                .paths
                .read()
                .is_ok_and(|paths| paths.contains(&(window.to_string(), path.clone())));
        let referenced = path.is_file()
            && self
                .references
                .read()
                .is_ok_and(|references| references.contains(&path));
        file_granted
            || referenced
            || self.directories.read().is_ok_and(|directories| {
                directories
                    .iter()
                    .any(|(owner, directory)| owner == window && path.starts_with(directory))
            })
    }

    pub fn revoke(&self, window: &str) {
        let Ok(mut generations) = self.generations.write() else {
            return;
        };
        let generation = generations.entry(window.to_string()).or_default();
        *generation = generation.saturating_add(1);
        if let Ok(mut paths) = self.paths.write() {
            paths.retain(|(owner, _)| owner != window);
        }
        if let Ok(mut directories) = self.directories.write() {
            directories.retain(|(owner, _)| owner != window);
        }
    }
}

fn existing_file(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let canonical = dunce::canonicalize(path).ok()?;
    canonical.is_file().then_some(canonical)
}

fn existing_directory(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let canonical = dunce::canonicalize(path).ok()?;
    canonical.is_dir().then_some(canonical)
}

fn existing_path(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    dunce::canonicalize(path).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_a_window_invalidates_pending_dialog_grants() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("file.md");
        std::fs::write(&path, "data").unwrap();
        let access = DocumentAccess::default();
        let generation = access.generation("main");
        access.revoke("main");
        assert!(!access.grant_for_generation("main", generation, &path));
        assert!(!access.contains("main", &path));
    }

    #[test]
    fn grants_are_isolated_and_revoked_per_window() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("private.md");
        std::fs::write(&file, "private").unwrap();
        let access = DocumentAccess::default();
        assert!(access.grant("first", &file));
        assert!(!access.contains("second", &file));
        assert!(access.grant("second", &file));
        access.revoke("first");
        assert!(!access.contains("first", &file));
        assert!(access.contains("second", &file));
    }

    #[test]
    fn extension_alone_never_grants_access() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("private.md");
        std::fs::write(&path, "private").unwrap();
        assert!(!DocumentAccess::default().contains("main", &path));
    }

    #[test]
    fn explicit_grant_does_not_authorize_siblings() {
        let directory = tempfile::tempdir().unwrap();
        let selected = directory.path().join("selected.md");
        let sibling = directory.path().join("private.md");
        std::fs::write(&selected, "selected").unwrap();
        std::fs::write(&sibling, "private").unwrap();
        let access = DocumentAccess::default();
        assert!(access.grant("main", &selected));
        assert!(access.contains("main", &selected));
        assert!(!access.contains("main", &sibling));
        assert!(!DocumentAccess::default().contains("main", &selected));
    }

    #[test]
    fn invalid_grants_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        let access = DocumentAccess::default();
        for path in [
            directory.path(),
            Path::new("relative.md"),
            &directory.path().join("missing.md"),
        ] {
            assert!(!access.grant("main", path));
            assert!(!access.contains("main", path));
        }
    }

    #[test]
    fn atomic_replacement_preserves_path_authorization() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("selected.md");
        std::fs::write(&path, "original").unwrap();
        let access = DocumentAccess::default();
        assert!(access.grant("main", &path));
        flowix_core::memo_file::atomic_write_bytes(&path, b"saved").unwrap();
        assert!(access.contains("main", &path));
        std::fs::remove_file(&path).unwrap();
        assert!(!access.contains("main", &path));
    }

    #[cfg(unix)]
    #[test]
    fn retargeted_symlink_does_not_inherit_authorization() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("original.md");
        let private = directory.path().join("private.md");
        let alias = directory.path().join("alias.md");
        std::fs::write(&original, "original").unwrap();
        std::fs::write(&private, "private").unwrap();
        symlink(&original, &alias).unwrap();
        let access = DocumentAccess::default();
        assert!(access.grant("main", &alias));
        assert!(access.contains("main", &original));
        std::fs::remove_file(&alias).unwrap();
        symlink(&private, &alias).unwrap();
        assert!(!access.contains("main", &alias));
    }
}
