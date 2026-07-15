//! Path-level debounce filter.
//!
//! Multiple notify events for the same path inside the debounce window are
//! dropped before reaching the memo processor.

use std::time::Instant;

use crate::watcher::event::{DropReason, FilterDecision, RawFsEvent};
use crate::watcher::filter::{Filter, FilterCtx, DEBOUNCE};

/// 段 3: 路径防抖。150ms 内同路径事件吞。
pub struct Debouncer;

impl Filter for Debouncer {
    fn decide(&self, event: &RawFsEvent, ctx: &mut FilterCtx) -> FilterDecision {
        let key = crate::watcher::path::normalize_for_compare(&event.path);
        let Ok(mut map) = ctx.last_emit.lock() else {
            return FilterDecision::Pass;
        };
        // 1.5s 滚动窗口 (DEBOUNCE * 10) 保留, 避免防抖表长期增长。
        map.retain(|_, t| t.elapsed() < DEBOUNCE.saturating_mul(10));
        if let Some(last) = map.get(&key) {
            if last.elapsed() < DEBOUNCE {
                return FilterDecision::Drop {
                    reason: DropReason::Debounced,
                };
            }
        }
        map.insert(key, Instant::now());
        FilterDecision::Pass
    }
}
