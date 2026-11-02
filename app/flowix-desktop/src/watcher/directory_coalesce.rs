//! Collapses a burst of directory-change events into one whole-notebook
//! reconcile.
//!
//! Windows reports a single atomic note write inside a subfolder as several
//! `Modify(Any)` events on the parent directory: creating the temp file and
//! renaming it over the target both touch that directory's entry table. The
//! same write performed directly in the notebook root reports no directory
//! event at all, because there the watched root is its own parent.
//!
//! `reconcile_directory_change` is whole-notebook and idempotent: it never
//! inspects which entry changed, it recomputes the notebook from disk. Three
//! runs in the same millisecond and one run therefore produce the same result,
//! so a burst only needs to be collapsed, never interpreted. Collapsing is not
//! the same as suppressing: nothing that arrived is dropped without being
//! covered by the following reconcile.
//!
//! The window is fixed rather than reset per event. An external bulk change
//! (checkout, folder copy) sends a long stream of directory events, and
//! resetting on every event would postpone the reconcile until the stream ends.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::NotebookWatchContext;

/// Covers one atomic save's event burst while staying below the point where a
/// newly created folder would stop feeling immediate.
pub(crate) const DIRECTORY_COALESCE_WINDOW: Duration = Duration::from_millis(400);

/// Caps the remembered directory list: the probe only needs a representative
/// sample, and a bulk change can touch thousands of paths.
const MAX_REMEMBERED_DIRECTORIES: usize = 4;

/// Per-notebook coalescing state. Lives on the worker thread and therefore
/// dies with the worker when the watched root is rebound.
#[derive(Default)]
pub(crate) struct DirectoryCoalescer {
    pending: HashMap<String, PendingReconcile>,
}

struct PendingReconcile {
    context: NotebookWatchContext,
    deadline: Instant,
    /// Every event folded into this window, including the first one.
    absorbed: u32,
    directories: Vec<PathBuf>,
}

/// One burst whose window has closed.
pub(crate) struct DueReconcile {
    pub context: NotebookWatchContext,
    pub absorbed: u32,
    pub directories: Vec<PathBuf>,
}

impl DirectoryCoalescer {
    /// Fold one directory event into the open window for its notebook, opening
    /// the window if this is the first event of a burst.
    pub(crate) fn absorb(&mut self, context: &NotebookWatchContext, directory: &Path, now: Instant) {
        if let Some(pending) = self.pending.get_mut(&context.notebook_id) {
            pending.absorbed += 1;
            if pending.directories.len() < MAX_REMEMBERED_DIRECTORIES
                && !pending.directories.iter().any(|known| known == directory)
            {
                pending.directories.push(directory.to_path_buf());
            }
            return;
        }
        self.pending.insert(
            context.notebook_id.clone(),
            PendingReconcile {
                context: context.clone(),
                deadline: now + DIRECTORY_COALESCE_WINDOW,
                absorbed: 1,
                directories: vec![directory.to_path_buf()],
            },
        );
    }

    /// Earliest moment at which some burst is due. The worker blocks on this so
    /// a trailing reconcile never waits for the next unrelated event.
    pub(crate) fn next_deadline(&self) -> Option<Instant> {
        self.pending
            .values()
            .map(|pending| pending.deadline)
            .min()
    }

