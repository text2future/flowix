//! `MemoEventProcessor` 鈥?鎶?`RawFsEvent` 杞垚 `MemoEvent` 骞?emit銆?//!
//! watcher manager 不直接调 `MemoFile` �?register / reload / unregister,
//! 统一委派给本模块。pipeline 跑过之后, �?`RawFsEvent` 喂给
//! `MemoEventProcessor::process`, 它看 event.kind 分派, �?register_unnamed /
//! reload / unregister, 最�?emit `MemoEvent` (�?dispatcher 抽象, �?channel
//! 后续在这�?extend)�?//!
//! `process` �?��步的: 拿到事件 �?同�?�?//! `MemoFile` (Arc<RwLock>) �?同�? emit �?返回。notify 回调线程�?await�?
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::memo_events::{emit, MemoChangeSource, MemoDerivedChanged, MemoEvent};
use crate::watcher::event::{FsEventKind, RawFsEvent};
use flowix_core::memo_file::{
    extract_frontmatter_key, notebook_path_from_relative, notebook_relative_path, Memo, MemoFile,
};

#[derive(Debug, Clone)]
pub struct NotebookWatchContext {
    pub notebook_id: String,
    pub root: PathBuf,
}

/// 业务处理�?—状态由调用方注�?(memo_file / app)�?///
/// 故意不做�?struct 持字�? 而是 stateless: `process` 接收所有依赖。原�?
/// manager �?notify 回调�?��已经�?`move |res| { ... }`, �?��捕获
/// Arc<MemoFile> / AppHandle 引用, 不需�?processor 内部再持一份�?
pub struct MemoEventProcessor;

/// �?��数分流结�? dispatcher 决定�?emit �?��事件 + 附带的副作用数据�?
#[derive(Debug)]
pub(crate) enum DispatchOutcome {
    /// �?Updated �?��, 无副作用
    Updated(MemoEvent),
    /// �?Created �?��, 需�?caller �?mark_self_write(new_abs_path) 抑制
    /// 鍚庣画 notify 浜嬩欢
    Created {
        event: MemoEvent,
        new_abs_path: PathBuf,
    },
}

fn read_indexed_memo_after_external_marker(
    memo_file: &MemoFile,
    notebook_id: &str,
    memo_id: &str,
) -> Option<Memo> {
    if let Some(memo) = memo_file.read_memo_for_notebook_id(notebook_id, memo_id) {
        return Some(memo);
    }
    if !memo_file
        .has_pending_external_memo_create(memo_id, notebook_id)
        .unwrap_or(false)
    {
        return None;
    }

    // The marker is committed before the markdown file is published. Give the
    // creating process a short opportunity to commit the corresponding memo row.
    for _ in 0..8 {
        std::thread::sleep(Duration::from_millis(25));
        if let Some(memo) = memo_file.read_memo_for_notebook_id(notebook_id, memo_id) {
            return Some(memo);
        }
    }
    None
}

fn emit_updated_for_context(
    ctx: &NotebookWatchContext,
    before: Option<&Memo>,
    memo: Memo,
) -> DispatchOutcome {
    let entry_path = notebook_path_from_relative(&ctx.root, &memo.relative_path)
        .unwrap_or_else(|_| ctx.root.join(&memo.filename))
        .display()
        .to_string();
    let derived_changed = MemoDerivedChanged::from_memos(before, &memo);
    DispatchOutcome::Updated(MemoEvent::Updated {
        id: memo.id.clone(),
        path: entry_path,
        notebook_id: ctx.notebook_id.clone(),
        memo,
        derived_changed,
        source: MemoChangeSource::ExternalTool,
    })
}

fn emit_created_for_context(
    ctx: &NotebookWatchContext,
    memo: Memo,
    new_abs_path: PathBuf,
) -> DispatchOutcome {
    let derived_changed = MemoDerivedChanged::from_memos(None, &memo);
    DispatchOutcome::Created {
        event: MemoEvent::Created {
            notebook_id: ctx.notebook_id.clone(),
            derived_changed,
            memo,
            source: MemoChangeSource::ExternalTool,
        },
        new_abs_path,
    }
}

