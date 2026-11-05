use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use tauri::{AppHandle, Emitter, Manager};

#[path = "window_lifetime.rs"]
mod lifetime;
#[path = "window_shutdown_state.rs"]
mod shutdown_state;
#[path = "shutdown_watchdog.rs"]
mod watchdog;
use lifetime::WindowLifetime;
use shutdown_state::ExitRequest;
use std::time::Instant;
use watchdog::CLOSE_BUDGET;

#[derive(Default)]
struct Shutdown {
    windows: HashSet<shutdown_state::WindowId>,
    waiting: Option<(u64, HashSet<shutdown_state::WindowId>, Completion)>,
    approved: bool,
    targets: HashMap<u64, Arc<CloseTarget>>,
}
pub(crate) struct CloseTarget {
    lifetime: Arc<WindowLifetime>,
    window: tauri::WebviewWindow,
    closing: OnceLock<CloseAttempt>,
}
struct CloseAttempt {
    request: u64,
    started: Instant,
}

/// A resource in the native Window's own table survives label reuse and JS
/// reloads. It contains no Window/App handle, so there is no ownership cycle.
struct WindowIdentity(Arc<WindowLifetime>);
impl tauri::Resource for WindowIdentity {}
fn window_lifetime<R: tauri::Runtime>(window: &tauri::Window<R>) -> Arc<WindowLifetime> {
    let mut resources = window.resources_table();
    let existing = resources
        .names()
        .find(|(_, name)| name.as_ref() == std::any::type_name::<WindowIdentity>())
        .and_then(|(id, _)| resources.get::<WindowIdentity>(id).ok());
    if let Some(identity) = existing {
        return identity.0.clone();
    }
    let lifetime = WindowLifetime::new();
    resources.add(WindowIdentity(lifetime.clone()));
    lifetime
}
fn native_window(window: &tauri::WebviewWindow) -> tauri::Window {
    let webview: &tauri::Webview = window.as_ref();
    webview.window()
}
fn next_request() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

enum Completion {
    Exit(i32),
    #[cfg(windows)]
    Prepared(tokio::sync::oneshot::Sender<UpdatePreparation>),
}
fn state() -> &'static Mutex<Shutdown> {
    static STATE: OnceLock<Mutex<Shutdown>> = OnceLock::new();
    STATE.get_or_init(Mutex::default)
}

// These deadlines run on OS threads, independently of WebView/Tokio/UI progress.
const UPDATE_SAVE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(8);

static EXITING: AtomicBool = AtomicBool::new(false);

pub(crate) fn is_exiting() -> bool {
    EXITING.load(Ordering::Acquire)
}

fn arm_exit_watchdog(code: i32, started: Instant) {
    if EXITING.swap(true, Ordering::AcqRel) {
        return;
    }
    watchdog::arm(started + CLOSE_BUDGET, move || hard_exit(code));
}

#[cfg(test)]
fn spawn_hard_exit(code: i32, deadline: std::time::Duration) {
    watchdog::arm(Instant::now() + deadline, move || hard_exit(code));
}

fn hard_exit(code: i32) -> ! {
    // Bypass atexit handlers and Rust destructors: they may hold the very locks
    // that prevented orderly shutdown.
    #[cfg(unix)]
    unsafe {
        libc::_exit(code);
    }
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Threading::{GetCurrentProcess, TerminateProcess};
        let _ = TerminateProcess(GetCurrentProcess(), code as u32);
    }
    #[allow(unreachable_code)]
    std::process::abort()
}

/// Call during native construction, before showing a window. Repeated calls
/// for the same instance are harmless; a dead instance is never reinstalled.
pub(crate) fn install_window(window: &tauri::WebviewWindow) -> Option<Arc<CloseTarget>> {
    let lifetime = window_lifetime(&native_window(window));
    if !lifetime.is_alive() {
        return None;
    }
    let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
    if !lifetime.is_alive() {
        return None;
    }
    if let Some(target) = state.targets.get(&lifetime.id()) {
        return Some(target.clone());
    }
    let target = Arc::new(CloseTarget {
        lifetime,
        window: window.clone(),
        closing: OnceLock::new(),
    });
    state.targets.insert(target.lifetime.id(), target.clone());
    Some(target)
}

