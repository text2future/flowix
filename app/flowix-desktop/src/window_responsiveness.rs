//! Liveness probes for the main window: native message pump and renderer.
//!
//! Diagnostics only. Nothing here changes behaviour, blocks input or recovers
//! the UI; the module exists so that an intermittent "the window stopped
//! responding after restore" report leaves evidence in `app.log` instead of a
//! screenshot.
//!
//! Two independent signals are required because the symptom is ambiguous on its
//! own: a frozen renderer keeps the native message pump alive (so Windows never
//! shows a "not responding" dialog and nothing is repainted), while a blocked
//! UI thread also stops delivering input and `CloseRequested`. Logging only the
//! renderer heartbeat cannot tell those apart, and logging only the pump cannot
//! see a hung renderer.
//!
//! See `docs/WINDOW-RESPONSIVENESS.md`.

#[path = "window_responsiveness_signals.rs"]
mod signals;

use std::{
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use signals::{Observation, Tracker, Verdict};

const PROBE_INTERVAL: Duration = Duration::from_secs(1);
const UI_PROBE_TIMEOUT_MS: u32 = 1_000;
/// One missed synchronous probe is a busy UI thread; two in a row is a hang.
const UI_PROBE_MISSES: u8 = 2;
const MAIN_WINDOW: &str = "main";

/// One renderer is monitored per process: the probe thread, the heartbeat slot
/// and the native window handle all describe the same window.
static MONITORED: OnceLock<String> = OnceLock::new();

fn monitored_label() -> &'static str {
    MONITORED.get().map_or(MAIN_WINDOW, String::as_str)
}

/// Auxiliary windows render the same bundle; their beats must never stand in
/// for the monitored renderer.
pub(crate) fn is_monitored(label: &str) -> bool {
    label == monitored_label()
}

#[derive(Clone, Copy)]
struct Beat {
    at: Instant,
    /// Only read on platforms without a native window probe, where the renderer
    /// is the only source of "this window is minimized".
    #[cfg_attr(windows, allow(dead_code))]
    hidden: bool,
}

fn beat_slot() -> &'static Mutex<Option<Beat>> {
    static BEAT: OnceLock<Mutex<Option<Beat>>> = OnceLock::new();
    BEAT.get_or_init(|| Mutex::new(None))
}

/// Called from the IPC command. `hidden` lets platforms without a native window
/// probe (macOS, Linux) distinguish "minimized" from "stopped running".
pub(crate) fn record_heartbeat(hidden: bool) {
    *beat_slot().lock().unwrap_or_else(|error| error.into_inner()) = Some(Beat {
        at: Instant::now(),
        hidden,
    });
}

fn last_beat() -> Option<Beat> {
    *beat_slot().lock().unwrap_or_else(|error| error.into_inner())
}

/// Start the watchdog once per process. Safe to call before the window is shown.
pub(crate) fn start(window: &tauri::WebviewWindow) {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    let _ = MONITORED.set(window.label().to_string());
    #[cfg(windows)]
    let hwnd = window.hwnd().ok().map(|handle| handle.0 as isize);
    #[cfg(not(windows))]
    let hwnd = {
        let _ = window;
        None
    };
    // A diagnostic thread must never be a startup dependency: if it cannot be
    // spawned the app runs exactly as before.
    if let Err(error) = std::thread::Builder::new()
        .name("window-health".into())
        .spawn(move || run(hwnd))
    {
        tracing::warn!("window responsiveness probe could not start: {error}");
    }
}

fn run(hwnd: Option<isize>) {
    let mut tracker = Tracker::new(Instant::now());
    let mut ui_misses = 0u8;
    let mut announced = false;
    loop {
        std::thread::sleep(PROBE_INTERVAL);
        let now = Instant::now();
        let (ui_pumping, minimized, visible) = read_window_state(hwnd, &mut ui_misses);
        let observation = tracker.observe(
            now,
            ui_pumping,
            minimized,
            visible,
            last_beat().map(|beat| beat.at),
        );
        if !announced {
            announced = true;
            announce(hwnd.is_some(), ui_pumping, &observation);
        }
        report(&observation);
    }
}

