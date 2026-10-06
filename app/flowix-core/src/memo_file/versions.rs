use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::ops::atomic_write_bytes;
use super::{IsMd, MemoFile};

pub const MEMO_AUTO_VERSION_INTERVAL_MS: i64 = 60 * 60 * 1000;
pub const MEMO_VERSION_LIMIT: usize = 20;
/// Unknown version directories are retained for this long before cleanup.
/// This protects against transient sync visibility and delayed watcher events.
pub const MEMO_ORPHAN_VERSION_RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoVersionSource {
    Auto,
    Manual,
    RestoreBackup,
    CloudConflict,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoVersionMeta {
    pub id: String,
    pub memo_id: String,
    pub created_at: i64,
    pub source: MemoVersionSource,
    pub filename: String,
    pub title: String,
    pub size: u64,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoVersionManifest {
    pub version: u32,
    pub memo_id: String,
    pub versions: Vec<MemoVersionMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathVersionMeta {
    pub id: String,
    pub created_at: i64,
    pub source: MemoVersionSource,
    pub size: u64,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathVersionManifest {
    version: u32,
    notebook_id: String,
    relative_path: String,
    versions: Vec<PathVersionMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathArchiveSummary {
    pub notebook_id: String,
    pub notebook_name: String,
    pub relative_path: String,
    pub latest_at: i64,
    pub version_count: usize,
}

impl MemoFile {
    pub fn list_path_archives(&self) -> Vec<PathArchiveSummary> {
        let mut summaries = Vec::new();
        let Ok(notebooks) = self.read_notebook_configs() else { return summaries; };
        for notebook in notebooks {
            let root = PathBuf::from(&notebook.path).join(".flowix").join("archives");
            if fs::symlink_metadata(&root).is_ok_and(|metadata| metadata.file_type().is_symlink()) { continue; }
            let Ok(entries) = fs::read_dir(root) else { continue; };
            for entry in entries.flatten() {
                if !entry.file_type().is_ok_and(|kind| kind.is_dir()) { continue; }
                let Ok(json) = fs::read(entry.path().join("manifest.json")) else { continue; };
                let Ok(manifest) = serde_json::from_slice::<PathVersionManifest>(&json) else { continue; };
                if manifest.notebook_id != notebook.id || manifest.versions.is_empty() { continue; }
                let Some(expected) = self.path_archive_location(&notebook.id, &manifest.relative_path) else { continue; };
                if entry.path().canonicalize().ok().as_deref() != Some(expected.as_path()) { continue; }
                summaries.push(PathArchiveSummary {
                    notebook_id: notebook.id.clone(), notebook_name: notebook.name.clone(),
                    relative_path: manifest.relative_path,
                    latest_at: manifest.versions.iter().map(|version| version.created_at).max().unwrap_or(0),
                    version_count: manifest.versions.len(),
                });
            }
        }
        summaries.sort_by_key(|entry| std::cmp::Reverse(entry.latest_at));
        summaries
    }

    pub(super) fn move_path_archive(
        &self,
        notebook_id: &str,
        old_relative: &str,
        new_relative: &str,
    ) -> std::io::Result<()> {
        let Some(notebook) = self.get_notebook_config_by_id(notebook_id) else {
            return Ok(());
        };
        let root = PathBuf::from(notebook.path)
            .join(".flowix")
            .join("archives");
        let key = |path: &str| format!("{:x}", Sha256::digest(path.replace('\\', "/").as_bytes()));
        let source = root.join(key(old_relative));
        if !source.exists() {
            return Ok(());
        }
        let destination = root.join(key(new_relative));
        if destination.exists() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "destination already has an archive",
            ));
        }
        let json = fs::read_to_string(source.join("manifest.json"))?;
        let mut manifest: PathVersionManifest = serde_json::from_str(&json)?;
        if manifest.notebook_id != notebook_id || manifest.relative_path != old_relative {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "archive identity mismatch",
            ));
        }
        fs::rename(&source, &destination)?;
        manifest.relative_path = new_relative.to_string();
        atomic_write_bytes(
            &destination.join("manifest.json"),
            &serde_json::to_vec_pretty(&manifest)?,
        )
    }

    fn path_archive_location(
        &self,
        notebook_id: &str,
        relative_path: &str,
    ) -> Option<PathBuf> {
        let relative = Path::new(relative_path);
        if relative.is_absolute()
            || !(relative.is_md() || relative_path.starts_with("attachments/"))
            || relative
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return None;
        }
        let notebook = self.get_notebook_config_by_id(notebook_id)?;
        let root = PathBuf::from(notebook.path).canonicalize().ok()?;
        let key = format!(
            "{:x}",
            Sha256::digest(relative_path.replace('\\', "/").as_bytes())
        );
        let archive = root.join(".flowix").join("archives").join(key);
        Some(archive)
    }

    fn read_path_manifest(
        &self,
        notebook_id: &str,
        relative_path: &str,
    ) -> Option<(PathBuf, PathVersionManifest)> {
        let archive = self.path_archive_location(notebook_id, relative_path)?;
        let manifest = fs::read_to_string(archive.join("manifest.json"))
            .ok()
            .and_then(|json| serde_json::from_str::<PathVersionManifest>(&json).ok())
            .filter(|manifest| {
                manifest.notebook_id == notebook_id && manifest.relative_path == relative_path
            })
            .unwrap_or_else(|| PathVersionManifest {
                version: 1,
                notebook_id: notebook_id.to_string(),
                relative_path: relative_path.to_string(),
                versions: Vec::new(),
            });
        Some((archive, manifest))
    }

    pub fn list_path_versions(
        &self,
        notebook_id: &str,
        relative_path: &str,
    ) -> Vec<PathVersionMeta> {
        self.read_path_manifest(notebook_id, relative_path)
            .map(|(_, mut manifest)| {
                manifest
                    .versions
                    .sort_by_key(|version| std::cmp::Reverse(version.created_at));
                manifest.versions
            })
            .unwrap_or_default()
    }

    pub fn read_path_version(
        &self,
        notebook_id: &str,
        relative_path: &str,
        version_id: &str,
    ) -> Option<String> {
        if !Path::new(relative_path).is_md() { return None; }
        String::from_utf8(self.read_path_version_bytes(notebook_id, relative_path, version_id)?).ok()
    }

    pub fn read_path_version_bytes(
        &self,
        notebook_id: &str,
        relative_path: &str,
        version_id: &str,
    ) -> Option<Vec<u8>> {
        if !is_safe_version_id(version_id) { return None; }
        let (archive, manifest) = self.read_path_manifest(notebook_id, relative_path)?;
        let version = manifest.versions.iter().find(|version| version.id == version_id)?;
        let extension = if Path::new(relative_path).is_md() { "md" } else { "bin" };
        let version_path = archive.join(format!("{version_id}.{extension}"));
        if fs::symlink_metadata(&version_path).ok()?.file_type().is_symlink() { return None; }
        let bytes = fs::read(version_path).ok()?;
        (format!("{:x}", Sha256::digest(&bytes)) == version.content_hash).then_some(bytes)
    }

    pub fn create_path_version(
        &self,
        notebook_id: &str,
        relative_path: &str,
        content: &str,
        source: MemoVersionSource,
    ) -> std::io::Result<Option<PathVersionMeta>> {
        self.create_path_version_bytes(notebook_id, relative_path, content.as_bytes(), source)
    }

    pub fn create_path_version_bytes(
        &self,
        notebook_id: &str,
        relative_path: &str,
        content: &[u8],
        source: MemoVersionSource,
    ) -> std::io::Result<Option<PathVersionMeta>> {
        let Some((archive, mut manifest)) = self.read_path_manifest(notebook_id, relative_path)
        else {
            return Ok(None);
        };
        for directory in [archive.parent().and_then(Path::parent), archive.parent(), Some(archive.as_path())]
            .into_iter().flatten()
        {
            if let Ok(metadata) = fs::symlink_metadata(directory) {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "unsafe version archive directory"));
                }
            }
        }
        let content_hash = format!("{:x}", Sha256::digest(content));
        if let Some(existing) = manifest.versions.iter_mut()
            .find(|version| version.content_hash == content_hash)
        {
            let extension = if Path::new(relative_path).is_md() { "md" } else { "bin" };
            let version_path = archive.join(format!("{}.{extension}", existing.id));
            if fs::read(&version_path).ok().as_deref() != Some(content) {
                atomic_write_bytes(&version_path, content)?;
            }
            if source == MemoVersionSource::CloudConflict
                && existing.source != MemoVersionSource::CloudConflict
            {
                existing.source = MemoVersionSource::CloudConflict;
                let promoted = existing.clone();
                atomic_write_bytes(
                    &archive.join("manifest.json"),
                    &serde_json::to_vec_pretty(&manifest)?,
                )?;
                return Ok(Some(promoted));
            }
            return Ok(None);
        }
        let now = chrono::Utc::now();
        let id = format!(
            "v_{}_{}",
            now.format("%Y%m%d_%H%M%S"),
            nanoid::nanoid!(6, &super::MEMO_ID_ALPHABET)
        );
        let meta = PathVersionMeta {
            id: id.clone(),
            created_at: now.timestamp_millis(),
            source,
            size: content.len() as u64,
            content_hash,
        };
        fs::create_dir_all(&archive)?;
        let extension = if Path::new(relative_path).is_md() { "md" } else { "bin" };
        atomic_write_bytes(&archive.join(format!("{id}.{extension}")), content)?;
        manifest.versions.push(meta.clone());
        manifest
            .versions
            .sort_by_key(|version| std::cmp::Reverse(version.created_at));
        let mut ordinary_kept = 0;
        manifest.versions.retain(|version| {
            if version.source == MemoVersionSource::CloudConflict { return true; }
            ordinary_kept += 1;
            let keep = ordinary_kept <= MEMO_VERSION_LIMIT;
            if !keep { let _ = fs::remove_file(archive.join(format!("{}.{extension}", version.id))); }
            keep
        });
        atomic_write_bytes(
            &archive.join("manifest.json"),
            &serde_json::to_vec_pretty(&manifest)?,
        )?;
        Ok(Some(meta))
    }

    pub fn maybe_create_auto_path_version(
        &self,
        notebook_id: &str,
        relative_path: &str,
        content: &str,
    ) -> std::io::Result<Option<PathVersionMeta>> {
        let Some((_, manifest)) = self.read_path_manifest(notebook_id, relative_path) else {
            return Ok(None);
        };
        let now = chrono::Utc::now().timestamp_millis();
        if manifest
            .versions
            .iter()
            .filter(|version| version.source == MemoVersionSource::Auto)
            .any(|version| now - version.created_at < MEMO_AUTO_VERSION_INTERVAL_MS)
        {
            return Ok(None);
        }
        self.create_path_version(notebook_id, relative_path, content, MemoVersionSource::Auto)
    }
}