/// This global native listener receives the actual Window instance, not only
/// its reusable label. Destruction updates the shared flag even before a late
/// constructor/input worker manages to register its coordinator record.
pub(crate) fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            // Resolve the instance before suppressing the close. `prevent_close`
            // is irreversible, so doing it first used to turn any resolution
            // failure into a window that could never be closed at all: no
            // destroy, no watchdog, and no way out but killing the process.
            let Some(target) = close_target_for(window) else {
                crate::runtime_log::record_event(
                    "warn",
                    "window.close.uncoordinated",
                    window.label(),
                );
                return;
            };
            api.prevent_close();
            request_target(target, Instant::now());
        }
        tauri::WindowEvent::Destroyed => {
            let lifetime = window_lifetime(window);
            lifetime.destroyed(); // atomic; all stale input/deadline clones see it
            forget_instance(window.app_handle(), &lifetime);
        }
        _ => {}
    }
}

/// Resolve the coordinator record for the *instance* that received the close.
/// Pure lookup: it never prevents the close and never mutates the coordinator,
/// so a failed resolution stays recoverable by the caller.
fn close_target_for(window: &tauri::Window) -> Option<Arc<CloseTarget>> {
    let lifetime = window_lifetime(window);
    if !lifetime.is_alive() {
        return None;
    }
    let target = state()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .targets
        .get(&lifetime.id())
        .cloned();
    target.or_else(|| {
        window
            .get_webview_window(window.label())
            .and_then(|webview| {
                let target = install_window(&webview)?;
                (target.lifetime.id() == lifetime.id()).then_some(target)
            })
    })
}

fn request_target(target: Arc<CloseTarget>, started: Instant) {
    if !target.lifetime.is_alive() {
        return;
    }
    let mut first = false;
    let closing = target.closing.get_or_init(|| {
        first = true;
        CloseAttempt {
            request: next_request(),
            started,
        }
    });
    if !first {
        return;
    }
    // Arm once per native close attempt, before taking the coordinator lock.
    // Every callback captures this instance's liveness, never its reusable label.
    let lifetime = target.lifetime.clone();
    watchdog::arm(started + CLOSE_BUDGET, move || {
        lifetime.force_if_alive(|| hard_exit(0))
    });
    if !target.lifetime.is_alive() {
        return;
    }
    let request = closing.request;
    let app = target.window.app_handle();
    let label = target.window.label();
    let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
    if !target.lifetime.is_alive() {
        return;
    }
    let cancelled_update = if state
        .waiting
        .as_ref()
        .is_some_and(|(_, _, completion)| !matches!(completion, Completion::Exit(_)))
    {
        state.waiting.take().map(|(request, _, _)| request)
    } else {
        None
    };
    let needs_save = state.windows.contains(&target.lifetime.id());
    drop(state);
    if let Some(request) = cancelled_update {
        let _ = app.emit("document:exit-cancelled", request);
    }
    if !needs_save
        || app
            .emit_to(label, "document:prepare-close", request)
            .is_err()
    {
        complete_close(&target, request);
    }
}

fn complete_close(target: &CloseTarget, request: u64) {
    if target.lifetime.is_alive()
        && target
            .closing
            .get()
            .is_some_and(|closing| closing.request == request)
    {
        let _ = target.window.destroy(); // success only when Destroyed is observed
    }
}

/// Input routes capture a specific instance. No label lookup happens later on
/// the native input worker, so an old click cannot close a replacement window.
#[cfg(windows)]
pub(crate) fn close_route(
    window: &tauri::WebviewWindow,
) -> Result<crate::native_close_region::CloseRoute, String> {
    let target = install_window(window).ok_or("Window has already been destroyed")?;
    let lifetime = target.lifetime.clone();
    Ok(crate::native_close_region::CloseRoute::new(
        target.lifetime.id(),
        move || lifetime.is_alive(),
        move |started| {
            request_target(target.clone(), started);
        },
    ))
}
#[cfg(windows)]
pub(crate) fn clear_native_region(window: &tauri::Window) {
    crate::native_close_region::remove(window_lifetime(window).id());
}

