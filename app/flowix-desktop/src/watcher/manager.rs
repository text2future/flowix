//! 绗旇鐩綍鏂囦欢鐩戝惉 鈥?鍖呰 `notify::RecommendedWatcher` 鐩戝惉鍏ㄩ儴宸查厤缃?notebook
//! 鐩綍, 鎶婂閮ㄧ紪杈戝櫒 / 鍏朵粬 AI 鐨勭鐩樺彉鏇磋浆涓?`MemoEvent::Updated` 鎴?//! `MemoEvent::Deleted` emit 缁欏墠绔€?//!
//! ## 鑷啓鎶戝埗 (self-write suppression)
//!
//! 鍚庣鑷韩鍐欏叆 (鐢ㄦ埛 UI / Agent / import 璺緞) 鍦?*鍐欑洏涔嬪墠**璋冪敤
//! `MemoWatcher::mark_self_write(path)` 鎶婅矾寰勫鍏ユ姂鍒堕泦鍚堛€倃atcher 鍥炶皟
//! 鐪嬪埌鍚岃矾寰勪簨浠? 鍛戒腑鍗冲悶銆傝繖涓€椤哄簭寰堝叧閿?鈥?鍐欑洏鍓?mark 鎵嶈兘鍏虫帀
//! "notify 浜嬩欢鍏堜簬 mark 鍒拌揪"鐨?race window, 鍚﹀垯 IPC 鍛戒护鍒氭妸鏂囦欢钀界洏
//! 杩樻病鏉ュ緱鍙婂鎶戝埗琛? watcher 灏卞厛鐪嬪埌 Create 浜嬩欢, 瑙﹀彂 reload/re-register
//! 浜屾 emit銆?//!
//! 璁捐: 鍚庣 emit 鏄悓姝ョ殑, 鍏堜簬 notify 鍥炶皟鍒拌揪鍓嶇; UI 姘歌繙鍏堢湅鍒拌嚜瀹?//! "Created" / "Updated" 浜嬩欢, 涓嶄細闂儊銆倃atcher 150ms 鍐呯殑鍥炲搷琚悶, 鏉滅粷
//! "澶栭儴鐪嬭捣鏉ユ敼浜嗕袱娆?銆?//!
//! ## Rename 妫€娴嬶細frontmatter-key-first
//!
//! 鏃х増鐢?`inode_tracker`锛圲nix ino / Windows NTFS MFT file_index + vol_serial锛?//! 閰嶅 From + To 浜嬩欢璇嗗埆 rename銆傞噸鏋勫悗**瀹屽叏涓嶉渶瑕?inode / file_index**锛?//! processor 璇荤鐩?frontmatter 鐨?`key` 瀛楁鐩存帴浣滀负 id 鐪熸簮銆俧s::rename
//! 鎷嗗嚭鐨?From + To 涓ゆ潯浜嬩欢涓? To 浜嬩欢璇诲埌鐨?frontmatter key 璺熸棫 entry 鐨?//! id 涓€鑷?鈫?`rename_memo_file` 鑷姩淇濈暀 id 鏀?entry.filename銆?//!
//! 璺ㄥ钩鍙拌涓虹粺涓€ 鈥?鍦?NTFS / FAT32 / exFAT / 缃戠粶鐩?/ symlink / 璺ㄥ嵎 涓?//! 琛屼负涓€鑷? 涓嶅啀鏈?Plan A 閭ｅ Windows-only `windows-sys` 渚濊禆銆?//!
//! ## 璺ㄥ钩鍙?//!
//! `notify::RecommendedWatcher` 鑷姩閫?macOS FSEvents / Linux inotify /
//! Windows ReadDirectoryChangesW, 宸茬敱 `notify` 6.0 鐨勪緷璧栧浘鑷寘鍚€?//!
//! 璺緞姣旇緝涓や晶 (`mark_self_write` 鍏ュ弬 / watcher 鏀跺埌鐨?`event.paths`) 閮?//! 璧?[`normalize_for_compare`] 褰掍竴: macOS 涓?`/var` 鈫?`/private/var` symlink
//! 鎶樺彔, Windows 涓?`\\?\C:\...` 鍓嶇紑鍘绘帀銆傚惁鍒?HashMap 绮剧‘鍖归厤浼?miss銆?
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

