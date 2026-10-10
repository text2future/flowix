//! Cross-process coordination for notebook structure and file content changes.
//!
//! Lock files are stable coordination objects. They are deliberately kept outside
//! notebook roots and are never removed after an operation completes.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::cell::RefCell;
use std::collections::HashMap;
use std::marker::PhantomData;
use std::rc::Rc;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

const LOCK_TIMEOUT: Duration = Duration::from_secs(5);
const RETRY_INTERVAL: Duration = Duration::from_millis(50);

thread_local! {
    static NOTEBOOK_READ_LOCKS: RefCell<HashMap<(PathBuf, String), Rc<OsLock>>> = RefCell::new(HashMap::new());
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FileLockIntent {
    Existing,
    Create,
    ExistingOrMissing,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LockMode {
    Shared,
    Exclusive,
}

struct OsLock {
    file: File,
    path: PathBuf,
    operation: String,
    acquired_at: Instant,
}

impl Drop for OsLock {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.file);
        tracing::debug!(operation = %self.operation, lock = %self.path.display(), held_ms = self.acquired_at.elapsed().as_millis(), "operation lock released");
    }
}

pub struct NotebookReadGuard {
    lock: Rc<OsLock>,
    key: (PathBuf, String),
}

impl Drop for NotebookReadGuard {
    fn drop(&mut self) {
        NOTEBOOK_READ_LOCKS.with_borrow_mut(|locks| {
            if Rc::strong_count(&self.lock) == 2 {
                locks.remove(&self.key);
            }
        });
    }
}

pub struct NotebookChangeGuard {
    _locks: Vec<OsLock>,
    _legacy_gate: OsLock,
    _not_send: PhantomData<Rc<()>>,
}

pub struct NotebookMaintenanceGuard {
    _lock: OsLock,
}

pub struct VersionManifestGuard {
    _lock: OsLock,
}

pub struct FileWriteGuard {
    // Drop the file lock before the notebook shared lock.
    file: OsLock,
    notebook: NotebookReadGuard,
    legacy_gate: OsLock,
    path: PathBuf,
}

impl FileWriteGuard {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for FileWriteGuard {
    fn drop(&mut self) {
        // Fields are dropped in declaration order after this method returns.
        let _ = (&self.file, &self.notebook, &self.legacy_gate);
    }
}

pub struct OperationLocks {
    config_dir: PathBuf,
}

impl OperationLocks {
    pub fn new(config_dir: PathBuf) -> Self {
        Self { config_dir }
    }

