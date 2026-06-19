//! 磁盘对账 + 单文件注册 — 把外部 .md 文件纳入 index.json。
//!
//! v3: 物理文件名 = index.json entry.filename (含 `.md`), 旧版 `{title}#xxxxxx.md`
//! 约定已废。所有入口不再抽 id from filename, 也不再重命名磁盘文件。
//!
//! ## 入口
//!
//! - [`MemoFile::register_existing_file`]: 单文件注册。原文件名入 index.json,
//!   不重命名磁盘文件。
//! - [`MemoFile::register_unnamed_file`]: 行为同 `register_existing_file` (旧版
//!   会重命名为 `{title}#xxxxxx.md`, 现版保留外部工具句柄, 不动磁盘)。
//! - [`MemoFile::reconcile_with_disk`]: 启动 / 切 notebook 时扫根目录, 把
//!   index.json 没记录的 .md 补进来。
//! - [`MemoFile::reload_memo_from_disk`]: 重新读 .md 派生 preview / tags / todos。
//! - [`MemoFile::unregister_memo_by_path`]: 按绝对路径找 index.json entry 并移除。
//!
//! 全部在 [`super::ops`] 实现 (`impl MemoFile` 块); 本文件只留模块占位。
