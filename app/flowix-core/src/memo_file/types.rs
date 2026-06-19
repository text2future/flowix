//! 公开 DTO 类型 — `Memo` / `Notebook` / `TodoItem` / `MemoTag` /
//! `NotebookConfig` / `MemoIndexFile` / `MemoIndexEntry` / `MemoTodoEntry` /
//! `MemoMetadataFile`。
//!
//! 拆分理由: 旧 `memo_file.rs` 把全部 DTO 堆在文件顶部, 跟 IO/CRUD/registration
//! 混在一起, 1654 行 god module。DTO 是稳定边界 (前端 TS 镜像直接读这些字段),
//! 单独放 `types.rs` 后改 IO 不影响类型签名。
//!
//! ## v3 — 2026/06 重构: `filename` 作为 path
//!
//! 旧版: `MemoIndexEntry` 不存物理路径, 物理文件名由 `entry.filename + entry.id` 拼成
//! `{title}#xxxxxx.md`。`Memo` 额外带 `path` 字段 (内存拼出来的相对路径)。
//!
//! 现版: 物理文件 = `<notebook>/<filename>.md`, `entry.filename` 直接是磁盘文件名
//! (含 `.md`)。`Memo` / `MemoIndexEntry` 都不再有 `path` 字段; 物理路径运行时
//! 拼 `get_memo_base() + filename`。`Memo` 的 `filename` 字段即"磁盘文件名",
//! 前端展示时去掉 `.md` 后缀即可。

use serde::{Deserialize, Serialize};

/// 文档颜色标签 — 写在 index.json 里的可选装饰字段, 单文档可挂多个色。
///
/// 取值集固定为 红/橙/黄/绿/青/蓝/灰 7 种, 序列化小写英文 (`"red"` /
/// `"orange"` / ...), 数组形式存, 空数组即"无颜色"。不持久化在 .md
/// frontmatter — index.json 是唯一真源, 跟 `icon` 字段同形。
///
/// 旧版用单值 `Option<MemoColor>`, 现在切到 `Vec<MemoColor>`。index.json
/// 老数据若含 `"color": "red"` / `"color": null` 会反序列化失败, 但本字段
/// 是这次会话新加的, 没有真实数据, 走纯 breaking change 即可。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoColor {
    Red,
    Orange,
    Yellow,
    Green,
    Cyan,
    Blue,
    Gray,
}

/// 跨 IPC 边界返回的 memo 完整形态 (前端 TS `MemoItem` 镜像)。
///
/// 字段语义:
/// - `id`: 6 位 shortid, index.json 的内部 key / 深链 / noteReference 节点 id。
/// - `filename`: 磁盘文件名, 含 `.md` 后缀 (如 `Hello.md` / `Hello-1.md`)。
///   列表展示前端去掉 `.md`; 编辑器内展示用 `MemoItem.filename` 直接可。
/// - `preview` / `tags` / `todos`: 从 body 派生的 index.json 缓存字段。
/// - `favorited` / `icon` / `colors`: 装饰字段, 仅 index.json 持久化。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Memo {
    pub id: String,
    pub filename: String,
    #[serde(rename = "preview")]
    pub preview: String,
    #[serde(rename = "tags")]
    pub tags: Vec<String>,
    #[serde(rename = "todos")]
    pub todos: Vec<TodoItem>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    pub favorited: bool,
    pub icon: Option<String>,
    #[serde(default)]
    pub colors: Vec<MemoColor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoItem {
    pub content: String,
    pub status: String,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotebookConfig {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub path: String,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

// ============================================
// Memo List Entry (for .metadata/index.json)
// ============================================

/// index.json 单条 memo 元数据。`filename` 即磁盘文件名, 含 `.md`。
/// 旧版有 `path` 字段, 现版删除, 物理路径运行时拼。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoIndexEntry {
    pub id: String,
    /// 磁盘文件名, 含 `.md` 后缀。冲突时由 ops 层自动追加 `-1` / `-2`。
    pub filename: String,
    pub preview: String,
    pub tags: Vec<String>,
    pub todos: Vec<TodoItem>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    pub favorited: bool,
    #[serde(rename = "icon")]
    pub icon: Option<String>,
    #[serde(default)]
    pub colors: Vec<MemoColor>,
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

// ============================================
// Notebook-level memo metadata (for .metadata/memo.json)
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoTodoEntry {
    pub content: String,
    pub status: String,
    #[serde(rename = "memoId")]
    pub memo_id: String,
    pub priority: String,
    #[serde(rename = "timeRange")]
    pub time_range: String,
    pub owner: String,
    pub assignee: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoMetadataFile {
    pub version: u32,
    pub last_updated: i64,
    pub todos: Vec<MemoTodoEntry>,
}

impl Default for MemoMetadataFile {
    fn default() -> Self {
        Self {
            version: 1,
            last_updated: chrono::Utc::now().timestamp_millis(),
            todos: Vec::new(),
        }
    }
}

/// [`crate::memo_file::MemoFile::reconcile_with_disk_bidirectional`] 的返回报告。
///
/// - `added`: 磁盘上有但 `index.json` 没有的 .md 文件, 被注册进 index.json 的条数。
/// - `removed`: `index.json` 有但磁盘上文件已不存在的条目, 被清理出 index.json 的条数。
///
/// `added == 0 && removed == 0` 时调用方可以视为 no-op (幂等)。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReconcileReport {
    pub added: usize,
    pub removed: usize,
}
