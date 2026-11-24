//! Notebook settings stored as synchronized JSON, with legacy SQLite migration.
//!
//! Folder and file properties are keyed by notebook-relative paths. Unknown
//! fields are preserved to allow future versions to extend the format.

use super::{atomic_write_bytes, FileLockIntent, MemoFile};
use crate::collection::{validate_properties, CollectionProperty};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 迁移完成标记：`folder_index_meta` 里的一行，保证每个笔记本只扫一次旧文件。
const LEGACY_MIGRATION_KEY: &str = "legacy_folder_collections_migrated";
/// 旧 `.index.yaml` 的备份目录（相对 `.flowix`）。文件从用户目录里消失，但内容
/// 仍可人工找回；这是「迁属性后删除」的安全网，不参与任何读取。
const LEGACY_BACKUP_DIRECTORY: &str = "legacy-folder-index";

/// The JSON is synced as one file; concurrent edits on different devices use
/// the normal cloud conflict policy. `files` is reserved for future settings.
pub const NOTEBOOK_SETTINGS_PATH: &str = ".flowix/database/notebook_settings.json";
const JSON_MIGRATION_KEY: &str = "folder_index_json_migrated";

#[derive(Default, Serialize, Deserialize)]
struct NotebookSettings {
    #[serde(default = "settings_version")]
    schema_version: u32,
    #[serde(default)]
    folders: BTreeMap<String, FolderSettings>,
    #[serde(default)]
    files: BTreeMap<String, serde_json::Value>,
    #[serde(flatten)]
    extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct FolderSettings {
    #[serde(default)]
    properties: BTreeMap<String, CollectionProperty>,
    #[serde(default)]
    updated_at: i64,
    #[serde(flatten)]
    extra: BTreeMap<String, serde_json::Value>,
}

fn settings_version() -> u32 {
    1
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderIndexEntry {
    /// 笔记本相对路径，`''` 代表笔记本根目录。
    pub relative_path: String,
    /// 与 `collection.properties` 同构：`icon` / `banner_hidden` / `banner_image` / `subtitle`。
    pub properties: BTreeMap<String, CollectionProperty>,
    /// 毫秒时间戳。
    pub updated_at: i64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

/// 规范化文件夹相对路径。空串 = 笔记本根目录，合法。
///
/// 拒绝反斜杠、NUL、绝对路径与任何 `.` / `..` 分量。
fn normalize_folder_path(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_matches('/');
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.contains('\\') || trimmed.contains('\0') {
        return Err("INVALID_FOLDER_PATH".into());
    }
    let path = Path::new(trimmed);
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("INVALID_FOLDER_PATH".into());
    }
    Ok(path.to_string_lossy().replace('\\', "/"))
}

fn open_connection(memo: &MemoFile, notebook_id: &str) -> Result<Connection, String> {
    let path = memo
        .notebook_db_path(notebook_id)
        .map_err(|e| e.to_string())?;
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(10))
        .map_err(|e| e.to_string())?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS folder_index (
           relative_path TEXT PRIMARY KEY,
           properties_json TEXT NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS folder_index_meta (
           key TEXT PRIMARY KEY,
           value INTEGER NOT NULL
         );",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn settings_path(memo: &MemoFile, notebook_id: &str) -> Result<PathBuf, String> {
    let notebook = memo
        .get_notebook_config_by_id(notebook_id)
        .ok_or("NOTEBOOK_NOT_FOUND")?;
    Ok(Path::new(&notebook.path).join(NOTEBOOK_SETTINGS_PATH))
}

fn read_settings(path: &Path) -> std::io::Result<NotebookSettings> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(std::io::Error::other),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(NotebookSettings {
            schema_version: settings_version(),
            ..Default::default()
        }),
        Err(error) => Err(error),
    }
}

fn write_settings(path: &Path, settings: &NotebookSettings) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(settings).map_err(std::io::Error::other)?;
    atomic_write_bytes(path, &bytes)
}

