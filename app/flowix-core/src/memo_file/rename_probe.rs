//! Per-rename timing, read by the desktop command layer.
//!
//! Rename is the only structural mutation that holds the cross-process
//! notebook lock while touching both the filesystem and the index, so its cost
//! decides two things that are easy to guess wrong: whether the exclusive
//! window is long enough to make concurrent saves time out, and whether the
//! index rebase is actually the expensive part or just folklore.
//!
//! Same shape as [`super::save_probe`]: a thread-local slot written by
//! `rename_indexed_path` and read by `commands/file/transfer.rs` on the same
//! thread immediately after. Nothing here locks, allocates on the hot path, or
//! changes behaviour — deleting the module restores the previous behaviour
//! exactly.

use std::cell::RefCell;
use std::time::Duration;

/// Stage timings for one `rename_indexed_path` call.
///
/// `structure_lock_wait` is time spent waiting for the cross-process exclusive
/// notebook lock — the window in which a concurrent save would block or time
/// out. `fs_move` is the actual `rename(2)`. `index_rebase` is everything else
/// inside that exclusive window (in-process index lock, validation queries,
/// every SQL rebase — notes, resources, collections, registry — and the
/// per-notebook resource-catalog updates), so the three add up to `total`.
#[derive(Clone, Copy, Debug, Default)]
pub struct RenameProfile {
    pub structure_lock_wait: Duration,
    pub fs_move: Duration,
    pub index_rebase: Duration,
    pub total: Duration,
}

impl RenameProfile {
    pub fn total_ms(&self) -> f64 {
        self.total.as_secs_f64() * 1_000.0
    }

    /// Compact JSON object, shaped for `runtime_log::record_event`.
    ///
    /// `tail` is the caller's share: everything `rename_indexed_path` does not
    /// cover (pre-flight config reads, watcher claim, collection catalog
    /// refresh, maintenance enqueue). Keeping it in one line is what makes
    /// "where did the 300ms go" answerable without a profiler.
    pub fn to_json(&self, tail: Duration, directory: bool) -> String {
        let ms = |value: Duration| (value.as_secs_f64() * 1_000_000.0).round() / 1_000.0;
        format!(
            "{{\"lockWaitMs\":{:.3},\"fsMoveMs\":{:.3},\"indexMs\":{:.3},\"coreMs\":{:.3},\"tailMs\":{:.3},\"totalMs\":{:.3},\"directory\":{}}}",
            ms(self.structure_lock_wait),
            ms(self.fs_move),
            ms(self.index_rebase),
            ms(self.total),
            ms(tail),
            ms(self.total + tail),
            directory,
        )
    }
}

thread_local! {
    static LAST_RENAME: RefCell<Option<RenameProfile>> = const { RefCell::new(None) };
}

pub fn record(profile: RenameProfile) {
    LAST_RENAME.with(|slot| {
        *slot.borrow_mut() = Some(profile);
    });
}

/// Take the profile for the rename that just finished on this thread.
pub fn take_last() -> Option<RenameProfile> {
    LAST_RENAME.with(|slot| slot.borrow_mut().take())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_reports_millisecond_precision_and_splits_the_total() {
        let profile = RenameProfile {
            structure_lock_wait: Duration::from_micros(120),
            fs_move: Duration::from_millis(1),
            index_rebase: Duration::from_micros(2_500),
            total: Duration::from_millis(4),
        };
        assert_eq!(
            profile.to_json(Duration::from_millis(6), true),
            "{\"lockWaitMs\":0.120,\"fsMoveMs\":1.000,\"indexMs\":2.500,\"coreMs\":4.000,\"tailMs\":6.000,\"totalMs\":10.000,\"directory\":true}"
        );
    }

    #[test]
    fn take_last_is_single_use_per_thread() {
        record(RenameProfile::default());
        assert!(take_last().is_some());
        assert!(take_last().is_none());
    }
}
