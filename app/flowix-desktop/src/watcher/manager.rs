//! Observe notebook paths and dispatch serial file updates.
//! Exact revisions suppress self-writes; explicit OS rename pairs rebase paths.
//! Split rename events use runtime filesystem identities, never frontmatter.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Manager};

use crate::watcher::directory_coalesce::DirectoryCoalescer;
use crate::watcher::filter::{FileRevision, SelfWriteMap, SelfWriteMark, SELF_WRITE_TTL};
use crate::watcher::tombstone::RemoveCoalescer;
use crate::watcher::{
    filter::PathFilter, normalize_for_compare, FsEventKind, PathNoteEventProcessor,
    NotebookWatchContext, RawFsEvent, WhitelistConfig,
};
use flowix_core::memo_file::{
    resource_kind_for_path, FileManagementPolicy, MemoFile, NotebookConfig,
};

const REMOVE_TOMBSTONE_DELAY: Duration = Duration::from_millis(450);

/// How long an in-app create window stays open after a backend command
/// announces it. Small on purpose: an unrelated external create in the same
/// folder must still surface the new-document notice.
const SELF_CREATE_WINDOW: Duration = Duration::from_secs(2);

/// Native creates one command may own inside its announced folder. Every create
/// command writes a single file; a batch creator must announce once per file.
const SELF_CREATE_BUDGET: u8 = 1;

/// Watches only the selected notebook root and sends filtered events to a serial worker.
/// A delayed remove can be canceled by a confirmed rename pair. The watcher
/// never matches a replacement file using its Markdown content or frontmatter.
pub struct MemoWatcher {
    _watcher: Option<RecommendedWatcher>,
    watched_roots: Arc<std::sync::RwLock<Vec<NotebookWatchContext>>>,
    active_notebook_id: Option<String>,
    worker_generation: Arc<AtomicU64>,
    suspended_notebook_ids: HashMap<String, usize>,
    recent_self_writes: Arc<Mutex<SelfWriteMap>>,
    /// Directories where this backend is creating files right now. A native
    /// create inside one of them is an in-app create, not an external new
    /// document, so it must not raise the new-document notice.
    recent_self_create_dirs: Arc<Mutex<HashMap<PathBuf, (Instant, u8)>>>,
    rename_tracker: Arc<Mutex<super::rename_tracker::RenameTracker>>,
    remove_coalescer: Option<RemoveCoalescer>,
    memo_file: Arc<std::sync::RwLock<MemoFile>>,
    whitelist: Arc<std::sync::RwLock<WhitelistConfig>>,
    /// notify shared thread -> one worker thread. The callback performs only
    /// cheap path filtering and enqueueing. File settling, revision reconciliation,
    /// deduplication and memo processing run serially on the worker, avoiding stalls in
    /// 所有 notebook 的事件投递会被单次 settle 卡住)。单 worker 保 FIFO, 不破坏同路径
    /// 事件顺序。重绑通过 worker generation 取消旧绑定的积压事件。
    worker_tx: Option<std::sync::mpsc::Sender<(RawFsEvent, NotebookWatchContext)>>,
    _worker: Option<std::thread::JoinHandle<()>>,
}

impl MemoWatcher {
    /// Refresh the active root when template writes temporarily suspend it.
    /// An inactive notebook is treated as a successful no-op.
    pub fn refresh_notebook_root(&mut self, config: &NotebookConfig) -> bool {
        if self.active_notebook_id.as_deref() != Some(config.id.as_str()) {
            return true;
        }
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
            self.rename_tracker
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .forget_root(&root);
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
        if !root.is_dir() {
            return false;
        }
        let context = NotebookWatchContext {
            notebook_id: config.id.clone(),
            root: root.clone(),
        };
        let generation = self.worker_generation.load(Ordering::Acquire);
        attach_notebook_root(
            watcher,
            &self.watched_roots,
            &self.rename_tracker,
            &self.worker_generation,
            context,
            generation,
        )
    }

    /// Attach the active notebook root without restarting the watcher.
    /// Inactive notebooks are rejected; false also asks the caller to retry binding.
    pub fn add_notebook_root(&mut self, config: &NotebookConfig) -> bool {
        if self.active_notebook_id.as_deref() != Some(config.id.as_str()) {
            return false;
        }
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
        let context = NotebookWatchContext {
            notebook_id: config.id.clone(),
            root: root.clone(),
        };
        let generation = self.worker_generation.load(Ordering::Acquire);
        attach_notebook_root(
            watcher,
            &self.watched_roots,
            &self.rename_tracker,
            &self.worker_generation,
            context,
            generation,
        )
    }

