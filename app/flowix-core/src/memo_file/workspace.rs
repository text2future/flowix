//! Device-local notebook repository attachments. JSON files are upgrade inputs only.
use super::notebook::sqlite_to_io;
use super::{MemoFile, NotebookConfig};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::Path};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotebookAddDir {
    pub id: String,
    pub path: String,
    pub label: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub missing: bool,
}
fn default_enabled() -> bool {
    true
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookWorkspaceConfig {
    #[serde(default = "config_version")]
    pub version: u32,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub add_dirs: Vec<NotebookAddDir>,
}
fn config_version() -> u32 {
    1
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookWorkspaceSnapshot {
    pub notebooks: Vec<NotebookConfig>,
    pub notebook_configs: HashMap<String, NotebookWorkspaceConfig>,
}

// A failed SQLite commit must not leave a newly selected folder claiming the
// notebook identity. Existing manifests are never rewritten by the save.
struct PendingNotebookManifest {
    file: Option<(std::path::PathBuf, Option<Vec<u8>>)>,
}
impl Drop for PendingNotebookManifest {
    fn drop(&mut self) {
        if let Some((path, previous)) = self.file.take() {
            let result = match previous {
                Some(bytes) => super::file_io::atomic_write_bytes(&path, &bytes),
                None => fs::remove_file(&path),
            };
            if let Err(error) = result {
                tracing::warn!(%error, path = %path.display(), "could not restore uncommitted notebook manifest");
            }
        }
    }
}

impl MemoFile {
    pub(super) fn workspace_connection(&self) -> std::io::Result<rusqlite::Connection> {
        let conn = self.open_registry_db()?;
        conn.execute_batch("CREATE TABLE IF NOT EXISTS notebook_workspace_state (
            notebook_id TEXT PRIMARY KEY REFERENCES notebooks(id) ON DELETE CASCADE,
            revision INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS notebook_add_dirs (
            id TEXT NOT NULL, notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
            path TEXT NOT NULL, path_key TEXT NOT NULL, label TEXT NOT NULL, enabled INTEGER NOT NULL,
            sort INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            PRIMARY KEY(notebook_id,id), UNIQUE(notebook_id,path_key));").map_err(sqlite_to_io)?;
        Ok(conn)
    }

    /// Import legacy notebook folder defaults into the authoritative SQLite
    /// workspace tables. The caller records this as a one-time startup job.
    /// `_global` applies to notebooks that already exist when the job runs;
    /// notebooks created later do not inherit stale global defaults.
    pub fn migrate_legacy_agent_workspace(&self) -> std::io::Result<usize> {
        let legacy = self.read_legacy_agent_access()?;
        let Some(files) = legacy
            .get("defaults")
            .and_then(|defaults| defaults.get("files"))
            .and_then(serde_json::Value::as_object)
        else {
            return Ok(0);
        };

        let notebooks = self.read_notebook_configs()?;
        if notebooks.is_empty() {
            return Ok(0);
        }
        if let Some(notebook) = notebooks
            .iter()
            .find(|notebook| !Path::new(&notebook.path).is_dir())
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::WouldBlock,
                format!("notebook {} is unavailable", notebook.id),
            ));
        }

        let folders_for = |key: &str| -> Vec<&str> {
            files
                .get(key)
                .and_then(|config| config.get("folders"))
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .collect()
        };
        let global_folders = folders_for("_global");
        let mut conn = self.workspace_connection()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_to_io)?;
        let now = chrono::Utc::now().timestamp_millis();
        let mut imported = 0usize;

        for notebook in &notebooks {
            let mut notebook_imported = 0usize;
            for path in folders_for(&notebook.id)
                .into_iter()
                .chain(global_folders.iter().copied())
            {
                if validate_add_dir(&notebook.path, path, false).is_err() {
                    tracing::warn!(notebook_id = %notebook.id, path, "skipping invalid legacy Agent folder default");
                    continue;
                }
                let normalized = normalized_directory(path);
                let stored_path = normalized.to_string_lossy();
                let path_key = directory_key(path);
                let label = normalized
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy();
                notebook_imported += tx
                    .execute(
                        "INSERT OR IGNORE INTO notebook_add_dirs \
                         (id,notebook_id,path,path_key,label,enabled,sort,created_at,updated_at) \
                         VALUES (?1,?2,?3,?4,?5,1,\
                           COALESCE((SELECT MAX(sort)+1 FROM notebook_add_dirs WHERE notebook_id=?2),0),?6,?6)",
                        params![
                            uuid::Uuid::new_v4().to_string(),
                            notebook.id,
                            stored_path,
                            path_key,
                            label,
                            now
                        ],
                    )
                    .map_err(sqlite_to_io)?;
            }
            if notebook_imported > 0 {
                tx.execute(
                    "INSERT INTO notebook_workspace_state VALUES (?1,1) \
                     ON CONFLICT(notebook_id) DO UPDATE SET revision=revision+1",
                    [&notebook.id],
                )
                .map_err(sqlite_to_io)?;
                imported += notebook_imported;
            }
        }

        tx.commit().map_err(sqlite_to_io)?;
        Ok(imported)
    }

    fn read_legacy_agent_access(&self) -> std::io::Result<serde_json::Value> {
        let path = self.registry.config_dir.join("agent-access.json");
        match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(value) => Ok(value),
                Err(_) => {
                    super::backup_storage_file(&path)?;
                    Ok(serde_json::Value::Null)
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::Value::Null),
            Err(e) => Err(e),
        }
    }
    pub fn read_notebook_workspace(&self) -> std::io::Result<NotebookWorkspaceSnapshot> {
        let notebooks = self.read_notebook_configs()?;
        let conn = self.workspace_connection()?;
        let mut notebook_configs = HashMap::new();
        for notebook in &notebooks {
            notebook_configs.insert(notebook.id.clone(), read_workspace_config(&conn, &notebook.id)?);
        }
        Ok(NotebookWorkspaceSnapshot {
            notebooks,
            notebook_configs,
        })
    }
    pub fn update_notebook_add_dir(
        &self,
        notebook_id: &str,
        path: &str,
        attach: bool,
    ) -> std::io::Result<NotebookWorkspaceSnapshot> {
        let notebook = self
            .read_notebook_configs()?
            .into_iter()
            .find(|n| n.id == notebook_id)
            .ok_or_else(|| std::io::Error::other("notebook not found"))?;
        let normalized = normalized_directory(path);
        let stored_path = normalized.to_string_lossy();
        let key = directory_key(path);
        if attach {
            validate_add_dir(&notebook.path, path, true)?;
        }
        let mut conn = self.workspace_connection()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_to_io)?;
        let now = chrono::Utc::now().timestamp_millis();
        let changed = if attach {
            let label = Path::new(path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            tx.execute("INSERT INTO notebook_add_dirs (id,notebook_id,path,path_key,label,enabled,sort,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,1,COALESCE((SELECT MAX(sort)+1 FROM notebook_add_dirs WHERE notebook_id=?2),0),?6,?6) ON CONFLICT(notebook_id,path_key) DO UPDATE SET enabled=1,updated_at=excluded.updated_at WHERE enabled=0", params![uuid::Uuid::new_v4().to_string(),notebook_id,stored_path,key,label,now]).map_err(sqlite_to_io)?
        } else {
            // Exact stored paths also allow removing a missing symlink after its target disappeared.
            tx.execute(
                "DELETE FROM notebook_add_dirs WHERE notebook_id=?1 AND (path_key=?2 OR path=?3)",
                params![notebook_id, key, path],
            )
            .map_err(sqlite_to_io)?
        };
        if changed > 0 {
            tx.execute("INSERT INTO notebook_workspace_state VALUES (?1,1) ON CONFLICT(notebook_id) DO UPDATE SET revision=revision+1",[notebook_id]).map_err(sqlite_to_io)?;
        }
        tx.commit().map_err(sqlite_to_io)?;
        self.read_notebook_workspace()
    }

    /// Compatibility entry point; use the same validation and transaction as
    /// the complete settings form.
    pub fn set_notebook_primary_directory(
        &self,
        notebook_id: &str,
        path: &str,
    ) -> std::io::Result<NotebookConfig> {
        let snapshot = self.read_notebook_workspace()?;
        let notebook = snapshot
            .notebooks
            .iter()
            .find(|item| item.id == notebook_id)
            .ok_or_else(|| std::io::Error::other("NOTEBOOK_NOT_FOUND"))?;
        let expected = snapshot.notebook_configs[notebook_id]
            .add_dirs
            .iter()
            .filter(|item| item.enabled && !item.missing)
            .map(|item| item.path.clone())
            .collect::<Vec<_>>();
        let mut desired = expected
            .iter()
            .filter(|item| directory_key(item) != directory_key(path))
            .cloned()
            .collect::<Vec<_>>();
        if directory_key(&notebook.path) != directory_key(path)
            && Path::new(&notebook.path).is_dir()
        {
            desired.push(notebook.path.clone());
        }
        self.save_notebook_settings(
            notebook_id,
            &notebook.name,
            notebook.icon.clone(),
            path,
            &desired,
            &notebook.path,
            &expected,
        )
        .map(|(notebook, _)| notebook)
    }

    /// Save the local notebook form as one transaction. Hidden/unavailable
    /// attachments are preserved; only the displayed baseline may be removed.
    pub fn save_notebook_settings(
        &self,
        notebook_id: &str,
        name: &str,
        icon: Option<String>,
        primary_path: &str,
        repository_paths: &[String],
        expected_primary_path: &str,
        expected_repository_paths: &[String],
    ) -> std::io::Result<(NotebookConfig, NotebookWorkspaceSnapshot)> {
        if name.trim().is_empty() || !Path::new(primary_path).is_absolute() {
            return Err(std::io::Error::other("INVALID_NOTEBOOK_SETTINGS"));
        }
        let mut snapshot = self.read_notebook_workspace()?;
        let configs = snapshot.notebooks.clone();
        let mut updated = configs
            .iter()
            .find(|item| item.id == notebook_id)
            .cloned()
            .ok_or_else(|| std::io::Error::other("NOTEBOOK_NOT_FOUND"))?;
        let primary_changed = directory_key(&updated.path) != directory_key(primary_path);
        let primary = if primary_changed {
            let target = dunce::canonicalize(primary_path)?;
            if !target.is_dir() {
                return Err(std::io::Error::other("PRIMARY_DIRECTORY_UNAVAILABLE"));
            }
            let old = normalized_directory(&updated.path);
            if target.starts_with(&old) || old.starts_with(&target) {
                return Err(std::io::Error::other("PRIMARY_DIRECTORY_OVERLAP"));
            }
            target.to_string_lossy().into_owned()
        } else {
            updated.path.clone()
        };
        let primary_key = directory_key(&primary);
        if configs
            .iter()
            .any(|item| item.id != notebook_id && directory_key(&item.path) == primary_key)
        {
            return Err(std::io::Error::other(
                "PRIMARY_DIRECTORY_ALREADY_REGISTERED",
            ));
        }
        let mut desired = std::collections::BTreeMap::new();
        for path in repository_paths {
            if primary_changed
                && directory_key(path) == directory_key(&updated.path)
                && !Path::new(path).is_dir()
            {
                continue;
            }
            validate_add_dir(&primary, path, true)?;
            desired.insert(directory_key(path), normalized_directory(path));
        }
        let expected: std::collections::BTreeSet<_> = expected_repository_paths
            .iter()
            .map(|path| directory_key(path))
            .collect();
        let mut conn = self.workspace_connection()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_to_io)?;
        let current_path: String = tx
            .query_row(
                "SELECT path FROM notebooks WHERE id=?1",
                [notebook_id],
                |row| row.get(0),
            )
            .map_err(sqlite_to_io)?;
        let current = {
            let mut stmt = tx
                .prepare("SELECT path FROM notebook_add_dirs WHERE notebook_id=?1 AND enabled=1")
                .map_err(sqlite_to_io)?;
            let paths = stmt
                .query_map([notebook_id], |row| row.get::<_, String>(0))
                .map_err(sqlite_to_io)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_to_io)?;
            paths
                .into_iter()
                .filter(|path| Path::new(path).is_dir())
                .map(|path| directory_key(&path))
                .collect::<std::collections::BTreeSet<_>>()
        };
        if directory_key(&current_path) != directory_key(expected_primary_path)
            || current != expected
        {
            return Err(std::io::Error::other("NOTEBOOK_SETTINGS_CONFLICT"));
        }
        updated.path = primary;
        updated.name = name.trim().to_string();
        updated.icon = icon;
        updated.updated_at = chrono::Utc::now().timestamp_millis();
        let manifest_path = Path::new(&updated.path).join(".flowix/notebook.json");
        let needs_manifest = Path::new(&updated.path).is_dir()
            && Self::read_notebook_manifest(Path::new(&updated.path))?.is_none();
        let previous_manifest = if needs_manifest {
            match fs::read(&manifest_path) {
                Ok(bytes) => Some(bytes),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error),
            }
        } else {
            None
        };
        if Path::new(&updated.path).is_dir() {
            Self::ensure_notebook_manifest(&updated)?;
        }
        let mut pending_manifest = PendingNotebookManifest {
            file: needs_manifest.then_some((manifest_path, previous_manifest)),
        };
        tx.execute(
            "UPDATE notebooks SET name=?1,icon=?2,path=?3,updated_at=?4 WHERE id=?5",
            params![
                updated.name,
                updated.icon,
                updated.path,
                updated.updated_at,
                notebook_id
            ],
        )
        .map_err(sqlite_to_io)?;
        for key in &expected {
            if !desired.contains_key(key) {
                tx.execute(
                    "DELETE FROM notebook_add_dirs WHERE notebook_id=?1 AND path_key=?2",
                    params![notebook_id, key],
                )
                .map_err(sqlite_to_io)?;
            }
        }
        tx.execute(
            "DELETE FROM notebook_add_dirs WHERE notebook_id=?1 AND path_key=?2",
            params![notebook_id, primary_key],
        )
        .map_err(sqlite_to_io)?;
        for (key, path) in desired {
            let id = uuid::Uuid::new_v4().to_string();
            let label = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            tx.execute(
                "INSERT INTO notebook_add_dirs (id,notebook_id,path,path_key,label,enabled,sort,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,?5,1,COALESCE((SELECT MAX(sort)+1 FROM notebook_add_dirs WHERE notebook_id=?2),0),?6,?6)
                 ON CONFLICT(notebook_id,path_key) DO UPDATE SET enabled=1,updated_at=excluded.updated_at",
                params![id, notebook_id, path.to_string_lossy(), key, label, updated.updated_at],
            ).map_err(sqlite_to_io)?;
        }
        snapshot
            .notebooks
            .iter_mut()
            .filter(|item| item.id == notebook_id)
            .for_each(|item| *item = updated.clone());
        tx.execute("INSERT INTO notebook_workspace_state VALUES (?1,1) ON CONFLICT(notebook_id) DO UPDATE SET revision=revision+1", [notebook_id])
            .map_err(sqlite_to_io)?;
        snapshot.notebook_configs.insert(
            notebook_id.to_string(),
            read_workspace_config(&tx, notebook_id)?,
        );
        tx.commit().map_err(sqlite_to_io)?;
        pending_manifest.file = None;
        *self
            .registry
            .configs_cache
            .write()
            .expect("notebook_configs_cache poisoned") = Some(snapshot.notebooks.clone());
        Ok((updated, snapshot))
    }

    pub fn attached_directory_paths(&self) -> std::io::Result<Vec<std::path::PathBuf>> {
        let conn = self.workspace_connection()?;
        let mut stmt = conn
            .prepare("SELECT DISTINCT path FROM notebook_add_dirs WHERE enabled=1")
            .map_err(sqlite_to_io)?;
        let paths = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(sqlite_to_io)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_to_io)?;
        Ok(paths
            .into_iter()
            .map(std::path::PathBuf::from)
            .filter(|path| path.is_dir())
            .collect())
    }
}
fn read_workspace_config(
    conn: &rusqlite::Connection,
    notebook_id: &str,
) -> std::io::Result<NotebookWorkspaceConfig> {
    let revision = conn
        .query_row(
            "SELECT revision FROM notebook_workspace_state WHERE notebook_id=?1",
            [notebook_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(sqlite_to_io)?
        .unwrap_or(0);
    let mut stmt = conn.prepare("SELECT id,path,label,enabled FROM notebook_add_dirs WHERE notebook_id=?1 ORDER BY sort,id").map_err(sqlite_to_io)?;
    let add_dirs = stmt
        .query_map([notebook_id], |r| {
            let path: String = r.get(1)?;
            let missing = !Path::new(&path).is_dir();
            Ok(NotebookAddDir {
                id: r.get(0)?,
                path,
                label: r.get(2)?,
                enabled: r.get(3)?,
                missing,
            })
        })
        .map_err(sqlite_to_io)?
        .collect::<Result<_, _>>()
        .map_err(sqlite_to_io)?;
    Ok(NotebookWorkspaceConfig {
        version: 1,
        revision,
        add_dirs,
    })
}

fn normalized_directory(path: &str) -> std::path::PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| {
        let mut normalized = std::path::PathBuf::new();
        for component in Path::new(path).components() {
            match component {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    normalized.pop();
                }
                other => normalized.push(other.as_os_str()),
            }
        }
        normalized
    })
}
fn directory_key(path: &str) -> String {
    let key = normalized_directory(path).to_string_lossy().into_owned();
    #[cfg(target_os = "windows")]
    let key = key.to_lowercase();
    key
}
fn validate_add_dir(notebook: &str, path: &str, require_exists: bool) -> std::io::Result<()> {
    if !Path::new(path).is_absolute() || (require_exists && !Path::new(path).is_dir()) {
        return Err(std::io::Error::other("add-dir is unavailable"));
    }
    let root = normalized_directory(notebook);
    let target = normalized_directory(path);
    if root.starts_with(&target) || target.starts_with(root.join(".flowix")) {
        return Err(std::io::Error::other("invalid notebook add-dir scope"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, MemoFile, NotebookConfig) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notes");
        fs::create_dir(&root).unwrap();
        let memo = MemoFile::new(temp.path().join("config"));
        let notebook = NotebookConfig {
            id: "one".into(),
            name: "One".into(),
            icon: None,
            path: root.to_string_lossy().into(),
            is_default: true,
            sort: 0,
            created_at: 1,
            updated_at: 1,
        };
        memo.write_notebook_configs(std::slice::from_ref(&notebook))
            .unwrap();
        (temp, memo, notebook)
    }
    #[test]
    fn settings_commit_primary_metadata_and_repository_snapshot_together() {
        let (temp, memo, original) = fixture();
        let repo = temp.path().join("repo");
        let added = temp.path().join("added");
        fs::create_dir(&repo).unwrap();
        fs::create_dir(&added).unwrap();
        memo.update_notebook_add_dir(&original.id, repo.to_str().unwrap(), true)
            .unwrap();
        let expected = vec![repo.to_string_lossy().into_owned()];
        let desired = vec![original.path.clone(), added.to_string_lossy().into_owned()];
        let (updated, snapshot) = memo
            .save_notebook_settings(
                &original.id,
                "Renamed",
                Some("icon".into()),
                repo.to_str().unwrap(),
                &desired,
                &original.path,
                &expected,
            )
            .unwrap();
        assert_eq!(updated.name, "Renamed");
        assert_eq!(
            directory_key(&updated.path),
            directory_key(repo.to_str().unwrap())
        );
        assert_eq!(updated.icon.as_deref(), Some("icon"));
        let persisted = memo.read_notebook_workspace().unwrap();
        let paths = |value: &NotebookWorkspaceSnapshot| {
            value.notebook_configs[&original.id]
                .add_dirs
                .iter()
                .map(|item| directory_key(&item.path))
                .collect::<std::collections::BTreeSet<_>>()
        };
        assert_eq!(paths(&snapshot), paths(&persisted));
        assert_eq!(
            paths(&snapshot),
            desired.iter().map(|path| directory_key(path)).collect()
        );
        assert_eq!(
            snapshot.notebook_configs[&original.id].revision,
            persisted.notebook_configs[&original.id].revision
        );
    }

    #[test]
    fn settings_database_failure_rolls_back_root_metadata_and_repositories() {
        let (temp, memo, original) = fixture();
        let repo = temp.path().join("repo");
        fs::create_dir(&repo).unwrap();
        memo.update_notebook_add_dir(&original.id, repo.to_str().unwrap(), true)
            .unwrap();
        memo.workspace_connection().unwrap().execute_batch(
            "CREATE TRIGGER reject_settings_insert BEFORE INSERT ON notebook_add_dirs BEGIN SELECT RAISE(ABORT, 'injected failure'); END;"
        ).unwrap();
        let result = memo.save_notebook_settings(
            &original.id,
            "Must roll back",
            None,
            repo.to_str().unwrap(),
            &[original.path.clone()],
            &original.path,
            &[repo.to_string_lossy().into_owned()],
        );
        assert!(result.is_err());
        assert!(!repo.join(".flowix/notebook.json").exists());
        let stored = memo.read_notebook_workspace().unwrap();
        assert_eq!(stored.notebooks[0].name, original.name);
        assert_eq!(stored.notebooks[0].path, original.path);
        assert_eq!(stored.notebook_configs[&original.id].add_dirs.len(), 1);
        assert_eq!(
            directory_key(&stored.notebook_configs[&original.id].add_dirs[0].path),
            directory_key(repo.to_str().unwrap())
        );
    }

    #[test]
    fn settings_reject_stale_repository_baseline_without_removing_concurrent_addition() {
        let (temp, memo, original) = fixture();
        let repo = temp.path().join("concurrent");
        fs::create_dir(&repo).unwrap();
        memo.update_notebook_add_dir(&original.id, repo.to_str().unwrap(), true)
            .unwrap();
        let result = memo.save_notebook_settings(
            &original.id,
            "Stale edit",
            None,
            &original.path,
            &[],
            &original.path,
            &[],
        );
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("NOTEBOOK_SETTINGS_CONFLICT"));
        let stored = memo.read_notebook_workspace().unwrap();
        assert_eq!(stored.notebooks[0].name, original.name);
        assert_eq!(stored.notebook_configs[&original.id].add_dirs.len(), 1);
    }

    #[test]
    fn metadata_save_preserves_unavailable_attachments_and_does_not_recreate_missing_root() {
        let (temp, memo, original) = fixture();
        let repo = temp.path().join("offline-repository");
        fs::create_dir(&repo).unwrap();
        memo.update_notebook_add_dir(&original.id, repo.to_str().unwrap(), true)
            .unwrap();
        fs::remove_dir(&repo).unwrap();
        fs::remove_dir_all(&original.path).unwrap();
        let (updated, snapshot) = memo
            .save_notebook_settings(
                &original.id,
                "Offline rename",
                None,
                &original.path,
                &[],
                &original.path,
                &[],
            )
            .unwrap();
        assert_eq!(updated.name, "Offline rename");
        assert!(!Path::new(&original.path).exists());
        assert_eq!(snapshot.notebook_configs[&original.id].add_dirs.len(), 1);
        assert!(snapshot.notebook_configs[&original.id].add_dirs[0].missing);
        assert_eq!(
            memo.read_notebook_workspace().unwrap().notebook_configs[&original.id]
                .add_dirs
                .len(),
            1
        );
    }

    #[test]
    fn settings_reject_parent_child_primary_switches_before_writing() {
        let (temp, memo, original) = fixture();
        let child = Path::new(&original.path).join("child");
        fs::create_dir(&child).unwrap();
        for target in [child.as_path(), temp.path()] {
            let result = memo.save_notebook_settings(
                &original.id,
                "Invalid",
                None,
                target.to_str().unwrap(),
                &[],
                &original.path,
                &[],
            );
            assert!(result
                .unwrap_err()
                .to_string()
                .contains("PRIMARY_DIRECTORY_OVERLAP"));
        }
        assert_eq!(memo.read_notebook_configs().unwrap()[0].path, original.path);
    }

    #[test]
    fn workspace_mounts_are_read_from_sqlite_not_legacy_json() {
        let (temp, memo, notebook) = fixture();
        let repo = temp.path().join("repo");
        fs::create_dir(&repo).unwrap();
        let missing = temp.path().join("missing");
        let source = Path::new(&notebook.path).join(".flowix/agent.json");
        fs::write(
            &source,
            serde_json::json!({"version":1,"revision":4,"addDirs":[
                {"id":"repo","path":repo,"label":"Repo","enabled":true},
                {"id":"missing","path":missing,"label":"Missing","enabled":true}
            ]})
            .to_string(),
        )
        .unwrap();
        fs::write(
            temp.path().join("config/agent-access.json"),
            r#"{"entries":[{"kind":"folder","path":"/orphan","enabled":true}]}"#,
        )
        .unwrap();
        let initial = memo.read_notebook_workspace().unwrap();
        assert!(initial.notebook_configs["one"].add_dirs.is_empty());
        assert_eq!(memo.migrate_legacy_agent_workspace().unwrap(), 0);
        assert!(memo.attached_directory_paths().unwrap().is_empty());

        memo.update_notebook_add_dir("one", repo.to_str().unwrap(), true)
            .unwrap();
        assert_eq!(
            memo.attached_directory_paths().unwrap(),
            vec![dunce::canonicalize(&repo).unwrap()]
        );
        memo.update_notebook_add_dir("one", repo.to_str().unwrap(), false)
            .unwrap();
        fs::write(&source, "invalid JSON").unwrap();
        assert_eq!(
            memo.read_notebook_workspace().unwrap().notebook_configs["one"]
                .add_dirs
                .len(),
            0
        );
        assert!(memo.attached_directory_paths().unwrap().is_empty());
    }
    #[test]
    fn shares_paths_across_notebooks_and_cascades_deleted_notebook_mounts() {
        let (temp, memo, one) = fixture();
        let mut two = one.clone();
        two.id = "two".into();
        two.path = temp.path().join("two").to_string_lossy().into();
        fs::create_dir(&two.path).unwrap();
        memo.write_notebook_configs(&[one.clone(), two.clone()])
            .unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir(&repo).unwrap();
        for id in ["one", "two"] {
            memo.update_notebook_add_dir(id, repo.to_str().unwrap(), true)
                .unwrap();
        }
        memo.update_notebook_add_dir("one", repo.to_str().unwrap(), true)
            .unwrap();
        assert_eq!(
            memo.read_notebook_workspace().unwrap().notebook_configs["one"]
                .add_dirs
                .len(),
            1
        );
        memo.write_notebook_configs(&[two]).unwrap();
        let conn = memo.workspace_connection().unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM notebook_add_dirs", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            memo.attached_directory_paths().unwrap(),
            vec![dunce::canonicalize(&repo).unwrap()]
        );
    }
    #[test]
    fn legacy_notebook_file_defaults_are_imported_once_for_existing_notebooks() {
        let (temp, memo, notebook) = fixture();
        let repo = temp.path().join("repo");
        fs::create_dir(&repo).unwrap();
        fs::write(
            temp.path().join("config/agent-access.json"),
            serde_json::json!({"defaults":{"files":{"one":{"folders":[repo]}}}}).to_string(),
        )
        .unwrap();
        assert_eq!(memo.migrate_legacy_agent_workspace().unwrap(), 1);
        assert_eq!(memo.migrate_legacy_agent_workspace().unwrap(), 0);
        let imported = memo.read_notebook_workspace().unwrap();
        assert_eq!(imported.notebook_configs["one"].add_dirs.len(), 1);
        assert_eq!(
            imported.notebook_configs["one"].add_dirs[0].path,
            dunce::canonicalize(&repo).unwrap().to_string_lossy()
        );
        let mut new_notebook = notebook.clone();
        new_notebook.id = "two".into();
        new_notebook.name = "Two".into();
        new_notebook.path = temp.path().join("two").to_string_lossy().into();
        fs::create_dir(&new_notebook.path).unwrap();
        memo.write_notebook_configs(&[notebook, new_notebook]).unwrap();
        let after_new_notebook = memo.read_notebook_workspace().unwrap();
        assert!(after_new_notebook.notebook_configs["two"].add_dirs.is_empty());
        assert!(memo
            .update_notebook_add_dir("one", temp.path().to_str().unwrap(), true)
            .is_err());
    }

    #[test]
    fn legacy_workspace_migration_defers_until_registered_notebooks_are_available() {
        let (temp, memo, notebook) = fixture();
        let repo = temp.path().join("repo");
        fs::create_dir(&repo).unwrap();
        fs::write(
            temp.path().join("config/agent-access.json"),
            serde_json::json!({"defaults":{"files":{"one":{"folders":[repo]}}}}).to_string(),
        )
        .unwrap();

        let parked = temp.path().join("parked-notebook");
        fs::rename(&notebook.path, &parked).unwrap();
        let error = memo.migrate_legacy_agent_workspace().unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
        assert!(memo.attached_directory_paths().unwrap().is_empty());

        fs::rename(&parked, &notebook.path).unwrap();
        assert_eq!(memo.migrate_legacy_agent_workspace().unwrap(), 1);
        assert_eq!(memo.read_notebook_workspace().unwrap().notebook_configs["one"].add_dirs.len(), 1);
    }

    #[test]
    fn invalid_legacy_agent_access_is_backed_up_without_workspace_defaults() {
        let (temp, memo, _notebook) = fixture();
        let source = temp.path().join("config/agent-access.json");
        fs::write(&source, "broken").unwrap();

        assert_eq!(memo.migrate_legacy_agent_workspace().unwrap(), 0);
        assert!(!source.exists());
        let backup_dir = temp.path().join("config/rebuild-backups");
        let backups = fs::read_dir(backup_dir).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(backups.len(), 1);
        assert!(backups[0].path().join("agent-access.json").is_file());
        assert!(memo.read_notebook_workspace().is_ok());
    }
}