#[tauri::command]
pub fn finish_document_close(window: tauri::WebviewWindow, request: u64, ready: bool) {
    if let Some(target) = install_window(&window) {
        complete_close(&target, request);
    }
    if !ready {
        tracing::warn!("closing window despite incomplete document persistence");
    }
}

#[tauri::command]
pub fn register_document_window(window: tauri::WebviewWindow, app: AppHandle) {
    let Some(target) = install_window(&window) else {
        return;
    };
    if is_exiting() {
        let _ = window.destroy();
        return;
    }
    let label = window.label().to_string();
    let pending_request = {
        let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
        if !target.lifetime.is_alive() {
            return;
        }
        state.windows.insert(target.lifetime.id());
        state.waiting.as_mut().map(|(request, windows, _)| {
            windows.insert(target.lifetime.id());
            *request
        })
    };
    if let Some(request) = pending_request {
        let _ = app.emit_to(&label, "document:prepare-exit", request);
    }
}

fn forget_instance(app: &AppHandle, lifetime: &WindowLifetime) {
    let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
    let Some(target) = state.targets.remove(&lifetime.id()) else {
        return;
    };
    state.windows.remove(&lifetime.id());
    if !state
        .targets
        .values()
        .any(|other| other.lifetime.is_alive())
    {
        if let Some(closing) = target.closing.get() {
            // Only actual destruction of the last registered instance promotes
            // its original close deadline to an unconditional process deadline.
            arm_exit_watchdog(0, closing.started);
        }
    }
    let require_saved = state
        .waiting
        .as_ref()
        .is_some_and(|(_, _, completion)| !matches!(completion, Completion::Exit(_)));
    let outcome = shutdown_state::destroyed(&mut state.waiting, lifetime.id(), require_saved);
    #[cfg(windows)]
    crate::native_close_region::remove(lifetime.id());
    resolve_outcome(app, state, outcome);
}

/// Briefly defer exit for best-effort saving; failure can never veto user exit.
pub fn request_exit(app: &AppHandle, code: i32) -> bool {
    arm_exit_watchdog(code, Instant::now());
    let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
    let cancelled = match shutdown_state::prepare_user_exit(&mut state.waiting, |completion| {
        matches!(completion, Completion::Exit(_))
    }) {
        ExitRequest::AlreadyPending => return false,
        ExitRequest::Start { cancelled } => cancelled,
    };
    drop(state);
    if let Some((request, completion)) = cancelled {
        drop(completion);
        let _ = app.emit("document:exit-cancelled", request);
    }
    begin_request(app, Completion::Exit(code))
}

/// Tauri's Windows updater uses process::exit, so saving must finish before
/// handing it the installation payload. Cancellation never exits the app.
#[cfg(windows)]
pub async fn prepare_for_update(app: &AppHandle) -> Result<UpdatePreparation, String> {
    if is_exiting() {
        return Err("Application is closing".into());
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    begin_request(app, Completion::Prepared(sender));
    receiver.await.map_err(|_| {
        "Update cancelled: documents could not finish saving. Save your documents and retry."
            .to_string()
    })
}

/// Unfreeze the editor if launching installation fails or the task is cancelled.
#[cfg(windows)]
pub struct UpdatePreparation {
    app: AppHandle,
    request: u64,
}
#[cfg(windows)]
impl Drop for UpdatePreparation {
    fn drop(&mut self) {
        let _ = self.app.emit("document:exit-cancelled", self.request);
    }
}

fn begin_request(app: &AppHandle, completion: Completion) -> bool {
    let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
    if (state.approved && matches!(&completion, Completion::Exit(_))) || state.windows.is_empty() {
        #[cfg(windows)]
        if let Completion::Prepared(sender) = completion {
            let _ = sender.send(UpdatePreparation {
                app: app.clone(),
                request: 0,
            });
        }
        return true;
    }
    if state.waiting.is_some() {
        return false;
    }
    let request = next_request();
    let windows = state.windows.clone();
    let targets = windows
        .iter()
        .map(|window_id| {
            let label = state
                .targets
                .get(window_id)
                .filter(|target| target.lifetime.is_alive())
                .map(|target| target.window.label().to_string());
            (*window_id, label)
        })
        .collect::<Vec<_>>();
    let budget = if matches!(&completion, Completion::Exit(_)) {
        CLOSE_BUDGET
    } else {
        UPDATE_SAVE_DEADLINE
    };
    state.waiting = Some((request, windows.clone(), completion));
    drop(state);
    let timeout_app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(budget);
        expire_request(&timeout_app, request);
    });
    for (window_id, label) in targets {
        let Some(label) = label else {
            finish_failed_window(app, window_id, request);
            continue;
        };
        if let Err(error) = app.emit_to(&label, "document:prepare-exit", request) {
            tracing::error!("cannot prepare document window for exit: {error}");
            finish_failed_window(app, window_id, request);
        }
    }
    false
}