impl MemoVersionManifest {
    fn empty(memo_id: &str) -> Self {
        Self {
            version: 1,
            memo_id: memo_id.to_string(),
            versions: Vec::new(),
        }
    }
}

impl MemoFile {
    fn versions_root(&self) -> PathBuf {
        self.get_versions_dir()
    }

    fn versions_root_for_memo(&self, memo_id: &str) -> PathBuf {
        self.resolve_memo_location(memo_id)
            .ok()
            .flatten()
            .map(|location| {
                PathBuf::from(location.notebook.path)
                    .join(".flowix")
                    .join("versions")
            })
            .unwrap_or_else(|| self.versions_root())
    }

    fn memo_versions_dir(&self, memo_id: &str) -> PathBuf {
        self.versions_root_for_memo(memo_id).join(memo_id)
    }

    fn memo_versions_manifest_path(&self, memo_id: &str) -> PathBuf {
        self.memo_versions_dir(memo_id).join("manifest.json")
    }

    fn read_version_manifest(&self, memo_id: &str) -> MemoVersionManifest {
        let path = self
            .versions_root_for_memo(memo_id)
            .join(memo_id)
            .join("manifest.json");
        if let Ok(content) = fs::read_to_string(path) {
            if let Ok(manifest) = serde_json::from_str(&content) {
                return manifest;
            }
        }
        MemoVersionManifest::empty(memo_id)
    }