    pub fn is_watching(&self, notebook_id: &str) -> bool {
        self._watcher.is_some()
            && self.watched_roots.read().is_ok_and(|roots| {
                roots.iter().any(|context| context.notebook_id == notebook_id)
            })
    }

    pub fn is_initialized(&self) -> bool {
        self._watcher.is_some()
    }

    pub fn is_notebook_suspended(&self, notebook_id: &str) -> bool {
        self.suspended_notebook_ids.contains_key(notebook_id)
    }

    pub fn new(memo_file: Arc<std::sync::RwLock<MemoFile>>) -> Self {
        Self {
            _watcher: None,
            watched_roots: Arc::new(std::sync::RwLock::new(Vec::new())),
            active_notebook_id: None,
            worker_generation: Arc::new(AtomicU64::new(0)),
            suspended_notebook_ids: HashMap::new(),
            recent_self_writes: Arc::new(Mutex::new(HashMap::new())),
            recent_self_create_dirs: Arc::new(Mutex::new(HashMap::new())),
            rename_tracker: Arc::new(Mutex::new(super::rename_tracker::RenameTracker::default())),
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
            // Name exclusions now come from the new notebook-local policy.
            // Keep only the internal directories in the global event filter.
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

    /// Replace the watched roots with the selected notebook's root, if available.
    pub fn rebind_current_notebook(
        &mut self,
        app: AppHandle,
        active_notebook_id: Option<&str>,
        active_config: Option<NotebookConfig>,
    ) {
        let active_notebook_id = active_notebook_id.map(str::to_string);
        let active_config = active_config
            .filter(|config| active_notebook_id.as_deref() == Some(config.id.as_str()));
        let desired_root = active_config
            .filter(|config| !self.suspended_notebook_ids.contains_key(&config.id))
            .and_then(|config| {
                let root = PathBuf::from(config.path);
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
            });
        let unchanged = self.active_notebook_id == active_notebook_id
            && self._watcher.is_some()
            && self
                .watched_roots
                .read()
                .is_ok_and(|roots| match (desired_root.as_ref(), roots.as_slice()) {
                    (None, []) => true,
                    (Some(desired), [current]) => {
                        desired.notebook_id == current.notebook_id
                            && desired.root == current.root
                    }
                    _ => false,
                });
        self.active_notebook_id = active_notebook_id;
        if unchanged {
            return;
        }
        self.rebind_current_root(app, desired_root);
    }

    fn rebind_current_root(&mut self, app: AppHandle, root: Option<NotebookWatchContext>) {
        let worker_generation = self.worker_generation.fetch_add(1, Ordering::AcqRel) + 1;
        let generation_counter = self.worker_generation.clone();
        // Drop �?watcher —此赋�?`take` �?Option, �?RecommendedWatcher 立即析构
        let _ = self._watcher.take();
        if let Some(coalescer) = self.remove_coalescer.take() {
            coalescer.cancel_all();
        }
        // The generation invalidates queued work before the old sender closes.
        let _ = self.worker_tx.take();
        let _ = self._worker.take();

        if let Ok(mut watched) = self.watched_roots.write() { watched.clear(); }
        let remove_coalescer =
            RemoveCoalescer::new(app.clone(), self.memo_file.clone(), REMOVE_TOMBSTONE_DELAY);
        let remove_coalescer_for_callback = remove_coalescer.clone();
        let app = app.clone();
        let recent_for_worker = self.recent_self_writes.clone();
        let self_create_dirs_for_callback = self.recent_self_create_dirs.clone();
        let whitelist = self.whitelist.clone();
        let watched_roots = self.watched_roots.clone();

        // notify 共享事件线程 -> 单 worker 线程的派发通道。notify 回调只做廉价的
        // filter / debounce / 自写抑制 + 入队 (`send` 非阻塞), 重 `process` 交给 worker。
        // tx 给回调, rx 交给 worker；即使当前没有可用根，worker 也保持就绪，
        // 供后续离线根恢复挂载后接收事件。
        let (worker_tx, worker_rx) =
            std::sync::mpsc::channel::<(RawFsEvent, NotebookWatchContext)>();
        let worker_tx_for_callback = worker_tx.clone();

        let rename_tracker = Arc::new(Mutex::new(super::rename_tracker::RenameTracker::default()));
        if let Some(root) = &root {
            rename_tracker
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .register_root(root);
        }
        self.rename_tracker = rename_tracker.clone();
        let rename_tracker_for_callback = rename_tracker.clone();
        let mut watcher: RecommendedWatcher =
            match notify::recommended_watcher(move |res: notify::Result<Event>| {
                let Ok(event) = res else {
                    return;
                };
                let (event, removed_known_directories, path_history) = {
                    let mut rename_tracker = rename_tracker_for_callback
                        .lock()
                        .unwrap_or_else(|p| p.into_inner());
                    let removed_known_directories: std::collections::HashSet<PathBuf> = event.paths.iter()
                        .filter(|path| rename_tracker.was_directory(path))
                        .cloned()
                        .collect();
                    let (event, path_history) = rename_tracker.correlate_with_path_history(event);
                    (event, removed_known_directories, path_history)
                };
                handle_notify_event(
                    &remove_coalescer_for_callback,
                    &whitelist,
                    &watched_roots,
                    &worker_tx_for_callback,
                    event,
                    removed_known_directories,
                    path_history,
                    &self_create_dirs_for_callback,
                );
            }) {
                Ok(w) => w,
                Err(e) => {
                    tracing::error!("[MemoWatcher] failed to create watcher: {e}");
                    return;
                }
            };

        let watched_count = if let Some(context) = root {
            if attach_notebook_root(
                &mut watcher,
                &self.watched_roots,
                &self.rename_tracker,
                &self.worker_generation,
                context,
                worker_generation,
            ) {
                1
            } else {
                0
            }
        } else {
            0
        };
        if watched_count == 0 {
            tracing::info!("[MemoWatcher] initialized with no available active notebook root; offline root can be retried later");
        }

        // 单 worker 在 10ms 窗口内合并同路径 Create/Modify 后串行处理。
        // rename 与目录事件是边界，不跨边界合并；`process` 含
        // `wait_for_markdown_copy_to_settle` (≤400ms) + 磁盘读写, 跑在这里而非 notify
        // 共享线程, 解放后者继续投递事件。重绑时 generation 变化会让旧 worker
        // 丢弃队列中尚未处理的事件，不会在切换后继续处理旧笔记本的积压。
        let worker_app = app.clone();
        let worker_memo_file = self.memo_file.clone();
        let worker = std::thread::Builder::new()
            .name("memo-watcher-processor".into())
            .spawn(move || {
                let mut processed_revisions = HashMap::<PathBuf, FileRevision>::new();
                // Directory events are collected per notebook and replayed once
                // the window closes. See `directory_coalesce` for why collapsing
                // them is safe: the reconcile they trigger is whole-notebook and
                // idempotent.
                let mut coalescer = DirectoryCoalescer::default();
                'worker: loop {
                    // Block until the next event, or until an absorbed burst is
                    // due — a trailing reconcile must never wait for an
                    // unrelated event to arrive.
                    let received = match coalescer.next_deadline() {
                        Some(deadline) => worker_rx
                            .recv_timeout(deadline.saturating_duration_since(Instant::now())),
                        None => worker_rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
                    };
                    match received {
                        Ok(first) => {
                            let batch = collect_queued_events(first, &worker_rx);
                            for (raw, ctx) in batch {
                                if generation_counter.load(Ordering::Acquire) != worker_generation {
                                    break 'worker;
                                }
                                if matches!(raw.kind, FsEventKind::DirectoryChange) {
                                    coalescer.absorb(&ctx, &raw.path, Instant::now());
                                    continue;
                                }
                                let decision = stabilize_event(
                                    &raw,
                                    &recent_for_worker,
                                    &mut processed_revisions,
                                );
                                let stable_content = match decision {
                                    StableEventDecision::Skip => continue,
                                    StableEventDecision::Process { content } => content,
                                };
                                // Serialize the final validity check and processing with notebook
                                // selection changes. If a switch already won, this old event is
                                // discarded; if processing won, the switch waits for it to finish.
                                let state = worker_app.state::<crate::app::state::AppState>();
                                let _transition = state
                                    .notebook_transition
                                    .lock()
                                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                                if generation_counter.load(Ordering::Acquire) != worker_generation {
                                    break 'worker;
                                }
                                // catch_unwind: 单个事件处理 panic 不能永久杀死 worker (否则后续事件
                                // 静默不处理)。panic 本身是 bug (见技术债务「unwrap panic」节), 这里只做
                                // 隔离 + 记录, 让 worker 继续处理后续事件。
                                if let Err(payload) =
                                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                        PathNoteEventProcessor::process(
                                            &raw,
                                            &worker_app,
                                            &worker_memo_file,
                                            &ctx,
                                            stable_content.as_deref(),
                                        )
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
                        }
                        Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => break 'worker,
                    }
                    for due in coalescer.drain_due(Instant::now()) {
                        if generation_counter.load(Ordering::Acquire) != worker_generation {
                            break 'worker;
                        }
                        // Same lock, same worker thread as a normal event: the
                        // reconcile keeps its position in the serial stream.
                        let state = worker_app.state::<crate::app::state::AppState>();
                        let _transition = state
                            .notebook_transition
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        if generation_counter.load(Ordering::Acquire) != worker_generation {
                            break 'worker;
                        }
                        let Ok(memo_file) = worker_memo_file.read() else {
                            tracing::warn!(
                                notebook_id = %due.context.notebook_id,
                                "directory reconcile skipped: memo file lock poisoned"
                            );
                            continue;
                        };
                        if let Err(payload) =
                            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                PathNoteEventProcessor::reconcile_directory_change(
                                    &worker_app,
                                    &memo_file,
                                    &due.context,
                                    &due.directories,
                                    due.absorbed,
                                )
                            }))
                        {
                            tracing::error!(
                                thread = "memo-watcher-processor",
                                notebook_id = %due.context.notebook_id,
                                absorbed = due.absorbed,
                                "directory reconcile panicked; worker recovered. payload={:?}",
                                payload
                            );
                        }
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

    /// Announce that this backend is about to create a file inside `dir`. The
    /// window is registered before the write so the native create event is
    /// recognized even when it reaches the watcher first.
    pub fn mark_self_create_dir(&self, dir: &Path) {
        if let Ok(mut map) = self.recent_self_create_dirs.lock() {
            let now = Instant::now();
            map.retain(|_, (at, _)| now.duration_since(*at) < SELF_CREATE_WINDOW);
            map.insert(normalize_for_compare(dir), (now, SELF_CREATE_BUDGET));
        }
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

fn attach_notebook_root(
    watcher: &mut RecommendedWatcher,
    watched_roots: &Arc<std::sync::RwLock<Vec<NotebookWatchContext>>>,
    rename_tracker: &Arc<Mutex<super::rename_tracker::RenameTracker>>,
    worker_generation: &Arc<AtomicU64>,
    context: NotebookWatchContext,
    generation: u64,
) -> bool {
    rename_tracker
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .register_root(&context);
    match watched_roots.write() {
        Ok(mut roots) => roots.push(context.clone()),
        Err(_) => {
            tracing::error!("[MemoWatcher] failed to record watched notebook root");
            rename_tracker
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .forget_root(&context.root);
            return false;
        }
    }
    if let Err(error) = watcher.watch(&context.root, RecursiveMode::Recursive) {
        tracing::error!(
            "[MemoWatcher] failed to watch {}: {error}",
            context.root.display()
        );
        if let Ok(mut roots) = watched_roots.write() {
            roots.retain(|item| item.notebook_id != context.notebook_id);
        }
        rename_tracker
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .forget_root(&context.root);
        return false;
    }
    tracing::info!(
        "[MemoWatcher] watching notebook {} at {}",
        context.notebook_id,
        context.root.display()
    );
    seed_rename_tracker_async(
        rename_tracker.clone(),
        context,
        worker_generation.clone(),
        generation,
    );
    true
}

fn seed_rename_tracker_async(
    tracker: Arc<Mutex<super::rename_tracker::RenameTracker>>,
    root: NotebookWatchContext,
    generation_counter: Arc<AtomicU64>,
    generation: u64,
) {
    let notebook_id = root.notebook_id.clone();
    if let Err(error) = std::thread::Builder::new()
        .name("memo-watcher-rename-seed".into())
        .spawn(move || {
            let keep_running = || generation_counter.load(Ordering::Acquire) == generation;
            let Some(seed) =
                super::rename_tracker::RenameTracker::seed_root_while(&root, keep_running)
            else {
                return;
            };
            let mut seed = seed;
            seed.discard_stale_entries();
            if generation_counter.load(Ordering::Acquire) == generation {
                tracker
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .merge_seed(seed);
            }
        })
    {
        tracing::warn!(%error, notebook_id = %notebook_id,
            "could not start background rename baseline scan");
    }
}

/// Notify callback path filtering and event enqueueing. Keep filesystem scans
/// and content settling on the serial worker, not the shared notify thread.
fn handle_notify_event(
    remove_coalescer: &RemoveCoalescer,
    whitelist: &Arc<std::sync::RwLock<WhitelistConfig>>,
    watched_roots: &Arc<std::sync::RwLock<Vec<NotebookWatchContext>>>,
    worker_tx: &std::sync::mpsc::Sender<(RawFsEvent, NotebookWatchContext)>,
    event: notify::Event,
    removed_known_directories: std::collections::HashSet<PathBuf>,
    path_history: std::collections::HashMap<PathBuf, bool>,
    self_create_dirs: &Arc<Mutex<HashMap<PathBuf, (Instant, u8)>>>,
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
                if !new.is_dir() && ((old_allowed && resource_kind_for_path(old).is_some())
                    || (new_allowed && resource_kind_for_path(new).is_some())) {
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
        if path.strip_prefix(&ctx.root).is_err() {
            continue;
        }
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
        let mut raw = RawFsEvent::new(fs_kind, path.clone());
        raw.path_was_known = path_history.get(&path).copied();
        // A backend create is announced before the file exists, but its native
        // event can still reach this callback before the tracker observes the
        // path. Inside a self-create window the path is a product-created
        // document, so reconcile it as an update instead of a new document.
        if matches!(fs_kind, FsEventKind::Create | FsEventKind::Modify)
            && self_create_window_covers(self_create_dirs, &path)
        {
            raw.path_was_known = Some(true);
        }
        match if matches!(fs_kind, FsEventKind::DirectoryChange)
            || resource_kind_for_path(&path).is_some()
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
/// Consume one unit of the in-app create budget when `path`'s parent has an open
/// window. The budget bounds the suppression to the file the command creates, so
/// an unrelated external create in the same folder still notifies.
fn self_create_window_covers(
    dirs: &Arc<Mutex<HashMap<PathBuf, (Instant, u8)>>>,
    path: &Path,
) -> bool {
    let Some(parent) = path.parent() else { return false };
    let Ok(mut map) = dirs.lock() else { return false };
    let now = Instant::now();
    map.retain(|_, (at, _)| now.duration_since(*at) < SELF_CREATE_WINDOW);
    let key = normalize_for_compare(parent);
    let Some((_, budget)) = map.get_mut(&key) else { return false };
    if *budget == 0 {
        return false;
    }
    *budget -= 1;
    if *budget == 0 {
        map.remove(&key);
    }
    true
}

/// One rule for every watcher event: app internals, dot-prefixed folders, the
/// shared dependency/attachment blacklist and `excludedIndexPaths` never
/// notify. Directory events use the directory form because the path may
/// already be gone from disk.
fn path_allowed_for_watch(root: &Path, path: &Path, directory_event: bool) -> bool {
    let Ok(relative) = path.strip_prefix(root) else { return false; };
    let policy = FileManagementPolicy::from_notebook_root(root);
    if directory_event {
        !policy.is_index_hidden_directory(relative)
    } else {
        !policy.is_index_hidden_at(root, relative)
    }
}

enum StableEventDecision {
    Skip,
    Process { content: Option<String> },
}

fn should_process_stable_event(
    event: &RawFsEvent,
    recent_self_writes: &Arc<Mutex<SelfWriteMap>>,
    processed_revisions: &mut HashMap<PathBuf, FileRevision>,
) -> bool {
    matches!(
        stabilize_event(event, recent_self_writes, processed_revisions),
        StableEventDecision::Process { .. }
    )
}

fn stabilize_event(
    event: &RawFsEvent,
    recent_self_writes: &Arc<Mutex<SelfWriteMap>>,
    processed_revisions: &mut HashMap<PathBuf, FileRevision>,
) -> StableEventDecision {
    if event.rename_from.is_some() {
        return StableEventDecision::Process { content: None };
    }
    let key = normalize_for_compare(&event.path);
    match event.kind {
        FsEventKind::Create | FsEventKind::Modify => {
            if !event.path.exists() {
                processed_revisions.remove(&key);
                return StableEventDecision::Process { content: None };
            }
            crate::watcher::processor::wait_for_markdown_copy_to_settle(&event.path);
            let indexed_resource = resource_kind_for_path(&event.path).is_some();
            let (revision, content) = if indexed_resource {
                (FileRevision::read_metadata(&event.path), None)
            } else if is_markdown_note_path(&event.path) {
                let Ok(bytes) = std::fs::read(&event.path) else {
                    return StableEventDecision::Process { content: None };
                };
                let revision = FileRevision::from_bytes(&bytes);
                (Some(revision), String::from_utf8(bytes).ok())
            } else {
                (FileRevision::read(&event.path), None)
            };
            let Some(revision) = revision else {
                return StableEventDecision::Process { content: None };
            };
            if !indexed_resource && crate::watcher::filter::self_write::is_exact_self_write(
                &event.path,
                &revision,
                recent_self_writes,
            ) {
                // Advance the observed baseline even though the originating
                // window already owns this content. A later external revert
                // to an older hash must then be treated as a new revision.
                processed_revisions.insert(key, revision);
                return StableEventDecision::Skip;
            }
            if processed_revisions.get(&key) == Some(&revision) {
                tracing::debug!(
                    "[MemoWatcher] duplicate stable revision dropped: {}",
                    event.path.display()
                );
                return StableEventDecision::Skip;
            }
            processed_revisions.insert(key, revision);
            StableEventDecision::Process { content }
        }
        FsEventKind::Remove => {
            processed_revisions.remove(&key);
            StableEventDecision::Process { content: None }
        }
        FsEventKind::DirectoryChange => StableEventDecision::Process { content: None },
        FsEventKind::Other => StableEventDecision::Skip,
    }
}

fn is_markdown_note_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown"))
}

fn collect_queued_events(
    first: (RawFsEvent, NotebookWatchContext),
    receiver: &std::sync::mpsc::Receiver<(RawFsEvent, NotebookWatchContext)>,
) -> Vec<(RawFsEvent, NotebookWatchContext)> {
    const BATCH_WINDOW: Duration = Duration::from_millis(10);
    const MAX_BATCH_SIZE: usize = 128;

    let deadline = Instant::now() + BATCH_WINDOW;
    let mut batch = vec![first];
    while batch.len() < MAX_BATCH_SIZE {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match receiver.recv_timeout(remaining) {
            Ok(event) => batch.push(event),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    coalesce_queued_events(batch)
}

fn coalesce_queued_events(
    batch: Vec<(RawFsEvent, NotebookWatchContext)>,
) -> Vec<(RawFsEvent, NotebookWatchContext)> {
    let mut events: Vec<(RawFsEvent, NotebookWatchContext)> = Vec::with_capacity(batch.len());
    let mut coalescible = HashMap::<(String, PathBuf, PathBuf), usize>::new();

    for (mut event, context) in batch {
        if event.rename_from.is_some()
            || !matches!(event.kind, FsEventKind::Create | FsEventKind::Modify)
        {
            // A rename or other event is an ordering boundary. Never merge
            // writes across it: path rebases and directory reconciliation rely
            // on the original sequence.
            coalescible.clear();
            events.push((event, context));
            continue;
        }

        let key = (
            context.notebook_id.clone(),
            normalize_for_compare(&context.root),
            normalize_for_compare(&event.path),
        );
        if let Some(index) = coalescible.get(&key).copied() {
            // A writer that creates a file and then fills it delivers
            // Create(known=false) followed by Modify(known=true) inside one
            // batch. Keeping the later flag would report the whole burst as an
            // update and silently drop the "new document" notice, so a
            // create-led burst keeps the create's evidence.
            //
            // Modify-led bursts keep the previous last-wins semantics on
            // purpose: right after a root rebind the rename baseline is still
            // being seeded on a background thread, so every path reads as
            // unknown. Letting the first Modify win there would turn an
            // ordinary edit into a false "new document".
            let first = &events[index].0;
            let create_led = first.kind == FsEventKind::Create;
            let fresh = create_led && first.path_was_known == Some(false);
            if create_led {
                event.kind = FsEventKind::Create;
            }
            if fresh {
                event.path_was_known = Some(false);
            }
            events[index] = (event, context);
        } else {
            coalescible.insert(key, events.len());
            events.push((event, context));
        }
    }

    events
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
    fn recovered_binding_reconciles_only_the_selected_attached_root() {
        let temp = tempfile::tempdir().unwrap();
        let memo = Arc::new(std::sync::RwLock::new(MemoFile::new(temp.path().join("config"))));
        let mut manager = MemoWatcher::new(memo);
        manager._watcher = Some(notify::recommended_watcher(|_: notify::Result<Event>| {}).unwrap());
        let configs: Vec<_> = (0..3).map(|index| {
            let path = temp.path().join(format!("book-{index}"));
            if index != 1 { std::fs::create_dir_all(&path).unwrap(); }
            NotebookConfig {
                id: format!("nb_{index}"), name: format!("Book {index}"),
                path: path.to_string_lossy().into_owned(), icon: None,
                is_default: false, sort: 0, created_at: 1, updated_at: 1,
            }
        }).collect();
        manager.active_notebook_id = Some(configs[0].id.clone());
        manager.set_notebook_suspended(&configs[2].id, true);
        assert!(manager.add_notebook_root(&configs[0]));
        assert!(!manager.add_notebook_root(&configs[1]));
        assert!(!manager.add_notebook_root(&configs[2]));
        let background = crate::app::notebook_background::NotebookBackground::default();
        crate::watcher::runtime::reconcile_bound_roots(&manager, &configs, &background);
        let statuses = background.statuses();
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].notebook_id, configs[0].id);
        assert_eq!(statuses[0].state, "queued");
    }

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
        manager.active_notebook_id = Some(configs[1].id.clone());
        assert!(!manager.add_notebook_root(&configs[0]));
        assert!(manager.add_notebook_root(&configs[1]));
        for _ in 0..2 {
            manager.set_notebook_suspended(&configs[1].id, true);
            assert!(manager.refresh_notebook_root(&configs[1]));
            let roots = manager.watched_roots.read().unwrap();
            assert!(roots.is_empty());
            drop(roots);
            manager.set_notebook_suspended(&configs[1].id, false);
            assert!(manager.refresh_notebook_root(&configs[1]));
            let roots = manager.watched_roots.read().unwrap();
            assert_eq!(roots.len(), 1);
            assert_eq!(roots[0].notebook_id, configs[1].id);
        }
        assert!(manager.refresh_notebook_root(&configs[0]));
        assert!(manager.refresh_notebook_root(&configs[1]));
        let roots = manager.watched_roots.read().unwrap();
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].notebook_id, configs[1].id);
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

    /// The editor knows the bytes it is about to write, so it marks the path
    /// before the write (`mark_self_write_content_for`). The gate must drop that
    /// event however long the save's index work afterwards takes, and must still
    /// pass a later external edit.
    #[test]
    fn worker_drops_a_save_marked_before_its_own_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.md");
        std::fs::write(&path, "# Note\n\nold body\n").unwrap();

        let writes = Arc::new(Mutex::new(SelfWriteMap::new()));
        let new_content = "# Note\n\nnew body written by the editor\n";
        writes.lock().unwrap().insert(
            normalize_for_compare(&path),
            SelfWriteMark {
                marked_at: Instant::now(),
                expected_revision: Some(FileRevision::from_bytes(new_content.as_bytes())),
            },
        );
        std::fs::write(&path, new_content).unwrap();

        let event = RawFsEvent::new(FsEventKind::Modify, path.clone());
        let mut processed = HashMap::new();
        assert!(!should_process_stable_event(
            &event,
            &writes,
            &mut processed
        ));

        std::fs::write(&path, "# Note\n\n外部的改动\n").unwrap();
        assert!(should_process_stable_event(&event, &writes, &mut processed));
    }

    #[test]
    fn worker_keeps_the_stable_markdown_snapshot_for_indexing() {        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.md");
        let content = "# Stable snapshot\nbody";
        std::fs::write(&path, content).unwrap();
        let event = RawFsEvent::new(FsEventKind::Modify, path);
        let mut processed = HashMap::new();

        let StableEventDecision::Process {
            content: Some(snapshot),
        } = stabilize_event(&event, &Arc::new(Mutex::new(SelfWriteMap::new())), &mut processed)
        else {
            panic!("stable Markdown event should carry its content snapshot");
        };

        assert_eq!(snapshot, content);
    }

    #[test]
    fn watcher_batch_merges_same_path_writes_and_keeps_create_semantics() {
        let root = PathBuf::from("/notes");
        let context = || NotebookWatchContext {
            notebook_id: "nb_a".into(),
            root: root.clone(),
        };
        let mut batch = vec![
            (RawFsEvent::new(FsEventKind::Create, root.join("a.md")), context()),
            (RawFsEvent::new(FsEventKind::Modify, root.join("b.md")), context()),
            (RawFsEvent::new(FsEventKind::Modify, root.join("a.md")), context()),
        ];

        let merged = coalesce_queued_events(std::mem::take(&mut batch));

        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].0.path, root.join("a.md"));
        assert_eq!(merged[0].0.kind, FsEventKind::Create);
        assert_eq!(merged[1].0.path, root.join("b.md"));
    }

    #[test]
    fn watcher_batch_keeps_the_pre_burst_history_for_create_then_write() {
        // A writer that creates a file and then fills it delivers
        // Create(known=false) + Modify(known=true) inside one batch window.
        // The burst must stay a creation, otherwise the new-document notice is
        // silently dropped.
        let root = PathBuf::from("/notes");
        let context = || NotebookWatchContext {
            notebook_id: "nb_a".into(),
            root: root.clone(),
        };
        let mut created = RawFsEvent::new(FsEventKind::Create, root.join("a.md"));
        created.path_was_known = Some(false);
        let mut filled = RawFsEvent::new(FsEventKind::Modify, root.join("a.md"));
        filled.path_was_known = Some(true);
        let mut touched = RawFsEvent::new(FsEventKind::Modify, root.join("a.md"));
        touched.path_was_known = Some(true);

        let merged = coalesce_queued_events(vec![
            (created, context()),
            (filled, context()),
            (touched, context()),
        ]);

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].0.kind, FsEventKind::Create);
        assert_eq!(merged[0].0.path_was_known, Some(false));
    }

