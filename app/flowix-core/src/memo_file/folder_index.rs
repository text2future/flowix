//! 文件夹的展示元数据：图标、头图、副标题。
//!
//! 这些信息曾经写在目录里的 `.index.yaml` 里，代价是「点开一个文件夹」等于
//! 「打开一个集合」——文件夹必须承担表格 / 图墙 / 列表的整套集合协议，还得在
//! 文件树里藏一个文件。现在文件夹只是一个表面（单 tab 的文件列表），外观是它
//! 自己的属性，所以搬进 `<notebook>/.flowix/notebook.db` 的 `folder_index` 表。
//!
//! 身份是**路径**（笔记本相对、`/` 分隔、无尾斜杠），不是 id：文件夹在磁盘上
//! 没有别的东西可当身份。因此每次目录改名 / 移动 / 删除都必须在同一把笔记本锁
//! 里重定位，否则外观会留在旧路径上。生产入口只有三处：
//!
//! - `commands/file/transfer.rs::rename_path_and_notify`：本地改名 / 移动（含
//!   `rename_folder`、`move_folder`）；
//! - `watcher/processor.rs`：系统文件管理器里的外部移动（`rebase_collection_paths_for_move`
//!   的同一个分支）；
//! - `commands/file/mutate.rs::delete_folder_blocking`：删除整棵子树。
//!
//! 表跟随笔记本数据库：`notebook.db` 是索引库，损坏时整体重建，文件夹外观随之
//! 丢失。这里刻意不写第二份 JSON 快照 —— 两处真相最终一定会分叉，宁可接受
//! 「和集合索引同一条纪律」。

use super::MemoFile;
use crate::collection::{validate_properties, CollectionProperty};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Component, Path};
use std::time::{SystemTime, UNIX_EPOCH};

/// 迁移完成标记：`folder_index_meta` 里的一行，保证每个笔记本只扫一次旧文件。
const LEGACY_MIGRATION_KEY: &str = "legacy_folder_collections_migrated";
/// 旧 `.index.yaml` 的备份目录（相对 `.flowix`）。文件从用户目录里消失，但内容
/// 仍可人工找回；这是「迁属性后删除」的安全网，不参与任何读取。
const LEGACY_BACKUP_DIRECTORY: &str = "legacy-folder-index";

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
/// 拒绝反斜杠、NUL、绝对路径与任何 `.` / `..` 分量：路径是表的主键，也是 SQL
/// 前缀匹配的输入，放过一处 `..` 就等于让一次重定位改到别的目录。
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
    let path = memo.notebook_db_path(notebook_id).map_err(|e| e.to_string())?;
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

fn read_properties(raw: &str) -> BTreeMap<String, CollectionProperty> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn entry_from_row(relative_path: String, properties_json: String, updated_at: i64) -> FolderIndexEntry {
    FolderIndexEntry {
        relative_path,
        properties: read_properties(&properties_json),
        updated_at,
    }
}

/// 前缀谓词（内联在下面两条 SQL 里）：精确命中本目录，或命中其子目录。用
/// `substr` 而不是 `LIKE`，避免 SQLite 的 ASCII 大小写折叠把 `Docs` 和 `docs`
/// 当成同一个目录。

