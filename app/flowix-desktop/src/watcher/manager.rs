//! Observe notebook paths and dispatch serial file updates.
//! Exact revisions suppress self-writes; explicit OS rename pairs rebase paths.
//! Split rename events use runtime filesystem identities, never frontmatter.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::AppHandle;

use crate::watcher::filter::{FileRevision, SelfWriteMap, SelfWriteMark, SELF_WRITE_TTL};
use crate::watcher::tombstone::RemoveCoalescer;
use crate::watcher::{
    filter::PathFilter, normalize_for_compare, FsEventKind, PathNoteEventProcessor,
    NotebookWatchContext, RawFsEvent, WhitelistConfig,
};
use flowix_core::memo_file::{
    media_kind_for_path, FileManagementPolicy, MemoFile, NotebookConfig,
};

const REMOVE_TOMBSTONE_DELAY: Duration = Duration::from_millis(450);

/// Watches configured notebook roots and sends filtered events to a serial worker.
/// A delayed remove can be canceled by a confirmed rename pair. The watcher
/// never matches a replacement file using its Markdown content or frontmatter.
pub struct MemoWatcher {
    _watcher: Option<RecommendedWatcher>,
    watched_roots: Arc<std::sync::RwLock<Vec<NotebookWatchContext>>>,
    suspended_notebook_ids: HashMap<String, usize>,
    recent_self_writes: Arc<Mutex<SelfWriteMap>>,
    remove_coalescer: Option<RemoveCoalescer>,
    memo_file: Arc<std::sync::RwLock<MemoFile>>,
    whitelist: Arc<std::sync::RwLock<WhitelistConfig>>,
    /// notify shared thread -> one worker thread. The callback performs only
    /// cheap path filtering and enqueueing. File settling, revision reconciliation,
    /// deduplication and memo processing run serially on the worker, avoiding stalls in
    /// 所有 notebook 的事件投递会被单次 settle 卡住)。单 worker 保 FIFO, 不破坏同路径
    /// 事件顺序。Drop 时 `worker_tx` 先落, 通道关闭, worker `recv` 返回 Err 后自然退出。
    worker_tx: Option<std::sync::mpsc::Sender<(RawFsEvent, NotebookWatchContext)>>,
    _worker: Option<std::thread::JoinHandle<()>>,
}

impl MemoWatcher {
    /// Update only one root when template writes temporarily suspend it. Keep
    /// the shared watcher, event queue and every unrelated notebook alive.
    pub fn refresh_notebook_root(&mut self, config: &NotebookConfig) -> bool {
        let Some(watcher) = self._watcher.as_mut() else {
            return false;
        };
        if self.suspended_notebook_ids.contains_key(&config.id) {
            if let Some(coalescer) = &self.remove_coalescer {
                coalescer.cancel_notebook(&config.id);
            }
        }
        let Ok(roots) = self.watched_roots.read() else {
            return false;
        };
        let previous: Vec<PathBuf> = roots
            .iter()
            .filter(|context| context.notebook_id == config.id)
            .map(|context| context.root.clone())
            .collect();
        drop(roots);
        for root in previous {
            if watcher.unwatch(&root).is_err() {
                return false;
            }
        }
        if let Ok(mut roots) = self.watched_roots.write() {
            roots.retain(|context| context.notebook_id != config.id);
        } else {
            return false;
        }
        if self.suspended_notebook_ids.contains_key(&config.id) {
            return true;
        }
        let root = PathBuf::from(&config.path);
        if !root.is_dir() || watcher.watch(&root, RecursiveMode::Recursive).is_err() {
            return false;
        }
        if let Ok(mut roots) = self.watched_roots.write() {
            roots.push(NotebookWatchContext {
                notebook_id: config.id.clone(),
                root,
            });
            true
        } else {
            false
        }
    }