/// 绗旇鏈洰褰曠殑鏂囦欢鐩戝惉鍣ㄣ€?///
/// 瀛楁璇箟:
/// - `_watcher`: 鎸佹湁 `RecommendedWatcher` 鏈熼棿鎸佺画鐩戝惉銆侱rop 鏃惰嚜鍔ㄥ仠姝€?/// - `watched_roots`: 褰撳墠缁戝畾鐨?notebook 鏍圭洰褰曢泦鍚堛€?/// - `recent_self_writes`: 鑷啓鎶戝埗琛? `(normalized path, 鏍囪鏃堕棿)`銆?///   鍥炶皟鏌ヨ〃, 鍛戒腑鍗冲悶; 琛ㄩ」閫氳繃 TTL 娓呯悊, 淇濊瘉 macOS FSEvents 涓€娆″啓鍏?///   浜х敓澶氭潯浜嬩欢鏃惰兘鍏ㄩ儴鎶戝埗銆傞敭閮借蛋 [`normalize_for_compare`] 褰掍竴銆?/// - `last_emit`: 璺緞闃叉姈琛? `(normalized path, 涓婃 emit 鏃堕棿)`銆?50ms
///   鍐呭悓璺緞浜嬩欢鍚炴帀, 澶勭悊缂栬緫鍣ㄤ繚瀛樻椂鐨勯噸澶?notify銆?/// - `remove_coalescer`: 澶栭儴 rename 鍙兘鍏堝埌 Remove(old), 杩欓噷鐭殏淇濈暀
///   tombstone, 绛夊緟闅忓悗 Create/Modify(new) 閫氳繃 frontmatter key 鍚堝苟銆?/// - `whitelist`: 杩愯鏃跺彲鐑洿鏂扮殑 watcher 鐧?榛戝悕鍗曢厤缃€?
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

    /// 鏇挎崲鐧藉悕鍗曢厤缃€?`lib.rs::setup` 浼氬湪鍚姩 + 鐑洿鏂版椂璋冪敤,
    /// 涓棿浠?`Arc<RwLock<WhitelistConfig>>` 鍏变韩銆?
    pub fn set_whitelist(&self, new_cfg: WhitelistConfig) {
        if let Ok(mut g) = self.whitelist.write() {
            *g = new_cfg;
        }
    }

    pub fn rebind_all(&mut self, app: AppHandle, configs: Vec<NotebookConfig>) {
        // Drop 鏃?watcher 鈥?姝よ祴鍊?`take` 鍑?Option, 鏃?RecommendedWatcher 绔嬪嵆鏋愭瀯
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

    /// 鍚庣鑷韩鍐欏叆璺緞鍦?*鍐欑洏涔嬪墠**璋冪敤, 鎶?path 濉炴姂鍒惰〃銆?    ///
    /// 璺緞鍏ヨ〃鍓嶅厛璧?[`normalize_for_compare`] 褰掍竴, 璺?watcher 绔煡琛ㄥ彛寰勪竴鑷淬€?    /// 琛ㄩ」涓嶅湪鍛戒腑鏃剁珛鍗冲垹闄? 鑰屾槸鐢?2s TTL 娓呯悊, 浠ュ悶鎺夊悓涓€娆″啓鐩樹骇鐢熺殑
    /// 澶氭潯 notify 浜嬩欢銆?
    pub fn mark_self_write(&self, path: &Path) {
        let key = normalize_for_compare(path);
        if let Ok(mut map) = self.recent_self_writes.lock() {
            // 椤烘墜鍓灊杩囪€佹潯鐩? 鎶戝埗琛ㄥ皬 (<鍑犲崄椤? 鍓灊 < 1碌s
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

/// notify 鍥炶皟涓讳綋 鈥?杩囨护 + 鑷啓鎶戝埗 + 闃叉姈 + 瑙﹀彂 `MemoFile` 閲嶆淳鐢?+ emit銆?///
/// 娉ㄦ剰: 杩欎釜鍑芥暟鍦?notify 鑷繁鐨勭嚎绋嬩笂璺? 璺?ReAct 涓诲惊鐜苟鍙戙€?/// `MemoFile` 鏄?`Arc<StdRwLock<MemoFile>>`, 鎴戜滑璇婚攣鎷? 璋冪敤鏂硅礋璐ｄ笉鎸侀攣璺?await銆?///
/// 鎶戝埗涓ら亾闂? 閫愮骇涓嬫矇:
/// 1. `recent_self_writes` (璺緞) 鈥?`mark_self_write` 鍦ㄥ啓鐩樺墠璋冪敤
/// 2. `last_emit` (璺緞) 鈥?150ms 鍐呭悓璺緞浜嬩欢鍚? 澶勭悊 FSEvents 鍙岃Е鍙?
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
        // 璺戜笁娈?filter pipeline: whitelist / self-write / debounce銆?
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

        // manager 鍙仛閲囬泦 + 杩囨护, 涓氬姟鍒嗘祦浜ょ粰 MemoEventProcessor銆?        // processor 鑷繁璇荤鐩樻娊 frontmatter key 鍋?rename / reload /
        // register 鍒嗘祦, 杩欓噷涓嶉渶瑕?stat 浠讳綍 metadata銆?
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
        // 鍐欑洏鍓?mark 鐨勫吀鍨嬪満鏅? 鏂囦欢杩樻病鍒涘缓, canonicalize 蹇呯劧澶辫触銆?        // 搴斿綋閫€鍒板師 path 瀛楃涓? 涓嶄涪鎶戝埗銆?
        let p = Path::new("/definitely/does/not/exist/foo.md");
        let normalized = normalize_for_compare(p);
        assert_eq!(normalized, p.to_path_buf());
    }

    #[test]
    fn normalize_for_compare_joins_canonical_parent_when_only_parent_exists() {
        // 鐖剁洰褰曞瓨鍦?(notebook dir 宸插缓), 鏂囦欢涓嶅瓨鍦?鈥?canonicalize 鐖剁洰褰?        // 鎴愬姛, 搴斿綋 join 鍥炲幓銆傝繖鏄啓鐩樺墠 mark 鏈熸湜璧扮殑鍥為€€璺緞銆?        // pid + nano 鍚庣紑闃茶窡鍏跺畠娴嬭瘯鐨?tempdir 鎾炲悕, 閬垮厤 cargo test 骞惰
        // 璺戞椂鐨勫伓鍙?flake銆?
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
        // 鐖剁洰褰曡蛋 canonicalize, 璺熷師 parent 绛変环 (鏈満鏃?symlink 鏃?
        assert_eq!(
            normalized.parent().unwrap().canonicalize().unwrap(),
            tmp.canonicalize().unwrap()
        );
        assert_eq!(normalized.file_name().unwrap(), "not-yet-created.md");
        std::fs::remove_dir_all(&tmp).ok();
    }
}
