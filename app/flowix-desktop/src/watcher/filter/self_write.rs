//! Self-write suppression filter.
//!
//! Paths marked through `MemoWatcher::mark_self_write` are dropped for the TTL
//! window so one backend write can suppress multiple notify events.

use crate::watcher::event::{DropReason, FilterDecision, RawFsEvent};
use crate::watcher::filter::{Filter, FilterCtx, SELF_WRITE_TTL};

/// 段 2: 自写抑制。`mark_self_write` 写过的路径, 命中即吞。
pub struct SelfWriteSuppressor;

impl Filter for SelfWriteSuppressor {
    fn decide(&self, event: &RawFsEvent, ctx: &mut FilterCtx) -> FilterDecision {
        let key = crate::watcher::path::normalize_for_compare(&event.path);
        let Ok(mut map) = ctx.recent_self_writes.lock() else {
            return FilterDecision::Pass;
        };
        // 顺手剪枝过老条目。SELF_WRITE_TTL (2s) 覆盖 IPC 命令结束 → notify
        // 回调到达的间隔, FSEvents 双触发 (macOS 把一次 fs::write 拆成
        // Metadata(Any) + Data(Content) 两条 Modify) 也都在窗内。
        map.retain(|_, t| t.elapsed() < SELF_WRITE_TTL);

        // 不 remove 表项 — FSEvents 双触发两条事件都要吞, remove 后第二条
        // 会 MISS 漏到 processor 走 "外部修改" 路径。 表项由上面的 retain
        // 走 2s TTL 兜底清理, 不会无限占位。
        if map.contains_key(&key) {
            tracing::debug!(
                "[SelfWriteSuppressor] HIT path={} key={} table_size={}",
                event.path.display(),
                key.display(),
                map.len(),
            );
            FilterDecision::Drop {
                reason: DropReason::SelfWriteSuppressed,
            }
        } else {
            tracing::debug!(
                "[SelfWriteSuppressor] MISS path={} key={} table_size={}",
                event.path.display(),
                key.display(),
                map.len(),
            );
            FilterDecision::Pass
        }
    }
}