    /// Add one newly registered notebook without restarting every existing watch.
    /// Return false when the watcher has not started, so the caller can bind all roots.
    pub fn add_notebook_root(&mut self, config: &NotebookConfig) -> bool {
        if self.is_watching(&config.id) {
            return true;
        }
        let Some(watcher) = self._watcher.as_mut() else {
            return false;
        };
        if self.suspended_notebook_ids.contains_key(&config.id) {
            return true;
        }
        let root = PathBuf::from(&config.path);
        if !root.is_dir() {
            return false;
        }
        if watcher.watch(&root, RecursiveMode::Recursive).is_err() {
            return false;
        }
        match self.watched_roots.write() {
            Ok(mut roots) => {
                roots.push(NotebookWatchContext { notebook_id: config.id.clone(), root });
                true
            }
            Err(_) => {
                let _ = watcher.unwatch(&root);
                false
            }
        }
    }

    pub fn is_watching(&self, notebook_id: &str) -> bool {
        self._watcher.is_some()
            && self.watched_roots.read().is_ok_and(|roots| {
                roots.iter().any(|context| context.notebook_id == notebook_id)
            })
    }

    pub fn new(memo_file: Arc<std::sync::RwLock<MemoFile>>) -> Self {
        Self {
            _watcher: None,
            watched_roots: Arc::new(std::sync::RwLock::new(Vec::new())),
            suspended_notebook_ids: HashMap::new(),
            recent_self_writes: Arc::new(Mutex::new(HashMap::new())),
            remove_coalescer: None,
            memo_file,
            whitelist: Arc::new(std::sync::RwLock::new(WhitelistConfig::load_or_default())),
            worker_tx: None,
            _worker: None,
        }
    }

    /// 鏇挎崲鐧藉悕鍗曢厤缃€?`lib.rs::setup` 浼氬湪鍚姩 + 鐑洿鏂版椂璋冪敤,
    /// �?���?`Arc<RwLock<WhitelistConfig>>` 共享�?
    pub fn set_whitelist(&self, new_cfg: WhitelistConfig) {
        if let Ok(mut g) = self.whitelist.write() {
            let mut config = new_cfg;
            // Legacy name rules are migrated into each notebook policy.
            config.skip_dirs = vec![".flowix".into(), ".plugin-output".into()];
            config.skip_files.clear();
            config.allowed_filename_patterns.clear();
            config.watch_hidden = true;
            *g = config;
        }
    }

    pub fn set_notebook_suspended(&mut self, notebook_id: &str, suspended: bool) {
        if suspended {
            *self
                .suspended_notebook_ids
                .entry(notebook_id.to_string())
                .or_default() += 1;
        } else if let Some(count) = self.suspended_notebook_ids.get_mut(notebook_id) {
            if *count == 1 {
                self.suspended_notebook_ids.remove(notebook_id);
            } else {
                *count -= 1;
            }
        }
    }