/// A silent log must not be mistaken for a broken probe, so the first tick
/// states what the probe could actually observe.
fn announce(native_probe: bool, ui_pumping: bool, observation: &Observation) {
    log(
        "info",
        "window.responsiveness.started",
        &serde_json::json!({
            "nativeProbe": native_probe,
            "heartbeat": observation.heartbeat_gap.is_some(),
            "uiPumping": ui_pumping,
        })
        .to_string(),
    );
}

#[cfg(windows)]
fn read_window_state(hwnd: Option<isize>, ui_misses: &mut u8) -> (bool, bool, bool) {
    use windows::Win32::{
        Foundation::{HWND, LPARAM, WPARAM},
        UI::WindowsAndMessaging::{
            IsIconic, IsWindowVisible, SendMessageTimeoutW, SMTO_ABORTIFHUNG, SMTO_BLOCK, WM_NULL,
        },
    };

    let Some(hwnd) = hwnd else {
        // Unknown handle: report nothing rather than inventing a stall.
        return (true, false, false);
    };
    let window = HWND(hwnd as _);
    let mut answered = 0usize;
    // The same probe Windows uses for its own "not responding" state, but with
    // our threshold and no dependency on the WebView or the Tauri runtime.
    let replied = unsafe {
        SendMessageTimeoutW(
            window,
            WM_NULL,
            WPARAM(0),
            LPARAM(0),
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            UI_PROBE_TIMEOUT_MS,
            Some(&mut answered as *mut usize),
        )
    };
    if replied.0 != 0 {
        *ui_misses = 0;
    } else {
        *ui_misses = ui_misses.saturating_add(1);
    }
    let minimized = unsafe { IsIconic(window) }.as_bool();
    let visible = unsafe { IsWindowVisible(window) }.as_bool();
    (*ui_misses < UI_PROBE_MISSES, minimized, visible)
}

#[cfg(not(windows))]
fn read_window_state(_hwnd: Option<isize>, _ui_misses: &mut u8) -> (bool, bool, bool) {
    // No portable message-pump probe: trust the renderer's own visibility report.
    match last_beat() {
        Some(beat) => (true, beat.hidden, !beat.hidden),
        None => (true, false, true),
    }
}

fn report(observation: &Observation) {
    let detail = serde_json::json!({
        "gapMs": observation.heartbeat_gap.map(|gap| gap.as_millis() as u64),
        "sinceRestoreMs": observation.since_restore.map(|age| age.as_millis() as u64),
        "stalledMs": observation.verdict_age.map(|age| age.as_millis() as u64),
    })
    .to_string();

    if observation.became_minimized {
        log("info", "window.minimized", &detail);
    }
    if observation.became_restored {
        log("info", "window.restored", &detail);
    }
    // Unchanged verdicts produce no event. Every other pair is enumerated so a
    // new Verdict variant is a compile error here rather than a silent default.
    let (level, event) = match (observation.previous, observation.verdict) {
        (Verdict::Healthy, Verdict::UiThreadHung)
        | (Verdict::RendererStalled, Verdict::UiThreadHung) => ("warn", "window.ui_thread.hung"),
        (Verdict::UiThreadHung, Verdict::Healthy) => ("info", "window.ui_thread.recovered"),
        (Verdict::Healthy, Verdict::RendererStalled)
        | (Verdict::UiThreadHung, Verdict::RendererStalled) => ("warn", "window.renderer.stalled"),
        (Verdict::RendererStalled, Verdict::Healthy) => ("info", "window.renderer.recovered"),
        (Verdict::Healthy, Verdict::Healthy)
        | (Verdict::UiThreadHung, Verdict::UiThreadHung)
        | (Verdict::RendererStalled, Verdict::RendererStalled) => return,
    };
    log(level, event, &detail);
}

fn log(level: &str, event: &str, detail: &str) {
    crate::runtime_log::record_event(level, event, detail);
}