#[cfg(test)]
mod concurrency_tests {
    use super::*;
    #[test]
    fn concurrent_process_connections_preserve_independent_mounts() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("config");
        let notes = temp.path().join("notes");
        fs::create_dir(&notes).unwrap();
        let memo = MemoFile::new(config.clone());
        memo.write_notebook_configs(&[NotebookConfig {
            id: "one".into(),
            name: "One".into(),
            icon: None,
            path: notes.to_string_lossy().into(),
            is_default: true,
            sort: 0,
            created_at: 1,
            updated_at: 1,
        }])
        .unwrap();
        memo.read_notebook_workspace().unwrap();
        let paths: Vec<_> = (0..4)
            .map(|i| {
                let p = temp.path().join(format!("repo{i}"));
                fs::create_dir(&p).unwrap();
                p
            })
            .collect();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(paths.len()));
        let threads: Vec<_> = paths
            .iter()
            .cloned()
            .map(|path| {
                let config = config.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let memo = MemoFile::new(config);
                    barrier.wait();
                    memo.update_notebook_add_dir("one", path.to_str().unwrap(), true)
                        .unwrap();
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(
            memo.read_notebook_workspace().unwrap().notebook_configs["one"]
                .add_dirs
                .len(),
            4
        );
        assert_eq!(memo.attached_directory_paths().unwrap().len(), 4);
    }
}