impl MemoFile {
    // File locking is shared with cloud conditional writes and other processes.
    fn with_settings<T>(
        &self,
        notebook_id: &str,
        operation: impl FnOnce(&Path, &mut NotebookSettings) -> std::io::Result<T>,
    ) -> Result<T, String> {
        let path = settings_path(self, notebook_id)?;
        std::fs::create_dir_all(path.parent().ok_or("INVALID_SETTINGS_PATH")?)
            .map_err(|e| e.to_string())?;
        self.with_file_write(
            notebook_id,
            &path,
            FileLockIntent::ExistingOrMissing,
            "notebook_settings",
            |path| {
                let mut settings = read_settings(path)?;
                operation(path, &mut settings)
            },
        )
        .map_err(|e| e.to_string())
    }

    pub fn migrate_folder_index_to_json(&self, notebook_id: &str) -> Result<(), String> {
        self.with_settings(notebook_id, |path, settings| {
            let conn = open_connection(self, notebook_id).map_err(std::io::Error::other)?;
            let done: Option<i64> = conn.query_row("SELECT value FROM folder_index_meta WHERE key = ?1", params![JSON_MIGRATION_KEY], |row| row.get(0)).optional().map_err(std::io::Error::other)?;
            if done.is_some_and(|value| value != 0) { return Ok(()); }
            // Existing JSON wins for the same folder; retain other legacy entries.
            let mut query = conn.prepare("SELECT relative_path, properties_json, updated_at FROM folder_index ORDER BY relative_path").map_err(std::io::Error::other)?;
            let rows = query.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))).map_err(std::io::Error::other)?;
            let mut changed = false;
            for row in rows {
                let (folder, raw, updated_at) = row.map_err(std::io::Error::other)?;
                if settings.folders.contains_key(&folder) { continue; }
                let properties = serde_json::from_str(&raw).map_err(std::io::Error::other)?;
                settings.folders.insert(folder, FolderSettings { properties, updated_at, extra: BTreeMap::new() });
                changed = true;
            }
            if changed { write_settings(path, settings)?; }
            conn.execute("INSERT INTO folder_index_meta (key, value) VALUES (?1, 1) ON CONFLICT(key) DO UPDATE SET value = 1", params![JSON_MIGRATION_KEY]).map_err(std::io::Error::other)?;
            Ok(())
        })
    }

    pub fn list_folder_index(&self, notebook_id: &str) -> Result<Vec<FolderIndexEntry>, String> {
        self.migrate_folder_index_to_json(notebook_id)?;
        let settings =
            read_settings(&settings_path(self, notebook_id)?).map_err(|e| e.to_string())?;
        Ok(settings
            .folders
            .into_iter()
            .map(|(relative_path, entry)| FolderIndexEntry {
                relative_path,
                properties: entry.properties,
                updated_at: entry.updated_at,
            })
            .collect())
    }

    pub fn folder_index_entry(
        &self,
        notebook_id: &str,
        relative_path: &str,
    ) -> Result<Option<FolderIndexEntry>, String> {
        let relative_path = normalize_folder_path(relative_path)?;
        Ok(self
            .list_folder_index(notebook_id)?
            .into_iter()
            .find(|entry| entry.relative_path == relative_path))
    }

    pub fn set_folder_index_properties(
        &self,
        notebook_id: &str,
        relative_path: &str,
        properties: BTreeMap<String, Option<CollectionProperty>>,
    ) -> Result<FolderIndexEntry, String> {
        let relative_path = normalize_folder_path(relative_path)?;
        self.migrate_folder_index_to_json(notebook_id)?;
        self.with_settings(notebook_id, |path, settings| {
            let mut entry = settings.folders.remove(&relative_path).unwrap_or_default();
            for (key, value) in properties {
                match value {
                    Some(value) => {
                        entry.properties.insert(key, value);
                    }
                    None => {
                        entry.properties.remove(&key);
                    }
                }
            }
            validate_properties(&entry.properties).map_err(std::io::Error::other)?;
            entry.updated_at = now_ms();
            let result = FolderIndexEntry {
                relative_path: relative_path.clone(),
                properties: entry.properties.clone(),
                updated_at: entry.updated_at,
            };
            if !entry.properties.is_empty() || !entry.extra.is_empty() {
                settings.folders.insert(relative_path, entry);
            }
            write_settings(path, settings)?;
            Ok(result)
        })
    }

    pub fn rebase_folder_index(
        &self,
        notebook_id: &str,
        previous_relative_path: &str,
        next_relative_path: &str,
    ) -> Result<usize, String> {
        let previous = normalize_folder_path(previous_relative_path)?;
        let next = normalize_folder_path(next_relative_path)?;
        if previous.is_empty() || previous == next {
            return Ok(0);
        }
        self.migrate_folder_index_to_json(notebook_id)?;
        self.with_settings(notebook_id, |path, settings| {
            let keys: Vec<_> = settings
                .folders
                .keys()
                .filter(|key| *key == &previous || key.starts_with(&format!("{previous}/")))
                .cloned()
                .collect();
            for key in &keys {
                if let Some(entry) = settings.folders.remove(key) {
                    settings
                        .folders
                        .insert(format!("{next}{}", &key[previous.len()..]), entry);
                }
            }
            if !keys.is_empty() {
                write_settings(path, settings)?;
            }
            Ok(keys.len())
        })
    }

    pub fn delete_folder_index_subtree(
        &self,
        notebook_id: &str,
        relative_path: &str,
    ) -> Result<usize, String> {
        let relative_path = normalize_folder_path(relative_path)?;
        if relative_path.is_empty() {
            return Ok(0);
        }
        self.migrate_folder_index_to_json(notebook_id)?;
        self.with_settings(notebook_id, |path, settings| {
            let before = settings.folders.len();
            settings.folders.retain(|key, _| {
                key != &relative_path && !key.starts_with(&format!("{relative_path}/"))
            });
            let removed = before - settings.folders.len();
            if removed > 0 {
                write_settings(path, settings)?;
            }
            Ok(removed)
        })
    }

    /// 把旧版「文件夹集合」的 `.index.yaml` 迁入设置文件。
    ///
    /// 只处理 `placement: folder` 的集合（`<目录>/.index.yaml` 且文件自己声明是
    /// 文件夹用途）；独立集合文件原样留在磁盘上。迁完把文件移到
    /// `<notebook>/.flowix/legacy-folder-index/` 备份，用户目录里不再出现这个隐藏
    /// 文件。设置文件里已有同名路径时以设置文件为准（用户可能已经在新界面上改过外观）。
    ///
    /// 幂等：标记写在 `folder_index_meta`，每个笔记本只扫一次。
    pub fn migrate_legacy_folder_collections(&self, notebook_id: &str) -> Result<usize, String> {
        self.migrate_folder_index_to_json(notebook_id)?;
        let conn = open_connection(self, notebook_id)?;
        let done: Option<i64> = conn
            .query_row(
                "SELECT value FROM folder_index_meta WHERE key = ?1",
                params![LEGACY_MIGRATION_KEY],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if done.is_some_and(|value| value != 0) {
            return Ok(0);
        }
        drop(conn);

        let notebook = self
            .get_notebook_config_by_id(notebook_id)
            .ok_or("NOTEBOOK_NOT_FOUND")?;
        let root = Path::new(&notebook.path);
        let policy = super::FileManagementPolicy::from_notebook_root(root);
        let mut legacy_files = Vec::new();
        collect_legacy_folder_indexes(root, root, &policy, &mut legacy_files);

        // 把每份旧文件转成一次合并写入；parse 失败的保留原位，下一轮人工处理。
        let mut migrated = 0usize;
        for path in legacy_files {
            let Ok(source) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(document) = crate::collection::CollectionDocument::parse(&source) else {
                continue;
            };
            if document.collection.placement != crate::collection::CollectionPlacement::Folder {
                continue;
            }
            let Some(relative_folder) = path
                .parent()
                .and_then(|parent| parent.strip_prefix(root).ok())
            else {
                continue;
            };
            let relative_folder = relative_folder.to_string_lossy().replace('\\', "/");
            if relative_folder.is_empty() {
                continue;
            }
            let has_row = self
                .folder_index_entry(notebook_id, &relative_folder)?
                .is_some();
            if !has_row && !document.collection.properties.is_empty() {
                let properties = document
                    .collection
                    .properties
                    .iter()
                    .map(|(key, property)| (key.clone(), Some(property.clone())))
                    .collect::<BTreeMap<_, _>>();
                self.set_folder_index_properties(notebook_id, &relative_folder, properties)?;
            }
            if move_legacy_index_to_backup(root, &path) {
                migrated += 1;
            }
        }

        let conn = open_connection(self, notebook_id)?;
        conn.execute(
            "INSERT INTO folder_index_meta (key, value) VALUES (?1, 1)
             ON CONFLICT(key) DO UPDATE SET value = 1",
            params![LEGACY_MIGRATION_KEY],
        )
        .map_err(|e| e.to_string())?;
        Ok(migrated)
    }
}