/// Frontmatter-key-first 分流: 给一�?Create/Modify 事件�?abs path,
/// 决定 emit �?? MemoEvent�?///
/// **磁盘 frontmatter �?`key` 字�?�?id 真源**, 文件名是派生属性。�?磁盘 �?/// �?key �?�?memo index 里按 id 反查, 命中即用 key 对应�?entry; 不命�?/// 才退�?filename 兜底�?///
/// 这样做的核心收益: rename �?fs::rename 拆成�?From + To 两条事件, To 事件
/// 读到�?frontmatter key 跟旧 entry �?id 一�?�?命中 �?�?`rename_memo_file`
/// �?entry.filename, id 保留。完全不需�?inode_tracker / file_index 这些 OS �?/// 元数�? �?NTFS / FAT32 / exFAT / 网络�?/ symlink 上�?为一致�?///
/// 分流规则 (�?disk key + memo index 状�?:
/// - key 命中 + filename 一�? reload (重派�?preview/tags/todos)
/// - key 命中 + filename 不一�?+ old file 已不存在: physical rename, 保留 id
/// - key 命中 + filename 不一�?+ old file 仍存�? pasted duplicate, 新建 memo 并刷�?key
/// - key 不在当前 memo index: pasted/imported markdown, 新建 memo 并刷�?key
/// - �?key + filename �?memo index: reload (保留 id/filename, 用户保存时会注入 key)
/// - �?key + filename 不在: register (生成�?id, 通过 merge_frontmatter 注入)
///
/// �?`process()` 抽出来好做单�?(process �?��依赖 AppHandle, 不易�?;
/// 分流规则�?�� MemoFile 状态有�? �?Tauri 解耦�?
/// 测试入口: 不需要自写抑制的调用方走这条, mark 传 no-op。生产路径 (`process`) 直接
/// 调 [`dispatch_modify_event_with_mark`], 在每个写盘分支 *之前* mark_self_write ──
/// 关闭 "stamp 写盘触发的 self-write notify 事件先于 mark 到达" 的 race window (见
/// manager.rs 模块头注释)。此前 mark 在写盘之后做、靠 process 跑在 notify 共享线程上
/// 的串行性兜底; process 移到 worker 线程后那层串行性没了, 必须改成写盘前 mark。
#[cfg(test)]
pub(crate) fn dispatch_modify_event(
    memo_file: &MemoFile,
    ctx: &NotebookWatchContext,
    path: &Path,
    event_kind: FsEventKind,
) -> Result<DispatchOutcome, String> {
    dispatch_modify_event_with_mark(memo_file, ctx, path, event_kind, |_: &Path| {})
}

fn dispatch_modify_event_with_mark(
    memo_file: &MemoFile,
    ctx: &NotebookWatchContext,
    path: &Path,
    _event_kind: FsEventKind,
    mark: impl Fn(&Path),
) -> Result<DispatchOutcome, String> {
    let relative_path = notebook_relative_path(&ctx.root, path)?;

    // 读�?盘抽 frontmatter key ── id 真源。�?失败 (权限 / 临时消失) 退�?    // filename-based 兜底, 行为等同�?refactor 前�?
    let disk_key = std::fs::read_to_string(path)
        .ok()
        .and_then(|c| extract_frontmatter_key(&c));

    match disk_key {
        Some(id) => match read_indexed_memo_after_external_marker(memo_file, &ctx.notebook_id, &id)
        {
            Some(existing) if existing.relative_path == relative_path => {
                if memo_file
                    .has_pending_external_memo_create(&id, &ctx.notebook_id)
                    .unwrap_or(false)
                {
                    tracing::info!(
                        "[MemoWatcher] claimed external create marker: id={} path={}",
                        existing.id,
                        path.display(),
                    );
                    let refreshed = memo_file.reload_memo_from_disk_by_filename_for_notebook_id(
                        &ctx.notebook_id,
                        &relative_path,
                    )?;
                    if memo_file
                        .consume_pending_external_memo_create(&id, &ctx.notebook_id)
                        .unwrap_or(false)
                    {
                        Ok(emit_created_for_context(ctx, refreshed, path.to_path_buf()))
                    } else {
                        Ok(emit_updated_for_context(ctx, Some(&existing), refreshed))
                    }
                } else {
                    reload_existing_memo(memo_file, ctx, &relative_path)
                }
            }
            Some(existing) => {
                // Rename handling must be idempotent. The internal save path can
                // update the index before this watcher event obtains the index lock,
                // so the locked sync below resolves by id and accepts both old->new
                // and already-new index states.
                let old_path = notebook_path_from_relative(&ctx.root, &existing.relative_path)
                    .unwrap_or_else(|_| ctx.root.join(&existing.filename));
                if is_physical_rename_candidate(&old_path) {
                    // sync_renamed_memo_from_key 不写 memo 文件 (只读 + 改 in-memory index),
                    // 无 self-write, 不需要 mark。
                    sync_renamed_memo_from_key(memo_file, ctx, &existing, &id, &old_path, path)
                } else {
                    // register_pasted_copy_as_new -> register_existing_file_as_new 会
                    // atomic_write_bytes 把 key stamp 进文件: 必须先 mark 再写。
                    mark(path);
                    register_pasted_copy_as_new(memo_file, ctx, path, Some(&id))
                }
            }
            None => {
                mark(path);
                register_pasted_copy_as_new(memo_file, ctx, path, Some(&id))
            }
        },
        None => {
            // Disk �?frontmatter key: 不能�?id 反查, 退�?filename-based�?
            if memo_file
                .find_memo_by_relative_path_for_notebook_id(&ctx.notebook_id, &relative_path)
                .is_some()
            {
                reload_existing_memo(memo_file, ctx, &relative_path)
            } else {
                // 新文件无 key: register_existing_file_for_notebook_id �?generate-new-id + stamp �?��
                mark(path);
                let memo =
                    memo_file.register_existing_file_for_notebook_id(&ctx.notebook_id, path)?;
                Ok(emit_created_for_context(ctx, memo, path.to_path_buf()))
            }
        }
    }
}

