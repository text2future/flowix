//! Path-level debounce filter.
//!
//! Multiple notify events for the same path inside the debounce window are
//! dropped before reaching the memo processor.

use std::time::Instant;

use crate::watcher::event::{DropReason, FilterDecision, RawFsEvent};
use crate::watcher::filter::{Filter, FilterCtx, DEBOUNCE};

/// 娈?3: 璺緞闃叉姈銆?50ms 鍐呭悓璺緞浜嬩欢鍚炪€?
pub struct Debouncer;

impl Filter for Debouncer {
    fn decide(&self, event: &RawFsEvent, ctx: &mut FilterCtx) -> FilterDecision {
        let key = crate::watcher::path::normalize_for_compare(&event.path);
        let Ok(mut map) = ctx.last_emit.lock() else {
            return FilterDecision::Pass;
        };
        // 1.5s 婊氬姩绐楀彛 (DEBOUNCE * 10) 淇濈暀, 閬垮厤闃叉姈琛ㄩ暱鏈熷闀裤€?        map.retain(|_, t| t.elapsed() < DEBOUNCE.saturating_mul(10));
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
