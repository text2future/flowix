//! `MemoEventProcessor` 鈥?鎶?`RawFsEvent` 杞垚 `MemoEvent` 骞?emit銆?//!
//! watcher manager 涓嶇洿鎺ヨ皟 `MemoFile` 鐨?register / reload / unregister,
//! 缁熶竴濮旀淳缁欐湰妯″潡銆俻ipeline 璺戣繃涔嬪悗, 鎶?`RawFsEvent` 鍠傜粰
//! `MemoEventProcessor::process`, 瀹冪湅 event.kind 鍒嗘淳, 璧?register_unnamed /
//! reload / unregister, 鏈€鍚?emit `MemoEvent` (璧?dispatcher 鎶借薄, 澶?channel
//! 鍚庣画鍦ㄨ繖閲?extend)銆?//!
//! `process` 鏄悓姝ョ殑: 鎷垮埌浜嬩欢 鈫?鍚屾鏀?//! `MemoFile` (Arc<RwLock>) 鈫?鍚屾 emit 鈫?杩斿洖銆俷otify 鍥炶皟绾跨▼涓?await銆?
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

/// 涓氬姟澶勭悊鍣?鈥?鐘舵€佺敱璋冪敤鏂规敞鍏?(memo_file / app)銆?///
/// 鏁呮剰涓嶅仛鎴?struct 鎸佸瓧娈? 鑰屾槸 stateless: `process` 鎺ユ敹鎵€鏈変緷璧栥€傚師鍥?
/// manager 鐨?notify 鍥炶皟闂寘宸茬粡鏄?`move |res| { ... }`, 闂寘鎹曡幏
/// Arc<MemoFile> / AppHandle 寮曠敤, 涓嶉渶瑕?processor 鍐呴儴鍐嶆寔涓€浠姐€?
pub struct MemoEventProcessor;

/// 绾嚱鏁板垎娴佺粨鏋? dispatcher 鍐冲畾瑕?emit 鍝釜浜嬩欢 + 闄勫甫鐨勫壇浣滅敤鏁版嵁銆?
#[derive(Debug)]
pub(crate) enum DispatchOutcome {
    /// 璧?Updated 璺緞, 鏃犲壇浣滅敤
    Updated(MemoEvent),
    /// 璧?Created 璺緞, 闇€瑕?caller 璋?mark_self_write(new_abs_path) 鎶戝埗
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

/// Frontmatter-key-first 鍒嗘祦: 缁欎竴涓?Create/Modify 浜嬩欢鐨?abs path,
/// 鍐冲畾 emit 鍝 MemoEvent銆?///
/// **纾佺洏 frontmatter 鐨?`key` 瀛楁鏄?id 鐪熸簮**, 鏂囦欢鍚嶆槸娲剧敓灞炴€с€傝纾佺洏 鈫?/// 鎶?key 鈫?鍦?memo index 閲屾寜 id 鍙嶆煡, 鍛戒腑鍗崇敤 key 瀵瑰簲鐨?entry; 涓嶅懡涓?/// 鎵嶉€€鍥?filename 鍏滃簳銆?///
/// 杩欐牱鍋氱殑鏍稿績鏀剁泭: rename 鍚?fs::rename 鎷嗘垚鐨?From + To 涓ゆ潯浜嬩欢, To 浜嬩欢
/// 璇诲埌鐨?frontmatter key 璺熸棫 entry 鐨?id 涓€鑷?鈫?鍛戒腑 鈫?璧?`rename_memo_file`
/// 鏀?entry.filename, id 淇濈暀銆傚畬鍏ㄤ笉闇€瑕?inode_tracker / file_index 杩欎簺 OS 灞?/// 鍏冩暟鎹? 鍦?NTFS / FAT32 / exFAT / 缃戠粶鐩?/ symlink 涓婅涓轰竴鑷淬€?///
/// 鍒嗘祦瑙勫垯 (鎸?disk key + memo index 鐘舵€?:
/// - key 鍛戒腑 + filename 涓€鑷? reload (閲嶆淳鐢?preview/tags/todos)
/// - key 鍛戒腑 + filename 涓嶄竴鑷?+ old file 宸蹭笉瀛樺湪: physical rename, 淇濈暀 id
/// - key 鍛戒腑 + filename 涓嶄竴鑷?+ old file 浠嶅瓨鍦? pasted duplicate, 鏂板缓 memo 骞跺埛鏂?key
/// - key 涓嶅湪褰撳墠 memo index: pasted/imported markdown, 鏂板缓 memo 骞跺埛鏂?key
/// - 鏃?key + filename 鍦?memo index: reload (淇濈暀 id/filename, 鐢ㄦ埛淇濆瓨鏃朵細娉ㄥ叆 key)
/// - 鏃?key + filename 涓嶅湪: register (鐢熸垚鏂?id, 閫氳繃 merge_frontmatter 娉ㄥ叆)
///
/// 浠?`process()` 鎶藉嚭鏉ュソ鍋氬崟娴?(process 鏈韩渚濊禆 AppHandle, 涓嶆槗娴?;
/// 鍒嗘祦瑙勫垯鍙窡 MemoFile 鐘舵€佹湁鍏? 璺?Tauri 瑙ｈ€︺€?
pub(crate) fn dispatch_modify_event(
    memo_file: &MemoFile,
    ctx: &NotebookWatchContext,
    path: &Path,
    _event_kind: FsEventKind,
) -> Result<DispatchOutcome, String> {
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("invalid path: {}", path.display()))?
        .to_string();

