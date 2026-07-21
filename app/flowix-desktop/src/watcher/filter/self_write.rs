//! Self-write suppression filter.
//!
//! Paths marked through `MemoWatcher::mark_self_write` are dropped for the TTL
//! window so one backend write can suppress multiple notify events.

use crate::watcher::event::{DropReason, FilterDecision, RawFsEvent};
use crate::watcher::filter::{Filter, FilterCtx, SELF_WRITE_TTL};

/// 娈?2: 鑷啓鎶戝埗銆俙mark_self_write` 鍐欒繃鐨勮矾寰? 鍛戒腑鍗冲悶銆?
pub struct SelfWriteSuppressor;

impl Filter for SelfWriteSuppressor {
    fn decide(&self, event: &RawFsEvent, ctx: &mut FilterCtx) -> FilterDecision {
        let key = crate::watcher::path::normalize_for_compare(&event.path);
        let Ok(mut map) = ctx.recent_self_writes.lock() else {
            return FilterDecision::Pass;
        };
        // 椤烘墜鍓灊杩囪€佹潯鐩€係ELF_WRITE_TTL (2s) 瑕嗙洊 IPC 鍛戒护缁撴潫 鈫?notify
        // 鍥炶皟鍒拌揪鐨勯棿闅? FSEvents 鍙岃Е鍙?(macOS 鎶婁竴娆?fs::write 鎷嗘垚
        // Metadata(Any) + Data(Content) 涓ゆ潯 Modify) 涔熼兘鍦ㄧ獥鍐呫€?        map.retain(|_, t| t.elapsed() < SELF_WRITE_TTL);

        // 涓?remove 琛ㄩ」 鈥?FSEvents 鍙岃Е鍙戜袱鏉′簨浠堕兘瑕佸悶, remove 鍚庣浜屾潯
        // 浼?MISS 婕忓埌 processor 璧?"澶栭儴淇敼" 璺緞銆?琛ㄩ」鐢变笂闈㈢殑 retain
        // 璧?2s TTL 鍏滃簳娓呯悊, 涓嶄細鏃犻檺鍗犱綅銆?
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
