//! 监听器模块 — `fs_watcher.rs` 的模块化重构入口。
//!
//! 三段式架构:
//! 1. `event` — `RawFsEvent` 跨平台统一抽象
//! 2. `whitelist` — `WhitelistConfig` 可配置白/黑名单
//! 3. 后续 PR: `filter/` + `dispatcher` + `processor`
//!
//! 当前 PR1 只引入 `event` + `whitelist` 类型, 在 `fs_watcher.rs` 顶部接入
//! `WhitelistConfig::allows()` 做第一道闸; 业务处理 (register / reload /
//! unregister) 仍在 `fs_watcher.rs::handle_notify_event` 内, 保持现有行为不变。

pub mod dispatcher;
pub mod event;
pub mod filter;
pub mod path;
pub mod processor;
pub mod whitelist;

pub use event::{FsEventKind, RawFsEvent};
pub use path::normalize_for_compare;
pub use processor::MemoEventProcessor;
pub use whitelist::WhitelistConfig;