/// 递归找出所有「文件夹专用」的 `.index.yaml`。只认文件名精确等于
/// `.index.yaml` 的那一份；`xxx.index.yaml` 是独立集合，不动。
fn collect_legacy_folder_indexes(
    root: &Path,
    directory: &Path,
    policy: &super::FileManagementPolicy,
    found: &mut Vec<std::path::PathBuf>,
) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            if policy.is_index_hidden_at(root, relative) {
                continue;
            }
            collect_legacy_folder_indexes(root, &path, policy, found);
            continue;
        }
        if path.file_name().and_then(|name| name.to_str()) != Some(".index.yaml") {
            continue;
        }
        found.push(path);
    }
}

/// 把旧文件移到 `.flowix/legacy-folder-index/<相对目录>.yaml`。移动失败时返回
/// false —— 迁表已经完成，用户目录里多一个隐藏文件比丢数据可接受得多。
fn move_legacy_index_to_backup(root: &Path, path: &Path) -> bool {
    let Some(relative) = path
        .parent()
        .and_then(|parent| parent.strip_prefix(root).ok())
    else {
        return false;
    };
    let backup_root = root.join(".flowix").join(LEGACY_BACKUP_DIRECTORY);
    let mut target = backup_root.join(relative).with_extension("yaml");
    let mut suffix = 1;
    while target.exists() {
        target = backup_root
            .join(relative)
            .with_extension(format!("{suffix}.yaml"));
        suffix += 1;
    }
    let Some(parent) = target.parent() else {
        return false;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return false;
    }
    std::fs::rename(path, &target).is_ok()
}