    pub fn rebind_all(&mut self, app: AppHandle, configs: Vec<NotebookConfig>) {
        // Drop �?watcher —此赋�?`take` �?Option, �?RecommendedWatcher 立即析构
        let _ = self._watcher.take();
        if let Some(coalescer) = self.remove_coalescer.take() {
            coalescer.cancel_all();
        }
        // 旧 worker_tx drop -> 旧通道关闭 -> 旧 worker `recv` 返回 Err 退出。
        let _ = self.worker_tx.take();
        let _ = self._worker.take();

        let roots: Vec<NotebookWatchContext> = configs
            .into_iter()
            .filter(|config| !self.suspended_notebook_ids.contains_key(&config.id))
            .filter_map(|config| {
                let root = PathBuf::from(&config.path);
                if !root.is_dir() {
                    tracing::warn!(
                        "[MemoWatcher] watch skipped, notebook path is not a dir: {}",
                        root.display()
                    );
                    return None;
                }
                Some(NotebookWatchContext {
                    notebook_id: config.id,
                    root,
                })
            })
            .collect();
        if let Ok(mut watched) = self.watched_roots.write() { watched.clear(); }
        if roots.is_empty() {
            return;
        }

        let remove_coalescer =
            RemoveCoalescer::new(app.clone(), self.memo_file.clone(), REMOVE_TOMBSTONE_DELAY);
        let remove_coalescer_for_callback = remove_coalescer.clone();
        let app = app.clone();
        let recent_for_worker = self.recent_self_writes.clone();
        let whitelist = self.whitelist.clone();
        let watched_roots = self.watched_roots.clone();

        // notify 共享事件线程 -> 单 worker 线程的派发通道。notify 回调只做廉价的
        // filter / debounce / 自写抑制 + 入队 (`send` 非阻塞), 重 `process` 交给 worker。
        // tx 给回调, rx 留给下方 watched_count>0 后 spawn 的 worker。
        let (worker_tx, worker_rx) =
            std::sync::mpsc::channel::<(RawFsEvent, NotebookWatchContext)>();
        let worker_tx_for_callback = worker_tx.clone();

        let mut rename_tracker = super::rename_tracker::RenameTracker::seed(&roots);
        let mut watcher: RecommendedWatcher =
            match notify::recommended_watcher(move |res: notify::Result<Event>| {
                let Ok(event) = res else {
                    return;
                };
                let removed_known_directories: std::collections::HashSet<PathBuf> = event.paths.iter()
                    .filter(|path| rename_tracker.was_directory(path))
                    .cloned()
                    .collect();
                let event = rename_tracker.correlate(event);
                handle_notify_event(
                    &remove_coalescer_for_callback,
                    &whitelist,
                    &watched_roots,
                    &worker_tx_for_callback,
                    event,
                    removed_known_directories,
                );
            }) {
                Ok(w) => w,
                Err(e) => {
                    tracing::error!("[MemoWatcher] failed to create watcher: {e}");
                    return;
                }
            };

        let mut watched_count = 0usize;
        for ctx in roots {
            if let Err(e) = watcher.watch(&ctx.root, RecursiveMode::Recursive) {
                tracing::error!("[MemoWatcher] failed to watch {}: {e}", ctx.root.display());
                continue;
            }
            tracing::info!(
                "[MemoWatcher] watching notebook {} at {}",
                ctx.notebook_id,
                ctx.root.display()
            );
            if let Ok(mut watched) = self.watched_roots.write() {
                watched.push(ctx.clone());
            } else {
                tracing::error!("[MemoWatcher] failed to record watched notebook root");
                let _ = watcher.unwatch(&ctx.root);
                continue;
            }
            watched_count += 1;
        }
        if watched_count == 0 {
            return;
        }

        // 单 worker 串行 drain -> 保 FIFO (同路径事件顺序不乱)。`process` 含
        // `wait_for_markdown_copy_to_settle` (≤400ms) + 磁盘读写, 跑在这里而非 notify
        // 共享线程, 解放后者继续投递其它 notebook 的事件。通道关闭 (MemoWatcher drop /
        // rebind 取走 worker_tx) 时 `recv` 返回 Err, worker 自然退出。
        let worker_app = app.clone();
        let worker_memo_file = self.memo_file.clone();
        let worker = std::thread::Builder::new()
            .name("memo-watcher-processor".into())
            .spawn(move || {
                let mut processed_revisions = HashMap::<PathBuf, FileRevision>::new();
                while let Ok((raw, ctx)) = worker_rx.recv() {
                    if !should_process_stable_event(
                        &raw,
                        &recent_for_worker,
                        &mut processed_revisions,
                    ) {
                        continue;
                    }
                    // catch_unwind: 单个事件处理 panic 不能永久杀死 worker (否则后续事件
                    // 静默不处理)。panic 本身是 bug (见技术债务「unwrap panic」节), 这里只做
                    // 隔离 + 记录, 让 worker 继续处理后续事件。
                    if let Err(payload) =
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            PathNoteEventProcessor::process(&raw, &worker_app, &worker_memo_file, &ctx)
                        }))
                    {
                        tracing::error!(
                            thread = "memo-watcher-processor",
                            path = %raw.path.display(),
                            kind = ?raw.kind,
                            "PathNoteEventProcessor::process panicked; worker recovered. payload={:?}",
                            payload
                        );
                    }
                }
            })
            .expect("spawn memo-watcher-processor");

        self.remove_coalescer = Some(remove_coalescer);
        self._watcher = Some(watcher);
        self.worker_tx = Some(worker_tx);
        self._worker = Some(worker);
    }

    /// Capture the current on-disk revision for a backend-owned write.
    /// Duplicate notify events are suppressed only while that exact revision
    /// remains on disk; a later writer on the same path passes immediately.
    pub fn mark_self_write(&self, path: &Path) {
        self.mark_self_write_expected(path, FileRevision::read(path));
    }

    pub fn mark_self_write_content(&self, path: &Path, content: &[u8]) {
        self.mark_self_write_expected(path, Some(FileRevision::from_bytes(content)));
    }

    pub fn mark_self_write_missing(&self, path: &Path) {
        self.mark_self_write_expected(path, None);
    }

    fn mark_self_write_expected(&self, path: &Path, expected_revision: Option<FileRevision>) {
        let key = normalize_for_compare(path);
        if let Ok(mut map) = self.recent_self_writes.lock() {
            // 顺手�?��过老条�? 抑制表小 (<几十�? �?�� < 1µs
            map.retain(|_, mark| mark.marked_at.elapsed() < SELF_WRITE_TTL);
            tracing::debug!(
                "[mark_self_write] path={} key={} table_size={}",
                path.display(),
                key.display(),
                map.len(),
            );
            map.insert(
                key,
                SelfWriteMark {
                    marked_at: Instant::now(),
                    expected_revision,
                },
            );
        }
    }
}

