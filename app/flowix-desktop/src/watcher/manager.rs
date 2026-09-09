//! 笔�?�?��文件监听 —包�? `notify::RecommendedWatcher` 监听全部已配�?notebook
//! �?��, 把�?部编辑器 / 其他 AI 的�?盘变更转�?`MemoEvent::Updated` �?//! `MemoEvent::Deleted` emit 给前�?�?//!
//! ## 鑷啓鎶戝埗 (self-write suppression)
//!
//! 后�?�?��写入 (用户 UI / Agent / import �?��) �?*写盘之前**调用
//! `MemoWatcher::mark_self_write(path)` 鎶婅矾寰勫鍏ユ姂鍒堕泦鍚堛€倃atcher 鍥炶皟
//! 看到同路径事�? 命中即吞。这一顺序很关�?—写盘�?mark 才能关掉
//! "notify 事件先于 mark 到达"�?race window, 否则 IPC 命令刚把文件落盘
//! 还没来得及�?抑制�? watcher 就先看到 Create 事件, 触发 reload/re-register
//! 二�? emit�?//!
//! 设�?: 后�? emit �?��步的, 先于 notify 回调到达前�?; UI 永远先看到自�?//! "Created" / "Updated" 事件, 不会�?��。watcher 150ms 内的回响�?��, 杜绝
//! "外部看起来改了两�?�?//!
//! ## Rename 妫€娴嬶細frontmatter-key-first
//!
//! 旧版�?`inode_tracker`（Unix ino / Windows NTFS MFT file_index + vol_serial�?//! 配�? From + To 事件识别 rename。重构后**完全不需�?inode / file_index**�?//! processor 读�?�?frontmatter �?`key` 字�?直接作为 id 真源。fs::rename
//! 拆出�?From + To 两条事件�? To 事件读到�?frontmatter key 跟旧 entry �?//! id 一�?�?`rename_memo_file` �?��保留 id �?entry.filename�?//!
//! 跨平台�?为统一 —�?NTFS / FAT32 / exFAT / 网络�?/ symlink / 跨卷 �?//! 行为一�? 不再�?Plan A 那�? Windows-only `windows-sys` 依赖�?//!
//! ## 跨平�?//!
//! `notify::RecommendedWatcher` 鑷姩閫?macOS FSEvents / Linux inotify /
//! Windows ReadDirectoryChangesW, 宸茬敱 `notify` 6.0 鐨勪緷璧栧浘鑷寘鍚€?//!
//! �?��比较两侧 (`mark_self_write` 入参 / watcher 收到�?`event.paths`) �?//! �?[`normalize_for_compare`] 归一: macOS �?`/var` �?`/private/var` symlink
//! 折叠, Windows �?`\\?\C:\...` 前缀去掉。否�?HashMap 精�匹配�?miss�?
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::AppHandle;

use crate::watcher::filter::{FileRevision, SelfWriteMap, SelfWriteMark, SELF_WRITE_TTL};
use crate::watcher::tombstone::RemoveCoalescer;
use crate::watcher::{
    filter::PathFilter, normalize_for_compare, FsEventKind, MemoEventProcessor,
    NotebookWatchContext, RawFsEvent, WhitelistConfig,
};
use flowix_core::memo_file::{
    is_ignored_notebook_relative_path, notebook_relative_path, MemoFile, NotebookConfig,
};

const REMOVE_TOMBSTONE_DELAY: Duration = Duration::from_millis(450);

