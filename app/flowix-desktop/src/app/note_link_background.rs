//! One bounded link extractor per desktop process, independent of notebook
//! scans. Core dirty rows are the durable queue; events only wake the worker.
use flowix_core::memo_file::MemoFile;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Listener};

const WAKE_DELAY: Duration = Duration::from_millis(250);
const ERROR_RETRY_DELAY: Duration = Duration::from_secs(2);
const BATCH_SOURCES: usize = 8;

#[derive(Default)]
pub(super) struct NoteLinkBackground {
    pending: Mutex<BTreeMap<String, Instant>>,
    wake: Condvar,
    stopped: AtomicBool,
    paused: AtomicBool,
}
impl NoteLinkBackground {
    pub fn request(&self, id: &str) {
        self.schedule(id, WAKE_DELAY);
    }
    fn schedule(&self, id: &str, delay: Duration) {
        if id.is_empty() {
            return;
        }
        let mut queue = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if self.stopped.load(Ordering::Acquire) {
            return;
        }
        let due = Instant::now() + delay;
        queue
            .entry(id.to_owned())
            .and_modify(|at| *at = (*at).min(due))
            .or_insert(due);
        self.wake.notify_one();
    }
    pub fn stop(&self) {
        let mut queue = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        self.stopped.store(true, Ordering::Release);
        queue.clear();
        self.wake.notify_all();
    }
    pub fn pause(&self, value: bool) {
        let _guard = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        self.paused.store(value, Ordering::Release);
        self.wake.notify_all();
    }
    pub fn start(self: &Arc<Self>, app: AppHandle, config: PathBuf) {
        for event in ["flowix:path-note-changed", "file-management-changed"] {
            let weak = Arc::downgrade(self);
            app.listen(event, move |event| {
                if let (Some(worker), Ok(payload)) = (
                    weak.upgrade(),
                    serde_json::from_str::<serde_json::Value>(event.payload()),
                ) {
                    if let Some(id) = payload.get("notebookId").and_then(|v| v.as_str()) {
                        worker.request(id);
                    }
                }
            });
        }
        let worker = self.clone();
        tauri::async_runtime::spawn_blocking(move || worker.run(app, config));
    }
    fn run(&self, app: AppHandle, config: PathBuf) {
        loop {
            let id = {
                let mut queue = self.pending.lock().unwrap_or_else(|e| e.into_inner());
                loop {
                    if self.stopped.load(Ordering::Acquire) {
                        return;
                    }
                    if !self.paused.load(Ordering::Acquire) {
                        if let Some((id, due)) = queue
                            .iter()
                            .min_by_key(|(_, at)| **at)
                            .map(|(id, at)| (id.clone(), *at))
                        {
                            let wait = due.saturating_duration_since(Instant::now());
                            if wait.is_zero() {
                                queue.remove(&id);
                                break id;
                            }
                            queue = self
                                .wake
                                .wait_timeout(queue, wait)
                                .unwrap_or_else(|e| e.into_inner())
                                .0;
                            continue;
                        }
                    }
                    queue = self.wake.wait(queue).unwrap_or_else(|e| e.into_inner());
                }
            };
            let keep_running =
                || !self.stopped.load(Ordering::Acquire) && !self.paused.load(Ordering::Acquire);
            let memo = MemoFile::new(config.clone());
            match memo.process_note_links_background_batch(&id, BATCH_SOURCES, &keep_running) {
                Ok(report) => {
                    if report.processed > 0 {
                        let _=app.emit("flowix:note-links-indexed",serde_json::json!({"notebookId":id,"processed":report.processed,"changed":report.changed,"failed":report.failed,"pending":report.pending}));
                    }
                    if report.pending {
                        self.schedule(
                            &id,
                            Duration::from_millis(
                                report
                                    .retry_after_ms
                                    .unwrap_or(WAKE_DELAY.as_millis() as u64),
                            ),
                        );
                    }
                }
                Err(error) => {
                    tracing::debug!(notebook=%id,%error,"document link index deferred");
                    if !matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound
                            | std::io::ErrorKind::InvalidData
                            | std::io::ErrorKind::Unsupported
                    ) {
                        self.schedule(&id, ERROR_RETRY_DELAY);
                    }
                }
            }
        }
    }
}
