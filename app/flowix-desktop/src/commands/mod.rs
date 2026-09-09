//! Tauri IPC 命令总入�?—按业务域拆分到子模块�?//!
//! ## 拆分 (v2 —2026/06 重构)
//!
//! �?`commands.rs` 单文�?1645 �? 52 �?`#[tauri::command]` �?12 �?��务域
//! 混在一起。拆�?
//!
//! - [`mod@helpers`]   —跨域 helper (索引 / notebook 切换 / �?�� scope / �?��抑制 / markdown 解析)
//! - [`mod@settings`]  —`~/.flowix/boot/preference.json` + DSH settings 读写
//! - [`mod@kv`]        鈥? notebook `.flowix/system.json` metadata (legacy global migration)
//! - [`mod@memo`]      —笔�? CRUD + 搜索 + Doc 合并(�?memo index / .md 文件的全进这)
//! - [`mod@tag`]       —tag 派生 + (todo: 增删�?stub)
//! - [`mod@notebook`]  —notebook 切换 / 增删 / CRUD
//! - [`mod@file`]      —任意文件�?in-notebook tree / read / write
//! - [`mod@dialog`]    —原生 dialog + 附件保存 + base64
//! - [`mod@agent`]     —LLM 流式 chat + abort
//! - [`mod@thread`]    —对话线程 CRUD
//! - [`mod@window`]    —preferences 窗口打开/聚焦
//!
//! ## 鍏叡 API 淇濇寔涓嶅彉
//!
//! `tauri::generate_handler![commands::xxx, ...]` (lib.rs:347-402) 涓?//! `crate::watcher::current_watcher` / `crate::commands::markdown_paths_from_args`
//! 的引用路�?*全部不变** —�?���?`pub use` 把每�?��模块�?IPC 函数重新
//! 暴露�?`commands::xxx` 命名空间�?//!
//! ## `AppState` �?���?IPC 命令的共�?���?//!
//! 子模块通过 [`crate::app::state::AppState`] 访问, 字�?�?`pub`, 各域
//! �??约定"�?vs �? —例�? `memo_file` 写命令必�?`write()`, 读命�?`read()`�?
// ==================== 子模�?====================

// 子模块一�?`pub` —`tauri::generate_handler![commands::<sub>::xxx]` �?// `lib.rs::run()` 里走完整�?��, 需�?`pub` �??性。`#[tauri::command]` �?// 生成�?`__cmd__xxx` 兄弟宏也要求子模块是 `pub`, 否则宏解析不到�?
pub mod agent;
pub mod agent_access;
pub mod artifact;
pub mod boot;
pub mod cli;
pub mod cloud;
pub mod dialog;
pub mod dsh;
pub mod external_document;
pub mod external_document_watch;
pub mod file;
pub mod file_browser_watch;
pub mod font;
pub mod helpers;
pub mod kv;
pub mod memo;
pub mod notebook;
pub mod plugin;
pub mod product;
pub mod settings;
pub mod tag;
pub mod thread;
pub mod web;
pub mod window;

// ==================== IPC 鍛戒护 re-export ====================
//
// `tauri::generate_handler![commands::<sub>::xxx]` �?`lib.rs::run()` 里走完整
// �?��, 所�?`pub use` re-export 不再�?IPC handler 用到。但有两�?��外仍保留:
//
// - `markdown_paths_from_args` —`lib.rs:324` �?single_instance �?��里通过
//   `commands::markdown_paths_from_args` �? 同样�?re-export�?//
// 其他 IPC 都通过 `commands::<sub>::xxx` 走子模块�?��直接访问, 不再 re-export�?// 想加�?IPC 不用动这�?���? �?memo_file 拆分后的风格保持一致�?
// helpers (跨模块消�? �?re-export)
pub use helpers::markdown_paths_from_args;
