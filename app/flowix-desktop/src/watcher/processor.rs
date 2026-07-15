//! `MemoEventProcessor` — 把 `RawFsEvent` 转成 `MemoEvent` 并 emit。
//!
//! watcher manager 不直接调 `MemoFile` 的 register / reload / unregister,
//! 统一委派给本模块。pipeline 跑过之后, 把 `RawFsEvent` 喂给
//! `MemoEventProcessor::process`, 它看 event.kind 分派, 走 register_unnamed /
//! reload / unregister, 最后 emit `MemoEvent` (走 dispatcher 抽象, 多 channel
//! 后续在这里 extend)。
//!
//! `process` 是同步的: 拿到事件 → 同步改
//! `MemoFile` (Arc<RwLock>) → 同步 emit → 返回。notify 回调线程不 await。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::memo_events::{emit, MemoChangeSource, MemoDerivedChanged, MemoEvent};
use crate::watcher::event::{FsEventKind, RawFsEvent};
use flowix_core::memo_file::{extract_frontmatter_key, Memo, MemoFile};

#[derive(Debug, Clone)]
pub struct NotebookWatchContext {
    pub notebook_id: String,
    pub root: PathBuf,
}

/// 业务处理器 — 状态由调用方注入 (memo_file / app)。
///
/// 故意不做成 struct 持字段, 而是 stateless: `process` 接收所有依赖。原因:
/// manager 的 notify 回调闭包已经是 `move |res| { ... }`, 闭包捕获
/// Arc<MemoFile> / AppHandle 引用, 不需要 processor 内部再持一份。
pub struct MemoEventProcessor;

/// 纯函数分流结果: dispatcher 决定要 emit 哪个事件 + 附带的副作用数据。
#[derive(Debug)]
enum DispatchOutcome {
    /// 走 Updated 路径, 无副作用
    Updated(MemoEvent),
    /// 走 Created 路径, 需要 caller 调 mark_self_write(new_abs_path) 抑制
    /// 后续 notify 事件
    Created {
        event: MemoEvent,
        new_abs_path: PathBuf,
    },
}