/// 文件移动后调用方已经拿到收尾路径，但源路径可能已不存在 —— 与
/// `commands/file/view.rs::canonicalize_move_path` 同一套还原：能给整条路径就
/// 用整条，否则 canonicalize 父目录再拼回文件名。
fn canonicalize_move_path(path: &Path) -> std::path::PathBuf {
    if let Ok(resolved) = dunce::canonicalize(path) {
        return resolved;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => match dunce::canonicalize(parent) {
            Ok(resolved) => resolved.join(name),
            Err(_) => path.to_path_buf(),
        },
        _ => path.to_path_buf(),
    }
}

/// 目录改名 / 移动之后重定位文件夹外观。
///
/// 供 `commands/file/transfer.rs`（全部本地移动的收尾）与
/// `watcher/processor.rs`（系统文件管理器的外部移动）共用：两条路径都在移动
/// 完成之后调用它，所以这里自己解决「源目录已不存在」。只处理目录移动；
/// 文件改名不改变任何文件夹路径。
pub fn rebase_folder_index_for_move(memo_file: &MemoFile, source: &Path, target: &Path) {
    if !target.is_dir() {
        return;
    }
    let source = canonicalize_move_path(source);
    let target = canonicalize_move_path(target);
    let Ok(notebooks) = memo_file.read_notebook_configs() else {
        return;
    };
    for notebook in notebooks {
        let Ok(root) = dunce::canonicalize(&notebook.path) else {
            continue;
        };
        let (Ok(previous), Ok(next)) = (source.strip_prefix(&root), target.strip_prefix(&root))
        else {
            continue;
        };
        let previous = previous.to_string_lossy().replace('\\', "/");
        let next = next.to_string_lossy().replace('\\', "/");
        match memo_file.rebase_folder_index(&notebook.id, &previous, &next) {
            Ok(0) => {}
            Ok(count) => tracing::debug!(
                notebook_id = %notebook.id,
                %previous,
                %next,
                count,
                "folder appearance rebased with directory move"
            ),
            Err(error) => tracing::warn!(
                notebook_id = %notebook.id,
                %previous,
                %next,
                "folder appearance rebase failed: {error}"
            ),
        }
        break;
    }
}