/// notify 回调主体 —过滤 + �?��抑制 + 防抖 + 触发 `MemoFile` 重派�?+ emit�?///
/// 注意: 这个函数�?notify �?��的线程上�? �?ReAct 主循�?��发�?/// `MemoFile` �?`Arc<StdRwLock<MemoFile>>`, 我们读锁�? 调用方负责不持锁�?await�?///
/// 抑制两道�? 逐级下沉:
/// 1. `recent_self_writes` (�?��) —`mark_self_write` 在写盘前调用
/// 2. `last_emit` (�?��) —150ms 内同�?��事件�? 处理 FSEvents 双触�?
fn handle_notify_event(
    remove_coalescer: &RemoveCoalescer,
    whitelist: &Arc<std::sync::RwLock<WhitelistConfig>>,
    watched_roots: &Arc<std::sync::RwLock<Vec<NotebookWatchContext>>>,
    worker_tx: &std::sync::mpsc::Sender<(RawFsEvent, NotebookWatchContext)>,
    event: notify::Event,
    removed_known_directories: std::collections::HashSet<PathBuf>,
) {
    let path_filter = PathFilter {
        whitelist: whitelist.clone(),
    };
    // Preserve explicit rename pairs; never infer identity from Markdown bytes.
    if matches!(
        event.kind,
        notify::EventKind::Modify(notify::event::ModifyKind::Name(
            notify::event::RenameMode::Both
        ))
    ) && event.paths.len() == 2
    {
        let old = &event.paths[0];
        let new = &event.paths[1];
        let old_context = context_for_path(watched_roots, old);
        let new_context = context_for_path(watched_roots, new);
        if old_context.as_ref().map(|ctx| &ctx.notebook_id)
            != new_context.as_ref().map(|ctx| &ctx.notebook_id)
        {
            if let (Some(old_ctx), Some(new_ctx)) = (old_context.as_ref(), new_context.as_ref()) {
                let mut rename = RawFsEvent::new(FsEventKind::Other, new.clone());
                rename.rename_from = Some(old.clone());
                rename.rename_from_notebook_id = Some(old_ctx.notebook_id.clone());
                rename.rename_from_root = Some(old_ctx.root.clone());
                let _ = worker_tx.send((rename, new_ctx.clone()));
            }
            for (path, context) in [(old, old_context), (new, new_context)] {
                if let Some(ctx) = context {
                    let _ = worker_tx.send((RawFsEvent::new(FsEventKind::DirectoryChange, path.clone()), ctx));
                }
            }
            return;
        }
        if let (Some(old_ctx), Some(ctx)) = (
            context_for_path(watched_roots, old),
            context_for_path(watched_roots, new),
        ) {
            if old_ctx.notebook_id == ctx.notebook_id {
                let new_allowed = path_allowed_for_watch(&ctx.root, new, new.is_dir());
                let old_allowed = path_allowed_for_watch(&ctx.root, old, new.is_dir() || old.is_dir());
                let new_markdown = new.extension().is_some_and(|extension| {
                    extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
                });
                if !new.is_dir() && ((old_allowed && media_kind_for_path(old).is_some())
                    || (new_allowed && media_kind_for_path(new).is_some())) {
                    remove_coalescer.cancel_path(old);
                    let mut raw = RawFsEvent::new(FsEventKind::Modify, new.clone());
                    raw.rename_from = Some(old.clone());
                    let _ = worker_tx.send((raw, ctx));
                    return;
                }
                if old_allowed && !new_markdown && !new.is_dir() {
                    let _ = worker_tx.send((RawFsEvent::new(FsEventKind::DirectoryChange, old.clone()), ctx));
                    return;
                }
                if new_allowed || old_allowed {
                    remove_coalescer.cancel_path(old);
                    let mut raw = RawFsEvent::new(
                        if new.is_dir() {
                            FsEventKind::DirectoryChange
                        } else {
                            FsEventKind::Modify
                        },
                        new.clone(),
                    );
                    raw.rename_from = Some(old.clone());
                    if new.is_dir() || !new_allowed
                        || crate::commands::document_list::is_table_document_path(old)
                        || crate::commands::document_list::is_table_document_path(new)
                        || matches!(
                            crate::watcher::filter::run_pipeline(&raw, &path_filter),
                            crate::watcher::event::FilterDecision::Pass
                        )
                    {
                        let _ = worker_tx.send((raw, ctx));
                        return;
                    }
                }
            }
        }
    }
    for path in event.paths {
        let Some(ctx) = context_for_path(watched_roots, &path) else {
            tracing::debug!("[MemoWatcher] no notebook root for {}", path.display());
            continue;
        };
        let relative = match path.strip_prefix(&ctx.root) {
            Ok(relative) => relative,
            Err(_) => continue,
        };
        let mut fs_kind = FsEventKind::from_notify(&event.kind);
        let removed_directory = matches!(event.kind, notify::EventKind::Remove(notify::event::RemoveKind::Folder));
        let directory_event = path.is_dir()
            || removed_directory
            || (removed_known_directories.contains(&path) && matches!(fs_kind, FsEventKind::Remove));
        if directory_event {
            fs_kind = FsEventKind::DirectoryChange;
        }
        if !path_allowed_for_watch(&ctx.root, &path, directory_event) {
            tracing::debug!(
                "[MemoWatcher] ignored hidden/internal notebook path: {}",
                path.display()
            );
            continue;
        }
        // notify callback only performs cheap path filtering. Revision-aware
        // self-write suppression and dedup happen after the worker observes a
        // stable file snapshot.
        if matches!(fs_kind, FsEventKind::Create | FsEventKind::Modify) {
            // A rename can arrive as Remove(old) followed by Create/Modify(new).
            // The new path may itself be marked as a self-write after the internal
            // save resolves, so cancel the old-path tombstone before the filter
            // pipeline has a chance to drop this event.
            remove_coalescer.cancel_path(&path);
        }
        // Split directory From/To events must be paired before reconciliation
        // can prune the old subtree. An unmatched From still reconciles later.
        if matches!(event.kind, notify::EventKind::Modify(notify::event::ModifyKind::Name(notify::event::RenameMode::From)))
            && matches!(fs_kind, FsEventKind::DirectoryChange) {
            let tx = worker_tx.clone();
            std::thread::spawn(move || {
                std::thread::sleep(REMOVE_TOMBSTONE_DELAY);
                let _ = tx.send((RawFsEvent::new(FsEventKind::DirectoryChange, path), ctx));
            });
            continue;
        }
        let raw = RawFsEvent::new(fs_kind, path.clone());
        match if matches!(fs_kind, FsEventKind::DirectoryChange)
            || media_kind_for_path(&path).is_some()
            || crate::commands::document_list::is_table_document_path(&path) {
            crate::watcher::event::FilterDecision::Pass
        } else {
            crate::watcher::filter::run_pipeline(&raw, &path_filter)
        } {
            crate::watcher::event::FilterDecision::Pass => {}
            crate::watcher::event::FilterDecision::PassMutated(_) => {}
            crate::watcher::event::FilterDecision::Drop { reason } => {
                tracing::debug!(
                    "[MemoWatcher] pipeline dropped ({}): {}",
                    reason.label(),
                    path.display()
                );
                continue;
            }
        }

        // The manager filters paths and delays removals. The processor updates
        // the path index and emits note events for accepted file changes.
        match fs_kind {
            FsEventKind::Remove => {
                remove_coalescer.schedule(ctx.clone(), &path);
                continue;
            }
            FsEventKind::Create | FsEventKind::Modify | FsEventKind::DirectoryChange => {}
            FsEventKind::Other => {}
        }

        // 重 `process` (含 `wait_for_markdown_copy_to_settle` ≤400ms + 磁盘读写) 移到
        // worker 线程串行 drain, 不阻塞 notify 共享线程。`send` 非阻塞 (unbounded channel)。
        let _ = worker_tx.send((raw, ctx));
    }
}

