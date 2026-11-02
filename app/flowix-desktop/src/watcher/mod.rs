//! 笔�?�?��监听模块�?//!
//! 妯″潡杈圭晫:
//! - `manager` 持有 `notify::RecommendedWatcher` 生命周期, 采集原�?文件事件�?//! - `event` 提供跨平�?`RawFsEvent` / `FsEventKind` 抽象�?//! - `filter` 负责 whitelist / self-write / debounce 三�?过滤�?//! - `processor` 把通过过滤的事件分流成 memo register / reload / unregister�?//! - `runtime` 提供�?Tauri state 访问当前 watcher 的窄接口�?
mod directory_coalesce;
pub mod event;
pub mod filter;
pub mod manager;
pub mod path;
pub mod probe;
pub mod processor;
mod rename_tracker;
pub mod runtime;
pub mod tombstone;
pub mod whitelist;

pub use event::{FsEventKind, RawFsEvent};
pub use manager::MemoWatcher;
pub use path::normalize_for_compare;
pub use processor::{NotebookWatchContext, PathNoteEventProcessor};
pub use runtime::current_watcher;
pub use whitelist::WhitelistConfig;
