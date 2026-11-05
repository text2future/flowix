//! Pure verdict logic for the window responsiveness probes.
//!
//! Deliberately dependency-free (std only) so the thresholds and transitions can
//! be exercised without a window, a clock or a Tauri runtime.

use std::time::{Duration, Instant};

/// A visible, restored window that has not reported for this long is stalled.
/// Four missed beats at the frontend interval; long enough to ignore a slow
/// frame or a GC pause, short enough to catch the failure while it happens.
pub(crate) const RENDERER_STALL: Duration = Duration::from_secs(8);
/// A restored window is not judged while it is still painting its first frame.
const RESTORE_GRACE: Duration = Duration::from_secs(5);
/// Before the first heartbeat there is no baseline to compare against; a window
/// that never reports at all is only judged once the frontend had time to boot.
const STARTUP_GRACE: Duration = Duration::from_secs(30);
/// A renderer stall must be seen twice in a row before it is reported. The
/// heartbeat is delivered through the same message loop, so a busy UI thread
/// also silences it; one extra tick lets a recovered pump flush its backlog
/// instead of logging a stall that never happened.
const STALL_CONFIRM_TICKS: u8 = 2;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Verdict {
    Healthy,
    UiThreadHung,
    RendererStalled,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Snapshot {
    pub(crate) ui_pumping: bool,
    pub(crate) minimized: bool,
    pub(crate) visible: bool,
    pub(crate) heartbeat_gap: Option<Duration>,
    pub(crate) since_restore: Option<Duration>,
    pub(crate) startup_age: Duration,
}

/// Pure decision so the thresholds stay testable without a window or a clock.
pub(crate) fn classify(snapshot: &Snapshot) -> Verdict {
    if !snapshot.ui_pumping {
        return Verdict::UiThreadHung;
    }
    // A minimized or hidden window is not expected to paint; silence there is
    // normal and must never be reported as a stall.
    if snapshot.minimized || !snapshot.visible {
        return Verdict::Healthy;
    }
    if snapshot
        .since_restore
        .is_some_and(|age| age < RESTORE_GRACE)
    {
        return Verdict::Healthy;
    }
    match snapshot.heartbeat_gap {
        Some(gap) if gap > RENDERER_STALL => Verdict::RendererStalled,
        Some(_) => Verdict::Healthy,
        // No beat has ever arrived. Report only after the frontend had a fair
        // chance to mount, otherwise every cold start looks like a stall.
        None if snapshot.startup_age > STARTUP_GRACE => Verdict::RendererStalled,
        None => Verdict::Healthy,
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Observation {
    pub(crate) verdict: Verdict,
    pub(crate) previous: Verdict,
    /// The window entered the minimized state on this tick (not "is minimized").
    pub(crate) became_minimized: bool,
    /// The window left the minimized state on this tick.
    pub(crate) became_restored: bool,
    pub(crate) heartbeat_gap: Option<Duration>,
    pub(crate) since_restore: Option<Duration>,
    pub(crate) verdict_age: Option<Duration>,
}

pub(crate) struct Tracker {
    verdict: Verdict,
    verdict_since: Option<Instant>,
    minimized: bool,
    started: Instant,
    restored_at: Option<Instant>,
    stall_ticks: u8,
}

impl Tracker {
    pub(crate) fn new(started: Instant) -> Self {
        Self {
            verdict: Verdict::Healthy,
            verdict_since: None,
            minimized: false,
            started,
            restored_at: None,
            stall_ticks: 0,
        }
    }

    pub(crate) fn observe(
        &mut self,
        now: Instant,
        ui_pumping: bool,
        minimized: bool,
        visible: bool,
        heartbeat: Option<Instant>,
    ) -> Observation {
        let became_minimized = minimized && !self.minimized;
        let became_restored = !minimized && self.minimized;
        self.minimized = minimized;
        if became_restored {
            self.restored_at = Some(now);
        }

        let snapshot = Snapshot {
            ui_pumping,
            minimized,
            visible,
            heartbeat_gap: heartbeat.map(|at| now.saturating_duration_since(at)),
            since_restore: self.restored_at.map(|at| now.saturating_duration_since(at)),
            startup_age: now.saturating_duration_since(self.started),
        };
        let evaluated = classify(&snapshot);
        if evaluated == Verdict::RendererStalled {
            self.stall_ticks = self.stall_ticks.saturating_add(1);
        } else {
            self.stall_ticks = 0;
        }
        let verdict = if self.stall_ticks >= STALL_CONFIRM_TICKS {
            evaluated
        } else if evaluated == Verdict::RendererStalled {
            Verdict::Healthy
        } else {
            evaluated
        };
        let previous = std::mem::replace(&mut self.verdict, verdict);
        if previous != verdict {
            self.verdict_since = (verdict != Verdict::Healthy).then_some(now);
        }
        Observation {
            verdict,
            previous,
            became_minimized,
            became_restored,
            heartbeat_gap: snapshot.heartbeat_gap,
            since_restore: snapshot.since_restore,
            verdict_age: self.verdict_since.map(|at| now.saturating_duration_since(at)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(gap: Option<Duration>, since_restore: Option<Duration>) -> Snapshot {
        Snapshot {
            ui_pumping: true,
            minimized: false,
            visible: true,
            heartbeat_gap: gap,
            since_restore,
            startup_age: Duration::from_secs(120),
        }
    }

    #[test]
    fn a_blocked_ui_thread_wins_over_any_renderer_verdict() {
        let verdict = classify(&Snapshot {
            ui_pumping: false,
            ..snapshot(Some(Duration::from_secs(60)), None)
        });
        assert_eq!(verdict, Verdict::UiThreadHung);
    }

    #[test]
    fn silence_while_minimized_or_hidden_is_not_a_stall() {
        let minimized = classify(&Snapshot {
            minimized: true,
            heartbeat_gap: Some(Duration::from_secs(600)),
            ..snapshot(None, None)
        });
        assert_eq!(minimized, Verdict::Healthy);
        let hidden = classify(&Snapshot {
            visible: false,
            heartbeat_gap: Some(Duration::from_secs(600)),
            ..snapshot(None, None)
        });
        assert_eq!(hidden, Verdict::Healthy);
    }

    #[test]
    fn stall_threshold_is_strict() {
        assert_eq!(
            classify(&snapshot(Some(RENDERER_STALL), None)),
            Verdict::Healthy
        );
        assert_eq!(
            classify(&snapshot(Some(RENDERER_STALL + Duration::from_millis(1)), None)),
            Verdict::RendererStalled
        );
    }

    #[test]
    fn a_window_that_never_pings_is_only_judged_after_startup() {
        let cold = Snapshot {
            startup_age: Duration::from_secs(10),
            ..snapshot(None, None)
        };
        assert_eq!(classify(&cold), Verdict::Healthy);
        let booted = Snapshot {
            startup_age: STARTUP_GRACE + Duration::from_secs(1),
            ..snapshot(None, None)
        };
        assert_eq!(classify(&booted), Verdict::RendererStalled);
    }

    #[test]
    fn restore_ignores_the_silence_that_happened_while_minimized() {
        let t0 = Instant::now();
        let mut tracker = Tracker::new(t0);
        let beat = t0;
        // Minimized for ten minutes: no beats, but no verdict either.
        tracker.observe(t0 + Duration::from_secs(1), true, true, false, Some(beat));
        let restored =
            tracker.observe(t0 + Duration::from_secs(601), true, false, true, Some(beat));
        assert!(restored.became_restored);
        assert_eq!(restored.verdict, Verdict::Healthy);
        // Past the grace window the renderer still has not answered; the first
        // suspicious tick is only a candidate, the second one confirms it.
        let suspicious =
            tracker.observe(t0 + Duration::from_secs(607), true, false, true, Some(beat));
        assert_eq!(suspicious.verdict, Verdict::Healthy);
        let stalled =
            tracker.observe(t0 + Duration::from_secs(608), true, false, true, Some(beat));
        assert_eq!(stalled.verdict, Verdict::RendererStalled);
        assert_ne!(stalled.previous, stalled.verdict);
    }

    #[test]
    fn a_single_silent_tick_is_not_reported_as_a_stall() {
        let t0 = Instant::now();
        let mut tracker = Tracker::new(t0);
        let silent = tracker.observe(t0 + Duration::from_secs(30), true, false, true, Some(t0));
        assert_eq!(silent.verdict, Verdict::Healthy);
        // A backlog flushed right after a busy UI thread must clear the count.
        let resumed = tracker.observe(
            t0 + Duration::from_secs(31),
            true,
            false,
            true,
            Some(t0 + Duration::from_secs(31)),
        );
        assert_eq!(resumed.verdict, Verdict::Healthy);
        let silent_again =
            tracker.observe(t0 + Duration::from_secs(40), true, false, true, Some(t0 + Duration::from_secs(31)));
        assert_eq!(silent_again.verdict, Verdict::Healthy);
    }

    #[test]
    fn a_renderer_that_resumes_clears_the_stall() {
        let t0 = Instant::now();
        let mut tracker = Tracker::new(t0);
        tracker.observe(t0 + Duration::from_secs(1), true, false, true, Some(t0));
        let suspicious = tracker.observe(t0 + Duration::from_secs(20), true, false, true, Some(t0));
        assert_eq!(suspicious.verdict, Verdict::Healthy);
        let stalled = tracker.observe(t0 + Duration::from_secs(21), true, false, true, Some(t0));
        assert_eq!(stalled.verdict, Verdict::RendererStalled);
        let recovered = tracker.observe(
            t0 + Duration::from_secs(22),
            true,
            false,
            true,
            Some(t0 + Duration::from_secs(22)),
        );
        assert_eq!(recovered.verdict, Verdict::Healthy);
        assert_ne!(recovered.previous, recovered.verdict);
        assert_eq!(recovered.verdict_age, None);
    }

    #[test]
    fn minimize_and_restore_are_reported_once_per_transition() {
        let t0 = Instant::now();
        let mut tracker = Tracker::new(t0);
        assert!(tracker.observe(t0, true, true, false, None).became_minimized);
        assert!(
            !tracker
                .observe(t0 + Duration::from_secs(1), true, true, false, None)
                .became_minimized
        );
        assert!(
            tracker
                .observe(t0 + Duration::from_secs(2), true, false, true, None)
                .became_restored
        );
        assert!(
            !tracker
                .observe(t0 + Duration::from_secs(3), true, false, true, None)
                .became_restored
        );
    }
}