fn path_allowed_for_watch(root: &Path, path: &Path, directory_event: bool) -> bool {
    let Ok(relative) = path.strip_prefix(root) else { return false; };
    let policy = FileManagementPolicy::from_notebook_root(root);
    if directory_event || crate::commands::document_list::is_table_document_path(path) {
        !policy.is_tree_hidden_at(root, relative)
    } else {
        !policy.is_index_ignored_at(root, relative)
    }
}

fn should_process_stable_event(
    event: &RawFsEvent,
    recent_self_writes: &Arc<Mutex<SelfWriteMap>>,
    processed_revisions: &mut HashMap<PathBuf, FileRevision>,
) -> bool {
    if event.rename_from.is_some() {
        return true;
    }
    let key = normalize_for_compare(&event.path);
    match event.kind {
        FsEventKind::Create | FsEventKind::Modify => {
            if !event.path.exists() {
                processed_revisions.remove(&key);
                return true;
            }
            crate::watcher::processor::wait_for_markdown_copy_to_settle(&event.path);
            let media = media_kind_for_path(&event.path).is_some();
            let revision = if media {
                FileRevision::read_metadata(&event.path)
            } else {
                FileRevision::read(&event.path)
            };
            let Some(revision) = revision else {
                return true;
            };
            if !media && crate::watcher::filter::self_write::is_exact_self_write(
                &event.path,
                &revision,
                recent_self_writes,
            ) {
                // Advance the observed baseline even though the originating
                // window already owns this content. A later external revert
                // to an older hash must then be treated as a new revision.
                processed_revisions.insert(key, revision);
                return false;
            }
            if processed_revisions.get(&key) == Some(&revision) {
                tracing::debug!(
                    "[MemoWatcher] duplicate stable revision dropped: {}",
                    event.path.display()
                );
                return false;
            }
            processed_revisions.insert(key, revision);
            true
        }
        FsEventKind::Remove => {
            processed_revisions.remove(&key);
            true
        }
        FsEventKind::DirectoryChange => true,
        FsEventKind::Other => false,
    }
}

