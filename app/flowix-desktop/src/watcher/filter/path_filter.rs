//! Path-based whitelist filter.
//!
//! This stage combines extension, skip-dir, skip-file, hidden-file and size
//! checks through `WhitelistConfig::allows`.

use std::sync::Arc;

use crate::watcher::event::{FilterDecision, RawFsEvent};
use crate::watcher::filter::{Filter, FilterCtx};
use crate::watcher::whitelist::WhitelistConfig;

/// 段 1: 路径白名单。集成 WhitelistConfig (扩展名 + skip_dirs + skip_files +
/// 隐藏文件 + max_file_size) 到一次决定里。
pub struct PathFilter {
    pub whitelist: Arc<std::sync::RwLock<WhitelistConfig>>,
}

impl Filter for PathFilter {
    fn decide(&self, event: &RawFsEvent, _ctx: &mut FilterCtx) -> FilterDecision {
        let allow = self
            .whitelist
            .read()
            .map(|g| g.allows(&event.path))
            .unwrap_or(Ok(()));
        match allow {
            Ok(()) => FilterDecision::Pass,
            Err(reason) => FilterDecision::Drop { reason },
        }
    }
}
