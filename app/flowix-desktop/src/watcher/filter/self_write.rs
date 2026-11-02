//! Stable-revision self-write reconciliation.
//!
//! The notify callback never drops a path merely because it was recently
//! written. The worker calls this module only after the file settles.

use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::watcher::filter::{FileRevision, SelfWriteMap, SELF_WRITE_TTL};

/// Return true only when the stable on-disk revision is the exact revision
/// captured by a backend-owned write. A path match alone is never sufficient.
pub fn is_exact_self_write(
    path: &Path,
    current_revision: &FileRevision,
    recent_self_writes: &Arc<Mutex<SelfWriteMap>>,
) -> bool {
    let key = crate::watcher::path::normalize_for_compare(path);
    let Ok(mut map) = recent_self_writes.lock() else {
        return false;
    };
    // 顺手�?��过老条�?��SELF_WRITE_TTL (2s) 覆盖 IPC 命令结束 �?notify
    // 回调到达的间�? FSEvents 双触�?(macOS 把一�?fs::write 拆成
    // Keep both Metadata and Data events suppressed during the TTL, then
    // prune expired entries so the table stays bounded.
    map.retain(|_, mark| mark.marked_at.elapsed() < SELF_WRITE_TTL);

    // Keep the entry after an exact hit so duplicate FSEvents for the same
    // write are suppressed. A different revision invalidates it below.
    let suppress = map
        .get(&key)
        .is_some_and(|mark| mark.expected_revision.as_ref() == Some(current_revision));
    if suppress {
        tracing::debug!(
            "[SelfWriteSuppressor] HIT path={} key={} table_size={}",
            path.display(),
            key.display(),
            map.len(),
        );
    } else {
        tracing::debug!(
            "[SelfWriteSuppressor] MISS path={} key={} table_size={}",
            path.display(),
            key.display(),
            map.len(),
        );
    }
    // A stable revision resolves the expectation either way. Duplicate
    // notify events are handled by the worker's processed-revision map.
    map.remove(&key);
    suppress
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::watcher::filter::{FileRevision, SelfWriteMap, SelfWriteMark};
    use std::time::Instant;

    fn marked_writes(path: &std::path::Path) -> Arc<Mutex<SelfWriteMap>> {
        let writes = Arc::new(Mutex::new(SelfWriteMap::new()));
        writes.lock().unwrap().insert(
            crate::watcher::path::normalize_for_compare(path),
            SelfWriteMark {
                marked_at: Instant::now(),
                expected_revision: FileRevision::read(path),
            },
        );
        writes
    }

    #[test]
    fn suppresses_only_the_exact_marked_content_revision() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.md");
        std::fs::write(&path, "first revision").unwrap();
        let writes = marked_writes(&path);
        let revision = FileRevision::read(&path).unwrap();

        assert!(is_exact_self_write(&path, &revision, &writes));
        assert!(writes.lock().unwrap().is_empty());
    }

    #[test]
    fn passes_a_new_revision_written_to_the_same_marked_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.md");
        std::fs::write(&path, "ui revision").unwrap();
        let writes = marked_writes(&path);
        std::fs::write(&path, "agent revision").unwrap();
        let revision = FileRevision::read(&path).unwrap();

        assert!(!is_exact_self_write(&path, &revision, &writes));
        assert!(writes.lock().unwrap().is_empty());
    }

    /// The editor knows the exact bytes it is about to write, so it marks the
    /// revision *before* the write. The watcher may validate at any later
    /// moment — the match must not depend on when the save finishes its index
    /// and FTS work.
    #[test]
    fn suppresses_a_write_marked_with_its_own_content_before_the_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.md");
        std::fs::write(&path, "old revision").unwrap();

        let writes = Arc::new(Mutex::new(SelfWriteMap::new()));
        let new_content = b"new revision written by the editor";
        writes.lock().unwrap().insert(
            crate::watcher::path::normalize_for_compare(&path),
            SelfWriteMark {
                marked_at: Instant::now(),
                expected_revision: Some(FileRevision::from_bytes(new_content)),
            },
        );
        std::fs::write(&path, new_content).unwrap();

        // No post-write mark has been registered yet: this is the window in
        // which a slow save used to be reported as an external edit.
        let revision = FileRevision::read(&path).unwrap();
        assert!(is_exact_self_write(&path, &revision, &writes));
    }

    /// Guards the regression this fixed: a pre-write mark taken from the file
    /// currently on disk hashes the *previous* content, never matches the
    /// revision that lands, and leaves the app's own save looking external.
    #[test]
    fn a_pre_write_mark_of_stale_disk_content_does_not_suppress_the_save() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.md");
        std::fs::write(&path, "old revision").unwrap();
        let writes = marked_writes(&path);
        std::fs::write(&path, "new revision").unwrap();

        let revision = FileRevision::read(&path).unwrap();
        assert!(!is_exact_self_write(&path, &revision, &writes));
    }
}