fn expire_request(app: &AppHandle, request: u64) {
    let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
    let Some((_, completion)) = shutdown_state::expire(&mut state.waiting, request) else {
        return;
    };
    state.approved = matches!(&completion, Completion::Exit(_));
    drop(state);
    match completion {
        Completion::Exit(code) => app.exit(code),
        #[cfg(windows)]
        Completion::Prepared(_) => {
            let _ = app.emit("document:exit-cancelled", request);
        }
    }
}

fn finish_failed_window(app: &AppHandle, window_id: shutdown_state::WindowId, request: u64) {
    report_window(app, window_id, request, false);
}

fn report_window(app: &AppHandle, window_id: shutdown_state::WindowId, request: u64, ready: bool) {
    let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
    let Some((id, _, completion)) = state.waiting.as_ref() else {
        return;
    };
    if *id != request {
        return;
    }
    let require_saved = !matches!(completion, Completion::Exit(_));
    let outcome = shutdown_state::report(&mut state.waiting, window_id, ready, require_saved);
    resolve_outcome(app, state, outcome);
}

fn resolve_outcome(
    app: &AppHandle,
    mut state: std::sync::MutexGuard<'_, Shutdown>,
    outcome: shutdown_state::Report<Completion>,
) {
    match outcome {
        shutdown_state::Report::Pending => {}
        shutdown_state::Report::Cancelled(request) => {
            drop(state);
            let _ = app.emit("document:exit-cancelled", request);
        }
        shutdown_state::Report::Complete(request, completion) => {
            state.approved = matches!(&completion, Completion::Exit(_));
            drop(state);
            complete_request(app, request, completion);
        }
    }
}

#[tauri::command]
pub fn finish_document_shutdown(
    window: tauri::WebviewWindow,
    app: AppHandle,
    request: u64,
    ready: bool,
) {
    if !ready {
        tracing::warn!("document persistence incomplete during shutdown");
    }
    let window_id = window_lifetime(&native_window(&window)).id();
    report_window(&app, window_id, request, ready);
}

fn complete_request(app: &AppHandle, _request: u64, completion: Completion) {
    match completion {
        Completion::Exit(code) => app.exit(code),
        #[cfg(windows)]
        Completion::Prepared(sender) => {
            // An unread queued guard is also dropped when an update is cancelled.
            let _ = sender.send(UpdatePreparation {
                app: app.clone(),
                request: _request,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hard_deadline_ignores_blocked_cleanup() {
        const CHILD: &str = "FLOWIX_SHUTDOWN_WATCHDOG_TEST_CHILD";
        if std::env::var_os(CHILD).is_some() {
            spawn_hard_exit(73, CLOSE_BUDGET);
            let mutex = Mutex::new(());
            let _held = mutex.lock().unwrap();
            // Deliberately deadlock this process; only the native watchdog can
            // finish it. No Tauri event loop or Tokio runtime is present.
            let _blocked = mutex.lock().unwrap();
            unreachable!();
        }
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "commands::window_shutdown::tests::hard_deadline_ignores_blocked_cleanup",
            ])
            .env(CHILD, "1")
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert_eq!(status.code(), Some(73));
                break;
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("watchdog failed to terminate a blocked process");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
}