    /// Remove and return every burst whose window has closed.
    pub(crate) fn drain_due(&mut self, now: Instant) -> Vec<DueReconcile> {
        let due: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, pending)| pending.deadline <= now)
            .map(|(notebook_id, _)| notebook_id.clone())
            .collect();
        due.into_iter()
            .filter_map(|notebook_id| self.pending.remove(&notebook_id))
            .map(|pending| DueReconcile {
                context: pending.context,
                absorbed: pending.absorbed,
                directories: pending.directories,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(notebook_id: &str) -> NotebookWatchContext {
        NotebookWatchContext {
            notebook_id: notebook_id.to_owned(),
            root: PathBuf::from("root"),
        }
    }

    #[test]
    fn burst_within_the_window_collapses_to_one_reconcile() {
        let mut coalescer = DirectoryCoalescer::default();
        let start = Instant::now();
        for _ in 0..3 {
            coalescer.absorb(&context("a"), Path::new("root/sub"), start);
        }

        assert!(coalescer.drain_due(start + Duration::from_millis(399)).is_empty());

        let due = coalescer.drain_due(start + DIRECTORY_COALESCE_WINDOW);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].absorbed, 3);
        assert_eq!(due[0].directories, vec![PathBuf::from("root/sub")]);
        assert!(coalescer.drain_due(start + DIRECTORY_COALESCE_WINDOW).is_empty());
    }

    #[test]
    fn a_later_burst_opens_a_new_window() {
        let mut coalescer = DirectoryCoalescer::default();
        let start = Instant::now();
        coalescer.absorb(&context("a"), Path::new("root/sub"), start);
        coalescer.drain_due(start + DIRECTORY_COALESCE_WINDOW);

        let later = start + Duration::from_secs(1);
        coalescer.absorb(&context("a"), Path::new("root/sub"), later);
        let due = coalescer.drain_due(later + DIRECTORY_COALESCE_WINDOW);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].absorbed, 1);
    }

    #[test]
    fn notebooks_keep_independent_windows() {
        let mut coalescer = DirectoryCoalescer::default();
        let start = Instant::now();
        coalescer.absorb(&context("a"), Path::new("root/sub"), start);

        let later = start + Duration::from_millis(200);
        coalescer.absorb(&context("b"), Path::new("other/sub"), later);

        assert_eq!(coalescer.next_deadline(), Some(start + DIRECTORY_COALESCE_WINDOW));
        let first = coalescer.drain_due(start + DIRECTORY_COALESCE_WINDOW);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].context.notebook_id, "a");
        assert_eq!(
            coalescer.next_deadline(),
            Some(later + DIRECTORY_COALESCE_WINDOW)
        );
    }

    #[test]
    fn the_directory_list_stays_bounded_on_a_bulk_change() {
        let mut coalescer = DirectoryCoalescer::default();
        let start = Instant::now();
        for index in 0..50 {
            coalescer.absorb(
                &context("a"),
                &PathBuf::from(format!("root/dir{index}")),
                start,
            );
        }
        let due = coalescer.drain_due(start + DIRECTORY_COALESCE_WINDOW);
        assert_eq!(due[0].absorbed, 50);
        assert_eq!(due[0].directories.len(), MAX_REMEMBERED_DIRECTORIES);
    }

    /// The premise of this module, measured against a real filesystem: a note
    /// saved with the same temp-file-plus-rename sequence the backend uses
    /// reports its parent directory as modified when it lives in a subfolder.
    ///
    /// This is the regression guard for the burst that made a subfolder note
    /// feel slower than a root note. If a notify upgrade stops reporting these,
    /// this test fails and the collapsing can be revisited — it would then be
    /// harmless rather than necessary.
    ///
    /// The mirror observation (the same write in the notebook root reports no
    /// directory event, because there the watched root is its own parent) is
    /// deliberately *not* asserted: it is an explanation, not a requirement.
    #[cfg(target_os = "windows")]
    #[test]
    fn an_atomic_write_in_a_subfolder_reports_its_parent_directory() {
        use notify::Watcher;
        use std::io::Write;

        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("notebook");
        let subfolder = root.join("sub");
        std::fs::create_dir_all(&subfolder).expect("subfolder");

        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                if let Ok(event) = result {
                    let _ = tx.send(event);
                }
            })
            .expect("watcher");
        watcher
            .watch(&root, notify::RecursiveMode::Recursive)
            .expect("watch root");
        std::thread::sleep(Duration::from_millis(300));

        let target = subfolder.join("note.md");
        let mut temporary = tempfile::NamedTempFile::new_in(&subfolder).expect("temp file");
        temporary.write_all(b"# hello\n").expect("write");
        temporary.as_file().sync_all().expect("sync");
        temporary.persist(&target).expect("persist");

        let deadline = Instant::now() + Duration::from_secs(3);
        let mut reported_parent_directory = false;
        while Instant::now() < deadline && !reported_parent_directory {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let Ok(event) = rx.recv_timeout(remaining.min(Duration::from_millis(200))) else {
                continue;
            };
            reported_parent_directory = event
                .paths
                .iter()
                .any(|path| path == &subfolder && path.is_dir());
        }

        assert!(
            reported_parent_directory,
            "an atomic write inside `sub/` no longer reports the parent directory; \
             the burst this module collapses may no longer exist"
        );
    }
}
