//! Directory-reconcile timing probe (measurement only).
//!
//! A save inside a subfolder makes the OS report the parent directory as
//! modified. That single fact currently fans out to a whole-notebook reconcile
//! (collection catalog + note-index rescan request + media scan + broadcast).
//!
//! These counters exist to size that work on a real machine *before* any
//! semantics change: nothing here skips, merges, gates or reorders production
//! behaviour. Removing this module restores the previous behaviour exactly.
//!
//! Read the output from `<user config>/logs/app.log`:
//! - `event = "directory-reconcile-summary"` — one line per notebook every
//!   [`SUMMARY_EVERY`] reconciles: rate, average and worst case.
//! - `event = "slow-directory-reconcile"` — one line for a single reconcile
//!   that took at least [`SLOW_MS`], with the per-stage breakdown and how long
//!   before it the app itself finished writing a note.
//!
//! `absorbed` is the number of directory events the coalescer folded into that
//! one reconcile; compare it with `count` to see how much the burst collapsing
//! actually saves.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Per-call stage timings for one `DirectoryChange` reconcile.
#[derive(Clone, Copy, Default)]
pub struct ReconcileProfile {
    /// `refresh_view_document_catalog` (collection catalog reconcile).
    pub catalog: Duration,
    /// Enqueueing the note-index rescan request.
    pub index_request: Duration,
    /// Enqueueing the media-resource scan request.
    pub media_request: Duration,
    /// Emitting the empty-path invalidation to the frontend.
    pub broadcast: Duration,
    pub total: Duration,
    /// Directory events folded into this one call by the coalescer. `1` means
    /// the burst was a single event and coalescing saved nothing.
    pub absorbed: u32,
}

struct Totals {
    count: u64,
    first_ms: u64,
    total: Duration,
    max: Duration,
    catalog: Duration,
    /// Directory events folded into all recorded reconciles.
    absorbed: u64,
    /// Reconciles that arrived within [`ATTRIBUTED_WINDOW_MS`] of our own save.
    attributed_to_save: u64,
    last_slow_log_ms: u64,
    /// Aggregate of the `sinceSaveMs` samples that were attributable.
    since_save_sum_ms: u64,
}

impl Totals {
    fn new(now: u64) -> Self {
        Self {
            count: 0,
            first_ms: now,
            total: Duration::ZERO,
            max: Duration::ZERO,
            catalog: Duration::ZERO,
            absorbed: 0,
            attributed_to_save: 0,
            last_slow_log_ms: 0,
            since_save_sum_ms: 0,
        }
    }
}

/// One line every N reconciles per notebook keeps the log readable while still
/// exposing the rate (a saving session produces several per minute).
const SUMMARY_EVERY: u64 = 20;
/// Mirrors `document_io`'s threshold so both logs can be compared directly.
const SLOW_MS: u128 = 40;
/// A reconcile this soon after our own successful save is almost certainly
/// caused by it (atomic temp+rename bumps the parent directory entry table).
const ATTRIBUTED_WINDOW_MS: u64 = 2_000;
/// Never write more than one slow line per notebook per this window: the probe
/// must not add measurable disk work to the thread it is measuring.
const SLOW_LOG_INTERVAL_MS: u64 = 2_000;

static TOTALS: OnceLock<Mutex<HashMap<String, Totals>>> = OnceLock::new();
static LAST_NOTE_SAVE_MS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Stamp the moment a backend-owned note write settled, so a reconcile that
/// follows it can be attributed to that write instead of to an external change.
pub fn note_save_finished() {
    LAST_NOTE_SAVE_MS.store(now_ms(), Ordering::Relaxed);
}

fn millis(value: Duration) -> f64 {
    (value.as_secs_f64() * 1_000_000.0).round() / 1_000.0
}

fn average(sum: Duration, count: u64) -> f64 {
    millis(sum) / count.max(1) as f64
}

