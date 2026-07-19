//! 笔记目录文件监听 — 包装 `notify::RecommendedWatcher` 监听全部已配置 notebook
//! 目录, 把外部编辑器 / 其他 AI 的磁盘变更转为 `MemoEvent::Updated` 或
//! `MemoEvent::Deleted` emit 给前端。
//!
//! ## 自写抑制 (self-write suppression)
//!
//! 后端自身写入 (用户 UI / Agent / import 路径) 在**写盘之前**调用
//! `MemoWatcher::mark_self_write(path)` 把路径塞入抑制集合。watcher 回调
//! 看到同路径事件, 命中即吞。这一顺序很关键 — 写盘前 mark 才能关掉
//! "notify 事件先于 mark 到达"的 race window, 否则 IPC 命令刚把文件落盘
//! 还没来得及塞抑制表, watcher 就先看到 Create 事件, 触发 reload/re-register
//! 二次 emit。
//!
//! 设计: 后端 emit 是同步的, 先于 notify 回调到达前端; UI 永远先看到自家
//! "Created" / "Updated" 事件, 不会闪烁。watcher 150ms 内的回响被吞, 杜绝
//! "外部看起来改了两次"。
//!
//! ## Rename 检测：frontmatter-key-first
//!
//! 旧版用 `inode_tracker`（Unix ino / Windows NTFS MFT file_index + vol_serial）
//! 配对 From + To 事件识别 rename。重构后**完全不需要 inode / file_index**：
//! processor 读磁盘 frontmatter 的 `key` 字段直接作为 id 真源。fs::rename
//! 拆出的 From + To 两条事件中, To 事件读到的 frontmatter key 跟旧 entry 的
//! id 一致 → `rename_memo_file` 自动保留 id 改 entry.filename。
//!
//! 跨平台行为统一 — 在 NTFS / FAT32 / exFAT / 网络盘 / symlink / 跨卷 上
//! 行为一致, 不再有 Plan A 那套 Windows-only `windows-sys` 依赖。
//!
//! ## 跨平台
//!
//! `notify::RecommendedWatcher` 自动选 macOS FSEvents / Linux inotify /
//! Windows ReadDirectoryChangesW, 已由 `notify` 6.0 的依赖图自包含。
//!
//! 路径比较两侧 (`mark_self_write` 入参 / watcher 收到的 `event.paths`) 都
//! 走 [`normalize_for_compare`] 归一: macOS 上 `/var` ↔ `/private/var` symlink
//! 折叠, Windows 上 `\\?\C:\...` 前缀去掉。否则 HashMap 精确匹配会 miss。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::AppHandle;

use crate::watcher::filter::SELF_WRITE_TTL;
use crate::watcher::tombstone::RemoveCoalescer;
use crate::watcher::{
    filter::PathFilter, normalize_for_compare, FsEventKind, MemoEventProcessor,
    NotebookWatchContext, RawFsEvent, WhitelistConfig,
};
use flowix_core::memo_file::{MemoFile, NotebookConfig};

const REMOVE_TOMBSTONE_DELAY: Duration = Duration::from_millis(450);

/// 笔记本目录的文件监听器。
///
/// 字段语义:
/// - `_watcher`: 持有 `RecommendedWatcher` 期间持续监听。Drop 时自动停止。
/// - `watched_roots`: 当前绑定的 notebook 根目录集合。
/// - `recent_self_writes`: 自写抑制表, `(normalized path, 标记时间)`。
///   回调查表, 命中即吞; 表项通过 TTL 清理, 保证 macOS FSEvents 一次写入
///   产生多条事件时能全部抑制。键都走 [`normalize_for_compare`] 归一。
/// - `last_emit`: 路径防抖表, `(normalized path, 上次 emit 时间)`。150ms
///   内同路径事件吞掉, 处理编辑器保存时的重复 notify。
/// - `remove_coalescer`: 外部 rename 可能先到 Remove(old), 这里短暂保留
///   tombstone, 等待随后 Create/Modify(new) 通过 frontmatter key 合并。
/// - `whitelist`: 运行时可热更新的 watcher 白/黑名单配置。
pub struct MemoWatcher {
    _watcher: Option<RecommendedWatcher>,
    watched_roots: Arc<std::sync::RwLock<Vec<NotebookWatchContext>>>,
    recent_self_writes: Arc<Mutex<HashMap<PathBuf, Instant>>>,
    last_emit: Arc<Mutex<HashMap<PathBuf, Instant>>>,
    remove_coalescer: Option<RemoveCoalescer>,
    memo_file: Arc<std::sync::RwLock<MemoFile>>,
    whitelist: Arc<std::sync::RwLock<WhitelistConfig>>,
}

impl MemoWatcher {
    pub fn new(memo_file: Arc<std::sync::RwLock<MemoFile>>) -> Self {
        Self {
            _watcher: None,
            watched_roots: Arc::new(std::sync::RwLock::new(Vec::new())),
            recent_self_writes: Arc::new(Mutex::new(HashMap::new())),
            last_emit: Arc::new(Mutex::new(HashMap::new())),
            remove_coalescer: None,
            memo_file,
            whitelist: Arc::new(std::sync::RwLock::new(WhitelistConfig::load_or_default())),
        }
    }

    /// 替换白名单配置。 `lib.rs::setup` 会在启动 + 热更新时调用,
    /// 中间以 `Arc<RwLock<WhitelistConfig>>` 共享。
    pub fn set_whitelist(&self, new_cfg: WhitelistConfig) {
        if let Ok(mut g) = self.whitelist.write() {
            *g = new_cfg;
        }
    }