fn reload_existing_memo(
    memo_file: &MemoFile,
    ctx: &NotebookWatchContext,
    relative_path: &str,
) -> Result<DispatchOutcome, String> {
    let before =
        memo_file.find_memo_by_relative_path_for_notebook_id(&ctx.notebook_id, relative_path);
    let updated = memo_file
        .reload_memo_from_disk_by_filename_for_notebook_id(&ctx.notebook_id, relative_path)?;
    Ok(emit_updated_for_context(ctx, before.as_ref(), updated))
}

fn is_physical_rename_candidate(old_path: &Path) -> bool {
    !old_path.exists()
}

/// path �?��在当�?notebook �?`attachments/` �?���? 这层判断�?���?/// [`crate::watcher::WhitelistConfig`], 因为 whitelist �?? preference.json
/// 瑕嗙洊, 鐢ㄦ埛鐨勬棫閰嶇疆鍙兘婕忛厤 `attachments`. processor 鍦ㄥ叆鍙ｈ蛋杩欓亾闃茬嚎,
/// �?attachments/ 下的任何 .md 文件 (无�?�?���??复制进来的另一台笔记本
/// 的笔�? 都直接拒�? 避免"幽灵笔�?"污染 memo 列表.
///
/// �?[`crate::watcher::path::normalize_for_compare`] 而不�?�� `starts_with`:
/// - canonicalize 任一边失败都退�?父目�?canonicalize + join"回退�?��,
///   文件刚写盘但 fs 元数�?��就绪时仍能给出�?�?���?/// - 同一�?normalize �?watcher 抑制�?(`SelfWriteSuppressor` /
///   `Debouncer`) 口径一�? 避免半状态路�?(canonical vs �?canonical)
///   缁曡繃杩欓亾闃茬嚎
/// - 不再�?component-level 匹配 (`parent.file_name == "attachments"`),
///   那�?匹配会�?杀 `bar/attachments/foo.md` 这�?"嵌�?同名子目�?�?��.
fn is_under_attachments_dir(ctx: &NotebookWatchContext, path: &Path) -> bool {
    let attachments_dir =
        crate::watcher::path::normalize_for_compare(&ctx.root.join("attachments"));
    let path_norm = crate::watcher::path::normalize_for_compare(path);
    path_norm.starts_with(&attachments_dir)
}

fn sync_renamed_memo_from_key(
    memo_file: &MemoFile,
    ctx: &NotebookWatchContext,
    before: &Memo,
    id: &str,
    old_path: &Path,
    new_path: &Path,
) -> Result<DispatchOutcome, String> {
    tracing::info!(
        "[MemoWatcher] rename detected via frontmatter key {}: {} -> {}",
        id,
        old_path.display(),
        new_path.display(),
    );
    let updated = memo_file.sync_memo_filename_from_disk_key_for_notebook_id(
        &ctx.notebook_id,
        id,
        new_path,
    )?;
    Ok(emit_updated_at(ctx, Some(before), updated, new_path))
}

