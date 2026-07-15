//! 笔记目录监听模块。
//!
//! 模块边界:
//! - `manager` 持有 `notify::RecommendedWatcher` 生命周期, 采集原始文件事件。
//! - `event` 提供跨平台 `RawFsEvent` / `FsEventKind` 抽象。
//! - `filter` 负责 whitelist / self-write / debounce 三段过滤。
//! - `processor` 把通过过滤的事件分流成 memo register / reload / unregister。
//! - `runtime` 提供从 Tauri state 访问当前 watcher 的窄接口。

pub mod event;
pub mod filter;
pub mod manager;
pub mod path;
pub mod processor;
pub mod runtime;
pub mod tombstone;
pub mod whitelist;

pub use event::{FsEventKind, RawFsEvent};
pub use manager::MemoWatcher;
pub use path::normalize_for_compare;
pub use processor::{MemoEventProcessor, NotebookWatchContext};
pub use runtime::current_watcher;
pub use whitelist::WhitelistConfig;
