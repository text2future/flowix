//! Process-local admission for passive notebook maintenance. Accurate CLI/cloud
//! snapshots keep their explicit blocking APIs and share the core OS locks.
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use flowix_core::memo_file::MemoFile;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const EVENT: &str = "flowix:notebook-maintenance";
pub const MEDIA_EVENT: &str = "flowix:media-maintenance";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookBackgroundStatus {
    pub notebook_id: String,
    pub state: &'static str,
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memo_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missing: Option<bool>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookMediaMaintenanceStatus {
    pub notebook_id: String,
    pub state: &'static str,
    pub revision: u64,
    pub message: Option<String>,
}

#[derive(Default)]
struct Queue {
    pending: VecDeque<String>,
    urgent: HashSet<String>,
    active: Option<String>,
    active_media: bool,
    media: VecDeque<String>,
    media_statuses: HashMap<String, NotebookMediaMaintenanceStatus>,
    media_revision: u64,
    preferred: Option<String>,
    rerun: HashSet<String>,
    statuses: HashMap<String, NotebookBackgroundStatus>,
    finished: HashMap<String, Instant>,
    revision: u64,
}

impl Queue {
    fn enqueue(&mut self, id: String, urgent: bool, invalidate: bool) {
        if self.active.as_deref() == Some(&id) && !self.active_media {
            if invalidate {
                self.rerun.insert(id);
            }
            return;
        }
        if urgent {
            self.urgent.insert(id.clone());
        }
        if let Some(position) = self.pending.iter().position(|queued| queued == &id) {
            if urgent {
                self.pending.remove(position);
                self.pending.push_front(id);
            }
            return;
        }
        // Passive queries cannot continuously retry an inaccessible disk.
        if !invalidate
            && self
                .statuses
                .get(&id)
                .is_some_and(|status| status.state == "failed")
            && self
                .finished
                .get(&id)
                .is_some_and(|at| at.elapsed() < Duration::from_secs(2))
        {
            self.urgent.remove(&id);
            return;
        }
        self.revision += 1;
        let previous = self.statuses.get(&id);
        self.statuses.insert(
            id.clone(),
            NotebookBackgroundStatus {
                notebook_id: id.clone(),
                state: "queued",
                revision: self.revision,
                memo_count: previous.and_then(|s| s.memo_count),
                missing: previous.and_then(|s| s.missing),
                message: None,
            },
        );
        if urgent {
            self.pending.push_front(id);
        } else {
            self.pending.push_back(id);
        }
    }

    fn enqueue_media(&mut self, id: String, urgent: bool) -> NotebookMediaMaintenanceStatus {
        if self.active_media && self.active.as_deref() == Some(&id) {
            return self.media_statuses[&id].clone();
        }
        if let Some(position) = self.media.iter().position(|queued| queued == &id) {
            if urgent && position != 0 {
                self.media.remove(position);
                self.media.push_front(id.clone());
            }
            return self.media_statuses[&id].clone();
        }
        self.media_revision += 1;
        let status = NotebookMediaMaintenanceStatus {
            notebook_id: id.clone(),
            state: "queued",
            revision: self.media_revision,
            message: None,
        };
        self.media_statuses.insert(id.clone(), status.clone());
        if urgent {
            self.media.push_front(id);
        } else {
            self.media.push_back(id);
        }
        status
    }

    fn update_media_status(
        &mut self,
        id: &str,
        state: &'static str,
        message: Option<String>,
    ) -> NotebookMediaMaintenanceStatus {
        self.media_revision += 1;
        let status = NotebookMediaMaintenanceStatus {
            notebook_id: id.to_owned(),
            state,
            revision: self.media_revision,
            message,
        };
        self.media_statuses.insert(id.to_owned(), status.clone());
        status
    }
}

#[derive(Default)]
pub struct NotebookBackground {
    queue: Mutex<Queue>,
    wake: Condvar,
    started: AtomicBool,
    stopped: AtomicBool,
    paused: AtomicBool,
}

impl NotebookBackground {
    pub fn request(&self, id: &str, urgent: bool, invalidate: bool) {
        if id.is_empty() || self.stopped.load(Ordering::Acquire) {
            return;
        }
        let mut queue = self.queue.lock().unwrap_or_else(|p| p.into_inner());
        // stop() and admission share the queue lock, closing the check/enqueue race.
        if self.stopped.load(Ordering::Acquire) {
            return;
        }
        queue.enqueue(id.to_owned(), urgent, invalidate);
        self.wake.notify_one();
    }

    pub fn prioritize(&self, id: &str) {
        self.queue
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .preferred = Some(id.to_owned());
        self.request(id, true, true);
    }

    pub fn request_media(&self, id: &str) -> Option<NotebookMediaMaintenanceStatus> {
        if id.is_empty() || self.stopped.load(Ordering::Acquire) {
            return None;
        }
        let mut queue = self.queue.lock().unwrap_or_else(|p| p.into_inner());
        if self.stopped.load(Ordering::Acquire) {
            return None;
        }
        let status = queue.enqueue_media(id.to_owned(), true);
        self.wake.notify_one();
        Some(status)
    }

    pub fn media_snapshot(&self, id: &str) -> Option<NotebookMediaMaintenanceStatus> {
        self.queue
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .media_statuses
            .get(id)
            .cloned()
    }

    pub fn media_statuses(&self) -> Vec<NotebookMediaMaintenanceStatus> {
        self.queue
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .media_statuses
            .values()
            .cloned()
            .collect()
    }

    pub fn pause(&self) {
        let _queue = self.queue.lock().unwrap_or_else(|p| p.into_inner());
        self.paused.store(true, Ordering::Release);
    }
    pub fn resume(&self) {
        let _queue = self.queue.lock().unwrap_or_else(|p| p.into_inner());
        self.paused.store(false, Ordering::Release);
        self.wake.notify_all();
    }

    pub fn snapshot(&self, id: &str) -> Option<NotebookBackgroundStatus> {
        self.queue
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .statuses
            .get(id)
            .cloned()
    }

    pub fn statuses(&self) -> Vec<NotebookBackgroundStatus> {
        self.queue
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .statuses
            .values()
            .cloned()
            .collect()
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        let mut queue = self.queue.lock().unwrap_or_else(|p| p.into_inner());
        queue.pending.clear();
        queue.media.clear();
        queue.rerun.clear();
        self.wake.notify_all();
    }

    // Called only after the workbench has painted. Requests made before then
    // are coalesced in the queue, without starting filesystem work.
    pub fn start(self: &Arc<Self>, app: AppHandle, config: PathBuf) {
        if self.started.swap(true, Ordering::AcqRel) {
            return;
        }
        let worker = self.clone();
        tauri::async_runtime::spawn_blocking(move || worker.run(app, config));
    }

    fn run(&self, app: AppHandle, config: PathBuf) {
        loop {
            let (id, urgent, media, media_status) = {
                let mut queue = self.queue.lock().unwrap_or_else(|p| p.into_inner());
                while ((queue.pending.is_empty() && queue.media.is_empty())
                    || self.paused.load(Ordering::Acquire))
                    && !self.stopped.load(Ordering::Acquire)
                {
                    queue = self.wake.wait(queue).unwrap_or_else(|p| p.into_inner());
                }
                if self.stopped.load(Ordering::Acquire) {
                    return;
                }
                let preferred_media = queue
                    .preferred
                    .as_ref()
                    .and_then(|id| queue.media.iter().position(|queued| queued == id));
                let media = queue.pending.is_empty()
                    || (queue.urgent.is_empty() && preferred_media.is_some());
                let id = if media {
                    if let Some(position) = preferred_media {
                        queue.media.remove(position).unwrap()
                    } else {
                        queue.media.pop_front().unwrap()
                    }
                } else {
                    queue.pending.pop_front().unwrap()
                };
                let urgent = if media {
                    queue.preferred.as_deref() == Some(id.as_str())
                } else {
                    queue.urgent.remove(&id)
                };
                queue.active = Some(id.clone());
                queue.active_media = media;
                if !media {
                    if let Some(status) = queue.statuses.get_mut(&id) {
                        status.state = "running";
                    }
                }
                let media_status = media.then(|| queue.update_media_status(&id, "running", None));
                (id, urgent, media, media_status)
            };
            if media {
                if let Some(status) = media_status {
                    let _ = app.emit(MEDIA_EVENT, status);
                }
            } else {
                if let Some(status) = self.snapshot(&id) {
                    let _ = app.emit(EVENT, status);
                }
            }
            let started = Instant::now();
            let ticks = std::cell::Cell::new(0usize);
            let keep_running = || {
                if self.stopped.load(Ordering::Acquire) || self.paused.load(Ordering::Acquire) {
                    return false;
                }
                let tick = ticks.get() + 1;
                ticks.set(tick);
                if tick % 32 != 0 {
                    return true;
                }
                // Yield between batches, never while holding a SQLite transaction.
                std::thread::sleep(Duration::from_millis(2));
                let queue = self.queue.lock().unwrap_or_else(|p| p.into_inner());
                queue.urgent.is_empty()
                    || (urgent && queue.preferred.as_deref() == Some(id.as_str()))
            };
            if media {
                let memo = MemoFile::new(config.clone());
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    // Resource catalogs can outlive the app version that
                    // introduced new indexed file kinds. Refresh their schema
                    // before scanning so existing notebooks remain usable
                    // when a new version-initialization pass is not pending.
                    memo.initialize_resource_catalog_schema(&id)?;
                    memo.reconcile_resources_background_with_changes(&id, &keep_running)
                }))
                .unwrap_or_else(|_| Err(std::io::Error::other("resource catalog maintenance panicked")));
                let mut queue = self.queue.lock().unwrap_or_else(|p| p.into_inner());
                queue.active = None;
                queue.active_media = false;
                if self.stopped.load(Ordering::Acquire) {
                    return;
                }
                let status = match result {
                    Ok((indexed, changed_kinds)) => {
                        crate::watcher::probe::record_background_scan(
                            crate::watcher::probe::ScanKind::Media,
                            &id,
                            started.elapsed(),
                            indexed as u64,
                            false,
                        );
                        let status = queue.update_media_status(&id, "ready", None);
                        drop(queue);
                        if !changed_kinds.is_empty() {
                            let _ = app.emit(
                                "file-management-changed",
                                serde_json::json!({ "notebookId": id,
                                "notebookPath": memo.get_notebook_config_by_id(&id).map(|n| n.path),
                                "resourceKinds": changed_kinds }),
                            );
                        }
                        let _ = app.emit(MEDIA_EVENT, status.clone());
                        continue;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                        queue.enqueue_media(id.clone(), false)
                    }
                    Err(error) => {
                        tracing::warn!(notebook = %id, %error, "background resource catalog maintenance unavailable");
                        queue.update_media_status(&id, "failed", Some(error.to_string()))
                    }
                };
                drop(queue);
                let _ = app.emit(MEDIA_EVENT, status);
                continue;
            }
            // Use a separate facade: a full scan must not hold AppState's global
            // MemoFile RwLock. Core per-file and cross-process locks still apply.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if !keep_running() {
                    return Err(std::io::Error::from(std::io::ErrorKind::Interrupted));
                }
                let memo = MemoFile::new(config.clone());
                memo.prepare_background_note_projection(&id)?;
                memo.reconcile_note_index_background(&id, &keep_running)?;
                if !keep_running() {
                    return Err(std::io::Error::from(std::io::ErrorKind::Interrupted));
                }
                let count = memo.cached_note_count(&id)?.ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::WouldBlock,
                        "index is being prepared by another process",
                    )
                })?;
                Ok::<_, std::io::Error>(count)
            }))
            .unwrap_or_else(|_| Err(std::io::Error::other("notebook maintenance panicked")));
            let mut queue = self.queue.lock().unwrap_or_else(|p| p.into_inner());
            queue.active = None;
            queue.active_media = false;
            if self.stopped.load(Ordering::Acquire) {
                return;
            }
            let yielded = result
                .as_ref()
                .is_err_and(|e| e.kind() == std::io::ErrorKind::Interrupted);
            let rerun = queue.rerun.remove(&id) || yielded;
            if let Some(status) = queue.statuses.get_mut(&id) {
                match result {
                    Ok(count) => {
                        status.state = "ready";
                        status.memo_count = Some(count);
                        status.missing = Some(false);
                        status.message = None;
                    }
                    Err(error) => {
                        status.state = if yielded { "queued" } else { "failed" };
                        status.message = Some(error.to_string());
                        if error.kind() == std::io::ErrorKind::NotFound {
                            status.missing = Some(true);
                        }
                    }
                }
            }
            queue.finished.insert(id.clone(), Instant::now());
            let status = queue.statuses.get(&id).cloned();
            let media_status = if status.as_ref().is_some_and(|s| s.state == "ready") {
                Some(queue.enqueue_media(id.clone(), false))
            } else { None };
            if rerun {
                queue.enqueue(id.clone(), false, true);
            }
            drop(queue);
            crate::watcher::probe::record_background_scan(
                crate::watcher::probe::ScanKind::NoteIndex,
                &id,
                started.elapsed(),
                ticks.get() as u64,
                rerun,
            );
            tracing::info!(notebook = %id, elapsed_ms = started.elapsed().as_millis(),
                files_checked = ticks.get(), "background notebook task settled");
            if let Some(status) = status {
                // Versioned completion also reconciles late frontend subscribers.
                let _ = app.emit(EVENT, status);
            }
            if let Some(status) = media_status {
                let _ = app.emit(MEDIA_EVENT, status);
            }
        }
    }
}