fn register_pasted_copy_as_new(
    memo_file: &MemoFile,
    ctx: &NotebookWatchContext,
    path: &Path,
    disk_key: Option<&str>,
) -> Result<DispatchOutcome, String> {
    if let Some(id) = disk_key {
        tracing::info!(
            "[MemoWatcher] markdown key {} treated as pasted/imported document, stamping fresh key: {}",
            id,
            path.display(),
        );
    }
    let memo = memo_file.register_existing_file_as_new_for_notebook_id(&ctx.notebook_id, path)?;
    Ok(emit_created_for_context(ctx, memo, path.to_path_buf()))
}

/// �?[`emit_updated`] 但路径用事件原�? path (rename 场景下是新位�?��绝�?�?��)�?
fn emit_updated_at(
    ctx: &NotebookWatchContext,
    before: Option<&Memo>,
    memo: Memo,
    abs_path: &Path,
) -> DispatchOutcome {
    let entry_path = abs_path.display().to_string();
    let derived_changed = MemoDerivedChanged::from_memos(before, &memo);
    DispatchOutcome::Updated(MemoEvent::Updated {
        id: memo.id.clone(),
        path: entry_path,
        notebook_id: ctx.notebook_id.clone(),
        memo,
        derived_changed,
        source: MemoChangeSource::ExternalTool,
    })
}

pub(crate) fn wait_for_markdown_copy_to_settle(path: &Path) {
    let mut last_len = None;
    let mut stable_samples = 0;

    for _ in 0..8 {
        let Ok(meta) = std::fs::metadata(path) else {
            std::thread::sleep(Duration::from_millis(50));
            continue;
        };
        if !meta.is_file() {
            return;
        }

        let len = meta.len();
        if Some(len) == last_len {
            stable_samples += 1;
            if stable_samples >= 2 && std::fs::File::open(path).is_ok() {
                return;
            }
        } else {
            last_len = Some(len);
            stable_samples = 0;
        }

        std::thread::sleep(Duration::from_millis(50));
    }
}

fn try_update_search_index(app: &AppHandle, id: &str) {
    if let Some(state) = app.try_state::<crate::app::state::AppState>() {
        crate::app::search_index::try_index_upsert(state.inner(), id);
    }
}

fn try_remove_from_search_index(app: &AppHandle, id: &str) {
    if let Some(state) = app.try_state::<crate::app::state::AppState>() {
        crate::app::search_index::try_index_remove(state.inner(), id);
    }
}