    pub fn rebind_all(&mut self, app: AppHandle, configs: Vec<NotebookConfig>) {
        // Drop 旧 watcher — 此赋值 `take` 出 Option, 旧 RecommendedWatcher 立即析构
        let _ = self._watcher.take();
        if let Some(coalescer) = self.remove_coalescer.take() {
            coalescer.cancel_all();
        }

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
        let recent = self.recent_self_writes.clone();
        let last_emit = self.last_emit.clone();
        let memo_file = self.memo_file.clone();
        let whitelist = self.whitelist.clone();
        let watched_roots = self.watched_roots.clone();

        let mut watcher: RecommendedWatcher =
            match notify::recommended_watcher(move |res: notify::Result<Event>| {
                let Ok(event) = res else {
                    return;
                };
                handle_notify_event(
                    &app,
                    &memo_file,
                    &recent,
                    &last_emit,
                    &remove_coalescer_for_callback,
                    &whitelist,
                    &watched_roots,
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

        self.remove_coalescer = Some(remove_coalescer);
        self._watcher = Some(watcher);
    }

    /// 后端自身写入路径在**写盘之前**调用, 把 path 塞抑制表。
    ///
    /// 路径入表前先走 [`normalize_for_compare`] 归一, 跟 watcher 端查表口径一致。
    /// 表项不在命中时立即删除, 而是由 2s TTL 清理, 以吞掉同一次写盘产生的
    /// 多条 notify 事件。
    pub fn mark_self_write(&self, path: &Path) {
        let key = normalize_for_compare(path);
        if let Ok(mut map) = self.recent_self_writes.lock() {
            // 顺手剪枝过老条目, 抑制表小 (<几十项) 剪枝 < 1µs
            map.retain(|_, t| t.elapsed() < SELF_WRITE_TTL);
            tracing::debug!(
                "[mark_self_write] path={} key={} table_size={}",
                path.display(),
                key.display(),
                map.len(),
            );
            map.insert(key, Instant::now());
        }
    }
}

/// notify 回调主体 — 过滤 + 自写抑制 + 防抖 + 触发 `MemoFile` 重派生 + emit。
///
/// 注意: 这个函数在 notify 自己的线程上跑, 跟 ReAct 主循环并发。
/// `MemoFile` 是 `Arc<StdRwLock<MemoFile>>`, 我们读锁拿, 调用方负责不持锁跨 await。
///
/// 抑制两道闸, 逐级下沉:
/// 1. `recent_self_writes` (路径) — `mark_self_write` 在写盘前调用
/// 2. `last_emit` (路径) — 150ms 内同路径事件吞, 处理 FSEvents 双触发
fn handle_notify_event(
    app: &AppHandle,
    memo_file: &Arc<std::sync::RwLock<MemoFile>>,
    recent: &Arc<
        std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, std::time::Instant>>,
    >,
    last_emit: &Arc<
        std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, std::time::Instant>>,
    >,
    remove_coalescer: &RemoveCoalescer,
    whitelist: &Arc<std::sync::RwLock<WhitelistConfig>>,
    watched_roots: &Arc<std::sync::RwLock<Vec<NotebookWatchContext>>>,
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
        // 跑三段 filter pipeline: whitelist / self-write / debounce。
        let fs_kind = FsEventKind::from_notify(&event.kind);
        if matches!(fs_kind, FsEventKind::Create | FsEventKind::Modify) {
            // A rename can arrive as Remove(old) followed by Create/Modify(new).
            // The new path may itself be marked as a self-write after the internal
            // save resolves, so cancel the old-path tombstone before the filter
            // pipeline has a chance to drop this event.
            remove_coalescer.cancel_by_disk_key(&path);
        }
        let raw = RawFsEvent::new(fs_kind, path.clone());
        match crate::watcher::filter::run_pipeline(&raw, recent, last_emit, &path_filter) {
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

        // manager 只做采集 + 过滤, 业务分流交给 MemoEventProcessor。
        // processor 自己读磁盘抽 frontmatter key 做 rename / reload /
        // register 分流, 这里不需要 stat 任何 metadata。
        match fs_kind {
            FsEventKind::Remove => {
                if schedule_pending_remove(remove_coalescer, memo_file, ctx.clone(), &path) {
                    continue;
                }
            }
            FsEventKind::Create | FsEventKind::Modify => {}
            FsEventKind::Other => {}
        }

        MemoEventProcessor::process(&raw, app, memo_file, &ctx);
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
    let filename = path.file_name().and_then(|n| n.to_str())?;
    let mf = memo_file.read().ok()?;
    mf.find_memo_by_filename_for_notebook_id(&ctx.notebook_id, filename)
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
        let expected_file_path = notes.join(&created.filename);

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
        // 写盘前 mark 的典型场景: 文件还没创建, canonicalize 必然失败。
        // 应当退到原 path 字符串, 不丢抑制。
        let p = Path::new("/definitely/does/not/exist/foo.md");
        let normalized = normalize_for_compare(p);
        assert_eq!(normalized, p.to_path_buf());
    }

    #[test]
    fn normalize_for_compare_joins_canonical_parent_when_only_parent_exists() {
        // 父目录存在 (notebook dir 已建), 文件不存在 — canonicalize 父目录
        // 成功, 应当 join 回去。这是写盘前 mark 期望走的回退路径。
        // pid + nano 后缀防跟其它测试的 tempdir 撞名, 避免 cargo test 并行
        // 跑时的偶发 flake。
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
        // 父目录走 canonicalize, 跟原 parent 等价 (本机无 symlink 时)
        assert_eq!(
            normalized.parent().unwrap().canonicalize().unwrap(),
            tmp.canonicalize().unwrap()
        );
        assert_eq!(normalized.file_name().unwrap(), "not-yet-created.md");
        std::fs::remove_dir_all(&tmp).ok();
    }
}