/// 目录被删除之后清掉它的外观（含子树）。与 rebase 同一套路径还原。
pub fn delete_folder_index_for_path(memo_file: &MemoFile, folder: &Path) {
    let folder = canonicalize_move_path(folder);
    let Ok(notebooks) = memo_file.read_notebook_configs() else {
        return;
    };
    for notebook in notebooks {
        let Ok(root) = dunce::canonicalize(&notebook.path) else {
            continue;
        };
        let Ok(relative) = folder.strip_prefix(&root) else {
            continue;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        match memo_file.delete_folder_index_subtree(&notebook.id, &relative) {
            Ok(0) => {}
            Ok(count) => tracing::debug!(
                notebook_id = %notebook.id,
                %relative,
                count,
                "folder appearance removed with directory"
            ),
            Err(error) => tracing::warn!(
                notebook_id = %notebook.id,
                %relative,
                "folder appearance cleanup failed: {error}"
            ),
        }
        break;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collection::CollectionProperty;
    use crate::memo_file::NotebookConfig;

    fn fixture() -> (MemoFile, tempfile::TempDir, std::path::PathBuf, String) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notebook");
        std::fs::create_dir_all(&root).unwrap();
        let memo = MemoFile::new(temp.path().join("config"));
        let id = format!("nb_{}", uuid::Uuid::now_v7().simple());
        memo.write_notebook_configs(&[NotebookConfig {
            id: id.clone(),
            name: "Folders".into(),
            icon: None,
            path: root.to_string_lossy().into_owned(),
            is_default: true,
            sort: 0,
            created_at: 0,
            updated_at: 0,
        }])
        .unwrap();
        (memo, temp, root, id)
    }

    fn text_property(value: &str) -> CollectionProperty {
        CollectionProperty {
            kind: "Text".into(),
            name: None,
            value: serde_json::json!(value),
        }
    }

    #[test]
    fn migrates_sqlite_once_and_preserves_unknown_settings() {
        let (memo, _temp, root, id) = fixture();
        let conn = open_connection(&memo, &id).unwrap();
        conn.execute(
            "INSERT INTO folder_index VALUES (?1, ?2, ?3)",
            params!["Docs", r#"{"icon":{"type":"Text","value":"cat"}}"#, 123],
        )
        .unwrap();
        drop(conn);
        assert_eq!(
            memo.list_folder_index(&id).unwrap()[0].properties["icon"].value,
            "cat"
        );
        let path = root.join(NOTEBOOK_SETTINGS_PATH);
        assert!(super::super::scan_syncable_notebook_files(&root)
            .unwrap()
            .iter()
            .any(|entry| entry.display_path == NOTEBOOK_SETTINGS_PATH));
        let mut json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        json["files"]["example.md"] = serde_json::json!({"future": true});
        json["future_section"] = serde_json::json!({"value": 42});
        std::fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();
        memo.set_folder_index_properties(&id, "Docs", BTreeMap::from([("icon".to_string(), None)]))
            .unwrap();
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(json["files"]["example.md"]["future"], true);
        assert_eq!(json["future_section"]["value"], 42);
        std::fs::remove_file(&path).unwrap();
        assert!(
            memo.list_folder_index(&id).unwrap().is_empty(),
            "deleted settings must not resurrect old SQLite rows"
        );
    }

    #[test]
    fn migration_merges_missing_folders_without_overwriting_json() {
        let (memo, _temp, root, id) = fixture();
        let conn = open_connection(&memo, &id).unwrap();
        let old = r#"{"icon":{"type":"Text","value":"old"}}"#;
        for folder in ["Docs", "Other"] {
            conn.execute(
                "INSERT INTO folder_index VALUES (?1, ?2, 1)",
                params![folder, old],
            )
            .unwrap();
        }
        let path = root.join(NOTEBOOK_SETTINGS_PATH);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"schema_version":1,"folders":{"Docs":{"properties":{"icon":{"type":"Text","value":"new"}}}},"files":{}}"#).unwrap();
        let entries = memo.list_folder_index(&id).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].properties["icon"].value, "new");
        assert_eq!(entries[1].properties["icon"].value, "old");
    }

    #[test]
    fn malformed_settings_are_not_overwritten() {
        let (memo, _temp, root, id) = fixture();
        let path = root.join(NOTEBOOK_SETTINGS_PATH);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{invalid").unwrap();
        assert!(memo
            .set_folder_index_properties(
                &id,
                "Docs",
                BTreeMap::from([("icon".to_string(), Some(text_property("cat")))])
            )
            .is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"{invalid");
    }

    #[test]
    fn merges_and_removes_properties() {
        let (memo, _temp, _root, id) = fixture();
        memo.set_folder_index_properties(
            &id,
            "Docs",
            BTreeMap::from([("icon".to_string(), Some(text_property("dog-face")))]),
        )
        .unwrap();
        let entry = memo
            .set_folder_index_properties(
                &id,
                "/Docs/",
                BTreeMap::from([
                    ("subtitle".to_string(), Some(text_property("团队文档"))),
                    ("icon".to_string(), None),
                ]),
            )
            .unwrap();
        assert_eq!(entry.relative_path, "Docs");
        assert!(!entry.properties.contains_key("icon"));
        assert_eq!(
            entry.properties["subtitle"].value,
            serde_json::json!("团队文档")
        );
    }

    #[test]
    fn empty_properties_delete_the_row() {
        let (memo, _temp, _root, id) = fixture();
        memo.set_folder_index_properties(
            &id,
            "Docs",
            BTreeMap::from([("icon".to_string(), Some(text_property("dog-face")))]),
        )
        .unwrap();
        memo.set_folder_index_properties(&id, "Docs", BTreeMap::from([("icon".to_string(), None)]))
            .unwrap();
        assert!(memo.list_folder_index(&id).unwrap().is_empty());
    }

    #[test]
    fn rebases_descendants_only() {
        let (memo, _temp, _root, id) = fixture();
        for folder in ["Docs", "Docs/Guide", "Docs2", ""] {
            memo.set_folder_index_properties(
                &id,
                folder,
                BTreeMap::from([("icon".to_string(), Some(text_property("dog-face")))]),
            )
            .unwrap();
        }
        assert_eq!(
            memo.rebase_folder_index(&id, "Docs", "Archive/Docs")
                .unwrap(),
            2
        );
        let paths = memo
            .list_folder_index(&id)
            .unwrap()
            .into_iter()
            .map(|entry| entry.relative_path)
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            vec!["", "Archive/Docs", "Archive/Docs/Guide", "Docs2"]
        );
    }

    #[test]
    fn deletes_the_whole_subtree() {
        let (memo, _temp, _root, id) = fixture();
        for folder in ["Docs", "Docs/Guide", "Docs2"] {
            memo.set_folder_index_properties(
                &id,
                folder,
                BTreeMap::from([("icon".to_string(), Some(text_property("dog-face")))]),
            )
            .unwrap();
        }
        assert_eq!(memo.delete_folder_index_subtree(&id, "Docs").unwrap(), 2);
        assert_eq!(memo.list_folder_index(&id).unwrap().len(), 1);
    }

    #[test]
    fn migrates_folder_placement_indexes_and_keeps_standalone_files() {
        let (memo, _temp, root, id) = fixture();
        let docs = root.join("Docs");
        std::fs::create_dir_all(&docs).unwrap();
        std::fs::write(
            docs.join(".index.yaml"),
            "format: flowix.collection\nschema_version: 2\ncollection:\n  id: col_01900000000070008000000000000000\n  type: table\n  placement: folder\n  revision: 0\n  created_at: \"2026-10-11T00:00:00.000Z\"\n  updated_at: \"2026-10-11T00:00:00.000Z\"\n  properties:\n    icon:\n      type: Text\n      value: dog-face\npayload:\n  schema_version: 2\n  dataset:\n    source: { scope: containing_folder }\n    schema: { fields: [] }\n    records: { include: [], exclude: [] }\n    filter: null\n  views: { default_id: view_01900000000070008000000000000001, items: [] }\n",
        )
        .unwrap();
        // 独立集合不是文件夹外观，迁移后必须还在。
        std::fs::write(docs.join("Tasks.index.yaml"), "format: flowix.collection\n").unwrap();
        assert_eq!(memo.migrate_legacy_folder_collections(&id).unwrap(), 1);
        let entries = memo.list_folder_index(&id).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].relative_path, "Docs");
        assert_eq!(
            entries[0].properties["icon"].value,
            serde_json::json!("dog-face")
        );
        assert!(!docs.join(".index.yaml").exists());
        assert!(docs.join("Tasks.index.yaml").exists());
        // 幂等：第二次不再迁移。
        assert_eq!(memo.migrate_legacy_folder_collections(&id).unwrap(), 0);
    }
}