impl MemoEventProcessor {
    /// 入口 —pipeline 跑过之后调用, 事件已通过 filter�?    ///
    /// 琛屼负:
    /// - Create/Modify: 文件存在 �?key-first 分流; 不存�?�?unregister
    /// - Remove:        unregister (�?filename �?memo index, 命中�? 没命�?no-op)
    /// - Other:         蹇界暐
    pub fn process(
        event: &RawFsEvent,
        app: &AppHandle,
        memo_file: &Arc<std::sync::RwLock<MemoFile>>,
        ctx: &NotebookWatchContext,
    ) {
        // 防御性拦�? 附件�?��下的 .md 文件不是 memo, 一律不处理.
        // 后�? `save_attachment` / `save_attachment_content` 会把任意�?�?        // �?��文件复制�?`<notebook>/attachments/`, 包括用户选了另一�?        // notebook 的笔�?.md —这�?情况 attachment �?��里会出现一�?        // 不�?出现�?memo 列表里的"幽灵笔�?".
        //
        // 这道防线�?���?whitelist (whitelist �?���?��户的 preference.json
        // 覆盖, 或�?hot-update 期间窗口�?��不一�?, �?processor 入口
        // 拒掉, �?create / modify / remove 三�? kind 的最后一道闸�?
        if is_under_attachments_dir(ctx, &event.path) {
            tracing::debug!(
                "[MemoWatcher] processor skipped attachments/ path: {}",
                event.path.display()
            );
            return;
        }

        match event.kind {
            FsEventKind::Create | FsEventKind::Modify => {
                let path = &event.path;
                if !path.exists() {
                    // Modify 事件但文件没�?—�?Delete �?��
                    Self::unregister_and_emit(app, memo_file, ctx, path);
                    return;
                }
                // Frontmatter-key-first 分流 ── 详情�?[`dispatch_modify_event`]�?
                let outcome = match memo_file.read() {
                    Ok(mf) => match mf.acquire_cross_process_write_lock() {
                        Ok(_guard) => {
                            dispatch_modify_event_with_mark(&mf, ctx, path, event.kind, |path| {
                                crate::watcher::runtime::mark_self_write_for(app, path)
                            })
                        }
                        Err(error) => Err(error.to_string()),
                    },
                    Err(_) => return,
                };
                match outcome {
                    Ok(DispatchOutcome::Updated(event)) => {
                        if let MemoEvent::Updated { id, .. } = &event {
                            try_update_search_index(app, id);
                        }
                        emit(app, event);
                    }
                    Ok(DispatchOutcome::Created {
                        event,
                        new_abs_path,
                    }) => {
                        tracing::info!("[MemoWatcher] registered: {}", new_abs_path.display(),);
                        if let Some(w) = crate::watcher::current_watcher(app) {
                            if let Ok(g) = w.read() {
                                g.mark_self_write(&new_abs_path);
                            }
                        }
                        if let MemoEvent::Created { memo, .. } = &event {
                            try_update_search_index(app, &memo.id);
                        }
                        emit(app, event);
                    }
                    Err(e) => {
                        tracing::warn!(
                            "[MemoWatcher] dispatch_modify_event failed for {}: {e}",
                            path.display()
                        );
                    }
                }
            }
            FsEventKind::Remove => {
                // Remove 事件�?filename �?── 没有 inode_tracker 也无所�?
                // - GUI �?���?SelfWriteSuppressor 已经吞了 From 事件, 走不到这�?                // - 外部 rename �?From 事件: �?unregister_and_emit, 后跟�?To
                //   事件�?key-first 分流�?(c) 分支, 用�?�?frontmatter key 重建
                //   entry, id 保留 (�?createdAt/updatedAt 会重�?�� now, 因为
                //   从�?盘�?不到原�?时间�? 这是 frontmatter-key-first 在�?�?                //   rename 场景下相�?inode_tracker 的取�?
                Self::unregister_and_emit(app, memo_file, ctx, &event.path);
            }
            FsEventKind::DirectoryChange => {
                Self::reconcile_directory_change(app, memo_file, ctx);
            }
            FsEventKind::Other => {
                // Access / Other —忽略
            }
        }
    }

    fn reconcile_directory_change(
        app: &AppHandle,
        memo_file: &Arc<std::sync::RwLock<MemoFile>>,
        ctx: &NotebookWatchContext,
    ) {
        let Ok(mf) = memo_file.read() else {
            return;
        };
        let before = mf.read_all_memos_for_notebook_id(Some(&ctx.notebook_id));
        let before_by_id = before
            .iter()
            .map(|memo| (memo.id.clone(), memo.clone()))
            .collect::<std::collections::HashMap<_, _>>();
        let report = match mf.reconcile_notebook_with_disk_bidirectional(&ctx.notebook_id) {
            Ok(report) => report,
            Err(error) => {
                tracing::warn!(
                    notebook_id = %ctx.notebook_id,
                    %error,
                    "directory change reconciliation failed"
                );
                return;
            }
        };
        let after = mf.read_all_memos_for_notebook_id(Some(&ctx.notebook_id));
        let after_ids = after
            .iter()
            .map(|memo| memo.id.as_str())
            .collect::<std::collections::HashSet<_>>();

        for memo in &after {
            match before_by_id.get(&memo.id) {
                None => {
                    try_update_search_index(app, &memo.id);
                    emit(
                        app,
                        MemoEvent::Created {
                            memo: memo.clone(),
                            notebook_id: ctx.notebook_id.clone(),
                            derived_changed: MemoDerivedChanged::from_memos(None, memo),
                            source: MemoChangeSource::ExternalTool,
                        },
                    );
                }
                Some(previous) if previous.relative_path != memo.relative_path => {
                    try_update_search_index(app, &memo.id);
                    let path = notebook_path_from_relative(&ctx.root, &memo.relative_path)
                        .unwrap_or_else(|_| ctx.root.join(&memo.filename));
                    emit(
                        app,
                        MemoEvent::Updated {
                            id: memo.id.clone(),
                            path: path.to_string_lossy().into_owned(),
                            notebook_id: ctx.notebook_id.clone(),
                            memo: memo.clone(),
                            derived_changed: MemoDerivedChanged::from_memos(Some(previous), memo),
                            source: MemoChangeSource::ExternalTool,
                        },
                    );
                }
                _ => {}
            }
        }
        for memo in before
            .iter()
            .filter(|memo| !after_ids.contains(memo.id.as_str()))
        {
            try_remove_from_search_index(app, &memo.id);
            let path = notebook_path_from_relative(&ctx.root, &memo.relative_path)
                .unwrap_or_else(|_| ctx.root.join(&memo.filename));
            emit(
                app,
                MemoEvent::Deleted {
                    id: memo.id.clone(),
                    path: path.to_string_lossy().into_owned(),
                    notebook_id: ctx.notebook_id.clone(),
                    derived_changed: MemoDerivedChanged::from_deleted(memo),
                    source: MemoChangeSource::ExternalTool,
                },
            );
        }
        tracing::info!(
            notebook_id = %ctx.notebook_id,
            added = report.added,
            removed = report.removed,
            "directory change reconciliation completed"
        );
    }