    fn write_version_manifest(
        &self,
        memo_id: &str,
        manifest: &MemoVersionManifest,
    ) -> std::io::Result<()> {
        let path = self.memo_versions_manifest_path(memo_id);
        let content = serde_json::to_vec_pretty(manifest)?;
        atomic_write_bytes(&path, &content)
    }

    fn memo_version_path(&self, memo_id: &str, version_id: &str) -> PathBuf {
        self.memo_versions_dir(memo_id)
            .join(format!("{version_id}.md"))
    }

    /// Remove all history belonging to a memo. The caller must pass the
    /// notebook root resolved before the memo index row is deleted.
    pub(super) fn remove_memo_versions_for_notebook(
        &self,
        notebook_root: &Path,
        memo_id: &str,
    ) -> std::io::Result<()> {
        if !is_safe_memo_id(memo_id) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("invalid memo id for version cleanup: {memo_id}"),
            ));
        }
        let dir = notebook_root.join(".flowix").join("versions").join(memo_id);
        if dir.exists() {
            fs::remove_dir_all(dir)?;
        }
        Ok(())
    }

    /// Reconcile version directories with the global memo index.
    ///
    /// A live ID found under another notebook is moved to that notebook. An
    /// unknown ID is removed only after the retention period, so a temporary
    /// missing index row cannot destroy recoverable history.
    pub fn cleanup_orphan_memo_versions(
        &self,
        notebook_id: &str,
        now: SystemTime,
    ) -> std::io::Result<super::types::MemoVersionCleanupReport> {
        let _guard = self.current_index_io.lock().expect("index_io poisoned");
        let Some(notebook) = self.get_notebook_config_by_id(notebook_id) else {
            return Ok(Default::default());
        };
        let source_root = PathBuf::from(&notebook.path);
        let mut report = super::types::MemoVersionCleanupReport::default();
        let versions_root = source_root.join(".flowix").join("versions");
        let entries = match fs::read_dir(&versions_root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(report),
            Err(_) => {
                report.failed += 1;
                return Ok(report);
            }
        };
        for entry in entries.flatten() {
            let file_type = match entry.file_type() {
                Ok(value) => value,
                Err(_) => {
                    report.failed += 1;
                    continue;
                }
            };
            if !file_type.is_dir() {
                continue;
            }
            let memo_id = entry.file_name().to_string_lossy().into_owned();
            if !is_safe_memo_id(&memo_id) {
                report.failed += 1;
                continue;
            }
            let Some(location) = self.resolve_memo_location(&memo_id)? else {
                if is_older_than(&entry.path(), now, MEMO_ORPHAN_VERSION_RETENTION) {
                    match fs::remove_dir_all(entry.path()) {
                        Ok(()) => report.removed += 1,
                        Err(_) => report.failed += 1,
                    }
                } else {
                    report.retained_recent += 1;
                }
                continue;
            };
            let destination = PathBuf::from(location.notebook.path)
                .join(".flowix")
                .join("versions")
                .join(&memo_id);
            if location.notebook.id == notebook_id {
                continue;
            }
            if destination.exists() {
                // Never merge or overwrite two histories automatically.
                // Keeping both makes the conflict observable and allows a
                // later repair tool to compare manifests safely.
                report.failed += 1;
                continue;
            }
            if let Some(parent) = destination.parent() {
                if let Err(_) = fs::create_dir_all(parent) {
                    report.failed += 1;
                    continue;
                }
            }
            match fs::rename(entry.path(), destination) {
                Ok(()) => report.moved += 1,
                Err(_) => report.failed += 1,
            }
        }
        Ok(report)
    }

    pub fn list_memo_versions(&self, memo_id: &str) -> Vec<MemoVersionMeta> {
        if !is_safe_memo_id(memo_id) {
            return Vec::new();
        }
        let mut versions = self.read_version_manifest(memo_id).versions;
        versions.sort_by_key(|v| std::cmp::Reverse(v.created_at));
        versions
    }

    pub fn read_memo_version(&self, memo_id: &str, version_id: &str) -> Option<String> {
        if !is_safe_memo_id(memo_id) || !is_safe_version_id(version_id) {
            return None;
        }
        let manifest = self.read_version_manifest(memo_id);
        if !manifest.versions.iter().any(|v| v.id == version_id) {
            return None;
        }
        fs::read_to_string(
            self.versions_root_for_memo(memo_id)
                .join(memo_id)
                .join(format!("{version_id}.md")),
        )
        .ok()
    }

    pub fn create_memo_version(
        &self,
        memo_id: &str,
        content: &str,
        source: MemoVersionSource,
    ) -> std::io::Result<Option<MemoVersionMeta>> {
        if !is_safe_memo_id(memo_id) {
            return Ok(None);
        }
        let memo = match self.read_memo_global(memo_id) {
            Some(memo) => memo,
            None => return Ok(None),
        };
        let mut manifest = self.read_version_manifest(memo_id);
        let content_hash = sha256_hex(content);

        if manifest
            .versions
            .iter()
            .any(|version| version.content_hash == content_hash)
        {
            return Ok(None);
        }

        let now = chrono::Utc::now().timestamp_millis();
        let version_id = format!(
            "v_{}_{}",
            chrono::Utc::now().format("%Y%m%d_%H%M%S"),
            nanoid::nanoid!(6, &super::MEMO_ID_ALPHABET)
        );
        let meta = MemoVersionMeta {
            id: version_id.clone(),
            memo_id: memo_id.to_string(),
            created_at: now,
            source,
            filename: memo.filename.clone(),
            title: memo
                .filename
                .strip_suffix(".md")
                .unwrap_or(&memo.filename)
                .to_string(),
            size: content.len() as u64,
            content_hash,
        };

        fs::create_dir_all(self.memo_versions_dir(memo_id))?;
        atomic_write_bytes(
            &self.memo_version_path(memo_id, &version_id),
            content.as_bytes(),
        )?;

        manifest.versions.push(meta.clone());
        self.prune_memo_versions(memo_id, &mut manifest)?;
        self.write_version_manifest(memo_id, &manifest)?;
        Ok(Some(meta))
    }

    pub fn maybe_create_auto_memo_version(
        &self,
        memo_id: &str,
        content: &str,
    ) -> std::io::Result<Option<MemoVersionMeta>> {
        if !is_safe_memo_id(memo_id) {
            return Ok(None);
        }
        let manifest = self.read_version_manifest(memo_id);
        let now = chrono::Utc::now().timestamp_millis();
        let last_auto = manifest
            .versions
            .iter()
            .filter(|version| version.source == MemoVersionSource::Auto)
            .max_by_key(|version| version.created_at);

        if let Some(last_auto) = last_auto {
            if now - last_auto.created_at < MEMO_AUTO_VERSION_INTERVAL_MS {
                return Ok(None);
            }
        }

        self.create_memo_version(memo_id, content, MemoVersionSource::Auto)
    }

    pub fn delete_memo_version(&self, memo_id: &str, version_id: &str) -> bool {
        if !is_safe_memo_id(memo_id) || !is_safe_version_id(version_id) {
            return false;
        }
        let mut manifest = self.read_version_manifest(memo_id);
        let before = manifest.versions.len();
        manifest.versions.retain(|version| version.id != version_id);
        if manifest.versions.len() == before {
            return false;
        }
        let path = self
            .versions_root_for_memo(memo_id)
            .join(memo_id)
            .join(format!("{version_id}.md"));
        if path.exists() && fs::remove_file(path).is_err() {
            return false;
        }
        if self.write_version_manifest(memo_id, &manifest).is_err() {
            return false;
        }
        if manifest.versions.is_empty() {
            let _ = fs::remove_file(self.memo_versions_manifest_path(memo_id));
            let _ = fs::remove_dir(self.memo_versions_dir(memo_id));
        }
        true
    }

    fn prune_memo_versions(
        &self,
        memo_id: &str,
        manifest: &mut MemoVersionManifest,
    ) -> std::io::Result<()> {
        manifest.versions.sort_by_key(|version| version.created_at);
        while manifest.versions.len() > MEMO_VERSION_LIMIT {
            let removed = manifest.versions.remove(0);
            let _ = fs::remove_file(self.memo_version_path(memo_id, &removed.id));
        }
        Ok(())
    }
}

