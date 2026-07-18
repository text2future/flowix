//! Tauri IPC 命令总入口 — 按业务域拆分到子模块。
//!
//! ## 拆分 (v2 — 2026/06 重构)
//!
//! 旧 `commands.rs` 单文件 1645 行, 52 个 `#[tauri::command]` 跨 12 个业务域
//! 混在一起。拆成:
//!
//! - [`mod@helpers`]   — 跨域 helper (索引 / notebook 切换 / 路径 scope / 自写抑制 / markdown 解析)
//! - [`mod@settings`]  — `~/.flowix/boot/preference.json` + `~/.flowix/agent-config.toml` 读写
//! - [`mod@kv`]        — `~/.flowix/boot/system.json` system metadata
//! - [`mod@memo`]      — 笔记 CRUD + 搜索 + Doc 合并(动 memo index / .md 文件的全进这)
//! - [`mod@tag`]       — tag 派生 + (todo: 增删改 stub)
//! - [`mod@notebook`]  — notebook 切换 / 增删 / CRUD
//! - [`mod@file`]      — 任意文件的 in-notebook tree / read / write
//! - [`mod@dialog`]    — 原生 dialog + 附件保存 + base64
//! - [`mod@agent`]     — LLM 流式 chat + abort
//! - [`mod@thread`]    — 对话线程 CRUD
//! - [`mod@window`]    — preferences 窗口打开/聚焦
//!
//! ## 公共 API 保持不变
//!
//! `tauri::generate_handler![commands::xxx, ...]` (lib.rs:347-402) 与
//! `crate::watcher::current_watcher` / `crate::commands::markdown_paths_from_args`
//! 的引用路径**全部不变** — 本文件 `pub use` 把每个子模块的 IPC 函数重新
//! 暴露到 `commands::xxx` 命名空间。
//!
//! ## `AppState` 是所有 IPC 命令的共享状态
//!
//! 子模块通过 [`crate::app::state::AppState`] 访问, 字段全 `pub`, 各域
//! 自行约定"读 vs 写" — 例如 `memo_file` 写命令必拿 `write()`, 读命令 `read()`。

// ==================== 子模块 ====================

// 子模块一律 `pub` — `tauri::generate_handler![commands::<sub>::xxx]` 在
// `lib.rs::run()` 里走完整路径, 需要 `pub` 可见性。`#[tauri::command]` 宏
// 生成的 `__cmd__xxx` 兄弟宏也要求子模块是 `pub`, 否则宏解析不到。

pub mod agent;
pub mod agent_access;
pub mod cli;
pub mod dialog;
pub mod external_document_watch;
pub mod external_document;
pub mod file;
pub mod font;
pub mod helpers;
pub mod kv;
pub mod memo;
pub mod notebook;
pub mod product;
pub mod settings;
pub mod tab_window;
pub mod tag;
pub mod thread;
pub mod web;
pub mod window;

// ==================== IPC 命令 re-export ====================
//
// `tauri::generate_handler![commands::<sub>::xxx]` 在 `lib.rs::run()` 里走完整
// 路径, 所以 `pub use` re-export 不再被 IPC handler 用到。但有两个例外仍保留:
//
// - `markdown_paths_from_args` — `lib.rs:324` 在 single_instance 闭包里通过
//   `commands::markdown_paths_from_args` 调, 同样留 re-export。
//
// 其他 IPC 都通过 `commands::<sub>::xxx` 走子模块路径直接访问, 不再 re-export。
// 想加新 IPC 不用动这个文件, 跟 memo_file 拆分后的风格保持一致。

// helpers (跨模块消费, 留 re-export)
pub use helpers::markdown_paths_from_args;