    #[test]
    fn watcher_batch_does_not_turn_a_seeding_edit_into_a_create() {
        // Right after a rebind every path reads as unknown until the rename
        // baseline merges. A modify-led burst must stay an update, otherwise an
        // ordinary edit would raise a false new-document notice.
        let root = PathBuf::from("/notes");
        let context = || NotebookWatchContext {
            notebook_id: "nb_a".into(),
            root: root.clone(),
        };
        let mut first = RawFsEvent::new(FsEventKind::Modify, root.join("a.md"));
        first.path_was_known = Some(false);
        let mut second = RawFsEvent::new(FsEventKind::Modify, root.join("a.md"));
        second.path_was_known = Some(true);

        let merged = coalesce_queued_events(vec![(first, context()), (second, context())]);

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].0.kind, FsEventKind::Modify);
        assert_eq!(merged[0].0.path_was_known, Some(true));
    }

    #[test]
    fn watcher_batch_keeps_product_created_suppression() {
        // The self-create window marks every event of the burst as known, so a
        // product-created document never surfaces as a new-document notice.
        let root = PathBuf::from("/notes");
        let context = || NotebookWatchContext {
            notebook_id: "nb_a".into(),
            root: root.clone(),
        };
        let mut created = RawFsEvent::new(FsEventKind::Create, root.join("a.md"));
        created.path_was_known = Some(true);
        let mut filled = RawFsEvent::new(FsEventKind::Modify, root.join("a.md"));
        filled.path_was_known = Some(true);

        let merged = coalesce_queued_events(vec![(created, context()), (filled, context())]);

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].0.path_was_known, Some(true));
    }

    #[test]
    fn table_database_watch_scope_is_root_relative() {
        let root = Path::new("/notebook");
        assert!(path_allowed_for_watch(root, &root.join(".flowix/database/col_1/note.md"), false));
        assert!(path_allowed_for_watch(root, &root.join(".flowix/database/col_1"), true));
        assert!(!path_allowed_for_watch(root, &root.join(".flowix/versions/note.md"), false));
        assert!(!path_allowed_for_watch(root, &root.join("nested/.flowix/database/col_1/note.md"), false));
        assert!(!path_allowed_for_watch(root, &root.join(".flowix/database2/note.md"), false));
    }

    #[test]
    fn watcher_batch_does_not_coalesce_across_rename_events() {
        let root = PathBuf::from("/notes");
        let context = || NotebookWatchContext {
            notebook_id: "nb_a".into(),
            root: root.clone(),
        };
        let mut rename = RawFsEvent::new(FsEventKind::Create, root.join("a.md"));
        rename.rename_from = Some(root.join("old.md"));
        let events = vec![
            (RawFsEvent::new(FsEventKind::Modify, root.join("a.md")), context()),
            (rename, context()),
            (RawFsEvent::new(FsEventKind::Modify, root.join("a.md")), context()),
        ];

        assert_eq!(coalesce_queued_events(events).len(), 3);
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
                        crate::watcher::processor::DispatchOutcome::PathIndexed { relative_path, .. }
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

    fn window_with(dir: &Path, budget: u8, age: Duration) -> Arc<Mutex<HashMap<PathBuf, (Instant, u8)>>> {
        let dirs = Arc::new(Mutex::new(HashMap::new()));
        dirs.lock().unwrap().insert(
            crate::watcher::path::normalize_for_compare(dir),
            (Instant::now() - age, budget),
        );
        dirs
    }

    #[test]
    fn self_create_window_covers_only_its_own_folder() {
        let folder = PathBuf::from("/notes/inbox");
        let dirs = window_with(&folder, SELF_CREATE_BUDGET, Duration::ZERO);

        assert!(self_create_window_covers(&dirs, Path::new("/notes/inbox/New.md")));
        // The budget is spent, so a second create in the same folder notifies.
        assert!(!self_create_window_covers(&dirs, Path::new("/notes/inbox/Second.md")));
        assert!(!self_create_window_covers(&dirs, Path::new("/notes/other/New.md")));
        assert!(!self_create_window_covers(&dirs, Path::new("/notes/inbox/sub/New.md")));
    }

    #[test]
    fn expired_self_create_window_no_longer_covers_creates() {
        let folder = PathBuf::from("/notes/inbox");
        let dirs = window_with(
            &folder,
            SELF_CREATE_BUDGET,
            SELF_CREATE_WINDOW + Duration::from_millis(1),
        );

        assert!(!self_create_window_covers(&dirs, Path::new("/notes/inbox/Later.md")));
    }

    #[test]
    fn spent_self_create_window_is_removed() {
        let folder = PathBuf::from("/notes/inbox");
        let dirs = window_with(&folder, SELF_CREATE_BUDGET, Duration::ZERO);

        assert!(self_create_window_covers(&dirs, Path::new("/notes/inbox/New.md")));
        assert!(dirs.lock().unwrap().is_empty());
    }
}