#[cfg(test)]
mod legacy_global_defaults_tests {
    use super::*;
    #[test]
    fn legacy_global_defaults_apply_to_notebooks_present_during_migration_only() {
        let temp = tempfile::tempdir().unwrap();
        let notes = temp.path().join("old");
        fs::create_dir(&notes).unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir(&repo).unwrap();
        let config = temp.path().join("config");
        let memo = MemoFile::new(config.clone());
        let old = NotebookConfig {
            id: "old".into(),
            name: "Old".into(),
            icon: None,
            path: notes.to_string_lossy().into(),
            is_default: true,
            sort: 0,
            created_at: 0,
            updated_at: 0,
        };
        memo.write_notebook_configs(std::slice::from_ref(&old))
            .unwrap();
        fs::write(config.join("agent-access.json"),serde_json::json!({"entries":[{"id":"old","kind":"notebook"}],"defaults":{"files":{"_global":{"folders":[repo]}}}}).to_string()).unwrap();
        assert_eq!(memo.migrate_legacy_agent_workspace().unwrap(), 1);
        assert_eq!(memo.read_notebook_workspace().unwrap().notebook_configs["old"]
            .add_dirs.len(), 1);
        let mut new = old.clone();
        new.id = "new".into();
        new.path = temp.path().join("new").to_string_lossy().into();
        fs::create_dir(&new.path).unwrap();
        memo.write_notebook_configs(&[old, new]).unwrap();
        assert!(
            memo.read_notebook_workspace().unwrap().notebook_configs["new"]
                .add_dirs
                .is_empty()
        );
    }
}
