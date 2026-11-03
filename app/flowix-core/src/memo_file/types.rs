//! 公开 DTO 类型 — `Memo` / `Notebook` / `TodoItem` / `MemoTag` /
//! `NotebookConfig` / notebook-relative-path projections。
//!
//! 拆分理由: 旧 `memo_file.rs` 把全部 DTO 堆在文件顶部, 跟 IO/CRUD/registration
//! 混在一起, 1654 行 god module。DTO 是稳定边界 (前端 TS 镜像直接读这些字段),
//! 单独放 `types.rs` 后改 IO 不影响类型签名。
//!
//! 笔记由 `(notebook_id, relative_path)` 定位。`filename` 是相对路径的末级文件名，
//! 用于列表显示和文件树操作；索引不为笔记生成独立 ID。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 文档颜色标签 — 持久值写在 Markdown frontmatter 中, 单文档可挂多个色。
///
/// 取值集固定为 红/橙/黄/绿/青/蓝/灰 7 种, 序列化小写英文 (`"red"` /
/// `"orange"` / ...), 数组形式存, 空数组即"无颜色"。
/// 索引只缓存从 Markdown 解析出的值, 与 `icon` 字段同形。
///
/// 旧版用单值 `Option<NoteColor>`, 现在切到 `Vec<NoteColor>`。memo index
/// 老数据若含 `"color": "red"` / `"color": null` 会反序列化失败, 但本字段
/// 是这次会话新加的, 没有真实数据, 走纯 breaking change 即可。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteColor {
    Red,
    Orange,
    Yellow,
    Green,
    Cyan,
    Blue,
    Gray,
}

