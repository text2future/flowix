//! Per-save timing, read by the desktop command layer.
//!
//! The save path runs as one synchronous call on a blocking worker thread
//! (`document_io::run` -> `spawn_blocking`), so a thread-local slot is enough:
//! the caller reads the profile on the same thread right after
//! `NoteService::save` returns. Nothing here locks, allocates on the hot path,
//! or changes behaviour.

use std::cell::RefCell;
use std::time::Duration;

/// Stage timings for a single note save.
///
/// `file_write` covers the cross-process file locks, the
/// temp-file + fsync + rename, and conflict detection.
/// `index_refresh` covers opening the index connection, the UPSERT and the
/// full-text (trigram) rebuild plus commit.
#[derive(Clone, Copy, Debug, Default)]
pub struct SaveProfile {
    pub prepare: Duration,
    pub file_write: Duration,
    pub index_refresh: Duration,
    pub read_back: Duration,
    pub total: Duration,
    pub bytes: usize,
}

impl SaveProfile {
    pub fn total_ms(&self) -> f64 {
        self.total.as_secs_f64() * 1_000.0
    }

    /// Compact JSON object, shaped for `runtime_log::record_event`.
    pub fn to_json(&self) -> String {
        let ms = |value: Duration| (value.as_secs_f64() * 1_000_000.0).round() / 1_000.0;
        format!(
            "{{\"prepareMs\":{:.3},\"fileWriteMs\":{:.3},\"indexMs\":{:.3},\"readBackMs\":{:.3},\"totalMs\":{:.3},\"bytes\":{}}}",
            ms(self.prepare),
            ms(self.file_write),
            ms(self.index_refresh),
            ms(self.read_back),
            ms(self.total),
            self.bytes,
        )
    }
}

thread_local! {
    static LAST_SAVE: RefCell<Option<SaveProfile>> = const { RefCell::new(None) };
}

pub fn record(profile: SaveProfile) {
    LAST_SAVE.with(|slot| {
        *slot.borrow_mut() = Some(profile);
    });
}

/// Take the profile for the save that just finished on this thread.
pub fn take_last() -> Option<SaveProfile> {
    LAST_SAVE.with(|slot| slot.borrow_mut().take())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_reports_millisecond_precision() {
        let profile = SaveProfile {
            prepare: Duration::from_micros(120),
            file_write: Duration::from_millis(7),
            index_refresh: Duration::from_micros(2_500),
            read_back: Duration::from_micros(300),
            total: Duration::from_micros(9_920),
            bytes: 4096,
        };
        assert_eq!(
            profile.to_json(),
            "{\"prepareMs\":0.120,\"fileWriteMs\":7.000,\"indexMs\":2.500,\"readBackMs\":0.300,\"totalMs\":9.920,\"bytes\":4096}"
        );
    }

    #[test]
    fn take_last_is_single_use_per_thread() {
        record(SaveProfile::default());
        assert!(take_last().is_some());
        assert!(take_last().is_none());
    }
}