impl MemoFile {
    /// 整本笔记本的文件夹外观。表只存「有自定义外观的文件夹」，通常只有几十行，
    /// 一次全量返回给文件树（每个文件夹图标共用同一份数据，避免每行一次 IPC）。
    pub fn list_folder_index(&self, notebook_id: &str) -> Result<Vec<FolderIndexEntry>, String> {
        let conn = open_connection(self, notebook_id)?;
        let mut statement = conn
            .prepare("SELECT relative_path, properties_json, updated_at FROM folder_index ORDER BY relative_path")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(entry_from_row(row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn folder_index_entry(
        &self,
        notebook_id: &str,
        relative_path: &str,
    ) -> Result<Option<FolderIndexEntry>, String> {
        let relative_path = normalize_folder_path(relative_path)?;
        let conn = open_connection(self, notebook_id)?;
        conn.query_row(
            "SELECT relative_path, properties_json, updated_at FROM folder_index WHERE relative_path = ?1",
            params![relative_path],
            |row| Ok(entry_from_row(row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    /// 合并写入：`None` 表示删除该属性键，其余键覆盖。返回写入后的完整外观。
    ///
    /// 合并语义与 `collections.mutate` 的 `properties` 一致，调用方（头图开关、
    /// 选图、图标、副标题）只需传自己改的那一个键，不会把别的键冲掉。
    pub fn set_folder_index_properties(
        &self,
        notebook_id: &str,
        relative_path: &str,
        properties: BTreeMap<String, Option<CollectionProperty>>,
    ) -> Result<FolderIndexEntry, String> {
        let relative_path = normalize_folder_path(relative_path)?;
        let mut conn = open_connection(self, notebook_id)?;
        let transaction = conn.transaction().map_err(|e| e.to_string())?;
        let existing: Option<String> = transaction
            .query_row(
                "SELECT properties_json FROM folder_index WHERE relative_path = ?1",
                params![relative_path],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let mut merged = existing.as_deref().map(read_properties).unwrap_or_default();
        for (key, value) in properties {
            match value {
                Some(property) => {
                    merged.insert(key, property);
                }
                None => {
                    merged.remove(&key);
                }
            }
        }
        validate_properties(&merged)?;
        let updated_at = now_ms();
        if merged.is_empty() {
            transaction
                .execute(
                    "DELETE FROM folder_index WHERE relative_path = ?1",
                    params![relative_path],
                )
                .map_err(|e| e.to_string())?;
        } else {
            let properties_json = serde_json::to_string(&merged).map_err(|e| e.to_string())?;
            transaction
                .execute(
                    "INSERT INTO folder_index (relative_path, properties_json, updated_at)
                     VALUES (?1, ?2, ?3)
                     ON CONFLICT(relative_path) DO UPDATE SET
                       properties_json = excluded.properties_json,
                       updated_at = excluded.updated_at",
                    params![relative_path, properties_json, updated_at],
                )
                .map_err(|e| e.to_string())?;
        }
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(FolderIndexEntry {
            relative_path,
            properties: merged,
            updated_at,
        })
    }

    /// 目录改名 / 移动后重定位整棵子树。返回被改写的行数（0 = 这个目录从来没有
    /// 自定义外观，调用方通常只需要打一条 debug 日志）。
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
        let conn = open_connection(self, notebook_id)?;
        let affected = conn
            .execute(
                "UPDATE OR REPLACE folder_index
                 SET relative_path = ?2 || substr(relative_path, length(?1) + 1)
                 WHERE relative_path = ?1
                    OR substr(relative_path, 1, length(?1) + 1) = ?1 || '/'",
                params![previous, next],
            )
            .map_err(|e| e.to_string())?;
        Ok(affected)
    }

    /// 删除一个目录（含子目录）的外观。笔记本根目录不可删，返回 0。
    pub fn delete_folder_index_subtree(
        &self,
        notebook_id: &str,
        relative_path: &str,
    ) -> Result<usize, String> {
        let relative_path = normalize_folder_path(relative_path)?;
        if relative_path.is_empty() {
            return Ok(0);
        }
        let conn = open_connection(self, notebook_id)?;
        conn.execute(
            "DELETE FROM folder_index
             WHERE relative_path = ?1
                OR substr(relative_path, 1, length(?1) + 1) = ?1 || '/'",
            params![relative_path],
        )
        .map_err(|e| e.to_string())
    }

    /// 把旧版「文件夹集合」的 `.index.yaml` 迁进表。
    ///
    /// 只处理 `placement: folder` 的集合（`<目录>/.index.yaml` 且文件自己声明是
    /// 文件夹用途）；独立集合文件原样留在磁盘上。迁完把文件移到
    /// `<notebook>/.flowix/legacy-folder-index/` 备份，用户目录里不再出现这个隐藏
    /// 文件。表里已有同名路径时以表为准（用户可能已经在新界面上改过外观）。
    ///
    /// 幂等：标记写在 `folder_index_meta`，每个笔记本只扫一次。
    pub fn migrate_legacy_folder_collections(&self, notebook_id: &str) -> Result<usize, String> {
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
        let (Ok(previous), Ok(next)) = (source.strip_prefix(&root), target.strip_prefix(&root)) else {
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
    use crate::memo_file::NotebookConfig;
    use crate::collection::CollectionProperty;

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
        memo.set_folder_index_properties(
            &id,
            "Docs",
            BTreeMap::from([("icon".to_string(), None)]),
        )
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
        assert_eq!(memo.rebase_folder_index(&id, "Docs", "Archive/Docs").unwrap(), 2);
        let paths = memo
            .list_folder_index(&id)
            .unwrap()
            .into_iter()
            .map(|entry| entry.relative_path)
            .collect::<Vec<_>>();
        assert_eq!(paths, vec!["", "Archive/Docs", "Archive/Docs/Guide", "Docs2"]);
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
        std::fs::write(
            docs.join("Tasks.index.yaml"),
            "format: flowix.collection\n",
        )
        .unwrap();
        assert_eq!(memo.migrate_legacy_folder_collections(&id).unwrap(), 1);
        let entries = memo.list_folder_index(&id).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].relative_path, "Docs");
        assert_eq!(entries[0].properties["icon"].value, serde_json::json!("dog-face"));
        assert!(!docs.join(".index.yaml").exists());
        assert!(docs.join("Tasks.index.yaml").exists());
        // 幂等：第二次不再迁移。
        assert_eq!(memo.migrate_legacy_folder_collections(&id).unwrap(), 0);
    }
}
