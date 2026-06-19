use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::ops::atomic_write_bytes;
use super::MemoFile;

pub const MEMO_AUTO_VERSION_INTERVAL_MS: i64 = 60 * 60 * 1000;
pub const MEMO_VERSION_LIMIT: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoVersionSource {
    Auto,
    Manual,
    RestoreBackup,
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
        self.get_metadata_dir().join("versions")
    }

    fn memo_versions_dir(&self, memo_id: &str) -> PathBuf {
        self.versions_root().join(memo_id)
    }

    fn memo_versions_manifest_path(&self, memo_id: &str) -> PathBuf {
        self.memo_versions_dir(memo_id).join("manifest.json")
    }

    fn read_version_manifest(&self, memo_id: &str) -> MemoVersionManifest {
        let path = self.memo_versions_manifest_path(memo_id);
        let Ok(content) = fs::read_to_string(path) else {
            return MemoVersionManifest::empty(memo_id);
        };
        serde_json::from_str(&content).unwrap_or_else(|_| MemoVersionManifest::empty(memo_id))
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

    pub fn list_memo_versions(&self, memo_id: &str) -> Vec<MemoVersionMeta> {
        let mut versions = self.read_version_manifest(memo_id).versions;
        versions.sort_by_key(|v| std::cmp::Reverse(v.created_at));
        versions
    }

    pub fn read_memo_version(&self, memo_id: &str, version_id: &str) -> Option<String> {
        let manifest = self.read_version_manifest(memo_id);
        if !manifest.versions.iter().any(|v| v.id == version_id) {
            return None;
        }
        fs::read_to_string(self.memo_version_path(memo_id, version_id)).ok()
    }

    pub fn create_memo_version(
        &self,
        memo_id: &str,
        content: &str,
        source: MemoVersionSource,
    ) -> std::io::Result<Option<MemoVersionMeta>> {
        let memo = match self.read_memo(memo_id) {
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
        let mut manifest = self.read_version_manifest(memo_id);
        let before = manifest.versions.len();
        manifest.versions.retain(|version| version.id != version_id);
        if manifest.versions.len() == before {
            return false;
        }
        let _ = fs::remove_file(self.memo_version_path(memo_id, version_id));
        self.write_version_manifest(memo_id, &manifest).is_ok()
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

fn sha256_hex(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}