    fn lock_path(path: PathBuf, mode: LockMode, operation: &str) -> io::Result<OsLock> {
        fs::create_dir_all(path.parent().ok_or_else(|| io::Error::other("invalid lock path"))?)?;
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&path)?;
        let started = Instant::now();
        loop {
            let result = match mode {
                LockMode::Shared => fs2::FileExt::try_lock_shared(&file),
                LockMode::Exclusive => fs2::FileExt::try_lock_exclusive(&file),
            };
            match result {
                Ok(()) => break,
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock
                        || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
                {
                    if started.elapsed() >= LOCK_TIMEOUT {
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            format!(
                                "{operation}: timed out waiting for {} lock {} after {} ms",
                                if mode == LockMode::Shared { "notebook shared" } else { "exclusive" },
                                path.display(),
                                started.elapsed().as_millis(),
                            ),
                        ));
                    }
                    std::thread::sleep(RETRY_INTERVAL);
                }
                Err(error) => return Err(error),
            }
        }
        tracing::debug!(operation, lock = %path.display(), mode = ?mode, wait_ms = started.elapsed().as_millis(), "operation lock acquired");
        Ok(OsLock { file, path, operation: operation.to_owned(), acquired_at: Instant::now() })
    }

    /// Attempt a single non-blocking lock acquisition. Returns `Ok(None)` when
    /// the lock is currently held elsewhere, so callers can skip instead of
    /// waiting. Used for coordination that must never turn into a blocking
    /// bottleneck (e.g. a second full-index reconcile pass).
    fn try_lock_path(path: PathBuf, mode: LockMode, operation: &str) -> io::Result<Option<OsLock>> {
        fs::create_dir_all(path.parent().ok_or_else(|| io::Error::other("invalid lock path"))?)?;
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&path)?;
        let result = match mode {
            LockMode::Shared => fs2::FileExt::try_lock_shared(&file),
            LockMode::Exclusive => fs2::FileExt::try_lock_exclusive(&file),
        };
        match result {
            Ok(()) => {
                tracing::debug!(operation, lock = %path.display(), mode = ?mode, "operation lock acquired (non-blocking)");
                Ok(Some(OsLock { file, path, operation: operation.to_owned(), acquired_at: Instant::now() }))
            }
            Err(error)
                if error.kind() == io::ErrorKind::WouldBlock
                    || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    fn lock_file(&self, relative: &Path, mode: LockMode, operation: &str) -> io::Result<OsLock> {
        Self::lock_path(self.config_dir.join("locks").join(relative), mode, operation)
    }

    fn legacy_gate(&self, operation: &str) -> io::Result<OsLock> {
        // Older Flowix processes take this lock exclusively. A shared hold
        // coordinates with them without serializing new file operations.
        Self::lock_path(self.config_dir.join(".memo-write.lock"), LockMode::Shared, operation)
    }

    fn notebook_lock_path(notebook_id: &str) -> io::Result<PathBuf> {
        if notebook_id.is_empty()
            || !notebook_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid notebook lock id"));
        }
        Ok(PathBuf::from("notebooks").join(format!("{notebook_id}.lock")))
    }

    pub fn notebook_read(&self, notebook_id: &str, operation: &str) -> io::Result<NotebookReadGuard> {
        let relative = Self::notebook_lock_path(notebook_id)?;
        let key = (self.config_dir.clone(), notebook_id.to_owned());
        if let Some(lock) = NOTEBOOK_READ_LOCKS.with_borrow(|locks| locks.get(&key).cloned()) {
            return Ok(NotebookReadGuard { lock, key });
        }
        let lock = Rc::new(self.lock_file(&relative, LockMode::Shared, operation)?);
        NOTEBOOK_READ_LOCKS.with_borrow_mut(|locks| {
            locks.insert(key.clone(), lock.clone());
        });
        Ok(NotebookReadGuard {
            lock, key,
        })
    }

    pub fn notebook_change(&self, notebook_ids: &[&str], operation: &str) -> io::Result<NotebookChangeGuard> {
        if notebook_ids.is_empty() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "notebook change needs at least one notebook"));
        }
        let legacy_gate = self.legacy_gate(operation)?;
        let mut ids = notebook_ids.to_vec();
        ids.sort_unstable();
        ids.dedup();
        let upgrading = NOTEBOOK_READ_LOCKS.with_borrow(|locks| ids.iter().any(|id| {
            locks.contains_key(&(self.config_dir.clone(), (*id).to_owned()))
        }));
        if upgrading {
            return Err(io::Error::new(io::ErrorKind::WouldBlock, "cannot upgrade notebook shared lock to exclusive"));
        }
        let mut locks = Vec::with_capacity(ids.len());
        for id in ids {
            locks.push(self.lock_file(&Self::notebook_lock_path(id)?, LockMode::Exclusive, operation)?);
        }
        Ok(NotebookChangeGuard { _locks: locks, _legacy_gate: legacy_gate, _not_send: PhantomData })
    }

    pub fn notebook_maintenance(&self, notebook_id: &str, operation: &str) -> io::Result<NotebookMaintenanceGuard> {
        let relative = Self::notebook_lock_path(notebook_id)?;
        Ok(NotebookMaintenanceGuard {
            _lock: self.lock_file(&PathBuf::from("maintenance").join(relative), LockMode::Exclusive, operation)?,
        })
    }

    /// Non-blocking variant of [`Self::notebook_maintenance`]. Returns `None`
    /// when another process already holds the per-notebook maintenance lock, so
    /// a second full-index reconcile pass can skip instead of timing out.
    pub fn try_notebook_maintenance(
        &self,
        notebook_id: &str,
        operation: &str,
    ) -> io::Result<Option<NotebookMaintenanceGuard>> {
        let relative = Self::notebook_lock_path(notebook_id)?;
        let path = self.config_dir.join("locks").join(PathBuf::from("maintenance").join(relative));
        Ok(Self::try_lock_path(path, LockMode::Exclusive, operation)?
            .map(|_lock| NotebookMaintenanceGuard { _lock }))
    }

    /// Serialize changes to one path archive's manifest. Callers also hold
    /// either the notebook's shared lock or its structural exclusive lock.
    pub fn version_manifest_write(&self, notebook_id: &str, relative_path: &str) -> io::Result<VersionManifestGuard> {
        Self::notebook_lock_path(notebook_id)?;
        let identity = format!("version-manifest:{notebook_id}:{}", relative_path.replace('\\', "/"));
        #[cfg(any(windows, target_os = "macos"))]
        let identity = identity.to_lowercase();
        let key = format!("{:x}.lock", Sha256::digest(identity.as_bytes()));
        Ok(VersionManifestGuard {
            _lock: self.lock_file(&PathBuf::from("files").join(key), LockMode::Exclusive, "write_path_version_manifest")?,
        })
    }

    fn stable_file_path(path: &Path, intent: FileLockIntent) -> io::Result<PathBuf> {
        match intent {
            FileLockIntent::Existing => fs::canonicalize(path),
            FileLockIntent::Create => {
                let parent = path.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "file has no parent"))?;
                let name = path.file_name().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "file has no name"))?;
                Ok(fs::canonicalize(parent)?.join(name))
            }
            FileLockIntent::ExistingOrMissing => match fs::canonicalize(path) {
                Ok(path) => Ok(path),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    Self::stable_file_path(path, FileLockIntent::Create)
                }
                Err(error) => Err(error),
            },
        }
    }

    pub fn file_write(
        &self,
        notebook_id: &str,
        notebook_root: &Path,
        path: &Path,
        intent: FileLockIntent,
        operation: &str,
    ) -> io::Result<FileWriteGuard> {
        let legacy_gate = self.legacy_gate(operation)?;
        let notebook = self.notebook_read(notebook_id, operation)?;
        let root = fs::canonicalize(notebook_root)?;
        let stable = Self::stable_file_path(path, intent)?;
        if !stable.starts_with(&root) || stable == root {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "file leaves notebook"));
        }
        let identity = stable.to_string_lossy().replace('\\', "/");
        #[cfg(any(windows, target_os = "macos"))]
        let identity = identity.to_lowercase();
        let digest = Sha256::digest(identity.as_bytes());
        let key = format!("{digest:x}.lock");
        let file = self.lock_file(&PathBuf::from("files").join(key), LockMode::Exclusive, operation)?;
        Ok(FileWriteGuard { file, notebook, legacy_gate, path: stable })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn different_files_can_write_while_notebook_is_shared() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notebook");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("a.md"), "a").unwrap();
        fs::write(root.join("b.md"), "b").unwrap();
        let locks = OperationLocks::new(temp.path().join("config"));
        let first = locks.file_write("book", &root, &root.join("a.md"), FileLockIntent::Existing, "test_a").unwrap();
        let second = locks.file_write("book", &root, &root.join("b.md"), FileLockIntent::Existing, "test_b").unwrap();
        assert_ne!(first.path(), second.path());
    }

    #[test]
    fn same_path_stays_locked_across_atomic_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notebook");
        fs::create_dir(&root).unwrap();
        let path = root.join("a.md");
        fs::write(&path, "old").unwrap();
        let config = temp.path().join("config");
        let first = OperationLocks::new(config.clone()).file_write("book", &root, &path, FileLockIntent::Existing, "first").unwrap();
        super::super::atomic_write_bytes(&path, b"new").unwrap();
        let (sender, receiver) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _second = OperationLocks::new(config).file_write("book", &root, &path, FileLockIntent::Existing, "second").unwrap();
            sender.send(()).unwrap();
        });
        assert!(receiver.recv_timeout(Duration::from_millis(150)).is_err());
        drop(first);
        receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        worker.join().unwrap();
    }

    #[test]
    fn notebook_change_waits_for_file_write() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notebook");
        fs::create_dir(&root).unwrap();
        let path = root.join("a.md");
        fs::write(&path, "a").unwrap();
        let config = temp.path().join("config");
        let file = OperationLocks::new(config.clone()).file_write("book", &root, &path, FileLockIntent::Existing, "save").unwrap();
        let (sender, receiver) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _change = OperationLocks::new(config).notebook_change(&["book"], "rename").unwrap();
            sender.send(()).unwrap();
        });
        assert!(receiver.recv_timeout(Duration::from_millis(150)).is_err());
        drop(file);
        receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        worker.join().unwrap();
    }

    #[test]
    fn save_waiting_for_deleted_directory_does_not_recreate_it() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notebook");
        fs::create_dir(&root).unwrap();
        let path = root.join("a.md");
        fs::write(&path, "a").unwrap();
        let config = temp.path().join("config");
        let change = OperationLocks::new(config.clone()).notebook_change(&["book"], "delete_directory").unwrap();
        let (sender, receiver) = mpsc::channel();
        let root_for_worker = root.clone();
        let worker = std::thread::spawn(move || {
            let result = OperationLocks::new(config).file_write("book", &root_for_worker, &path, FileLockIntent::Existing, "save");
            sender.send(result.map(|_| ())).unwrap();
        });
        assert!(receiver.recv_timeout(Duration::from_millis(150)).is_err());
        fs::remove_dir_all(&root).unwrap();
        drop(change);
        assert_eq!(receiver.recv_timeout(Duration::from_secs(2)).unwrap().unwrap_err().kind(), io::ErrorKind::NotFound);
        assert!(!root.exists());
        worker.join().unwrap();
    }

    #[test]
    fn legacy_exclusive_lock_blocks_new_file_operations() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notebook");
        fs::create_dir(&root).unwrap();
        let path = root.join("a.md");
        fs::write(&path, "a").unwrap();
        let config = temp.path().join("config");
        fs::create_dir(&config).unwrap();
        let legacy = OpenOptions::new().create(true).read(true).write(true)
            .open(config.join(".memo-write.lock")).unwrap();
        fs2::FileExt::lock_exclusive(&legacy).unwrap();
        let (sender, receiver) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _guard = OperationLocks::new(config).file_write("book", &root, &path, FileLockIntent::Existing, "new_save").unwrap();
            sender.send(()).unwrap();
        });
        assert!(receiver.recv_timeout(Duration::from_millis(150)).is_err());
        fs2::FileExt::unlock(&legacy).unwrap();
        receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        worker.join().unwrap();
    }

    #[test]
    fn nested_shared_lock_survives_out_of_order_drop() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("config");
        let locks = OperationLocks::new(config.clone());
        let outer = locks.notebook_read("book", "outer").unwrap();
        let inner = locks.notebook_read("book", "inner").unwrap();
        drop(outer);
        let (sender, receiver) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _change = OperationLocks::new(config).notebook_change(&["book"], "change").unwrap();
            sender.send(()).unwrap();
        });
        assert!(receiver.recv_timeout(Duration::from_millis(150)).is_err());
        drop(inner);
        receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        worker.join().unwrap();
    }

    #[test]
    fn cross_notebook_change_acquires_in_sorted_order_without_deadlock() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("config");
        let locks = OperationLocks::new(config.clone());
        // Take the parent lock before spawning the worker so the worker is
        // guaranteed to wait rather than racing ahead.
        let _change = locks.notebook_change(&["a", "b"], "move_a_to_b").unwrap();
        let (sender, receiver) = mpsc::channel();
        // The worker submits the ids in the opposite order. notebook_change must
        // sort internally, otherwise the two threads would deadlock on a->b vs b->a.
        let worker = std::thread::spawn(move || {
            let _change = OperationLocks::new(config)
                .notebook_change(&["b", "a"], "move_b_to_a")
                .unwrap();
            sender.send(()).unwrap();
        });
        // While the parent holds both notebooks, the worker must be waiting rather
        // than already finished.
        assert!(receiver.recv_timeout(Duration::from_millis(150)).is_err());
        drop(_change);
        receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        worker.join().unwrap();
    }
}