    pub(crate) fn unregister_and_emit(
        app: &AppHandle,
        memo_file: &Arc<std::sync::RwLock<MemoFile>>,
        ctx: &NotebookWatchContext,
        path: &Path,
    ) {
        // v2: inode 还在 tracker 里的�? 这是 rename 的旧位置, 跳过 unregister
        // (�?Create(new) �?rename 配�?�?��)�?process() 已经先做了一次�?�?
        // 这里�?defense-in-depth 一欰�?
        let Ok(mf) = memo_file.read() else {
            return;
        };
        let _write_guard = match mf.acquire_cross_process_write_lock() {
            Ok(guard) => guard,
            Err(error) => {
                tracing::warn!(%error, "failed to lock memo deletion observation");
                return;
            }
        };
        // 鐗╃悊鏂囦欢鍚嶆槸 `<title>.md` (id 璺熸枃浠跺悕瑙ｈ€?, 鏃у疄鐜颁細鎶婄┖ id 鍙戝埌鍓嶇,
        // �?`handleMemoDeleted` �?`memos.filter(m => m.id !== "")` 一条都
        // 过滤不掉 -> 幽灵笔�?�?        //
        // �?��: **�?`unregister_memo_by_path` 之前**�?filename 反查 memo index
        // 拿到真实 id。`unregister_memo_by_path` 内部就是用同一 filename 匹配 + �?        // entry, 所以这里查到的 id 跟它即将删的那条�?��一�? 不存�?race -- 都是
        // �?`current_index_io` 锁串行化, 内部�?? + �?memo index 一欰�?        //
        // 拿不�?id 的两种情�?
        // - �?��里没有合法的 .md 文件�?(�?`..`): 直接放弃 emit, 反�?
        //   `unregister_memo_by_path` 也会 return false, memo index 没动�?        // - filename 不在 memo index (孤立 .md / 已经�?���?: 同样放弃 emit, 不凭�?        //   generate id, 保持 id 一定来�?memo index 这个不变量�?
        let Ok(relative_path) = notebook_relative_path(&ctx.root, path) else {
            return;
        };
        let Some(memo) =
            mf.find_memo_by_relative_path_for_notebook_id(&ctx.notebook_id, &relative_path)
        else {
            tracing::debug!(
                "[MemoWatcher] unregister_and_emit: no memo index entry for relative_path={}, skipping emit (unregister will also no-op)",
                relative_path
            );
            return;
        };
        let id = memo.id.clone();
        let derived_changed = MemoDerivedChanged::from_deleted(&memo);
        if !mf.unregister_memo_by_path_for_notebook_id(&ctx.notebook_id, path) {
            return;
        }
        let entry_path = path.display().to_string();
        try_remove_from_search_index(app, &id);
        // emit 带真�?id �?Deleted, 让前�?handleMemoDeleted 能精准从
        // 列表 filter �?(避免 id=“�?�?filter 什么都不丢、只能靠
        // triggerRefresh 重拉补救)�?path 依然传出, 供会话点�?path 匹配�?
        emit(
            app,
            MemoEvent::Deleted {
                id,
                path: entry_path,
                notebook_id: ctx.notebook_id.clone(),
                derived_changed,
                source: MemoChangeSource::ExternalTool,
            },
        );
    }
}

#[cfg(test)]
mod tests;
