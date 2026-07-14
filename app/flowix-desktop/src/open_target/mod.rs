//! 全局"通过链接打开笔记"模块 — 覆盖 3 个场景:
//!
//! 1. 外部深链 `flowix://memo/<id>` (浏览器 / 终端 / 其它 app 触发, 冷启动 + 二次启动)
//! 2. 产品内物理路径 (e.g. `/Users/.../xxx#vex4v.md`)
//! 3. 产品内深链 (Agent 输出 / 跨窗口 / 复制粘贴)
//!
//! ## 分层
//!
//! - [`parser`]    — 纯字符串解析 (URL / 物理路径 → [`OpenTarget`])。 无副作用。
//! - [`resolver`]  — [`OpenTarget`] → [`ResolvedOpenTarget`] (查磁盘, 跨 notebook)。
//! - [`handler`]   — `#[tauri::command] open_memo_by_target` + emit `flowix:open-target`。
//!
//! ## URL scheme
//!
//! - `flowix://memo/<6-char-id>`            — 主要场景
//! - `flowix://memo/<6-char-id>?nb=<nid>`   — 跨 notebook hint
//! - `flowix://open?path=<encoded-abs>`     — 物理路径 (内部走 id 抽)
//!
//! 后端 IPC 命令接收**任意**标识符形态 (URL / 物理路径), 内部经 [`parse_open_target`]
//! 规整成 [`OpenTarget`], 经 [`resolve_open_target`] 拿到 [`ResolvedOpenTarget`],
//! 推 `flowix:open-target` 事件给前端。 前端做"切换 notebook + 打开 document"。

pub mod handler;
pub mod parser;
pub mod resolver;

// Re-exports 留给测试 / 文档用, 真正注册到 Tauri IPC 的 `open_memo_by_target`
// 在 `lib.rs` 走完整路径 `open_target::handler::open_memo_by_target`, 这样
// `#[tauri::command]` 宏生成的 `__cmd__` 兄弟符号才能被 `generate_handler!` 找到。
#[allow(unused_imports)]
pub use parser::{parse_open_target, OpenTarget, OpenTargetError};
#[allow(unused_imports)]
pub use resolver::{resolve_open_target, ResolveError, ResolvedOpenTarget};