fn context_for_path(
    watched_roots: &Arc<std::sync::RwLock<Vec<NotebookWatchContext>>>,
    path: &Path,
) -> Option<NotebookWatchContext> {
    let path_norm = normalize_for_compare(path);
    let roots = watched_roots.read().ok()?;
    roots
        .iter()
        .filter_map(|ctx| {
            let root_norm = normalize_for_compare(&ctx.root);
            path_norm
                .starts_with(&root_norm)
                .then_some((root_norm.components().count(), ctx.clone()))
        })
        .max_by_key(|(depth, _)| *depth)
        .map(|(_, ctx)| ctx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_suspension_only_rebinds_its_own_root() {
        let directory = tempfile::tempdir().unwrap();
        let memo_file = Arc::new(std::sync::RwLock::new(MemoFile::new(
            directory.path().join("config"),
        )));
        let mut manager = MemoWatcher::new(memo_file);
        manager._watcher =
            Some(notify::recommended_watcher(|_: notify::Result<Event>| {}).unwrap());
        let configs: Vec<_> = (0..2)
            .map(|index| {
                let path = directory.path().join(format!("book-{index}"));
                std::fs::create_dir_all(&path).unwrap();
                NotebookConfig {
                    id: format!("nb_{index}"),
                    name: format!("Book {index}"),
                    path: path.to_string_lossy().into_owned(),
                    icon: None,
                    is_default: false,
                    sort: 0,
                    created_at: 1,
                    updated_at: 1,
                }
            })
            .collect();
        assert!(manager.add_notebook_root(&configs[0]));
        assert!(manager.add_notebook_root(&configs[1]));
        for _ in 0..2 {
            manager.set_notebook_suspended(&configs[1].id, true);
            assert!(manager.refresh_notebook_root(&configs[1]));
            let roots = manager.watched_roots.read().unwrap();
            assert_eq!(roots.len(), 1);
            assert_eq!(roots[0].notebook_id, configs[0].id);
        }
        manager.set_notebook_suspended(&configs[1].id, false);
        assert!(manager.refresh_notebook_root(&configs[1]));
        assert_eq!(manager.watched_roots.read().unwrap().len(), 1);
        manager.set_notebook_suspended(&configs[1].id, false);
        assert!(manager.refresh_notebook_root(&configs[1]));
        assert!(manager.refresh_notebook_root(&configs[1]));
        assert_eq!(manager.watched_roots.read().unwrap().len(), 2);
    }

    fn marked_revision(path: &Path) -> Arc<Mutex<SelfWriteMap>> {
        let writes = Arc::new(Mutex::new(SelfWriteMap::new()));
        writes.lock().unwrap().insert(
            normalize_for_compare(path),
            SelfWriteMark {
                marked_at: Instant::now(),
                expected_revision: FileRevision::read(path),
            },
        );
        writes
    }

    #[test]
    fn worker_passes_a_later_revision_on_the_same_self_written_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.md");
        std::fs::write(&path, "ui revision").unwrap();
        let writes = marked_revision(&path);
        std::fs::write(&path, "agent revision").unwrap();
        let event = RawFsEvent::new(FsEventKind::Modify, path);
        let mut processed = HashMap::new();

        assert!(should_process_stable_event(&event, &writes, &mut processed));
    }

    #[test]
    fn worker_drops_exact_self_write_and_duplicate_stable_revisions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.md");
        std::fs::write(&path, "one revision").unwrap();
        let writes = marked_revision(&path);
        let event = RawFsEvent::new(FsEventKind::Modify, path.clone());
        let mut processed = HashMap::new();

        assert!(!should_process_stable_event(
            &event,
            &writes,
            &mut processed
        ));

        let unmarked = Arc::new(Mutex::new(SelfWriteMap::new()));
        assert!(!should_process_stable_event(
            &event,
            &unmarked,
            &mut processed
        ));
        std::fs::write(&path, "external revision").unwrap();
        assert!(should_process_stable_event(
            &event,
            &unmarked,
            &mut processed
        ));
        assert!(!should_process_stable_event(
            &event,
            &unmarked,
            &mut processed
        ));
        std::fs::write(&path, "one revision").unwrap();
        assert!(should_process_stable_event(
            &event,
            &unmarked,
            &mut processed
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mcp_style_create_surfaces_a_final_path_event_on_macos() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let notes = tmp.path().join("notes");
        let config_dir = tmp.path().join("config");
        std::fs::create_dir_all(&notes).expect("notes dir");

        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
            if let Ok(event) = result {
                let _ = tx.send(event);
            }
        })
        .expect("watcher");
        watcher
            .watch(&notes, RecursiveMode::Recursive)
            .expect("watch notes");
        // FSEvents installs its stream asynchronously after `watch()` returns.
        std::thread::sleep(Duration::from_millis(300));

        let mut memo_file = MemoFile::new(config_dir);
        let notebook = NotebookConfig {
            id: "nb_mcp".to_string(),
            name: "MCP".to_string(),
            icon: None,
            path: notes.to_string_lossy().to_string(),
            is_default: true,
            sort: 0,
            created_at: 0,
            updated_at: 0,
        };
        memo_file
            .write_notebook_configs(std::slice::from_ref(&notebook))
            .expect("write notebook config");
        memo_file.set_current_notebook(Some(notebook.id.clone()));
        let created = memo_file
            .create_external_memo_for_notebook_id(
                &notebook.id,
                "MCP notify",
                "# MCP notify\n",
                None,
            )
            .expect("mcp-style create");
        let expected_file_path = notes.join(&created.relative_path);

        let expected_path = normalize_for_compare(&expected_file_path);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut observed = Vec::new();
        while std::time::Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            let Ok(event) = rx.recv_timeout(remaining.min(Duration::from_millis(250))) else {
                continue;
            };
            let paths: Vec<PathBuf> = event
                .paths
                .iter()
                .map(|path| normalize_for_compare(path))
                .collect();
            let kind = FsEventKind::from_notify(&event.kind);
            observed.push((kind, paths.clone()));
            if paths.iter().any(|path| path == &expected_path) {
                if matches!(kind, FsEventKind::Create | FsEventKind::Modify) {
                    let ctx = NotebookWatchContext {
                        notebook_id: notebook.id.clone(),
                        root: notes.clone(),
                    };
                    let outcome = crate::watcher::processor::dispatch_modify_event(
                        &memo_file,
                        &ctx,
                        &expected_file_path,
                        kind,
                    )
                    .expect("classify observed MCP event");
                    assert!(matches!(
                        outcome,
                        crate::watcher::processor::DispatchOutcome::PathIndexed { relative_path }
                            if relative_path == created.relative_path
                    ));
                    return;
                }
            }
        }

        panic!("expected a final-path event for MCP-style creation, observed {observed:?}");
    }

    #[test]
    fn normalize_for_compare_falls_back_when_path_missing() {
        // 写盘�?mark 的典型场�? 文件还没创建, canonicalize 必然失败�?        // 应当退到原 path 字�?�? 不丢抑制�?
        let p = Path::new("/definitely/does/not/exist/foo.md");
        let normalized = normalize_for_compare(p);
        assert_eq!(normalized, p.to_path_buf());
    }

    #[test]
    fn normalize_for_compare_joins_canonical_parent_when_only_parent_exists() {
        // 父目录存�?(notebook dir 已建), 文件不存�?—canonicalize 父目�?        // 成功, 应当 join 回去。这�?��盘前 mark 期望走的回退�?���?        // pid + nano 后缀防跟其它测试�?tempdir 撞名, 避免 cargo test 并�?
        // 跑时的偶�?flake�?
        let tmp = std::env::temp_dir().join(format!(
            "flowix-fs-watcher-norm-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let file_path = tmp.join("not-yet-created.md");
        let normalized = normalize_for_compare(&file_path);
        // 父目录走 canonicalize, 跟原 parent 等价 (�?���?symlink �?
        assert_eq!(
            normalized.parent().unwrap().canonicalize().unwrap(),
            tmp.canonicalize().unwrap()
        );
        assert_eq!(normalized.file_name().unwrap(), "not-yet-created.md");
        std::fs::remove_dir_all(&tmp).ok();
    }
}
