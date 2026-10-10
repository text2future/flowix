use std::{
    collections::HashSet,
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Emitter};

#[path = "document_shutdown_state.rs"]
mod shutdown_state;

#[derive(Default)]
struct Shutdown {
    windows: HashSet<String>,
    waiting: Option<(u64, HashSet<String>, Completion)>,
    sequence: u64,
    approved: bool,
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

#[tauri::command]
pub fn register_document_window(window: tauri::WebviewWindow) {
    state()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .windows
        .insert(window.label().into());
}

pub fn forget_window(app: &AppHandle, label: &str) {
    let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
    state.windows.remove(label);
    finish_window(app, state, label);
}

/// Return false while registered editor windows protect their drafts.
pub fn request_exit(app: &AppHandle, code: i32) -> bool {
    begin_request(app, Completion::Exit(code))
}

/// Tauri's Windows updater uses process::exit, so saving must finish before
/// handing it the installation payload. Cancellation never exits the app.
#[cfg(windows)]
pub async fn prepare_for_update(app: &AppHandle) -> Result<UpdatePreparation, String> {
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
    state.sequence += 1;
    let request = state.sequence;
    let windows = state.windows.clone();
    state.waiting = Some((request, windows.clone(), completion));
    drop(state);
    let timeout_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        if state_reset(request) {
            let _ = timeout_app.emit("document:exit-cancelled", request);
        }
    });
    for window in windows {
        if let Err(error) = app.emit_to(&window, "document:prepare-exit", request) {
            tracing::error!("cannot prepare document window for exit: {error}");
            if state_reset(request) {
                let _ = app.emit("document:exit-cancelled", request);
            }
        }
    }
    false
}

fn state_reset(request: u64) -> bool {
    let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
    if state
        .waiting
        .as_ref()
        .is_some_and(|(id, _, _)| *id == request)
    {
        state.waiting = None;
        true
    } else {
        false
    }
}

#[tauri::command]
pub async fn flush_document_background() -> bool {
    crate::document_derived::flush().await
}

#[tauri::command]
pub fn finish_document_shutdown(
    window: tauri::WebviewWindow,
    app: AppHandle,
    request: u64,
    ready: bool,
) {
    let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
    let Some((active_request, _, _)) = state.waiting.as_ref() else {
        return;
    };
    if *active_request != request {
        return;
    }
    if !ready {
        state.waiting = None;
        drop(state);
        let _ = app.emit("document:exit-cancelled", request);
        return;
    }
    finish_window(&app, state, window.label());
}

/// Both acknowledgements and window destruction can release the last draft.
fn finish_window(app: &AppHandle, mut state: std::sync::MutexGuard<'_, Shutdown>, label: &str) {
    let Some((request, completion)) = shutdown_state::finish_window(&mut state.waiting, label)
    else {
        return;
    };
    state.approved = matches!(&completion, Completion::Exit(_));
    drop(state);
    match completion {
        Completion::Exit(code) => app.exit(code),
        #[cfg(windows)]
        Completion::Prepared(sender) => {
            // An unread queued guard is also dropped when an update is cancelled.
            let _ = sender.send(UpdatePreparation {
                app: app.clone(),
                request,
            });
        }
    }
}