fn emit_updated_for_context(
    ctx: &NotebookWatchContext,
    before: Option<&Memo>,
    memo: Memo,
) -> DispatchOutcome {
    let entry_path = ctx.root.join(&memo.filename).display().to_string();
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

/// Frontmatter-key-first 分流: 给一个 Create/Modify 事件的 abs path,
/// 决定 emit 哪种 MemoEvent。
///
/// **磁盘 frontmatter 的 `key` 字段是 id 真源**, 文件名是派生属性。读磁盘 →
/// 抽 key → 在 memo index 里按 id 反查, 命中即用 key 对应的 entry; 不命中
/// 才退回 filename 兜底。
///
/// 这样做的核心收益: rename 后 fs::rename 拆成的 From + To 两条事件, To 事件
/// 读到的 frontmatter key 跟旧 entry 的 id 一致 → 命中 → 走 `rename_memo_file`
/// 改 entry.filename, id 保留。完全不需要 inode_tracker / file_index 这些 OS 层
/// 元数据, 在 NTFS / FAT32 / exFAT / 网络盘 / symlink 上行为一致。
///
/// 分流规则 (按 disk key + memo index 状态):
/// - key 命中 + filename 一致: reload (重派生 preview/tags/todos)
/// - key 命中 + filename 不一致 + old file 已不存在: physical rename, 保留 id
/// - key 命中 + filename 不一致 + old file 仍存在: pasted duplicate, 新建 memo 并刷新 key
/// - key 不在当前 memo index: pasted/imported markdown, 新建 memo 并刷新 key
/// - 无 key + filename 在 memo index: reload (保留 id/filename, 用户保存时会注入 key)
/// - 无 key + filename 不在: register (生成新 id, 通过 merge_frontmatter 注入)
///
/// 从 `process()` 抽出来好做单测 (process 本身依赖 AppHandle, 不易测);
/// 分流规则只跟 MemoFile 状态有关, 跟 Tauri 解耦。
fn dispatch_modify_event(
    memo_file: &MemoFile,
    ctx: &NotebookWatchContext,
    path: &Path,
) -> Result<DispatchOutcome, String> {
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("invalid path: {}", path.display()))?
        .to_string();

    // 读磁盘抽 frontmatter key ── id 真源。读失败 (权限 / 临时消失) 退回
    // filename-based 兜底, 行为等同未 refactor 前。
    let disk_key = std::fs::read_to_string(path)
        .ok()
        .and_then(|c| extract_frontmatter_key(&c));

    match disk_key {
        Some(id) => match memo_file.read_memo_for_notebook_id(&ctx.notebook_id, &id) {
            Some(existing) if existing.filename == filename => {
                reload_existing_memo(memo_file, ctx, &filename)
            }
            Some(existing) => {
                // Rename handling must be idempotent. The internal save path can
                // update the index before this watcher event obtains the index lock,
                // so the locked sync below resolves by id and accepts both old->new
                // and already-new index states.
                let old_path = ctx.root.join(&existing.filename);
                if is_physical_rename_candidate(&old_path) {
                    sync_renamed_memo_from_key(memo_file, ctx, &existing, &id, &old_path, path)
                } else {
                    register_pasted_copy_as_new(memo_file, ctx, path, Some(&id))
                }
            }
            None => register_pasted_copy_as_new(memo_file, ctx, path, Some(&id)),
        },
        None => {
            // Disk 无 frontmatter key: 不能用 id 反查, 退到 filename-based。
            if memo_file
                .find_memo_by_filename_for_notebook_id(&ctx.notebook_id, &filename)
                .is_some()
            {
                reload_existing_memo(memo_file, ctx, &filename)
            } else {
                // 新文件无 key: register_existing_file_for_notebook_id 走 generate-new-id + stamp 路径
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
    filename: &str,
) -> Result<DispatchOutcome, String> {
    let before = memo_file.find_memo_by_filename_for_notebook_id(&ctx.notebook_id, filename);
    let updated =
        memo_file.reload_memo_from_disk_by_filename_for_notebook_id(&ctx.notebook_id, filename)?;
    Ok(emit_updated_for_context(ctx, before.as_ref(), updated))
}

fn is_physical_rename_candidate(old_path: &Path) -> bool {
    !old_path.exists()
}

/// path 是否在当前 notebook 的 `attachments/` 目录下. 这层判断独立于
/// [`crate::watcher::WhitelistConfig`], 因为 whitelist 可被 preference.json
/// 覆盖, 用户的旧配置可能漏配 `attachments`. processor 在入口走这道防线,
/// 把 attachments/ 下的任何 .md 文件 (无论是不是被复制进来的另一台笔记本
/// 的笔记) 都直接拒掉, 避免"幽灵笔记"污染 memo 列表.
///
/// 走 [`crate::watcher::path::normalize_for_compare`] 而不是裸 `starts_with`:
/// - canonicalize 任一边失败都退到"父目录 canonicalize + join"回退路径,
///   文件刚写盘但 fs 元数据未就绪时仍能给出正确答案
/// - 同一份 normalize 跟 watcher 抑制表 (`SelfWriteSuppressor` /
///   `Debouncer`) 口径一致, 避免半状态路径 (canonical vs 非 canonical)
///   绕过这道防线
/// - 不再用 component-level 匹配 (`parent.file_name == "attachments"`),
///   那种匹配会误杀 `bar/attachments/foo.md` 这种"嵌套同名子目录"路径.
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

/// 同 [`emit_updated`] 但路径用事件原始 path (rename 场景下是新位置的绝对路径)。
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

fn wait_for_markdown_copy_to_settle(path: &Path) {
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
    /// 入口 — pipeline 跑过之后调用, 事件已通过 filter。
    ///
    /// 行为:
    /// - Create/Modify: 文件存在 → key-first 分流; 不存在 → unregister
    /// - Remove:        unregister (按 filename 查 memo index, 命中删, 没命中 no-op)
    /// - Other:         忽略
    pub fn process(
        event: &RawFsEvent,
        app: &AppHandle,
        memo_file: &Arc<std::sync::RwLock<MemoFile>>,
        ctx: &NotebookWatchContext,
    ) {
        // 防御性拦截: 附件目录下的 .md 文件不是 memo, 一律不处理.
        // 后端 `save_attachment` / `save_attachment_content` 会把任意被选
        // 中的文件复制到 `<notebook>/attachments/`, 包括用户选了另一个
        // notebook 的笔记 .md — 这种情况 attachment 目录里会出现一份
        // 不该出现在 memo 列表里的"幽灵笔记".
        //
        // 这道防线独立于 whitelist (whitelist 可能被用户的 preference.json
        // 覆盖, 或者 hot-update 期间窗口短暂不一致), 走 processor 入口
        // 拒掉, 是 create / modify / remove 三种 kind 的最后一道闸。
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
                    // Modify 事件但文件没了 — 走 Delete 路径
                    Self::unregister_and_emit(app, memo_file, ctx, path);
                    return;
                }
                wait_for_markdown_copy_to_settle(path);

                // Frontmatter-key-first 分流 ── 详情见 [`dispatch_modify_event`]。
                let outcome = match memo_file.read() {
                    Ok(mf) => dispatch_modify_event(&mf, ctx, path),
                    Err(_) => return,
                };
                match outcome {
                    Ok(DispatchOutcome::Updated(event)) => {
                        if let MemoEvent::Updated { id, .. } = &event {
                            try_update_search_index(app, id);
                        }
                        emit(app, event)
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
                // Remove 事件按 filename 删 ── 没有 inode_tracker 也无所谓:
                // - GUI 路径下 SelfWriteSuppressor 已经吞了 From 事件, 走不到这里
                // - 外部 rename 的 From 事件: 进 unregister_and_emit, 后跟的 To
                //   事件走 key-first 分流的 (c) 分支, 用磁盘 frontmatter key 重建
                //   entry, id 保留 (但 createdAt/updatedAt 会重置成 now, 因为
                //   从磁盘读不到原始时间戳; 这是 frontmatter-key-first 在外部
                //   rename 场景下相对 inode_tracker 的取舍)
                Self::unregister_and_emit(app, memo_file, ctx, &event.path);
            }
            FsEventKind::Other => {
                // Access / Other — 忽略
            }
        }
    }

    pub(crate) fn unregister_and_emit(
        app: &AppHandle,
        memo_file: &Arc<std::sync::RwLock<MemoFile>>,
        ctx: &NotebookWatchContext,
        path: &Path,
    ) {
        // v2: inode 还在 tracker 里的话, 这是 rename 的旧位置, 跳过 unregister
        // (让 Create(new) 走 rename 配对路径)。 process() 已经先做了一次检查,
        // 这里再 defense-in-depth 一次。
        let Ok(mf) = memo_file.read() else {
            return;
        };
        // 物理文件名是 `<title>.md` (id 跟文件名解耦), 旧实现会把空 id 发到前端,
        // 让 `handleMemoDeleted` 的 `memos.filter(m => m.id !== "")` 一条都
        // 过滤不掉 -> 幽灵笔记。
        //
        // 修法: **在 `unregister_memo_by_path` 之前**按 filename 反查 memo index
        // 拿到真实 id。`unregister_memo_by_path` 内部就是用同一 filename 匹配 + 删
        // entry, 所以这里查到的 id 跟它即将删的那条是同一条, 不存在 race -- 都是
        // 走 `current_index_io` 锁串行化, 内部只读 + 写 memo index 一次。
        //
        // 拿不到 id 的两种情形:
        // - 路径里没有合法的 .md 文件名 (如 `..`): 直接放弃 emit, 反正
        //   `unregister_memo_by_path` 也会 return false, memo index 没动。
        // - filename 不在 memo index (孤立 .md / 已经被删过): 同样放弃 emit, 不凭空
        //   generate id, 保持 id 一定来自 memo index 这个不变量。
        let Some(filename) = path.file_name().and_then(|n| n.to_str()) else {
            return;
        };
        let Some(memo) = mf.find_memo_by_filename_for_notebook_id(&ctx.notebook_id, filename)
        else {
            tracing::debug!(
                "[MemoWatcher] unregister_and_emit: no memo index entry for filename={}, skipping emit (unregister will also no-op)",
                filename
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
        // emit 带真实 id 的 Deleted, 让前端 handleMemoDeleted 能精准从
        // 列表 filter 掉 (避免 id=“” 时 filter 什么都不丢、只能靠
        // triggerRefresh 重拉补救)。 path 依然传出, 供会话点以 path 匹配。
        emit(
            app,
            MemoEvent::Deleted {
                id,
                path: entry_path,
                notebook_id: ctx.notebook_id.clone(),
                derived_changed,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    //! 覆盖 `dispatch_modify_event` 纯函数的两种分流路径。
    //!
    //! 不依赖 Tauri AppHandle / MemoWatcher / inode tracker ── 拿 MemoFile
    //! 直接调纯函数, 断言 emit 出来的事件 kind/path/memo 字段。
    //!
    //! setup pattern 跟 flowix-core 的 `fresh_memo_file` 一致: tempdir +
    //! seed notebook registry + MemoFile::new。

    use super::*;
    use flowix_core::memo_file::MemoFile;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// 构造一个指向 tempdir 的 MemoFile, tempdir 模拟 "default notebook"。
    fn fresh_memo_file() -> (MemoFile, PathBuf) {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let tmp = std::env::temp_dir().join(format!(
            "flowix-watcher-processor-test-{}-{}-{}",
            std::process::id(),
            n,
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let app_data = tmp.join("app_data");
        let config_dir = tmp.join("config");
        fs::create_dir_all(&app_data).unwrap();
        fs::create_dir_all(&config_dir).unwrap();

        let memo_file = MemoFile::new(config_dir);
        // 把测试 fixture 的 nb_test 写进 SQLite ── 没有这条, register_existing_file
        // 走 memo index sync 时撞 `memos.notebook_id` -> `notebooks.id` 的
        // FOREIGN KEY 失败 (FOREIGN KEY constraint failed)。
        // 不调 set_current_notebook 的话, get_memo_base 走默认路径
        // (~/Documents/flowix) ── register_existing_file / write_index
        // 会写到那个目录, 我们的 tempdir 测试 fixture 失效。
        let cfg = flowix_core::memo_file::NotebookConfig {
            id: "nb_test".to_string(),
            name: "Test".to_string(),
            icon: None,
            path: format!("{}/", tmp.display()),
            is_default: true,
            created_at: 0,
            updated_at: 0,
        };
        let mut memo_file = memo_file;
        memo_file.write_notebook_configs(&[cfg]).unwrap();
        memo_file.set_current_notebook(Some("nb_test".to_string()));
        (memo_file, tmp)
    }

    fn watch_ctx(base: &Path) -> NotebookWatchContext {
        NotebookWatchContext {
            notebook_id: "nb_test".to_string(),
            root: base.to_path_buf(),
        }
    }

    /// 写一个 .md 到 notebook 根目录, 走 register_existing_file 把它登记
    /// 进 memo index。返回 (memo, abs_path)。
    fn seed_registered_md(mf: &MemoFile, base: &PathBuf, title: &str) -> (String, PathBuf) {
        let filename = format!("{title}.md");
        let path = base.join(&filename);
        fs::write(
            &path,
            format!("---\ntitle: {title}\n---\n# {title}\n\ninitial body\n"),
        )
        .unwrap();
        // register_existing_file 自己生成 id, 这里只关心 filename
        let _memo = mf.register_existing_file(&path).expect("register ok");
        (filename, path)
    }

    #[test]
    fn dispatch_modify_event_emits_updated_for_registered_file() {
        // (1) 准备: 临时 notebook + 一个已注册 .md
        let (mf, base) = fresh_memo_file();
        let (filename, path) = seed_registered_md(&mf, &base, "Hello");

        // (2) 模拟"vim 改 body": 覆写磁盘
        fs::write(&path, format!("# Hello\n\nexternal edit content\n")).unwrap();

        // (3) 调 dispatch_modify_event, 期望 Updated
        let outcome = dispatch_modify_event(&mf, &watch_ctx(&base), &path).expect("dispatch ok");
        let event = match outcome {
            DispatchOutcome::Updated(e) => e,
            DispatchOutcome::Created { .. } => panic!("expected Updated, got Created"),
        };

        // (4) 断言事件字段
        match event {
            MemoEvent::Updated {
                id,
                path: ep,
                memo,
                source,
                ..
            } => {
                assert!(!id.is_empty(), "id should not be empty");
                let expected_path = mf
                    .get_memo_base()
                    .join(&memo.filename)
                    .display()
                    .to_string();
                assert_eq!(ep, expected_path, "path should equal base+filename");
                assert_eq!(memo.filename, filename);
                // preview 来自新 body 的派生
                assert!(
                    memo.preview.contains("external edit content"),
                    "preview should reflect new body, got: {}",
                    memo.preview
                );
                assert!(matches!(source, MemoChangeSource::ExternalTool));
            }
            other => panic!("expected Updated, got {:?}", std::mem::discriminant(&other)),
        }
    }

    #[test]
    fn dispatch_modify_event_emits_created_for_unregistered_file() {
        // (1) 准备: 临时 notebook, **不**注册任何 .md
        let (mf, base) = fresh_memo_file();
        let filename = "Stranger.md";
        let path = base.join(filename);
        fs::write(&path, "# Stranger\n\nnew file content\n").unwrap();

        // (2) 调 dispatch_modify_event, 期望 Created + new_abs_path
        let outcome = dispatch_modify_event(&mf, &watch_ctx(&base), &path).expect("dispatch ok");
        let (event, new_abs_path) = match outcome {
            DispatchOutcome::Updated(_) => panic!("expected Created, got Updated"),
            DispatchOutcome::Created {
                event,
                new_abs_path,
            } => (event, new_abs_path),
        };

        match event {
            MemoEvent::Created { memo, source, .. } => {
                assert!(!memo.id.is_empty(), "id should be generated");
                assert_eq!(memo.filename, filename);
                assert!(matches!(source, MemoChangeSource::ExternalTool));
            }
            other => panic!("expected Created, got {:?}", std::mem::discriminant(&other)),
        }
        // register_existing_file_for_notebook_id 走 generate-new-id + stamp 路径,
        // new_abs_path 跟原 path 不一定相同
        assert!(
            new_abs_path.exists(),
            "registered file should exist on disk"
        );
    }

    #[test]
    fn dispatch_modify_event_updated_preserves_id_across_external_edit() {
        // 关键不变量: 外部改 body 后, memo index 里这条 entry 的 id 不会变
        // (id 在 register_existing_file 时生成, 后续 reload 只动 preview/
        // tags/todos/updated_at)。
        let (mf, base) = fresh_memo_file();
        let (_, path) = seed_registered_md(&mf, &base, "Note");

        // 第一次 dispatch: 拿到 id
        let e1 = match dispatch_modify_event(&mf, &watch_ctx(&base), &path).unwrap() {
            DispatchOutcome::Updated(e) => e,
            _ => panic!("expected Updated"),
        };
        let id1 = match e1 {
            MemoEvent::Updated { id, .. } => id,
            _ => unreachable!(),
        };

        // 模拟第二次外部改
        fs::write(&path, "# Note\n\nsecond edit\n").unwrap();
        let e2 = match dispatch_modify_event(&mf, &watch_ctx(&base), &path).unwrap() {
            DispatchOutcome::Updated(e) => e,
            _ => panic!("expected Updated on second dispatch"),
        };
        let id2 = match e2 {
            MemoEvent::Updated { id, .. } => id,
            _ => unreachable!(),
        };

        assert_eq!(id1, id2, "id must be stable across external body edits");
    }

    /// 回归: 物理删除时, `unregister_and_emit` 必须能从 memo index 查到真实 id
    /// 注入到 `MemoEvent::Deleted` 里。物理文件名是 `<title>.md` (id 跟
    /// 文件名解耦), emit `id=""` 给前端 → `memos.filter(m => m.id !== "")`
    /// 一条都过滤不掉 → 幽灵笔记。这里直接验证修复后的核心查找逻辑:
    /// "按 filename 找 memo index entry, 拿到的 id 跟 register 时生成的 id 一致"。
    #[test]
    fn physical_delete_resolves_real_id_from_index() {
        let (mf, base) = fresh_memo_file();
        let (filename, path) = seed_registered_md(&mf, &base, "Ghost");

        // 修复前: id=""
        // 修复后: id 应该是 memo index 里这条 entry 的真实 id
        let memo = mf
            .find_memo_by_filename(&filename)
            .expect("seeded entry should be in memo index");
        let real_id = memo.id.clone();

        assert!(
            !real_id.is_empty(),
            "register_existing_file should have generated a non-empty id; got empty"
        );
        // 文件名 (v3) 跟 id 解耦, 这条不变量是回归核心: 删除事件里
        // 必须带 memo index 的 id, 而不是从 filename 里硬猜
        assert_ne!(real_id, filename, "v3 id must be decoupled from filename");
        // 路径存在 + 跟 base join 起来等于 expected_abs (unregister_memo_by_path
        // 内部就是这个 invariant guard 通过后才删 entry)
        assert!(
            path.exists(),
            "seeded .md should still be on disk for this test"
        );
        let expected_abs = base.join(&memo.filename);
        assert_eq!(
            expected_abs.canonicalize().ok(),
            path.canonicalize().ok(),
            "abs path should round-trip through base + filename"
        );
    }

    /// 边界: 一个**未登记**的 .md 被物理删除 (用户误删了未注册文件, 或
    /// 我们刚 register 完就删了), `unregister_and_emit` 应当**不**emit
    /// `MemoEvent::Deleted` (id 拿不到),也不动 memo index。
    #[test]
    fn physical_delete_for_unregistered_file_is_noop() {
        let (mf, base) = fresh_memo_file();
        let filename = "Stray.md";
        let path = base.join(filename);
        fs::write(&path, "# Stray\n").unwrap();

        // 模拟 unregister_and_emit 的 id 查找前置段: filename 不在 memo index
        let looked_up = mf.find_memo_by_filename(filename);
        assert!(
            looked_up.is_none(),
            "unregistered .md must not resolve to a memo index entry"
        );

        // 模拟 unregister 段: 同样 no-op
        let removed = mf.unregister_memo_by_path(&path);
        assert!(!removed, "unregister must return false for unknown file");
    }

    // ====== Frontmatter-key-first 分流：rename via disk key ======
    //
    // 复现 GUI 标题编辑的代码路径：fs::rename(OLD → NEW) 后,
    // SELF_WRITE_SUPPRESSOR 吞了 From 事件, To 事件进入 dispatch_modify_event。
    // 关键断言: 磁盘 frontmatter key (跨 rename 保留) → 命中 OLD entry →
    // rename_memo_file 改 entry.filename, id 不变, created_at 不变。
    //
    // 这个测试不依赖 Tauri AppHandle / notify / SelfWriteSuppressor — 直接
    // 喂一个 Create 事件形态的 path 给 dispatch_modify_event, 模拟 GUI 路径
    // 走到 processor 时的入参。
    #[test]
    fn dispatch_modify_event_detects_rename_via_frontmatter_key() {
        let (mf, base) = fresh_memo_file();
        let (filename, old_path) = seed_registered_md(&mf, &base, "Original");

        // 抓原始 entry 的 id / timestamps
        let original = mf
            .find_memo_by_filename(&filename)
            .expect("seeded entry should exist");
        let original_id = original.id.clone();
        let original_created = original.created_at;
        let original_updated = original.updated_at;

        // 物理 rename ── 跟 GUI write_memo_renaming_on_title_change 一样,
        // frontmatter key 跟着文件走 (fs::rename 是 metadata-only 操作,
        // 文件内容不变, frontmatter 块的 key 字段保留)
        let new_filename = "Renamed.md".to_string();
        let new_path = base.join(&new_filename);
        std::fs::rename(&old_path, &new_path).expect("physical rename must succeed");

        // 喂 To 事件形态: dispatch_modify_event 读磁盘 → 抽 key → 反查 entry
        let outcome =
            dispatch_modify_event(&mf, &watch_ctx(&base), &new_path).expect("dispatch ok");
        let event = match outcome {
            DispatchOutcome::Updated(e) => e,
            DispatchOutcome::Created { .. } => {
                panic!("expected Updated (rename via key), got Created")
            }
        };

        match event {
            MemoEvent::Updated {
                id,
                path,
                memo,
                source,
                ..
            } => {
                // 关键不变量 ── id 跨 rename 保留
                assert_eq!(
                    id, original_id,
                    "id must be preserved across rename detected via frontmatter key"
                );
                assert_eq!(
                    memo.id, original_id,
                    "memo.id must match memo index entry id"
                );
                // filename 改成磁盘实际文件名
                assert_eq!(
                    memo.filename, new_filename,
                    "filename must reflect post-rename disk state"
                );
                // path 是新位置 (rename 后的绝对路径)
                assert_eq!(
                    path,
                    new_path.display().to_string(),
                    "emit path must be the post-rename abs path"
                );
                // created_at 保留 ── rename_memo_file 不动 created_at
                assert_eq!(
                    memo.created_at, original_created,
                    "created_at must be preserved (rename_memo_file leaves it alone)"
                );
                // updated_at 刷新 ── rename 本身算一次更新
                assert!(
                    memo.updated_at >= original_updated,
                    "updated_at should be refreshed on rename"
                );
                assert!(matches!(source, MemoChangeSource::ExternalTool));
            }
            other => panic!("expected Updated, got {:?}", std::mem::discriminant(&other)),
        }

        // 收尾: memo index 的 entry.filename 真的更新了
        let entry_after = mf
            .find_memo_by_filename(&new_filename)
            .expect("new filename should be in memo index after rename");
        assert_eq!(
            entry_after.id, original_id,
            "memo index entry's id must be preserved"
        );
        // 旧 filename 应该已经不在 memo index
        assert!(
            mf.find_memo_by_filename(&filename).is_none(),
            "old filename must be removed from memo index after rename"
        );

        // 清理
        std::fs::rename(&new_path, &old_path).ok();
    }

    #[test]
    fn dispatch_modify_event_rekeys_pasted_duplicate_when_original_still_exists() {
        let (mf, base) = fresh_memo_file();
        let (original_filename, original_path) = seed_registered_md(&mf, &base, "Original");
        let original = mf
            .find_memo_by_filename(&original_filename)
            .expect("seeded entry should exist");
        let original_id = original.id.clone();

        let pasted_filename = "Original Copy.md".to_string();
        let pasted_path = base.join(&pasted_filename);
        std::fs::copy(&original_path, &pasted_path).expect("copy should succeed");

        let outcome =
            dispatch_modify_event(&mf, &watch_ctx(&base), &pasted_path).expect("dispatch ok");
        let memo = match outcome {
            DispatchOutcome::Created {
                event: MemoEvent::Created { memo, .. },
                ..
            } => memo,
            DispatchOutcome::Updated(_) => panic!("pasted duplicate must emit Created"),
            DispatchOutcome::Created { event, .. } => {
                panic!("expected Created memo event, got {event:?}")
            }
        };

        assert_ne!(memo.id, original_id, "pasted copy must get a fresh id");
        assert_eq!(memo.filename, pasted_filename);
        assert_eq!(
            mf.read_current_memo(&original_id).unwrap().filename,
            original_filename,
            "original memo entry must not be moved"
        );
        let pasted_content = std::fs::read_to_string(&pasted_path).unwrap();
        assert_eq!(extract_frontmatter_key(&pasted_content), Some(memo.id));
    }

    // ====== Frontmatter-key-first 分流：(c) case ======
    //
    // 模拟"memo index 已经被前序事件清掉, 磁盘 key 还在" ── 比如外部
    // rename 走 From + To 两条事件, From 进了 unregister_and_emit 删了
    // entry, To 进 dispatch_modify_event 此时 read_memo(key) 返回 None。
    // 当前粘贴语义: 带 key 的陌生文件也按新文档注册, 并把磁盘 key 刷新成新 id。
    #[test]
    fn dispatch_modify_event_rekeys_orphan_disk_key_as_new_document() {
        let (mf, base) = fresh_memo_file();

        // 直接造一个 .md 带 frontmatter key 但 memo index 里没记录的"孤儿"
        let orphan_filename = "Orphan.md".to_string();
        let orphan_path = base.join(&orphan_filename);
        let orphan_id = "abc123";
        std::fs::write(
            &orphan_path,
            format!("---\nkey: {orphan_id}\n---\n# Orphan\n\nbody content\n"),
        )
        .unwrap();

        // 模拟 read_memo 返回 None 的状态 ── memo index 干净
        assert!(mf.read_current_memo(orphan_id).is_none());

        // dispatch: 应创建新 memo, 不沿用磁盘旧 key
        let outcome =
            dispatch_modify_event(&mf, &watch_ctx(&base), &orphan_path).expect("dispatch ok");
        let memo = match outcome {
            DispatchOutcome::Created {
                event: MemoEvent::Created { memo, .. },
                ..
            } => memo,
            other => panic!("expected Created via (c) path, got {other:?}"),
        };

        assert_ne!(memo.id, orphan_id, "pasted file must get a fresh id");
        assert_eq!(memo.filename, orphan_filename);

        // 收尾: memo index 真的有这条 entry
        assert!(
            mf.read_current_memo(orphan_id).is_none(),
            "old disk key must not be registered in this notebook"
        );
        let entry = mf
            .read_current_memo(&memo.id)
            .expect("fresh id should now be in memo index");
        assert_eq!(entry.id, memo.id);
        let stamped = std::fs::read_to_string(&orphan_path).unwrap();
        assert_eq!(extract_frontmatter_key(&stamped), Some(memo.id));
    }

    // ====== GUI 标题编辑全链路：SelfWriteSuppressor + dispatch 协作 ======
    //
    // 模拟 write_memo_renaming_on_title_change 流程:
    //   1. mark_self_write(OLD) ── 把 OLD 路径塞抑制表
    //   2. fs::rename(OLD → NEW) ── 触发 notify From(OLD) + To(NEW)
    //   3. notify 回调 → filter pipeline:
    //      - From(OLD) → SelfWriteSuppressor 命中 → 吞掉 ✓
    //      - To(NEW)   → SelfWriteSuppressor miss → 进 processor
    //   4. processor 走 frontmatter-key-first 分流:
    //      - 读磁盘 → 抽 key = id (frontmatter 跟着 fs::rename 走)
    //      - read_memo(id) → Some (entry 没被删, From 被吞了)
    //      - existing.filename != current filename → (a) 分支
    //      - rename_memo_file(OLD, NEW) → entry.filename 改, id 保留
    //
    // 关键 invariant: id 跨 rename 保留, created_at 不变, updated_at 刷新。
    // 这是用户报告的 bug 的核心 ── 之前 Windows 上因 inode_tracker 留空,
    // dispatch_modify_event 走 filename-based 路径, 把 entry 当"新文件"
    // 重新注册, id 漂移 / createdAt 重置。
    //
    // 这个测试**不依赖 Tauri AppHandle / 真实 notify** ── 直接调
    // SelfWriteSuppressor + dispatch_modify_event, 验证两条事件流入
    // processor 后, dispatch 的输出是正确的 rename_memo_file 调用。
    #[test]
    fn gui_title_edit_full_pipeline_preserves_id_and_timestamps() {
        use crate::watcher::filter::{run_pipeline, PathFilter};
        use crate::watcher::path::normalize_for_compare;
        use crate::watcher::whitelist::WhitelistConfig;
        use std::path::PathBuf;
        use std::time::Instant;

        let (mf, base) = fresh_memo_file();
        let (filename, old_path) = seed_registered_md(&mf, &base, "Original");

        // 抓原始 entry 的 id / created_at / updated_at
        let original = mf
            .find_memo_by_filename(&filename)
            .expect("seeded entry should exist");
        let original_id = original.id.clone();
        let original_created = original.created_at;
        let original_updated = original.updated_at;

        // ====== Step 1: GUI 写盘前 mark_self_write(OLD) ======
        let recent = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::<
            PathBuf,
            Instant,
        >::new()));
        recent
            .lock()
            .unwrap()
            .insert(normalize_for_compare(&old_path), Instant::now());

        // ====== Step 2: fs::rename(OLD → NEW) ── 物理重命名 ======
        let new_filename = "Renamed.md".to_string();
        let new_path = base.join(&new_filename);
        std::fs::rename(&old_path, &new_path).expect("physical rename must succeed");

        // ====== Step 3a: 模拟 notify From(OLD) 事件进入 filter pipeline ======
        let whitelist =
            std::sync::Arc::new(std::sync::RwLock::new(WhitelistConfig::load_or_default()));
        let path_filter = PathFilter {
            whitelist: whitelist.clone(),
        };
        let last_emit = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::<
            PathBuf,
            Instant,
        >::new()));
        let from_event = RawFsEvent::new(FsEventKind::Remove, old_path.clone());
        let from_decision = run_pipeline(&from_event, &recent, &last_emit, &path_filter);
        assert!(
            matches!(
                from_decision,
                crate::watcher::event::FilterDecision::Drop {
                    reason: crate::watcher::event::DropReason::SelfWriteSuppressed
                }
            ),
            "From(OLD) must be suppressed by SelfWriteSuppressor (GUI marked OLD)"
        );

        // ====== Step 3b: 模拟 notify To(NEW) 事件进入 filter pipeline ======
        let to_event = RawFsEvent::new(FsEventKind::Create, new_path.clone());
        let to_decision = run_pipeline(&to_event, &recent, &last_emit, &path_filter);
        assert!(
            matches!(to_decision, crate::watcher::event::FilterDecision::Pass),
            "To(NEW) must pass through filter pipeline (NEW was not marked)"
        );

        // ====== Step 4: processor dispatch_modify_event(NEW) ── 走 (a) 分支 ======
        let outcome =
            dispatch_modify_event(&mf, &watch_ctx(&base), &new_path).expect("dispatch ok");
        let event = match outcome {
            DispatchOutcome::Updated(e) => e,
            DispatchOutcome::Created { .. } => {
                panic!("GUI rename must emit Updated (rename detected via disk key), not Created")
            }
        };

        match event {
            MemoEvent::Updated {
                id,
                path,
                memo,
                source: _,
                ..
            } => {
                assert_eq!(id, original_id, "id must be preserved across GUI rename");
                assert_eq!(memo.id, original_id);
                assert_eq!(
                    memo.filename, new_filename,
                    "filename must reflect post-rename disk state"
                );
                assert_eq!(
                    path,
                    new_path.display().to_string(),
                    "emit path must be the post-rename abs path"
                );
                assert_eq!(
                    memo.created_at, original_created,
                    "created_at must be preserved (rename_memo_file leaves it alone)"
                );
                assert!(
                    memo.updated_at >= original_updated,
                    "updated_at should be refreshed on rename"
                );
            }
            other => panic!("expected Updated, got {:?}", std::mem::discriminant(&other)),
        }

        // ====== 收尾：memo index entry 状态 ======
        let entry_after = mf
            .find_memo_by_filename(&new_filename)
            .expect("new filename should be in memo index after rename");
        assert_eq!(entry_after.id, original_id);
        assert!(
            mf.find_memo_by_filename(&filename).is_none(),
            "old filename must be removed from memo index after rename"
        );

        // 清理: 把文件挪回去避免污染其他测试
        std::fs::rename(&new_path, &old_path).ok();
    }

    #[test]
    fn dispatch_modify_event_emits_updated_when_index_already_renamed() {
        let (mf, base) = fresh_memo_file();
        let (filename, old_path) = seed_registered_md(&mf, &base, "Original");
        let original = mf
            .find_memo_by_filename(&filename)
            .expect("seeded entry should exist");
        let original_id = original.id.clone();
        let original_created = original.created_at;

        let new_filename = "Renamed Already Indexed.md".to_string();
        let new_path = base.join(&new_filename);
        std::fs::rename(&old_path, &new_path).expect("physical rename must succeed");

        // Simulate the internal save path winning the race and updating the index
        // before the watcher processes the new-path event.
        let synced = mf
            .sync_memo_filename_from_disk_key(&original_id, &new_path)
            .expect("pre-sync should succeed");
        assert_eq!(synced.filename, new_filename);

        let outcome =
            dispatch_modify_event(&mf, &watch_ctx(&base), &new_path).expect("dispatch ok");
        let event = match outcome {
            DispatchOutcome::Updated(event) => event,
            DispatchOutcome::Created { .. } => {
                panic!("already-indexed rename must still emit Updated")
            }
        };

        match event {
            MemoEvent::Updated { id, path, memo, .. } => {
                assert_eq!(id, original_id);
                assert_eq!(memo.id, original_id);
                assert_eq!(memo.filename, new_filename);
                assert_eq!(memo.created_at, original_created);
                assert_eq!(
                    crate::watcher::path::normalize_for_compare(std::path::Path::new(&path)),
                    crate::watcher::path::normalize_for_compare(&new_path)
                );
            }
            other => panic!("expected Updated, got {:?}", std::mem::discriminant(&other)),
        }
    }
}
