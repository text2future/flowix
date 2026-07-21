//! Path-based whitelist filter.
//!
//! This stage combines extension, skip-dir, skip-file, hidden-file and size
//! checks through `WhitelistConfig::allows`.

use std::sync::Arc;

use crate::watcher::event::{FilterDecision, RawFsEvent};
use crate::watcher::filter::{Filter, FilterCtx};
use crate::watcher::whitelist::WhitelistConfig;

/// 娈?1: 璺緞鐧藉悕鍗曘€傞泦鎴?WhitelistConfig (鎵╁睍鍚?+ skip_dirs + skip_files +
/// 闅愯棌鏂囦欢 + max_file_size) 鍒颁竴娆″喅瀹氶噷銆?
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
