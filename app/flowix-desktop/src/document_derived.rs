//! One coalescing worker for derived search work, outside save receipts.
use crate::app::state::AppState;
use std::{
    collections::BTreeMap,
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Manager};

struct Job {
    app: AppHandle,
    memo_id: String,
}
#[derive(Default)]
struct Pending {
    running: bool,
    jobs: BTreeMap<String, Job>,
}
fn pending() -> &'static Mutex<Pending> {
    static PENDING: OnceLock<Mutex<Pending>> = OnceLock::new();
    PENDING.get_or_init(Mutex::default)
}

pub fn schedule(app: &AppHandle, memo_id: &str) {
    let mut state = pending().lock().unwrap_or_else(|e| e.into_inner());
    state.jobs.entry(memo_id.into()).or_insert_with(|| Job {
        app: app.clone(),
        memo_id: memo_id.into(),
    });
    if state.running {
        return;
    }
    state.running = true;
    drop(state);
    tauri::async_runtime::spawn(async {
        loop {
            let job = {
                let mut state = pending().lock().unwrap_or_else(|e| e.into_inner());
                match state.jobs.pop_first() {
                    Some((_, job)) => job,
                    None => {
                        state.running = false;
                        break;
                    }
                }
            };
            let result = crate::document_io::run("derive", move || {
                let state = job.app.state::<AppState>();
                // A delayed local snapshot must not overwrite a newer external
                // search update, or resurrect an entry deleted meanwhile.
                // 旧 memo id → notebook + relative_path，再刷新 search index。
                let target = crate::lock_utils::read_lock(&state.memo_file, "memo_file")
                    .resolve_memo_location(&job.memo_id)
                    .ok()
                    .flatten()
                    .map(|location| (location.notebook.id, location.memo.relative_path));
                if let Some((notebook_id, relative_path)) = target {
                }
                Ok::<(), flowix_core::FlowixError>(())
            })
            .await;
            match result {
                Err(error) => tracing::error!("document derived worker failed: {error}"),
                Ok(Err(error)) => tracing::error!("document derived work failed: {error}"),
                Ok(Ok(())) => {}
            }
        }
    });
}

pub async fn flush() -> bool {
    for _ in 0..100 {
        if !pending().lock().unwrap_or_else(|e| e.into_inner()).running {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    false
}