/// 绗旇鏈洰褰曠殑鏂囦欢鐩戝惉鍣ㄣ€?///
/// 瀛楁璇箟:
/// - `_watcher`: 持有 `RecommendedWatcher` 期间持续监听。Drop 时自动停�?�?/// - `watched_roots`: 当前绑定�?notebook 根目录集合�?/// - `recent_self_writes`: �?��抑制�? `(normalized path, 标�?时间)`�?///   回调查表, 命中即吞; 表项通过 TTL 清理, 保证 macOS FSEvents 一次写�?///   产生多条事件时能全部抑制。键都走 [`normalize_for_compare`] 归一�?/// - `last_emit`: �?��防抖�? `(normalized path, 上�? emit 时间)`�?50ms
///   内同�?��事件吞掉, 处理编辑器保存时的重�?notify�?/// - `remove_coalescer`: 外部 rename �?��先到 Remove(old), 这里�?��保留
///   tombstone, 等待随后 Create/Modify(new) 通过 frontmatter key 合并�?/// - `whitelist`: 运�?时可�?��新的 watcher �?黑名单配�?�?
pub struct MemoWatcher {
    _watcher: Option<RecommendedWatcher>,
    watched_roots: Arc<std::sync::RwLock<Vec<NotebookWatchContext>>>,
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
    pub fn new(memo_file: Arc<std::sync::RwLock<MemoFile>>) -> Self {
        Self {
            _watcher: None,
            watched_roots: Arc::new(std::sync::RwLock::new(Vec::new())),
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
            *g = new_cfg;
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
        if let Ok(mut watched) = self.watched_roots.write() {
            *watched = roots.clone();
        }
        if roots.is_empty() {
            return;
        }

        let remove_coalescer =
            RemoveCoalescer::new(app.clone(), self.memo_file.clone(), REMOVE_TOMBSTONE_DELAY);
        let remove_coalescer_for_callback = remove_coalescer.clone();
        let app = app.clone();
        let recent_for_worker = self.recent_self_writes.clone();
        let memo_file = self.memo_file.clone();
        let whitelist = self.whitelist.clone();
        let watched_roots = self.watched_roots.clone();

        // notify 共享事件线程 -> 单 worker 线程的派发通道。notify 回调只做廉价的
        // filter / debounce / 自写抑制 + 入队 (`send` 非阻塞), 重 `process` 交给 worker。
        // tx 给回调, rx 留给下方 watched_count>0 后 spawn 的 worker。
        let (worker_tx, worker_rx) =
            std::sync::mpsc::channel::<(RawFsEvent, NotebookWatchContext)>();
        let worker_tx_for_callback = worker_tx.clone();

        let mut watcher: RecommendedWatcher =
            match notify::recommended_watcher(move |res: notify::Result<Event>| {
                let Ok(event) = res else {
                    return;
                };
                handle_notify_event(
                    &memo_file,
                    &remove_coalescer_for_callback,
                    &whitelist,
                    &watched_roots,
                    &worker_tx_for_callback,
                    event,
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
                            MemoEventProcessor::process(&raw, &worker_app, &worker_memo_file, &ctx)
                        }))
                    {
                        tracing::error!(
                            thread = "memo-watcher-processor",
                            path = %raw.path.display(),
                            kind = ?raw.kind,
                            "MemoEventProcessor::process panicked; worker recovered. payload={:?}",
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
                    expected_revision: FileRevision::read(path),
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
    memo_file: &Arc<std::sync::RwLock<MemoFile>>,
    remove_coalescer: &RemoveCoalescer,
    whitelist: &Arc<std::sync::RwLock<WhitelistConfig>>,
    watched_roots: &Arc<std::sync::RwLock<Vec<NotebookWatchContext>>>,
    worker_tx: &std::sync::mpsc::Sender<(RawFsEvent, NotebookWatchContext)>,
    event: notify::Event,
) {
    let path_filter = PathFilter {
        whitelist: whitelist.clone(),
    };
    for path in event.paths {
        let Some(ctx) = context_for_path(watched_roots, &path) else {
            tracing::debug!("[MemoWatcher] no notebook root for {}", path.display());
            continue;
        };
        let relative = match path.strip_prefix(&ctx.root) {
            Ok(relative) => relative,
            Err(_) => continue,
        };
        if is_ignored_notebook_relative_path(relative) {
            tracing::debug!(
                "[MemoWatcher] ignored hidden/internal notebook path: {}",
                path.display()
            );
            continue;
        }
        // notify callback only performs cheap path filtering. Revision-aware
        // self-write suppression and dedup happen after the worker observes a
        // stable file snapshot.
        let mut fs_kind = FsEventKind::from_notify(&event.kind);
        let relative_prefix = relative.to_string_lossy().replace('\\', "/");
        let is_indexed_directory_prefix = matches!(fs_kind, FsEventKind::Remove)
            && memo_file.read().ok().is_some_and(|memo_file| {
                let prefix = format!("{}/", relative_prefix.trim_end_matches('/'));
                memo_file
                    .read_all_memos_for_notebook_id(Some(&ctx.notebook_id))
                    .iter()
                    .any(|memo| memo.relative_path.starts_with(&prefix))
            });
        if path.is_dir() || is_indexed_directory_prefix {
            fs_kind = FsEventKind::DirectoryChange;
        }
        if matches!(fs_kind, FsEventKind::Create | FsEventKind::Modify) {
            // A rename can arrive as Remove(old) followed by Create/Modify(new).
            // The new path may itself be marked as a self-write after the internal
            // save resolves, so cancel the old-path tombstone before the filter
            // pipeline has a chance to drop this event.
            remove_coalescer.cancel_by_disk_key(&path);
        }
        let raw = RawFsEvent::new(fs_kind, path.clone());
        match if matches!(fs_kind, FsEventKind::DirectoryChange) {
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

        // manager �?��采集 + 过滤, 业务分流交给 MemoEventProcessor�?        // processor �?��读�?盘抽 frontmatter key �?rename / reload /
        // register 分流, 这里不需�?stat 任何 metadata�?
        match fs_kind {
            FsEventKind::Remove => {
                if schedule_pending_remove(remove_coalescer, memo_file, ctx.clone(), &path) {
                    continue;
                }
            }
            FsEventKind::Create | FsEventKind::Modify | FsEventKind::DirectoryChange => {}
            FsEventKind::Other => {}
        }

        // 重 `process` (含 `wait_for_markdown_copy_to_settle` ≤400ms + 磁盘读写) 移到
        // worker 线程串行 drain, 不阻塞 notify 共享线程。`send` 非阻塞 (unbounded channel)。
        let _ = worker_tx.send((raw, ctx));
    }
}

fn should_process_stable_event(
    event: &RawFsEvent,
    recent_self_writes: &Arc<Mutex<SelfWriteMap>>,
    processed_revisions: &mut HashMap<PathBuf, FileRevision>,
) -> bool {
    let key = normalize_for_compare(&event.path);
    match event.kind {
        FsEventKind::Create | FsEventKind::Modify => {
            if !event.path.exists() {
                processed_revisions.remove(&key);
                return true;
            }
            crate::watcher::processor::wait_for_markdown_copy_to_settle(&event.path);
            let Some(revision) = FileRevision::read(&event.path) else {
                return true;
            };
            if crate::watcher::filter::self_write::is_exact_self_write(
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

fn resolve_removed_memo_id(
    memo_file: &Arc<std::sync::RwLock<MemoFile>>,
    ctx: &NotebookWatchContext,
    path: &Path,
) -> Option<String> {
    let relative_path = notebook_relative_path(&ctx.root, path).ok()?;
    let mf = memo_file.read().ok()?;
    mf.find_memo_by_relative_path_for_notebook_id(&ctx.notebook_id, &relative_path)
        .map(|memo| memo.id)
}

fn schedule_pending_remove(
    remove_coalescer: &RemoveCoalescer,
    memo_file: &Arc<std::sync::RwLock<MemoFile>>,
    ctx: NotebookWatchContext,
    path: &Path,
) -> bool {
    let Some(id) = resolve_removed_memo_id(&memo_file, &ctx, path) else {
        return false;
    };
    remove_coalescer.schedule(id, ctx, path);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

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
                        crate::watcher::processor::DispatchOutcome::Created {
                            event: crate::memo_events::MemoEvent::Created { memo, .. },
                            ..
                        } if memo.id == created.id
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