    // 璇荤鐩樻娊 frontmatter key 鈹€鈹€ id 鐪熸簮銆傝澶辫触 (鏉冮檺 / 涓存椂娑堝け) 閫€鍥?    // filename-based 鍏滃簳, 琛屼负绛夊悓鏈?refactor 鍓嶃€?
    let disk_key = std::fs::read_to_string(path)
        .ok()
        .and_then(|c| extract_frontmatter_key(&c));

    match disk_key {
        Some(id) => match read_indexed_memo_after_external_marker(memo_file, &ctx.notebook_id, &id)
        {
            Some(existing) if existing.filename == filename => {
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
                        &filename,
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
                    reload_existing_memo(memo_file, ctx, &filename)
                }
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
            // Disk 鏃?frontmatter key: 涓嶈兘鐢?id 鍙嶆煡, 閫€鍒?filename-based銆?
            if memo_file
                .find_memo_by_filename_for_notebook_id(&ctx.notebook_id, &filename)
                .is_some()
            {
                reload_existing_memo(memo_file, ctx, &filename)
            } else {
                // 鏂版枃浠舵棤 key: register_existing_file_for_notebook_id 璧?generate-new-id + stamp 璺緞
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

/// path 鏄惁鍦ㄥ綋鍓?notebook 鐨?`attachments/` 鐩綍涓? 杩欏眰鍒ゆ柇鐙珛浜?/// [`crate::watcher::WhitelistConfig`], 鍥犱负 whitelist 鍙 preference.json
/// 瑕嗙洊, 鐢ㄦ埛鐨勬棫閰嶇疆鍙兘婕忛厤 `attachments`. processor 鍦ㄥ叆鍙ｈ蛋杩欓亾闃茬嚎,
/// 鎶?attachments/ 涓嬬殑浠讳綍 .md 鏂囦欢 (鏃犺鏄笉鏄澶嶅埗杩涙潵鐨勫彟涓€鍙扮瑪璁版湰
/// 鐨勭瑪璁? 閮界洿鎺ユ嫆鎺? 閬垮厤"骞界伒绗旇"姹℃煋 memo 鍒楄〃.
///
/// 璧?[`crate::watcher::path::normalize_for_compare`] 鑰屼笉鏄８ `starts_with`:
/// - canonicalize 浠讳竴杈瑰け璐ラ兘閫€鍒?鐖剁洰褰?canonicalize + join"鍥為€€璺緞,
///   鏂囦欢鍒氬啓鐩樹絾 fs 鍏冩暟鎹湭灏辩华鏃朵粛鑳界粰鍑烘纭瓟妗?/// - 鍚屼竴浠?normalize 璺?watcher 鎶戝埗琛?(`SelfWriteSuppressor` /
///   `Debouncer`) 鍙ｅ緞涓€鑷? 閬垮厤鍗婄姸鎬佽矾寰?(canonical vs 闈?canonical)
///   缁曡繃杩欓亾闃茬嚎
/// - 涓嶅啀鐢?component-level 鍖归厤 (`parent.file_name == "attachments"`),
///   閭ｇ鍖归厤浼氳鏉€ `bar/attachments/foo.md` 杩欑"宓屽鍚屽悕瀛愮洰褰?璺緞.
fn is_under_attachments_dir(ctx: &NotebookWatchContext, path: &Path) -> bool {
    let attachments_dir =
        crate::watcher::path::normalize_for_compare(&ctx.root.join("attachments"));
    let path_norm = crate::watcher::path::normalize_for_compare(path);
    path_norm.starts_with(&attachments_dir)
}

/// Memo files live directly under the notebook root. The watcher itself is
/// recursive because it also observes notebook-owned auxiliary directories,
/// but Markdown files below arbitrary subdirectories are regular documents,
/// not memos, and must never be registered in the memo index.
fn is_direct_notebook_child(ctx: &NotebookWatchContext, path: &Path) -> bool {
    let root = crate::watcher::path::normalize_for_compare(&ctx.root);
    let path = crate::watcher::path::normalize_for_compare(path);
    path.parent().is_some_and(|parent| parent == root)
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

/// 鍚?[`emit_updated`] 浣嗚矾寰勭敤浜嬩欢鍘熷 path (rename 鍦烘櫙涓嬫槸鏂颁綅缃殑缁濆璺緞)銆?
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
    /// 鍏ュ彛 鈥?pipeline 璺戣繃涔嬪悗璋冪敤, 浜嬩欢宸查€氳繃 filter銆?    ///
    /// 琛屼负:
    /// - Create/Modify: 鏂囦欢瀛樺湪 鈫?key-first 鍒嗘祦; 涓嶅瓨鍦?鈫?unregister
    /// - Remove:        unregister (鎸?filename 鏌?memo index, 鍛戒腑鍒? 娌″懡涓?no-op)
    /// - Other:         蹇界暐
    pub fn process(
        event: &RawFsEvent,
        app: &AppHandle,
        memo_file: &Arc<std::sync::RwLock<MemoFile>>,
        ctx: &NotebookWatchContext,
    ) {
        if !is_direct_notebook_child(ctx, &event.path) {
            tracing::debug!(
                "[MemoWatcher] processor skipped non-root Markdown path: {}",
                event.path.display()
            );
            return;
        }

        // 闃插尽鎬ф嫤鎴? 闄勪欢鐩綍涓嬬殑 .md 鏂囦欢涓嶆槸 memo, 涓€寰嬩笉澶勭悊.
        // 鍚庣 `save_attachment` / `save_attachment_content` 浼氭妸浠绘剰琚€?        // 涓殑鏂囦欢澶嶅埗鍒?`<notebook>/attachments/`, 鍖呮嫭鐢ㄦ埛閫変簡鍙︿竴涓?        // notebook 鐨勭瑪璁?.md 鈥?杩欑鎯呭喌 attachment 鐩綍閲屼細鍑虹幇涓€浠?        // 涓嶈鍑虹幇鍦?memo 鍒楄〃閲岀殑"骞界伒绗旇".
        //
        // 杩欓亾闃茬嚎鐙珛浜?whitelist (whitelist 鍙兘琚敤鎴风殑 preference.json
        // 瑕嗙洊, 鎴栬€?hot-update 鏈熼棿绐楀彛鐭殏涓嶄竴鑷?, 璧?processor 鍏ュ彛
        // 鎷掓帀, 鏄?create / modify / remove 涓夌 kind 鐨勬渶鍚庝竴閬撻椄銆?
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
                    // Modify 浜嬩欢浣嗘枃浠舵病浜?鈥?璧?Delete 璺緞
                    Self::unregister_and_emit(app, memo_file, ctx, path);
                    return;
                }
                wait_for_markdown_copy_to_settle(path);

                // Frontmatter-key-first 鍒嗘祦 鈹€鈹€ 璇︽儏瑙?[`dispatch_modify_event`]銆?
                let outcome = match memo_file.read() {
                    Ok(mf) => dispatch_modify_event(&mf, ctx, path, event.kind),
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
                // Remove 浜嬩欢鎸?filename 鍒?鈹€鈹€ 娌℃湁 inode_tracker 涔熸棤鎵€璋?
                // - GUI 璺緞涓?SelfWriteSuppressor 宸茬粡鍚炰簡 From 浜嬩欢, 璧颁笉鍒拌繖閲?                // - 澶栭儴 rename 鐨?From 浜嬩欢: 杩?unregister_and_emit, 鍚庤窡鐨?To
                //   浜嬩欢璧?key-first 鍒嗘祦鐨?(c) 鍒嗘敮, 鐢ㄧ鐩?frontmatter key 閲嶅缓
                //   entry, id 淇濈暀 (浣?createdAt/updatedAt 浼氶噸缃垚 now, 鍥犱负
                //   浠庣鐩樿涓嶅埌鍘熷鏃堕棿鎴? 杩欐槸 frontmatter-key-first 鍦ㄥ閮?                //   rename 鍦烘櫙涓嬬浉瀵?inode_tracker 鐨勫彇鑸?
                Self::unregister_and_emit(app, memo_file, ctx, &event.path);
            }
            FsEventKind::Other => {
                // Access / Other 鈥?蹇界暐
            }
        }
    }

    pub(crate) fn unregister_and_emit(
        app: &AppHandle,
        memo_file: &Arc<std::sync::RwLock<MemoFile>>,
        ctx: &NotebookWatchContext,
        path: &Path,
    ) {
        // v2: inode 杩樺湪 tracker 閲岀殑璇? 杩欐槸 rename 鐨勬棫浣嶇疆, 璺宠繃 unregister
        // (璁?Create(new) 璧?rename 閰嶅璺緞)銆?process() 宸茬粡鍏堝仛浜嗕竴娆℃鏌?
        // 杩欓噷鍐?defense-in-depth 涓€娆°€?
        let Ok(mf) = memo_file.read() else {
            return;
        };
        // 鐗╃悊鏂囦欢鍚嶆槸 `<title>.md` (id 璺熸枃浠跺悕瑙ｈ€?, 鏃у疄鐜颁細鎶婄┖ id 鍙戝埌鍓嶇,
        // 璁?`handleMemoDeleted` 鐨?`memos.filter(m => m.id !== "")` 涓€鏉￠兘
        // 杩囨护涓嶆帀 -> 骞界伒绗旇銆?        //
        // 淇硶: **鍦?`unregister_memo_by_path` 涔嬪墠**鎸?filename 鍙嶆煡 memo index
        // 鎷垮埌鐪熷疄 id銆俙unregister_memo_by_path` 鍐呴儴灏辨槸鐢ㄥ悓涓€ filename 鍖归厤 + 鍒?        // entry, 鎵€浠ヨ繖閲屾煡鍒扮殑 id 璺熷畠鍗冲皢鍒犵殑閭ｆ潯鏄悓涓€鏉? 涓嶅瓨鍦?race -- 閮芥槸
        // 璧?`current_index_io` 閿佷覆琛屽寲, 鍐呴儴鍙 + 鍐?memo index 涓€娆°€?        //
        // 鎷夸笉鍒?id 鐨勪袱绉嶆儏褰?
        // - 璺緞閲屾病鏈夊悎娉曠殑 .md 鏂囦欢鍚?(濡?`..`): 鐩存帴鏀惧純 emit, 鍙嶆
        //   `unregister_memo_by_path` 涔熶細 return false, memo index 娌″姩銆?        // - filename 涓嶅湪 memo index (瀛ょ珛 .md / 宸茬粡琚垹杩?: 鍚屾牱鏀惧純 emit, 涓嶅嚟绌?        //   generate id, 淇濇寔 id 涓€瀹氭潵鑷?memo index 杩欎釜涓嶅彉閲忋€?
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
        // emit 甯︾湡瀹?id 鐨?Deleted, 璁╁墠绔?handleMemoDeleted 鑳界簿鍑嗕粠
        // 鍒楄〃 filter 鎺?(閬垮厤 id=鈥溾€?鏃?filter 浠€涔堥兘涓嶄涪銆佸彧鑳介潬
        // triggerRefresh 閲嶆媺琛ユ晳)銆?path 渚濈劧浼犲嚭, 渚涗細璇濈偣浠?path 鍖归厤銆?
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
    //! 瑕嗙洊 `dispatch_modify_event` 绾嚱鏁扮殑涓ょ鍒嗘祦璺緞銆?    //!
    //! 涓嶄緷璧?Tauri AppHandle / MemoWatcher / inode tracker 鈹€鈹€ 鎷?MemoFile
    //! 鐩存帴璋冪函鍑芥暟, 鏂█ emit 鍑烘潵鐨勪簨浠?kind/path/memo 瀛楁銆?    //!
    //! setup pattern 璺?flowix-core 鐨?`fresh_memo_file` 涓€鑷? tempdir +
    //! seed notebook registry + MemoFile::new銆?
    use super::*;
    use flowix_core::memo_file::MemoFile;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// 鏋勯€犱竴涓寚鍚?tempdir 鐨?MemoFile, tempdir 妯℃嫙 "default notebook"銆?
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
        // 鎶婃祴璇?fixture 鐨?nb_test 鍐欒繘 SQLite 鈹€鈹€ 娌℃湁杩欐潯, register_existing_file
        // 璧?memo index sync 鏃舵挒 `memos.notebook_id` -> `notebooks.id` 鐨?        // FOREIGN KEY 澶辫触 (FOREIGN KEY constraint failed)銆?        // 涓嶈皟 set_current_notebook 鐨勮瘽, get_memo_base 璧伴粯璁よ矾寰?        // (~/Documents/flowix) 鈹€鈹€ register_existing_file / write_index
        // 浼氬啓鍒伴偅涓洰褰? 鎴戜滑鐨?tempdir 娴嬭瘯 fixture 澶辨晥銆?
        let cfg = flowix_core::memo_file::NotebookConfig {
            id: "nb_test".to_string(),
            name: "Test".to_string(),
            icon: None,
            path: format!("{}/", tmp.display()),
            is_default: true,
            sort: 0,
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

    #[test]
    fn memo_processing_accepts_only_markdown_directly_under_notebook_root() {
        let (_mf, base) = fresh_memo_file();
        let ctx = watch_ctx(&base);
        let root_memo = base.join("Memo.md");
        let nested_document = base.join("docs").join("Reference.md");
        fs::create_dir_all(nested_document.parent().unwrap()).unwrap();
        fs::write(&root_memo, "# Memo\n").unwrap();
        fs::write(&nested_document, "# Reference\n").unwrap();

        assert!(is_direct_notebook_child(&ctx, &root_memo));
        assert!(!is_direct_notebook_child(&ctx, &nested_document));
    }

    /// 鍐欎竴涓?.md 鍒?notebook 鏍圭洰褰? 璧?register_existing_file 鎶婂畠鐧昏
    /// 杩?memo index銆傝繑鍥?(memo, abs_path)銆?
    fn seed_registered_md(mf: &MemoFile, base: &PathBuf, title: &str) -> (String, PathBuf) {
        let filename = format!("{title}.md");
        let path = base.join(&filename);
        fs::write(
            &path,
            format!("---\ntitle: {title}\n---\n# {title}\n\ninitial body\n"),
        )
        .unwrap();
        // register_existing_file 鑷繁鐢熸垚 id, 杩欓噷鍙叧蹇?filename
        let _memo = mf.register_existing_file(&path).expect("register ok");
        (filename, path)
    }

    #[test]
    fn dispatch_modify_event_emits_updated_for_registered_file() {
        // (1) 鍑嗗: 涓存椂 notebook + 涓€涓凡娉ㄥ唽 .md
        let (mf, base) = fresh_memo_file();
        let (filename, path) = seed_registered_md(&mf, &base, "Hello");

        // (2) 妯℃嫙"vim 鏀?body": 瑕嗗啓纾佺洏
        fs::write(&path, format!("# Hello\n\nexternal edit content\n")).unwrap();

        // (3) 璋?dispatch_modify_event, 鏈熸湜 Updated
        let outcome = dispatch_modify_event(&mf, &watch_ctx(&base), &path, FsEventKind::Modify)
            .expect("dispatch ok");
        let event = match outcome {
            DispatchOutcome::Updated(e) => e,
            DispatchOutcome::Created { .. } => panic!("expected Updated, got Created"),
        };

        // (4) 鏂█浜嬩欢瀛楁
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
                // preview 鏉ヨ嚜鏂?body 鐨勬淳鐢?
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
        // (1) 鍑嗗: 涓存椂 notebook, **涓?*娉ㄥ唽浠讳綍 .md
        let (mf, base) = fresh_memo_file();
        let filename = "Stranger.md";
        let path = base.join(filename);
        fs::write(&path, "# Stranger\n\nnew file content\n").unwrap();

        // (2) 璋?dispatch_modify_event, 鏈熸湜 Created + new_abs_path
        let outcome = dispatch_modify_event(&mf, &watch_ctx(&base), &path, FsEventKind::Create)
            .expect("dispatch ok");
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
        // register_existing_file_for_notebook_id 璧?generate-new-id + stamp 璺緞,
        // new_abs_path 璺熷師 path 涓嶄竴瀹氱浉鍚?
        assert!(
            new_abs_path.exists(),
            "registered file should exist on disk"
        );
    }

    #[test]
    fn dispatch_modify_emits_created_when_mcp_already_wrote_the_shared_index() {
        let (mf, base) = fresh_memo_file();
        // MCP/CLI uses a separate MemoFile instance but performs this same
        // file + shared-index write before Desktop observes the fs event.
        let created = mf
            .create_external_memo_for_notebook_id("nb_test", "MCP note", "# MCP note\n", None)
            .expect("mcp-style create");
        let path = base.join(&created.filename);

        // macOS FSEvents reports MemoFile's atomic temp-file rename at the
        // final markdown path as Modify rather than Create.
        let outcome = dispatch_modify_event(&mf, &watch_ctx(&base), &path, FsEventKind::Modify)
            .expect("dispatch ok");

        match outcome {
            DispatchOutcome::Created {
                event: MemoEvent::Created { memo, source, .. },
                ..
            } => {
                assert_eq!(memo.id, created.id);
                assert!(matches!(source, MemoChangeSource::ExternalTool));
            }
            DispatchOutcome::Updated(_) => {
                panic!("MCP-created memo must stay a Created event")
            }
            DispatchOutcome::Created { event, .. } => {
                panic!("expected Created memo event, got {event:?}")
            }
        }
    }

    #[test]
    fn dispatch_modify_event_updated_preserves_id_across_external_edit() {
        // 鍏抽敭涓嶅彉閲? 澶栭儴鏀?body 鍚? memo index 閲岃繖鏉?entry 鐨?id 涓嶄細鍙?        // (id 鍦?register_existing_file 鏃剁敓鎴? 鍚庣画 reload 鍙姩 preview/
        // tags/todos/updated_at)銆?
        let (mf, base) = fresh_memo_file();
        let (_, path) = seed_registered_md(&mf, &base, "Note");

        let id1 = mf
            .find_memo_by_filename_for_notebook_id("nb_test", "Note.md")
            .expect("seeded memo")
            .id;

        // 妯℃嫙绗簩娆″閮ㄦ敼
        fs::write(&path, "# Note\n\nsecond edit\n").unwrap();
        let e2 = match dispatch_modify_event(&mf, &watch_ctx(&base), &path, FsEventKind::Modify)
            .unwrap()
        {
            DispatchOutcome::Updated(e) => e,
            _ => panic!("expected Updated on second dispatch"),
        };
        let id2 = match e2 {
            MemoEvent::Updated { id, .. } => id,
            _ => unreachable!(),
        };

        assert_eq!(id1, id2, "id must be stable across external body edits");
    }

    #[test]
    fn external_create_marker_is_consumed_once_without_reopening_on_quick_edit() {
        let (mf, base) = fresh_memo_file();
        let created = mf
            .create_external_memo_for_notebook_id("nb_test", "MCP note", "# MCP note\n", None)
            .expect("external create");
        let path = base.join(&created.filename);

        let first = dispatch_modify_event(&mf, &watch_ctx(&base), &path, FsEventKind::Modify)
            .expect("first event");
        assert!(matches!(first, DispatchOutcome::Created { .. }));

        fs::write(&path, "# MCP note\n\nquick external edit\n").unwrap();
        let second = dispatch_modify_event(&mf, &watch_ctx(&base), &path, FsEventKind::Modify)
            .expect("second event");
        assert!(matches!(second, DispatchOutcome::Updated(_)));
    }

    /// 鍥炲綊: 鐗╃悊鍒犻櫎鏃? `unregister_and_emit` 蹇呴』鑳戒粠 memo index 鏌ュ埌鐪熷疄 id
    /// 娉ㄥ叆鍒?`MemoEvent::Deleted` 閲屻€傜墿鐞嗘枃浠跺悕鏄?`<title>.md` (id 璺?    /// 鏂囦欢鍚嶈В鑰?, emit `id=""` 缁欏墠绔?鈫?`memos.filter(m => m.id !== "")`
    /// 涓€鏉￠兘杩囨护涓嶆帀 鈫?骞界伒绗旇銆傝繖閲岀洿鎺ラ獙璇佷慨澶嶅悗鐨勬牳蹇冩煡鎵鹃€昏緫:
    /// "鎸?filename 鎵?memo index entry, 鎷垮埌鐨?id 璺?register 鏃剁敓鎴愮殑 id 涓€鑷?銆?
    #[test]
    fn physical_delete_resolves_real_id_from_index() {
        let (mf, base) = fresh_memo_file();
        let (filename, path) = seed_registered_md(&mf, &base, "Ghost");

        // 淇鍓? id=""
        // 淇鍚? id 搴旇鏄?memo index 閲岃繖鏉?entry 鐨勭湡瀹?id
        let memo = mf
            .find_memo_by_filename(&filename)
            .expect("seeded entry should be in memo index");
        let real_id = memo.id.clone();

        assert!(
            !real_id.is_empty(),
            "register_existing_file should have generated a non-empty id; got empty"
        );
        // 鏂囦欢鍚?(v3) 璺?id 瑙ｈ€? 杩欐潯涓嶅彉閲忔槸鍥炲綊鏍稿績: 鍒犻櫎浜嬩欢閲?        // 蹇呴』甯?memo index 鐨?id, 鑰屼笉鏄粠 filename 閲岀‖鐚?        assert_ne!(real_id, filename, "v3 id must be decoupled from filename");
        // 璺緞瀛樺湪 + 璺?base join 璧锋潵绛変簬 expected_abs (unregister_memo_by_path
        // 鍐呴儴灏辨槸杩欎釜 invariant guard 閫氳繃鍚庢墠鍒?entry)
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

    /// 杈圭晫: 涓€涓?*鏈櫥璁?*鐨?.md 琚墿鐞嗗垹闄?(鐢ㄦ埛璇垹浜嗘湭娉ㄥ唽鏂囦欢, 鎴?    /// 鎴戜滑鍒?register 瀹屽氨鍒犱簡), `unregister_and_emit` 搴斿綋**涓?*emit
    /// `MemoEvent::Deleted` (id 鎷夸笉鍒?,涔熶笉鍔?memo index銆?
    #[test]
    fn physical_delete_for_unregistered_file_is_noop() {
        let (mf, base) = fresh_memo_file();
        let filename = "Stray.md";
        let path = base.join(filename);
        fs::write(&path, "# Stray\n").unwrap();

        // 妯℃嫙 unregister_and_emit 鐨?id 鏌ユ壘鍓嶇疆娈? filename 涓嶅湪 memo index
        let looked_up = mf.find_memo_by_filename(filename);
        assert!(
            looked_up.is_none(),
            "unregistered .md must not resolve to a memo index entry"
        );

        // 妯℃嫙 unregister 娈? 鍚屾牱 no-op
        let removed = mf.unregister_memo_by_path(&path);
        assert!(!removed, "unregister must return false for unknown file");
    }

    // ====== Frontmatter-key-first 鍒嗘祦锛歳ename via disk key ======
    //
    // 澶嶇幇 GUI 鏍囬缂栬緫鐨勪唬鐮佽矾寰勶細fs::rename(OLD 鈫?NEW) 鍚?
    // SELF_WRITE_SUPPRESSOR 鍚炰簡 From 浜嬩欢, To 浜嬩欢杩涘叆 dispatch_modify_event銆?    // 鍏抽敭鏂█: 纾佺洏 frontmatter key (璺?rename 淇濈暀) 鈫?鍛戒腑 OLD entry 鈫?    // rename_memo_file 鏀?entry.filename, id 涓嶅彉, created_at 涓嶅彉銆?    //
    // 杩欎釜娴嬭瘯涓嶄緷璧?Tauri AppHandle / notify / SelfWriteSuppressor 鈥?鐩存帴
    // 鍠備竴涓?Create 浜嬩欢褰㈡€佺殑 path 缁?dispatch_modify_event, 妯℃嫙 GUI 璺緞
    // 璧板埌 processor 鏃剁殑鍏ュ弬銆?
    #[test]
    fn dispatch_modify_event_detects_rename_via_frontmatter_key() {
        let (mf, base) = fresh_memo_file();
        let (filename, old_path) = seed_registered_md(&mf, &base, "Original");

        // 鎶撳師濮?entry 鐨?id / timestamps
        let original = mf
            .find_memo_by_filename(&filename)
            .expect("seeded entry should exist");
        let original_id = original.id.clone();
        let original_created = original.created_at;
        let original_updated = original.updated_at;

        // 鐗╃悊 rename 鈹€鈹€ 璺?GUI write_memo_renaming_on_title_change 涓€鏍?
        // frontmatter key 璺熺潃鏂囦欢璧?(fs::rename 鏄?metadata-only 鎿嶄綔,
        // 鏂囦欢鍐呭涓嶅彉, frontmatter 鍧楃殑 key 瀛楁淇濈暀)
        let new_filename = "Renamed.md".to_string();
        let new_path = base.join(&new_filename);
        std::fs::rename(&old_path, &new_path).expect("physical rename must succeed");

        // 鍠?To 浜嬩欢褰㈡€? dispatch_modify_event 璇荤鐩?鈫?鎶?key 鈫?鍙嶆煡 entry
        let outcome = dispatch_modify_event(&mf, &watch_ctx(&base), &new_path, FsEventKind::Create)
            .expect("dispatch ok");
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
                // 鍏抽敭涓嶅彉閲?鈹€鈹€ id 璺?rename 淇濈暀
                assert_eq!(
                    id, original_id,
                    "id must be preserved across rename detected via frontmatter key"
                );
                assert_eq!(
                    memo.id, original_id,
                    "memo.id must match memo index entry id"
                );
                // filename 鏀规垚纾佺洏瀹為檯鏂囦欢鍚?
                assert_eq!(
                    memo.filename, new_filename,
                    "filename must reflect post-rename disk state"
                );
                // path 鏄柊浣嶇疆 (rename 鍚庣殑缁濆璺緞)
                assert_eq!(
                    path,
                    new_path.display().to_string(),
                    "emit path must be the post-rename abs path"
                );
                // created_at 淇濈暀 鈹€鈹€ rename_memo_file 涓嶅姩 created_at
                assert_eq!(
                    memo.created_at, original_created,
                    "created_at must be preserved (rename_memo_file leaves it alone)"
                );
                // updated_at 鍒锋柊 鈹€鈹€ rename 鏈韩绠椾竴娆℃洿鏂?
                assert!(
                    memo.updated_at >= original_updated,
                    "updated_at should be refreshed on rename"
                );
                assert!(matches!(source, MemoChangeSource::ExternalTool));
            }
            other => panic!("expected Updated, got {:?}", std::mem::discriminant(&other)),
        }

        // 鏀跺熬: memo index 鐨?entry.filename 鐪熺殑鏇存柊浜?
        let entry_after = mf
            .find_memo_by_filename(&new_filename)
            .expect("new filename should be in memo index after rename");
        assert_eq!(
            entry_after.id, original_id,
            "memo index entry's id must be preserved"
        );
        // 鏃?filename 搴旇宸茬粡涓嶅湪 memo index
        assert!(
            mf.find_memo_by_filename(&filename).is_none(),
            "old filename must be removed from memo index after rename"
        );

        // 娓呯悊
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
            dispatch_modify_event(&mf, &watch_ctx(&base), &pasted_path, FsEventKind::Create)
                .expect("dispatch ok");
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

    // ====== Frontmatter-key-first 鍒嗘祦锛?c) case ======
    //
    // 妯℃嫙"memo index 宸茬粡琚墠搴忎簨浠舵竻鎺? 纾佺洏 key 杩樺湪" 鈹€鈹€ 姣斿澶栭儴
    // rename 璧?From + To 涓ゆ潯浜嬩欢, From 杩涗簡 unregister_and_emit 鍒犱簡
    // entry, To 杩?dispatch_modify_event 姝ゆ椂 read_memo(key) 杩斿洖 None銆?    // 褰撳墠绮樿创璇箟: 甯?key 鐨勯檶鐢熸枃浠朵篃鎸夋柊鏂囨。娉ㄥ唽, 骞舵妸纾佺洏 key 鍒锋柊鎴愭柊 id銆?
    #[test]
    fn dispatch_modify_event_rekeys_orphan_disk_key_as_new_document() {
        let (mf, base) = fresh_memo_file();

        // 鐩存帴閫犱竴涓?.md 甯?frontmatter key 浣?memo index 閲屾病璁板綍鐨?瀛ゅ効"
        let orphan_filename = "Orphan.md".to_string();
        let orphan_path = base.join(&orphan_filename);
        let orphan_id = "abc123";
        std::fs::write(
            &orphan_path,
            format!("---\nkey: {orphan_id}\n---\n# Orphan\n\nbody content\n"),
        )
        .unwrap();

        // 妯℃嫙 read_memo 杩斿洖 None 鐨勭姸鎬?鈹€鈹€ memo index 骞插噣
        assert!(mf.read_current_memo(orphan_id).is_none());

        // dispatch: 搴斿垱寤烘柊 memo, 涓嶆部鐢ㄧ鐩樻棫 key
        let outcome =
            dispatch_modify_event(&mf, &watch_ctx(&base), &orphan_path, FsEventKind::Create)
                .expect("dispatch ok");
        let memo = match outcome {
            DispatchOutcome::Created {
                event: MemoEvent::Created { memo, .. },
                ..
            } => memo,
            other => panic!("expected Created via (c) path, got {other:?}"),
        };

        assert_ne!(memo.id, orphan_id, "pasted file must get a fresh id");
        assert_eq!(memo.filename, orphan_filename);

        // 鏀跺熬: memo index 鐪熺殑鏈夎繖鏉?entry
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

    // ====== GUI 鏍囬缂栬緫鍏ㄩ摼璺細SelfWriteSuppressor + dispatch 鍗忎綔 ======
    //
    // 妯℃嫙 write_memo_renaming_on_title_change 娴佺▼:
    //   1. mark_self_write(OLD) 鈹€鈹€ 鎶?OLD 璺緞濉炴姂鍒惰〃
    //   2. fs::rename(OLD 鈫?NEW) 鈹€鈹€ 瑙﹀彂 notify From(OLD) + To(NEW)
    //   3. notify 鍥炶皟 鈫?filter pipeline:
    //      - From(OLD) 鈫?SelfWriteSuppressor 鍛戒腑 鈫?鍚炴帀 鉁?    //      - To(NEW)   鈫?SelfWriteSuppressor miss 鈫?杩?processor
    //   4. processor 璧?frontmatter-key-first 鍒嗘祦:
    //      - 璇荤鐩?鈫?鎶?key = id (frontmatter 璺熺潃 fs::rename 璧?
    //      - read_memo(id) 鈫?Some (entry 娌¤鍒? From 琚悶浜?
    //      - existing.filename != current filename 鈫?(a) 鍒嗘敮
    //      - rename_memo_file(OLD, NEW) 鈫?entry.filename 鏀? id 淇濈暀
    //
    // 鍏抽敭 invariant: id 璺?rename 淇濈暀, created_at 涓嶅彉, updated_at 鍒锋柊銆?    // 杩欐槸鐢ㄦ埛鎶ュ憡鐨?bug 鐨勬牳蹇?鈹€鈹€ 涔嬪墠 Windows 涓婂洜 inode_tracker 鐣欑┖,
    // dispatch_modify_event 璧?filename-based 璺緞, 鎶?entry 褰?鏂版枃浠?
    // 閲嶆柊娉ㄥ唽, id 婕傜Щ / createdAt 閲嶇疆銆?    //
    // 杩欎釜娴嬭瘯**涓嶄緷璧?Tauri AppHandle / 鐪熷疄 notify** 鈹€鈹€ 鐩存帴璋?    // SelfWriteSuppressor + dispatch_modify_event, 楠岃瘉涓ゆ潯浜嬩欢娴佸叆
    // processor 鍚? dispatch 鐨勮緭鍑烘槸姝ｇ‘鐨?rename_memo_file 璋冪敤銆?
    #[test]
    fn gui_title_edit_full_pipeline_preserves_id_and_timestamps() {
        use crate::watcher::filter::{run_pipeline, PathFilter};
        use crate::watcher::path::normalize_for_compare;
        use crate::watcher::whitelist::WhitelistConfig;
        use std::path::PathBuf;
        use std::time::Instant;

        let (mf, base) = fresh_memo_file();
        let (filename, old_path) = seed_registered_md(&mf, &base, "Original");

        // 鎶撳師濮?entry 鐨?id / created_at / updated_at
        let original = mf
            .find_memo_by_filename(&filename)
            .expect("seeded entry should exist");
        let original_id = original.id.clone();
        let original_created = original.created_at;
        let original_updated = original.updated_at;

        // ====== Step 1: GUI 鍐欑洏鍓?mark_self_write(OLD) ======
        let recent = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::<
            PathBuf,
            Instant,
        >::new()));
        recent
            .lock()
            .unwrap()
            .insert(normalize_for_compare(&old_path), Instant::now());

        // ====== Step 2: fs::rename(OLD 鈫?NEW) 鈹€鈹€ 鐗╃悊閲嶅懡鍚?======
        let new_filename = "Renamed.md".to_string();
        let new_path = base.join(&new_filename);
        std::fs::rename(&old_path, &new_path).expect("physical rename must succeed");

        // ====== Step 3a: 妯℃嫙 notify From(OLD) 浜嬩欢杩涘叆 filter pipeline ======
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

        // ====== Step 3b: 妯℃嫙 notify To(NEW) 浜嬩欢杩涘叆 filter pipeline ======
        let to_event = RawFsEvent::new(FsEventKind::Create, new_path.clone());
        let to_decision = run_pipeline(&to_event, &recent, &last_emit, &path_filter);
        assert!(
            matches!(to_decision, crate::watcher::event::FilterDecision::Pass),
            "To(NEW) must pass through filter pipeline (NEW was not marked)"
        );

        // ====== Step 4: processor dispatch_modify_event(NEW) 鈹€鈹€ 璧?(a) 鍒嗘敮 ======
        let outcome = dispatch_modify_event(&mf, &watch_ctx(&base), &new_path, FsEventKind::Create)
            .expect("dispatch ok");
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

        // ====== 鏀跺熬锛歮emo index entry 鐘舵€?======
        let entry_after = mf
            .find_memo_by_filename(&new_filename)
            .expect("new filename should be in memo index after rename");
        assert_eq!(entry_after.id, original_id);
        assert!(
            mf.find_memo_by_filename(&filename).is_none(),
            "old filename must be removed from memo index after rename"
        );

        // 娓呯悊: 鎶婃枃浠舵尓鍥炲幓閬垮厤姹℃煋鍏朵粬娴嬭瘯
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

        let outcome = dispatch_modify_event(&mf, &watch_ctx(&base), &new_path, FsEventKind::Create)
            .expect("dispatch ok");
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