/// Record one reconcile. `directory` is the notebook-relative directory that
/// reported the change (empty for the notebook root).
pub fn record(notebook_id: &str, directory: &str, profile: ReconcileProfile) {
    let now = now_ms();
    let last_save = LAST_NOTE_SAVE_MS.load(Ordering::Relaxed);
    let since_save = (last_save != 0 && now >= last_save).then(|| now - last_save);
    let attributable = since_save.is_some_and(|elapsed| elapsed <= ATTRIBUTED_WINDOW_MS);

    tracing::debug!(
        notebook_id,
        directory,
        total_ms = millis(profile.total),
        catalog_ms = millis(profile.catalog),
        absorbed = profile.absorbed,
        since_save_ms = ?since_save,
        "directory reconcile"
    );

    let Ok(mut table) = TOTALS.get_or_init(Default::default).lock() else {
        return;
    };
    let totals = table
        .entry(notebook_id.to_owned())
        .or_insert_with(|| Totals::new(now));
    totals.count += 1;
    totals.total += profile.total;
    totals.catalog += profile.catalog;
    totals.absorbed += u64::from(profile.absorbed);
    if profile.total > totals.max {
        totals.max = profile.total;
    }
    if attributable {
        totals.attributed_to_save += 1;
        totals.since_save_sum_ms += since_save.unwrap_or(0);
    }

    let slow = profile.total.as_millis() >= SLOW_MS;
    let slow_line_due = slow && now.saturating_sub(totals.last_slow_log_ms) >= SLOW_LOG_INTERVAL_MS;
    if slow_line_due {
        totals.last_slow_log_ms = now;
    }
    let summary_line_due = totals.count % SUMMARY_EVERY == 0;
    let summary = if summary_line_due {
        let span_ms = now.saturating_sub(totals.first_ms).max(1);
        let per_minute = totals.count as f64 * 60_000.0 / span_ms as f64;
        Some((
            totals.count,
            average(totals.total, totals.count),
            millis(totals.max),
            average(totals.catalog, totals.count),
            totals.absorbed,
            totals.attributed_to_save,
            if totals.attributed_to_save == 0 {
                0.0
            } else {
                totals.since_save_sum_ms as f64 / totals.attributed_to_save as f64
            },
            per_minute,
        ))
    } else {
        None
    };
    drop(table);

    if slow_line_due {
        crate::runtime_log::record_event(
            "warn",
            "slow-directory-reconcile",
            format!(
                "{{\"notebookId\":{},\"directory\":{},\"catalogMs\":{:.3},\"indexRequestMs\":{:.3},\"mediaRequestMs\":{:.3},\"broadcastMs\":{:.3},\"totalMs\":{:.3},\"absorbed\":{},\"sinceSaveMs\":{}}}",
                json_string(notebook_id),
                json_string(directory),
                millis(profile.catalog),
                millis(profile.index_request),
                millis(profile.media_request),
                millis(profile.broadcast),
                millis(profile.total),
                profile.absorbed,
                since_save.map_or("null".to_owned(), |value| value.to_string()),
            ),
        );
    }

    if let Some((
        count,
        avg_total,
        max,
        avg_catalog,
        absorbed,
        attributed,
        avg_since_save,
        per_minute,
    )) = summary
    {
        crate::runtime_log::record_event(
            "info",
            "directory-reconcile-summary",
            format!(
                "{{\"notebookId\":{},\"count\":{},\"perMinute\":{:.2},\"avgTotalMs\":{:.3},\"maxTotalMs\":{:.3},\"avgCatalogMs\":{:.3},\"absorbed\":{},\"attributedToOwnSave\":{},\"avgSinceSaveMs\":{:.0}}}",
                json_string(notebook_id),
                count,
                per_minute,
                avg_total,
                max,
                avg_catalog,
                absorbed,
                attributed,
                avg_since_save,
            ),
        );
    }
}

/// Which background maintenance pass finished.
#[derive(Clone, Copy)]
pub enum ScanKind {
    NoteIndex,
    Media,
}

impl ScanKind {
    fn label(self) -> &'static str {
        match self {
            Self::NoteIndex => "note-index",
            Self::Media => "media",
        }
    }
}

struct ScanTotals {
    count: u64,
    first_ms: u64,
    total: Duration,
    max: Duration,
    reruns: u64,
    last_slow_log_ms: u64,
}

static SCAN_TOTALS: OnceLock<Mutex<HashMap<String, ScanTotals>>> = OnceLock::new();

/// Index scans settle once per request, and a settled scan enqueues a media
/// scan, so this is the number that shows whether a typing session is driving
/// repeated whole-notebook maintenance.
const SCAN_SUMMARY_EVERY: u64 = 10;
const SCAN_SLOW_MS: u128 = 500;

/// Record one finished background maintenance pass.
pub fn record_background_scan(
    kind: ScanKind,
    notebook_id: &str,
    elapsed: Duration,
    files_checked: u64,
    rerun: bool,
) {
    let now = now_ms();
    let key = format!("{}\u{0}{}", notebook_id, kind.label());
    let Ok(mut table) = SCAN_TOTALS.get_or_init(Default::default).lock() else {
        return;
    };
    let totals = table.entry(key).or_insert_with(|| ScanTotals {
        count: 0,
        first_ms: now,
        total: Duration::ZERO,
        max: Duration::ZERO,
        reruns: 0,
        last_slow_log_ms: 0,
    });
    totals.count += 1;
    totals.total += elapsed;
    if elapsed > totals.max {
        totals.max = elapsed;
    }
    if rerun {
        totals.reruns += 1;
    }

    let slow = elapsed.as_millis() >= SCAN_SLOW_MS;
    let slow_line_due = slow && now.saturating_sub(totals.last_slow_log_ms) >= SLOW_LOG_INTERVAL_MS;
    if slow_line_due {
        totals.last_slow_log_ms = now;
    }
    let summary = (totals.count % SCAN_SUMMARY_EVERY == 0).then(|| {
        let span_ms = now.saturating_sub(totals.first_ms).max(1);
        (
            totals.count,
            millis(totals.total) / totals.count as f64,
            millis(totals.max),
            totals.reruns,
            totals.count as f64 * 60_000.0 / span_ms as f64,
        )
    });
    drop(table);

    if slow_line_due {
        crate::runtime_log::record_event(
            "warn",
            "slow-background-scan",
            format!(
                "{{\"notebookId\":{},\"kind\":\"{}\",\"elapsedMs\":{:.3},\"filesChecked\":{},\"rerun\":{}}}",
                json_string(notebook_id),
                kind.label(),
                millis(elapsed),
                files_checked,
                rerun,
            ),
        );
    }

    if let Some((count, avg_ms, max_ms, reruns, per_minute)) = summary {
        crate::runtime_log::record_event(
            "info",
            "background-scan-summary",
            format!(
                "{{\"notebookId\":{},\"kind\":\"{}\",\"count\":{},\"perMinute\":{:.2},\"avgMs\":{:.1},\"maxMs\":{:.1},\"reruns\":{}}}",
                json_string(notebook_id),
                kind.label(),
                count,
                per_minute,
                avg_ms,
                max_ms,
                reruns,
            ),
        );
    }
}

/// Minimal JSON string escaping: paths and notebook ids only, so the full
/// table is unnecessary, but quotes and backslashes must not break the line.
fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if (control as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", control as u32));
            }
            other => out.push(other),
        }
    }
    out.push('"');
    out
}
