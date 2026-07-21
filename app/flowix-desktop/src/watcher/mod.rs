//! 绗旇鐩綍鐩戝惉妯″潡銆?//!
//! 妯″潡杈圭晫:
//! - `manager` 鎸佹湁 `notify::RecommendedWatcher` 鐢熷懡鍛ㄦ湡, 閲囬泦鍘熷鏂囦欢浜嬩欢銆?//! - `event` 鎻愪緵璺ㄥ钩鍙?`RawFsEvent` / `FsEventKind` 鎶借薄銆?//! - `filter` 璐熻矗 whitelist / self-write / debounce 涓夋杩囨护銆?//! - `processor` 鎶婇€氳繃杩囨护鐨勪簨浠跺垎娴佹垚 memo register / reload / unregister銆?//! - `runtime` 鎻愪緵浠?Tauri state 璁块棶褰撳墠 watcher 鐨勭獎鎺ュ彛銆?
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
