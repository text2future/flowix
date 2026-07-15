//! Delayed remove coalescing for watcher rename/delete events.
//!
//! A filesystem rename often arrives as `Remove(old)` followed by
//! `Create/Modify(new)`. The coalescer keeps the old path briefly and lets the
//! new path cancel it by matching the frontmatter key. If no matching new path
//! arrives before the deadline, the remove is committed as a real delete.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};

use flowix_core::memo_file::{extract_frontmatter_key, MemoFile};
use tauri::AppHandle;

use crate::watcher::processor::{MemoEventProcessor, NotebookWatchContext};

#[derive(Debug, Clone)]
struct PendingRemove {
    path: PathBuf,
    ctx: NotebookWatchContext,
    deadline: Instant,
}

struct RemoveCoalescerInner {
    pending: Mutex<HashMap<String, PendingRemove>>,
    wake: Condvar,
}

#[derive(Clone)]
pub struct RemoveCoalescer {
    inner: Arc<RemoveCoalescerInner>,
    delay: Duration,
}

impl RemoveCoalescer {
    pub fn new(app: AppHandle, memo_file: Arc<RwLock<MemoFile>>, delay: Duration) -> Self {
        let coalescer = Self::inert(delay);
        spawn_worker(coalescer.inner.clone(), app, memo_file, delay);
        coalescer
    }

    pub(crate) fn cancel_all(&self) {
        if let Ok(mut pending) = self.inner.pending.lock() {
            pending.clear();
            self.inner.wake.notify_one();
        }
    }

    pub fn schedule(&self, id: String, ctx: NotebookWatchContext, path: &Path) {
        let marker = PendingRemove {
            path: path.to_path_buf(),
            ctx,
            deadline: Instant::now() + self.delay,
        };
        if let Ok(mut pending) = self.inner.pending.lock() {
            pending.insert(id, marker);
            self.inner.wake.notify_one();
        }
    }

    pub fn cancel_by_disk_key(&self, path: &Path) {
        let has_pending = self
            .inner
            .pending
            .lock()
            .map(|pending| !pending.is_empty())
            .unwrap_or(false);
        if !has_pending || !path.exists() {
            return;
        }

        let mut id = None;
        for _ in 0..8 {
            id = std::fs::read_to_string(path)
                .ok()
                .and_then(|content| extract_frontmatter_key(&content));
            if id.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }

        let Some(id) = id else { return };
        if let Ok(mut pending) = self.inner.pending.lock() {
            if let Some(old) = pending.remove(&id) {
                tracing::debug!(
                    "[MemoWatcher] coalesced remove into update for id={}: {} -> {}",
                    id,
                    old.path.display(),
                    path.display()
                );
                self.inner.wake.notify_one();
            }
        }
    }

    fn inert(delay: Duration) -> Self {
        Self {
            inner: Arc::new(RemoveCoalescerInner {
                pending: Mutex::new(HashMap::new()),
                wake: Condvar::new(),
            }),
            delay,
        }
    }

    #[cfg(test)]
    fn insert_for_test(&self, id: String, path: PathBuf, ctx: NotebookWatchContext) {
        let marker = PendingRemove {
            path,
            ctx,
            deadline: Instant::now() + Duration::from_secs(60),
        };
        self.inner.pending.lock().unwrap().insert(id, marker);
    }

    #[cfg(test)]
    fn contains_for_test(&self, id: &str) -> bool {
        self.inner.pending.lock().unwrap().contains_key(id)
    }

    #[cfg(test)]
    fn pending_len_for_test(&self) -> usize {
        self.inner.pending.lock().unwrap().len()
    }
}

fn spawn_worker(
    inner: Arc<RemoveCoalescerInner>,
    app: AppHandle,
    memo_file: Arc<RwLock<MemoFile>>,
    fallback_delay: Duration,
) {
    std::thread::spawn(move || loop {
        let expired = {
            let mut pending = match inner.pending.lock() {
                Ok(pending) => pending,
                Err(_) => return,
            };
            loop {
                if Arc::strong_count(&inner) == 1 && pending.is_empty() {
                    return;
                }

                let now = Instant::now();
                let mut expired = Vec::new();
                pending.retain(|_, remove| {
                    if remove.deadline <= now {
                        expired.push(remove.clone());
                        false
                    } else {
                        true
                    }
                });
                if !expired.is_empty() {
                    break expired;
                }

                let wait_for = pending
                    .values()
                    .map(|remove| remove.deadline.saturating_duration_since(now))
                    .min()
                    .unwrap_or(fallback_delay);

                pending = match inner.wake.wait_timeout(pending, wait_for) {
                    Ok((pending, _)) => pending,
                    Err(_) => return,
                };
            }
        };

        for pending in expired {
            MemoEventProcessor::unregister_and_emit(&app, &memo_file, &pending.ctx, &pending.path);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watch_ctx() -> NotebookWatchContext {
        NotebookWatchContext {
            notebook_id: "nb_test".to_string(),
            root: PathBuf::from("."),
        }
    }

    #[test]
    fn create_event_with_same_frontmatter_key_cancels_pending_remove() {
        let coalescer = RemoveCoalescer::inert(Duration::from_secs(60));
        let id = "abc123".to_string();
        coalescer.insert_for_test(id.clone(), PathBuf::from("Old.md"), watch_ctx());

        let tmp = std::env::temp_dir().join(format!(
            "flowix-pending-remove-cancel-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let new_path = tmp.join("New.md");
        std::fs::write(&new_path, "---\nkey: abc123\n---\n# New\n").unwrap();

        coalescer.cancel_by_disk_key(&new_path);

        assert!(
            !coalescer.contains_for_test(&id),
            "new path with the same frontmatter key must cancel the old-path tombstone"
        );
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn schedule_records_pending_remove() {
        let coalescer = RemoveCoalescer::inert(Duration::from_secs(60));
        let id = "memo-1".to_string();
        coalescer.schedule(id.clone(), watch_ctx(), Path::new("Old.md"));

        assert!(coalescer.contains_for_test(&id));
        assert_eq!(coalescer.pending_len_for_test(), 1);
    }

    #[test]
    fn cancel_all_clears_pending_removes() {
        let coalescer = RemoveCoalescer::inert(Duration::from_secs(60));
        coalescer.schedule("memo-1".to_string(), watch_ctx(), Path::new("One.md"));
        coalescer.schedule("memo-2".to_string(), watch_ctx(), Path::new("Two.md"));

        coalescer.cancel_all();

        assert_eq!(coalescer.pending_len_for_test(), 0);
    }

    #[test]
    fn create_event_with_unknown_frontmatter_key_keeps_pending_remove() {
        let coalescer = RemoveCoalescer::inert(Duration::from_secs(60));
        let id = "abc123".to_string();
        coalescer.insert_for_test(id.clone(), PathBuf::from("Old.md"), watch_ctx());

        let tmp = std::env::temp_dir().join(format!(
            "flowix-pending-remove-unknown-key-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let new_path = tmp.join("New.md");
        std::fs::write(&new_path, "---\nkey: other\n---\n# New\n").unwrap();

        coalescer.cancel_by_disk_key(&new_path);

        assert!(
            coalescer.contains_for_test(&id),
            "unrelated frontmatter key must not cancel the old-path tombstone"
        );
        std::fs::remove_dir_all(&tmp).ok();
    }
}