/// Schedule a missing projection without turning a read into a blocking scan.
pub fn query_error(
    state: &crate::app::state::AppState,
    id: &str,
    error: impl std::fmt::Display,
) -> String {
    let message = error.to_string();
    if message.contains("Note index is not ready") {
        state.notebook_background.request(id, true, false);
        if let Some(status) = state.notebook_background.snapshot(id) {
            if status.state == "failed" {
                return format!(
                    "NOTE_INDEX_UNAVAILABLE: {}",
                    status.message.unwrap_or_default()
                );
            }
        }
        "NOTE_INDEX_PENDING".into()
    } else {
        message
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_missing_projection_after_success_can_be_scheduled_immediately() {
        let mut queue = Queue::default();
        queue.enqueue("a".into(), false, false);
        queue.pending.clear();
        queue.statuses.get_mut("a").unwrap().state = "ready";
        queue.finished.insert("a".into(), Instant::now());
        queue.enqueue("a".into(), true, false);
        assert_eq!(queue.pending.front().unwrap(), "a");
    }

    #[test]
    fn failed_passive_reads_back_off_but_explicit_retry_is_admitted() {
        let mut queue = Queue::default();
        queue.enqueue("a".into(), false, false);
        queue.pending.clear();
        queue.statuses.get_mut("a").unwrap().state = "failed";
        queue.finished.insert("a".into(), Instant::now());
        queue.enqueue("a".into(), true, false);
        assert!(queue.pending.is_empty());
        queue.enqueue("a".into(), true, true);
        assert_eq!(queue.pending.len(), 1);
    }

    #[test]
    fn repeated_requests_coalesce_and_current_notebook_moves_first() {
        let mut queue = Queue::default();
        queue.enqueue("other".into(), false, false);
        queue.enqueue("current".into(), false, false);
        queue.enqueue("current".into(), true, false);
        queue.enqueue("current".into(), true, false);
        assert_eq!(
            queue.pending.into_iter().collect::<Vec<_>>(),
            ["current", "other"]
        );
    }
    #[test]
    fn active_queries_do_not_loop_but_changes_schedule_one_followup() {
        let mut queue = Queue::default();
        queue.active = Some("current".into());
        queue.enqueue("current".into(), true, false);
        assert!(queue.rerun.is_empty());
        for _ in 0..10 {
            queue.enqueue("current".into(), true, true);
        }
        assert_eq!(queue.rerun.len(), 1);
        assert!(queue.pending.is_empty());
    }
    #[test]
    fn shutdown_rejects_new_work() {
        let queue = NotebookBackground::default();
        queue.request("a", false, false);
        queue.stop();
        queue.request("b", true, false);
        assert!(queue.queue.lock().unwrap().pending.is_empty());
        assert!(queue.snapshot("b").is_none());
    }
}