fn is_safe_memo_id(value: &str) -> bool {
    // Six-character IDs are accepted for pre-v3 histories; new IDs use eight.
    matches!(value.len(), 6 | super::MEMO_ID_LENGTH)
        && value
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
}

fn is_safe_version_id(value: &str) -> bool {
    (3..=128).contains(&value.len())
        && value.starts_with("v_")
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
}

fn is_older_than(path: &Path, now: SystemTime, retention: Duration) -> bool {
    let modified = fs::read_to_string(path.join("manifest.json"))
        .ok()
        .and_then(|content| serde_json::from_str::<MemoVersionManifest>(&content).ok())
        .and_then(|manifest| {
            manifest
                .versions
                .iter()
                .map(|version| version.created_at)
                .max()
        })
        .and_then(|millis| {
            if millis < 0 {
                return None;
            }
            SystemTime::UNIX_EPOCH.checked_add(Duration::from_millis(millis as u64))
        })
        .or_else(|| fs::metadata(path).and_then(|meta| meta.modified()).ok())
        .unwrap_or(now);
    now.duration_since(modified).unwrap_or_default() >= retention
}

fn sha256_hex(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod path_version_tests {
    use super::*;
    use crate::memo_file::NotebookConfig;

    #[test]
    fn cloud_conflict_versions_use_path_history_and_survive_ordinary_pruning() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notebook");
        fs::create_dir_all(root.join("attachments")).unwrap();
        fs::write(root.join("Note.md"), "current").unwrap();
        fs::write(root.join("Extra.MARKDOWN"), "current").unwrap();
        fs::write(root.join("attachments/image.png"), [0, 1, 2]).unwrap();
        let store = MemoFile::new(temp.path().join("config"));
        store.write_notebook_configs(&[NotebookConfig {
            id: "work".into(), name: "Work".into(), icon: None,
            path: root.to_string_lossy().to_string(), is_default: true,
            sort: 0, created_at: 1, updated_at: 1,
        }]).unwrap();
        let rejected = store.create_path_version_bytes(
            "work", "Note.md", b"offline edit", MemoVersionSource::CloudConflict,
        ).unwrap().unwrap();
        let manual = store.create_path_version(
            "work", "Note.md", "shared", MemoVersionSource::Manual,
        ).unwrap().unwrap();
        let promoted = store.create_path_version_bytes(
            "work", "Note.md", b"shared", MemoVersionSource::CloudConflict,
        ).unwrap().unwrap();
        assert_eq!(promoted.id, manual.id);
        assert_eq!(promoted.source, MemoVersionSource::CloudConflict);
        let repeated = store.create_path_version_bytes(
            "work", "Note.md", b"offline edit", MemoVersionSource::CloudConflict,
        ).unwrap();
        assert!(repeated.is_none());
        assert_eq!(store.read_path_version("work", "Note.md", &rejected.id).as_deref(), Some("offline edit"));
        let markdown = store.create_path_version_bytes(
            "work", "Extra.MARKDOWN", b"offline markdown", MemoVersionSource::CloudConflict,
        ).unwrap().unwrap();
        assert_eq!(store.read_path_version("work", "Extra.MARKDOWN", &markdown.id).as_deref(), Some("offline markdown"));
        let attachment = store.create_path_version_bytes(
            "work", "attachments/image.png", &[3, 4, 5], MemoVersionSource::CloudConflict,
        ).unwrap().unwrap();
        assert!(store.list_path_versions("work", "attachments/image.png")
            .iter().any(|version| version.id == attachment.id));
        assert_eq!(store.read_path_version_bytes("work", "attachments/image.png", &attachment.id), Some(vec![3, 4, 5]));
        let attachment_archive = store.path_archive_location("work", "attachments/image.png").unwrap();
        fs::write(attachment_archive.join(format!("{}.bin", attachment.id)), b"corrupt").unwrap();
        assert!(store.read_path_version_bytes("work", "attachments/image.png", &attachment.id).is_none());
        for index in 0..=MEMO_VERSION_LIMIT {
            store.create_path_version(
                "work", "Note.md", &format!("ordinary {index}"), MemoVersionSource::Manual,
            ).unwrap();
        }
        assert!(store.list_path_versions("work", "Note.md")
            .iter().any(|version| version.id == rejected.id));
        fs::remove_file(root.join("Note.md")).unwrap();
        assert_eq!(store.read_path_version("work", "Note.md", &rejected.id).as_deref(), Some("offline edit"));
        assert!(store.list_path_archives().iter().any(|entry| entry.relative_path == "Note.md"));
    }

    #[test]
    fn archives_markdown_by_notebook_and_relative_path_without_memo_id() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notebook");
        fs::create_dir_all(root.join("Projects")).unwrap();
        fs::write(root.join("Projects/Plan.md"), "# Plan").unwrap();
        let store = MemoFile::new(temp.path().join("config"));
        store
            .write_notebook_configs(&[NotebookConfig {
                id: "work".into(),
                name: "Work".into(),
                icon: None,
                path: root.to_string_lossy().to_string(),
                is_default: true,
                sort: 0,
                created_at: 1,
                updated_at: 1,
            }])
            .unwrap();
        let version = store
            .create_path_version(
                "work",
                "Projects/Plan.md",
                "# Plan",
                MemoVersionSource::Manual,
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            store.list_path_versions("work", "Projects/Plan.md").len(),
            1
        );
        assert_eq!(
            store
                .read_path_version("work", "Projects/Plan.md", &version.id)
                .as_deref(),
            Some("# Plan")
        );
        assert!(store
            .create_path_version("work", "../Plan.md", "bad", MemoVersionSource::Manual)
            .unwrap()
            .is_none());
        assert!(root.join(".flowix/archives").is_dir());
        let renamed = store
            .rename_note_by_path("work", "Projects/Plan.md", "Renamed", None)
            .unwrap();
        assert_eq!(renamed, "Projects/Renamed.md");
        assert!(store
            .list_path_versions("work", "Projects/Plan.md")
            .is_empty());
        assert_eq!(
            store
                .read_path_version("work", &renamed, &version.id)
                .as_deref(),
            Some("# Plan")
        );
    }
}