/// 跨 IPC 边界返回的笔记投影 (前端 TS `MemoItem` 镜像)。
///
/// 字段语义:
/// - `relative_path`: 相对于 notebook 根目录的笔记路径，也是索引键。
/// - `filename`: 磁盘文件名, 含 `.md` 后缀 (如 `Hello.md` / `Hello-1.md`)。
/// - `preview` / `tags` / `todos` / `agents`: from Markdown content, cached in the index.
/// - `favorited` / `icon` / `colors`: 从 Markdown frontmatter 读取的持久属性。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Memo {
    /// 文件名本身，不包含笔记本内的目录部分。
    pub filename: String,
    /// 相对于所属笔记本根目录的规范化路径，使用 `/` 作为分隔符。
    #[serde(rename = "relativePath", default)]
    pub relative_path: String,
    #[serde(rename = "preview")]
    pub preview: String,
    #[serde(default)]
    pub thumbnail: Option<String>,
    #[serde(rename = "tags")]
    pub tags: Vec<String>,
    #[serde(rename = "todos")]
    pub todos: Vec<TodoItem>,
    #[serde(default, rename = "agents")]
    pub agents: Vec<AgentThreadItem>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    pub favorited: bool,
    pub icon: Option<String>,
    #[serde(default)]
    pub colors: Vec<NoteColor>,
    #[serde(default)]
    pub properties: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoItem {
    pub content: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentThreadItem {
    #[serde(rename = "threadId")]
    pub thread_id: String,
    pub title: String,
    // Agent Type key, serialized as the frontend `agentType` field.
    #[serde(rename = "agentType")]
    pub agent_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoTag {
    pub id: String,
    pub name: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Notebook {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub path: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
    /// 用户拖拽顺序, 小值在前。`read_notebook_configs` 读时按该字段升序返回,
    /// 旧库升级时按 created_at 一次性回填 10/20/30...。前端透传展示顺序。
    pub sort: i64,
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotebookConfig {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub path: String,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
    /// 用户拖拽顺序, 小值在前; `None` 表示尚未分配 (旧库 upgrade 路径内部使用)。
    pub sort: i64,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

/// Notebook identity stored in
/// `<notebook>/.flowix/notebook.json`. Markdown remains the note source of truth.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookManifest {
    pub format_version: u32,
    pub notebook_id: String,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub struct MemoLocation {
    pub memo: MemoIndexEntry,
    pub notebook: NotebookConfig,
}

/// Rebuildable note projection row. The notebook-relative path is its key.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoIndexEntry {
    /// 磁盘文件名, 含 `.md` 后缀。冲突时由 ops 层自动追加 `-1` / `-2`。
    pub filename: String,
    /// 相对于 notebook 根目录的规范化路径，使用 `/` 作为分隔符。
    #[serde(rename = "relativePath", default)]
    pub relative_path: String,
    pub preview: String,
    #[serde(default)]
    pub thumbnail: Option<String>,
    pub tags: Vec<String>,
    pub todos: Vec<TodoItem>,
    #[serde(default)]
    pub agents: Vec<AgentThreadItem>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    pub favorited: bool,
    #[serde(rename = "icon")]
    pub icon: Option<String>,
    #[serde(default)]
    pub colors: Vec<NoteColor>,
    #[serde(default)]
    pub properties: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoIndexFile {
    pub version: u32,
    pub last_updated: i64,
    pub memos: Vec<MemoIndexEntry>,
}

impl Default for MemoIndexFile {
    fn default() -> Self {
        Self {
            version: 1,
            last_updated: chrono::Utc::now().timestamp_millis(),
            memos: Vec::new(),
        }
    }
}

/// [`crate::memo_file::MemoFile::reconcile_with_disk_bidirectional`] 的返回报告。
///
/// - `added`: 磁盘上有但 `memo index` 没有的 .md 文件, 被注册进 memo index 的条数。
/// - `removed`: `memo index` 有但磁盘上文件已不存在的条目, 被清理出 memo index 的条数。
///
/// `added == 0 && removed == 0` 时调用方可以视为 no-op (幂等)。
#[derive(Debug, Clone, Default)]
pub struct ReconcileReport {
    pub added: usize,
    /// Entries this reconciliation registered. The watcher uses these exact
    /// snapshots to publish create events without reporting concurrent app writes.
    pub added_memos: Vec<Memo>,
    pub removed: usize,
    /// Entries removed from the index during a complete disk scan. Callers
    /// can use these snapshots to publish deletion tombstones after the
    /// index mutation has succeeded.
    pub removed_memos: Vec<Memo>,
}

/// [`crate::memo_file::MemoFile::move_memo_tag_locked`] 的返回报告。
///
/// - `affected_memos`: 实际被批量改写 YAML `tags` + 同步索引的笔记数
///   条数; 当 `old_path` 在任何 memo 都没出现时为 0。
/// - `renamed_tags`: 操作涉及的 `(old, new)` tag name 对 (去重)。`old`
///   可以是 `old_path` 本身, 也可以是 `old_path/<...>` 的子树 tag。
///   用于前端在下拉 / 标签面板里精确刷新 UI。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MoveTagReport {
    #[serde(rename = "affectedMemos")]
    pub affected_memos: usize,
    #[serde(rename = "renamedTags")]
    pub renamed_tags: Vec<(String, String)>,
}

/// [`crate::memo_file::MemoFile::delete_memo_tag_locked`] 的返回报告。
///
/// - `affected_memos`: 实际被批量改写 YAML `tags` + 同步索引的笔记数
///   条数; 当 `tag_path` 在任何 memo 都没出现时为 0。
/// - `deleted_tags`: 操作涉及的 (被删除的) tag 路径, 含 `tag_path` 自身
///   加上所有以 `tag_path/` 为前缀的子树 tag, **去重**。 前端用它把
///   memos[*].tags 里命中的 token 移除 + 标签树清理。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DeleteTagReport {
    #[serde(rename = "affectedMemos")]
    pub affected_memos: usize,
    #[serde(rename = "deletedTags")]
    pub deleted_tags: Vec<String>,
}
