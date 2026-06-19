//! Memo / Doc IPC 鈥?v3 (ops 鍘熻鐗?銆?//!
//! 13 涓?IPC:
//! - **璇诲彇**: `get_memos` / `read_memo` / `search_memos` / `read_document` / `get_launch_open_files`
//! - **鍒涘缓**: `add_document` / `import_external_document_to_memo`
//! - **鏇存柊**: `update_memo_db` / `write_document` / `favorite_memo` / `unfavorite_memo`
//!                / `set_memo_colors`
//! - **鍒犻櫎**: `delete_memo` / `clear_memos`
//!
//! 鍐欒矾寰勫叏閮ㄨ蛋 `MemoFile` 鐨?ops 鍘熻 (`create_memo` / `rename_memo` /
//! `write_memo` / `delete_memo` / `sync_metadata_only`); 鐗╃悊鏂囦欢鍚?= index.json
//! entry.filename (鍚?`.md`), 鏃х増 `#xxxxxx` 绾﹀畾宸插簾銆?//!
//! 鍩熷唴 helper `extract_memo_id_from_path` / `generate_memo_id` 浠嶄繚鐣?(Tauri 鍛戒护
//! 鍐呰皟鐢? 涓嶅鍑?; 鍩熷 helper (绱㈠紩鍚屾 / notebook 鍒囨崲 / markdown 瑙ｆ瀽) 璧?//! `super::helpers::*`銆?
use std::fs;
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::lock_utils::{read_lock, write_lock};
use crate::memo_events::{self, MemoChangeSource, MemoEvent};
use flowix_core::memo_file::{
    atomic_write_bytes, extract_body_content, Memo, MemoColor, MemoVersionMeta, MemoVersionSource,
};
use flowix_core::search::MemoSearchHit;

use super::helpers::{
    force_rebuild_index, mark_self_write_for, rebuild_index_in_background, synthesize_minimal_memo,
    try_index_remove, try_index_upsert,
};
use super::AppState;

#[derive(Serialize)]
pub struct GetMemosResponse {
    pub memos: Vec<Memo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMemosResponse {
    pub hits: Vec<MemoSearchHit>,
    pub index_ready: bool,
}

// ==================== 鍩熷唴 helper ====================

/// Read a memo from index.json; returns None when the id is missing.
fn read_memo_or_none(state: &AppState, id: &str) -> Option<Memo> {
    read_lock(&state.memo_file, "memo_file").read_memo(id)
}

/// Resolve the physical file path for an event payload.
fn abs_path_for(state: &AppState, id: &str) -> String {
    read_lock(&state.memo_file, "memo_file")
        .find_memo_file_path(id)
        .map(|p| p.display().to_string())
        .unwrap_or_default()
}

/// 鍐欑洏鍚庤蛋缁熶竴鏀跺彛: mark 鑷啓鎶戝埗 + 閲嶅缓绱㈠紩 + emit `Updated`銆?///
/// 椤轰究浠?index.json 璇诲嚭褰撳墠鏉冨▉ memo 闄勫湪 payload 閲? 鍓嶇鎸?id 璧?upsert
/// 鍗冲彲, 涓嶅啀瑙﹀彂 readMemo IPC銆?
fn emit_updated_after_write(state: &AppState, app: &AppHandle, id: &str) {
    let path = abs_path_for(state, id);
    if !path.is_empty() {
        mark_self_write_for(app, Path::new(&path));
    }
    try_index_upsert(state, id);
    let memo = read_memo_or_none(state, id);
    // 鏋佸皯鏁版儏鍐?(鍐欑洏鍚?index.json 浠嶈涓嶅埌) 閫€鍖栨垚鏃?payload, 鍓嶇璧?readMemo 鍏滃簳
    let payload = match memo {
        Some(memo) => MemoEvent::Updated {
            id: id.to_string(),
            path: path.clone(),
            memo,
            source: MemoChangeSource::UserEdit,
        },
        None => MemoEvent::Updated {
            id: id.to_string(),
            path,
            memo: synthesize_minimal_memo(id),
            source: MemoChangeSource::UserEdit,
        },
    };
    memo_events::emit(app, payload);
}

/// Lightweight CAS fallback normalization.
///
/// The fast path stays byte-for-byte equality. This is only used after that
/// fails, to tolerate editor serialization noise that does not change the
/// document body meaning: CRLF/LF, frontmatter rewrite, line-end spaces, and
/// empty paragraphs represented as `&nbsp;`/NBSP.
fn normalize_markdown_for_cas(content: &str) -> String {
    let lf = content.replace("\r\n", "\n").replace('\r', "\n");
    let body = extract_body_content(&lf);
    let mut out = String::new();
    let mut pending_blank = false;
    let mut wrote_line = false;

    for raw_line in body.lines() {
        let line = raw_line.trim_end();
        let marker = line.trim();
        let is_blank = marker.is_empty() || marker == "&nbsp;" || marker == "\u{00a0}";

        if is_blank {
            pending_blank = true;
            continue;
        }

        if wrote_line {
            out.push('\n');
            if pending_blank {
                out.push('\n');
            }
        }

        out.push_str(line);
        wrote_line = true;
        pending_blank = false;
    }

    out
}

fn cas_content_matches(current: &str, expected: &str, incoming: &str) -> bool {
    if current == expected || current == incoming {
        return true;
    }

    normalize_markdown_for_cas(current) == normalize_markdown_for_cas(expected)
}

#[cfg(test)]
mod tests {
    use super::cas_content_matches;

    #[test]
    fn cas_accepts_markdown_serialization_noise() {
        let current = "---\nkey: abc123\n---\r\n\r\n# Title\r\n&nbsp;\r\nBody  \r\n";
        let expected = "---\nkey: oldkey\n---\n\n# Title\n\nBody\n";
        let incoming = "---\nkey: abc123\n---\n\n# Title\n&nbsp;\nBody\n";

        assert!(cas_content_matches(current, expected, incoming));
    }

    #[test]
    fn cas_rejects_real_body_change() {
        let current = "---\nkey: abc123\n---\n\n# Title\nChanged\n";
        let expected = "---\nkey: abc123\n---\n\n# Title\nBody\n";
        let incoming = "---\nkey: abc123\n---\n\n# Title\nBody plus local edit\n";

        assert!(!cas_content_matches(current, expected, incoming));
    }

    #[test]
    fn cas_accepts_idempotent_incoming_content() {
        let current = "# Title\n\nBody\n";
        let expected = "# Title\n\nOld body\n";
        let incoming = "# Title\n\nBody\n";

        assert!(cas_content_matches(current, expected, incoming));
    }
}

// ==================== 璇诲彇 ====================

#[tauri::command]
#[allow(non_snake_case)]
pub fn get_memos(
    notebook_id: Option<String>,
    filter: Option<String>,
    sort: Option<String>,
    tag_id: Option<String>,
    state: State<AppState>,
    _app: AppHandle,
) -> GetMemosResponse {
    // 绾鍛戒护: 鍙湪 `current_notebook_id` 璺熷墠绔紶鍏ヤ笉涓€鑷存椂鍚屾鍒囨崲 (鍗曞瓧娈?    // 璧嬪€? 鏃?IO), 鐒跺悗浠庡唴瀛?cache 鎷?`index.json` 杩囨护鎺掑簭杩斿洖銆?    //
    // 鍘嗗彶: 涔嬪墠杩欓噷璋?`switch_notebook_and_rebuild`, 姣忔 get_memos 閮戒細:
    //   1. drop 鏃?`notify::RecommendedWatcher` 骞堕噸寤?(鍚?inode tracker 鍏ㄧ洏 stat)
    //   2. `reconcile_with_disk_bidirectional` (read_dir + read_index 脳 2)
    //   3. 鍚庡彴 `read_all_memos_with_body` 鍏ㄦ枃璇绘墍鏈?.md
    // 7 绗旇涔熶細 8-9s, 鍥犱负 1+2 鍚屾鎵ц + 3 璺?IPC 浜?`MemoFile` 璇婚攣銆?    //
    // 閲嶆椿 (watcher rebind / reconcile / 绱㈠紩 rebuild) 杩佺Щ鍒?
    //   - `set_current_notebook` IPC (鍓嶇 `handleSelectNotebook` 鏄惧紡璋?
    //     main-layout.tsx:457)
    //   - `create_notebook` IPC
    //   - `lib.rs::run` 鍚姩涓嶅彉閲?(`.setup()` 宸茬粡鍋氫竴娆?
    // 杩欎笁澶勬墠鏄湡姝ｉ渶瑕侀噸娲荤殑鏃跺埢銆俙get_memos` 姣忕鍙兘琚皟鏁版, 缁濅笉璇?    // 鎼哄甫 watcher 閲嶅缓鎴愭湰銆?    {
    {
        let mut mf = write_lock(&state.memo_file, "memo_file");
        if mf.current_notebook_id_value() != notebook_id {
            mf.set_current_notebook(notebook_id);
        }
    }
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let memos = memo_file.read_all_memos_filtered(
        filter.as_deref().unwrap_or("all"),
        sort.as_deref().unwrap_or("createdAt"),
        tag_id.as_deref(),
    );
    GetMemosResponse { memos }
}

#[tauri::command]
pub fn read_memo(id: String, state: State<AppState>) -> Option<Memo> {
    let memo = read_lock(&state.memo_file, "memo_file").read_memo(&id)?;
    // lazy defense: index.json 杩樺湪, 浣?.md 鐗╃悊鏂囦欢宸蹭笉鍦?(watcher 婕忔姤 /
    // 鍚屾鐩樺悓姝ュ垹闄ょ瓑鏋佺璺緞)銆?鍗曟潯鍏滃簳娓呭菇鐏垫潯鐩? 閬垮厤鍓嶇鎷垮埌 stale
    // Keep stale index entries from opening an empty editor when the file is gone.
    let path = read_lock(&state.memo_file, "memo_file").file_path_for(&memo.filename);
    if !path.exists() {
        tracing::info!(
            "[read_memo] file gone, unregistering ghost: {}",
            path.display()
        );
        let _ = read_lock(&state.memo_file, "memo_file").unregister_memo_by_path(&path);
        return None;
    }
    Some(memo)
}

#[tauri::command]
pub fn read_document(file_path: String, state: State<AppState>) -> Option<String> {
    if !super::helpers::can_access_document_path(Path::new(&file_path), &state) {
        eprintln!("[read_document] refused out-of-scope path: {}", file_path);
        return None;
    }
    let io_path = resolve_document_path_for_io(&file_path, state.inner());
    fs::read_to_string(&io_path).ok()
}

/// 璧?index.json 瑙ｆ瀽 memo 鐗╃悊缁濆璺緞 (v3: `get_memo_base() + entry.filename`)銆?/// 鎵句笉鍒?entry (id 涓嶅湪 index.json) 鏃堕€€鍒?`file_path` 鍘熷€?(璺熸棫琛屼负涓€鑷? 鍏佽
/// 澶栭儴 .md 鏂囦欢鐢?read_document 璇?銆?
fn resolve_document_path_for_io(file_path: &str, state: &AppState) -> std::path::PathBuf {
    let requested_path = std::path::PathBuf::from(file_path);
    // 鐩存帴鎸?index.json 鎵?memo 鐗╃悊璺緞
    if let Some(file_name) = requested_path.file_name().and_then(|n| n.to_str()) {
        if let Some(entry_path) = read_lock(&state.memo_file, "memo_file")
            .find_memo_by_filename(file_name)
            .map(|m| read_lock(&state.memo_file, "memo_file").file_path_for(&m.filename))
        {
            return entry_path;
        }
    }
    requested_path
}

/// `write_document` 杩斿洖鍊?鈹€鈹€ 鍐欑洏鎴愬姛鍚? 纾佺洏涓婄殑鏈€缁堣矾寰?+ 鍐呭銆?///
/// 鍐呴儴 memo 璺緞涓?`path` 鍙兘鏄悗绔?rename 鍑虹殑鏂拌矾寰? 璺?caller 浼?/// 杩涙潵鐨?`file_path` 涓嶅悓 鈹€鈹€ 鍓嶇闇€瑕佹嵁姝ゅ垏 buf / 鏇存柊 closure銆?
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteDocumentResult {
    pub path: String,
    pub content: String,
}

/// `channel` 瀛楁:
/// - `"internal"` 鈹€鈹€ 鍐呴儴 memo 鏂囨。, 璧?`key` 鍙嶆煡 index.json 鎷垮綋鍓?///   entry.filename, 娲剧敓鏀瑰悕璧?`write_memo_renaming_on_title_change`銆?///   `path` 鍦ㄦ鍦烘櫙涓嬪彧鐢ㄤ綔 hint, 鏉冨▉瀵诲潃鐢?`key`銆?/// - `"external"` 鈹€鈹€ 澶栭儴 .md 鏂囦欢, 璧?`path` 瀵诲潃 + 鍘熷瓙 `atomic_write_bytes`,
///   **涓?*娲剧敓鏀瑰悕 (filename 涓嶅湪 index.json 鍐?, **涓?*鏇存柊 index.json銆?///
/// `expectedContent` 鈹€鈹€ 涓?channel 鍏辩敤鐨勪箰瑙傚苟鍙戞帶鍒? 鍏堣窡纾佺洏褰撳墠鍐呭鍋?/// byte equality, 澶辫触鍚庡啀璧拌交閲?markdown 璇箟绛変环鍏滃簳; 浠嶄笉鍖归厤鎵嶆嫆缁?/// (`None` 杩斿洖 + 鍓嶇璧?stale toast 鍏滃簳)銆?/// 鍐呴儴 channel 涔嬪墠 v3 娉ㄩ噴"key 鍞竴 + 閿佽冻澶?鍋囪涓嶈В鍐?鍐呭灞傚苟鍙?
/// (Tiptap 涓?CLI / 澶栭儴宸ュ叿鍚屾椂鏀逛竴绡? 鍚庡啓鑰呴潤榛樺悶鍓嶈€? 鈹€鈹€ v4 璧?/// 寮哄埗 CAS銆傜墿鐞?rename / index.json entry 鏀瑰姩浠嶇敱 key/path 鏉冨▉璺緞澶勭悊;
/// frontmatter rewrite 杩欑被姝ｆ枃璇箟涓嶅彉鐨勫樊寮傜敱璇箟鍏滃簳鍚告敹銆?
#[tauri::command]
#[allow(non_snake_case)]
pub fn write_document(
    key: Option<String>,
    channel: String,
    file_path: String,
    content: String,
    expectedContent: Option<String>,
    state: State<AppState>,
    app: AppHandle,
) -> Option<WriteDocumentResult> {
    match channel.as_str() {
        "internal" => write_document_internal(
            key.as_deref(),
            &content,
            expectedContent.as_deref(),
            &state,
            &app,
        ),
        "external" => {
            write_document_external(&file_path, &content, expectedContent.as_deref(), &state)
        }
        other => {
            eprintln!("[write_document] unknown channel: {other}");
            None
        }
    }
}

/// 鍐呴儴 memo 鍐欑洏 鈹€鈹€ 鐢?`key` 鍙嶆煡 index.json 鎷垮綋鍓?entry.filename,
/// 鐢ㄦ柊璺緞鍐欑洏銆侰AS 璧?`expectedContent` 瀛楄妭鐩哥瓑浼樺厛銆佽交閲忚涔夌浉绛夊厹搴?/// (v4 寮曞叆, 鏇夸唬鏃?key 鍞竴 + 閿佽冻澶?鍋囪): 鍓嶇 send 鏃跺涓?/// `buf.lastSavedContent`, 鍚庣 `read_to_string` 鎷垮綋鍓嶇鐩樺唴瀹规瘮瀵广€?/// key 鍞竴鎬т笉瑙ｅ喅"鍐呭灞傜殑骞跺彂", 鍙兘淇濊瘉 id 涓嶄細鎾?鈹€鈹€ 杩欐潯 CAS
/// 姝ｆ槸琛ヤ笂鍐呭灞傚苟鍙戙€?///
/// key 鍙嶆煡澶辫触 = 鏁版嵁婕傜Щ (index.json 宸插垹 / 璺?notebook 璇紶), 涓?/// 鍋?path 鍏滃簳閬垮厤璇懡涓叾瀹?memo 鈹€鈹€ 鐩存帴鎷掔粷銆?
fn write_document_internal(
    key: Option<&str>,
    content: &str,
    expected_content: Option<&str>,
    state: &State<AppState>,
    app: &AppHandle,
) -> Option<WriteDocumentResult> {
    let key = key?;
    let memo_file = read_lock(&state.memo_file, "memo_file");
    if memo_file.read_memo(key).is_none() {
        eprintln!("[write_document_internal] 鏈壘鍒扮瑪璁? key={key}");
        return None;
    }
    drop(memo_file);

    // CAS: 璺?write_document_external 鍚屾, 鍐呴儴 channel 璧板瓧鑺傜浉绛変紭鍏堛€?    // 杞婚噺璇箟鐩哥瓑鍏滃簳銆侼one 琛ㄧず caller 娌′紶 (渚嬪鏃?CLI 璺緞), 璺宠繃 CAS
    // 璧伴攣鍏滃簳; 鐜伴樁娈垫墍鏈夊墠绔皟鐢ㄩ兘浼? 鍙湁 IPC schema 鍗囩骇鏈熼棿
    // 鍑虹幇 None銆?
    if let Some(expected) = expected_content {
        let current_path = match read_lock(&state.memo_file, "memo_file").find_memo_file_path(key) {
            Some(p) => p,
            None => {
                eprintln!("[write_document_internal] no file path for key={key}");
                return None;
            }
        };
        match fs::read_to_string(&current_path) {
            Ok(current) if cas_content_matches(&current, expected, content) => {}
            Ok(_) => {
                eprintln!(
                    "[write_document_internal] CAS refused: key={} disk != expected",
                    key
                );
                return None;
            }
            Err(e) => {
                eprintln!("[write_document_internal] CAS read failed for {key}: {e}");
                return None;
            }
        }
    }

    // Mark the target before writing so the watcher can suppress our own change.
    if let Some(path) = read_lock(&state.memo_file, "memo_file").find_memo_file_path(key) {
        mark_self_write_for(app, &path);
    }
    let result =
        read_lock(&state.memo_file, "memo_file").write_memo_renaming_on_title_change(key, content);
    match result {
        Ok(_updated) => {
            // emit + 绱㈠紩
            emit_updated_after_write(state.inner(), app, key);
            // The write may rename the file, so resolve the final path after it succeeds.
            let final_path = read_lock(&state.memo_file, "memo_file")
                .find_memo_file_path(key)
                .expect("just verified memo exists");
            let final_content = match fs::read_to_string(&final_path) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!(
                        "[write_document_internal] final read_to_string failed for {key}: {e}"
                    );
                    return None;
                }
            };
            if let Err(e) = read_lock(&state.memo_file, "memo_file")
                .maybe_create_auto_memo_version(key, &final_content)
            {
                eprintln!("[write_document_internal] auto version failed for {key}: {e}");
            }
            Some(WriteDocumentResult {
                path: final_path.to_string_lossy().to_string(),
                content: final_content,
            })
        }
        Err(e) => {
            eprintln!("[write_document_internal] write_memo failed for {key}: {e}");
            None
        }
    }
}

/// 澶栭儴 .md 鏂囦欢鍐欑洏 鈹€鈹€ 璧?`file_path` 瀵诲潃 + CAS 鏍￠獙 (澶栭儴鏂囦欢
/// 娌℃湁 id 鏉冨▉, CAS 鏄槻澶栭儴宸ュ叿骞跺彂鐨勫敮涓€鎵嬫), 涓嶅姩 index.json
/// (index.json 鏄唴閮?memo 绱㈠紩, 澶栭儴鏂囦欢涓嶅湪鍐?銆?///
/// 娲剧敓鏀瑰悕: 涓嶆墽琛屻€傚閮ㄦ枃浠剁殑 filename 鏄敤鎴峰喅瀹氱殑, 涓嶇敱鍚庣
/// 娲剧敓, 鏀归琛屼笉瑙﹀彂鐗╃悊 rename銆?
fn write_document_external(
    file_path: &str,
    content: &str,
    expected_content: Option<&str>,
    state: &State<AppState>,
) -> Option<WriteDocumentResult> {
    if !super::helpers::can_access_document_path(Path::new(file_path), state) {
        eprintln!(
            "[write_document_external] refused out-of-scope path: {}",
            file_path
        );
        return None;
    }
    if let Some(parent) = Path::new(file_path).parent() {
        let _ = fs::create_dir_all(parent);
    }
    let io_path = resolve_document_path_for_io(file_path, state.inner());
    if let Some(parent) = io_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    // 澶栭儴鏂囦欢淇濈暀 CAS: 娌?id 鏉冨▉, 鍙兘姣斿"caller 鏈熸湜鐨勭鐩樺唴瀹?
    if let Some(expected) = expected_content {
        match fs::read_to_string(&io_path) {
            Ok(current_content) if cas_content_matches(&current_content, expected, content) => {}
            Ok(_) => {
                eprintln!(
                    "[write_document_external] CAS refused: {} changed on disk",
                    file_path
                );
                return None;
            }
            Err(e) => {
                eprintln!(
                    "[write_document_external] Failed to verify {}: {}",
                    file_path, e
                );
                return None;
            }
        }
    }

    match atomic_write_bytes(&io_path, content.as_bytes()) {
        Ok(_) => Some(WriteDocumentResult {
            path: io_path.to_string_lossy().to_string(),
            content: content.to_string(),
        }),
        Err(e) => {
            eprintln!(
                "[write_document_external] write failed for {}: {}",
                file_path, e
            );
            None
        }
    }
}

#[tauri::command]
pub fn get_launch_open_files() -> Vec<String> {
    super::helpers::markdown_paths_from_args(std::env::args())
}

#[tauri::command]
pub fn search_memos(
    notebook_id: Option<String>,
    query: String,
    limit: Option<usize>,
    state: State<AppState>,
    app: AppHandle,
) -> SearchMemosResponse {
    let idx = read_lock(&state.search, "search");
    if let Some(ref nb) = notebook_id {
        if idx.current_notebook() != Some(nb.as_str()) {
            drop(idx);
            rebuild_index_in_background(state.inner(), &app);
            return SearchMemosResponse {
                hits: vec![],
                index_ready: false,
            };
        }
    }
    drop(idx);

    let needs_rebuild = {
        let idx = read_lock(&state.search, "search");
        let current_nb = read_lock(&state.memo_file, "memo_file").current_notebook_id_value();
        !idx.is_loaded() || idx.current_notebook() != current_nb.as_deref()
    };
    if needs_rebuild {
        rebuild_index_in_background(state.inner(), &app);
    }

    let idx = read_lock(&state.search, "search");
    let index_ready = idx.is_loaded();
    let hits = idx.search(&query, limit.unwrap_or(30));
    SearchMemosResponse { hits, index_ready }
}

// ==================== 鍒涘缓 ====================

#[tauri::command]
pub fn add_document(
    tag: Option<String>,
    notebook_id: Option<String>,
    state: State<AppState>,
    app: AppHandle,
) -> Memo {
    // 1. Switch notebook context when requested.
    if let Some(ref id) = notebook_id {
        write_lock(&state.memo_file, "memo_file").set_current_notebook(Some(id.clone()));
    }

    // 2. 绠?title (榛樿 `untitled-YYYY-MM-DD`) + body (鍚?tag 琛?
    let now = chrono::Utc::now().timestamp_millis();
    let title = chrono::Local::now().format("%Y-%m-%d").to_string();
    let body = match tag.as_deref() {
        Some(t) if !t.is_empty() => format!("# {}\n#{}\n", title, t),
        _ => format!("# {}\n", title),
    };

    // 3. 鑷啓鎶戝埗: 鎻愬墠 mark 鍐欑洏鐩爣璺緞 (鍐欑洏鍓?mark 闃?notify race)
    let abs = read_lock(&state.memo_file, "memo_file").file_path_for(&format!("{}.md", title));
    mark_self_write_for(&app, &abs);

    // 4. 璧?ops create_memo 鍐欑洏 + 鍐?index.json
    let memo = match read_lock(&state.memo_file, "memo_file").create_memo(&title, &body, None) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[add_document] create_memo failed: {e}");
            // 澶辫触鏃舵瀯閫犱竴涓┖ Memo 杩斿洖 (鍓嶇浠?memo_event Created 鎷?
            return Memo {
                id: String::new(),
                filename: format!("{}.md", title),
                preview: String::new(),
                tags: vec![],
                todos: vec![],
                created_at: now,
                updated_at: now,
                favorited: false,
                icon: None,
                colors: vec![],
            };
        }
    };

    try_index_upsert(state.inner(), &memo.id);
    // 閲嶆柊 mark (鍒涘缓鍚?filename 鍙兘鏄?`untitled-YYYY-MM-DD.md` 鐪熷疄鍊?
    // 涓嶄竴瀹氱瓑浜庨鏈?title; 鍐欑洏鍓?mark 璧扮殑鏄?title 鎺ㄦ祴, 杩欓噷鍏滃簳)
    let real_path = read_lock(&state.memo_file, "memo_file").find_memo_file_path(&memo.id);
    if let Some(p) = real_path {
        mark_self_write_for(&app, &p);
    }
    memo_events::emit(
        &app,
        MemoEvent::Created {
            memo: memo.clone(),
            source: MemoChangeSource::UserNew,
        },
    );
    memo
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn import_external_document_to_memo(
    file_path: String,
    content: String,
    notebook_id: Option<String>,
    state: State<AppState>,
    app: AppHandle,
) -> Result<Memo, String> {
    // Switch notebook context when requested.
    if let Some(ref id) = notebook_id {
        write_lock(&state.memo_file, "memo_file").set_current_notebook(Some(id.clone()));
    }

    let abs = std::path::PathBuf::from(&file_path);

    // 鍐欎竴浠?.md 鍒扮鐩?(鐢?caller content) 鍐?register
    // v3: register_existing_file 涓嶅姩鐗╃悊鏂囦欢, 鎴戜滑闇€瑕佸厛鍐?caller 缁欑殑 content
    // Import by creating a normal memo from the external file stem and content.
    let title = std::path::Path::new(&file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("imported")
        .to_string();
    let body = if content.is_empty() {
        String::new()
    } else {
        content.clone()
    };

    // Mark the likely new path before writing.
    let mf = read_lock(&state.memo_file, "memo_file");
    let base = mf.get_memo_base();
    let candidate = flowix_core::memo_file::base_filename(&title);
    // 璇?index.json 鎷垮凡鍗犵敤 filenames 鈹€鈹€ 璺?create_memo / rename_memo
    // 璧板悓婧愬啿绐佹娴? 鏉滅粷骞跺彂 import 鎾炲埌宸叉湁 entry銆?
    let occupied: Vec<String> = mf
        .read_index()
        .map(|l| l.memos.into_iter().map(|e| e.filename).collect())
        .unwrap_or_default();
    let filename = flowix_core::memo_file::resolve_filename_conflict(&base, &candidate, &occupied);
    let abs_new = base.join(&filename);
    mark_self_write_for(&app, &abs_new);

    let memo = mf
        .create_memo(&title, &body, None)
        .map_err(|e| format!("create_memo failed: {e}"))?;
    drop(mf);

    try_index_upsert(state.inner(), &memo.id);
    let _ = abs; // 涓嶅啀鐢? 璋冪敤鏂瑰凡鏈?file_path
    memo_events::emit(
        &app,
        MemoEvent::Created {
            memo: memo.clone(),
            source: MemoChangeSource::UserImport,
        },
    );
    Ok(memo)
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn update_memo_db(
    id: String,
    content: Option<String>,
    filename: Option<String>,
    preview: Option<String>,
    defer_rename: Option<bool>,
    state: State<AppState>,
    app: AppHandle,
) -> bool {
    let defer_rename = defer_rename.unwrap_or(true);

    let memo_file = read_lock(&state.memo_file, "memo_file");
    let Some(current) = memo_file.read_memo(&id) else {
        return false;
    };

    if defer_rename {
        // metadata-only 璺緞: 鍙悓姝?index.json 瀛楁, 涓嶅姩纾佺洏銆?
        let mut updated = current.clone();
        if let Some(f) = filename {
            updated.filename = f;
        }
        if let Some(p) = preview {
            updated.preview = p;
        }
        // 娲剧敓: 鑻ョ粰浜?content, 璺戜竴娆℃淳鐢?(preview / tags / todos)
        if let Some(ref body) = content {
            let full = flowix_core::memo_file::build_md_content(
                &updated.filename.trim_end_matches(".md").to_string(),
                body,
            );
            // 澶嶅埢 apply_derived_memo_fields 鐨勫壇浣滅敤 (鍦?metadata-only 鍦烘櫙)
            use flowix_core::memo_file::apply_derived_memo_fields;
            apply_derived_memo_fields(&mut updated, &full);
        }
        updated.updated_at = chrono::Utc::now().timestamp_millis();
        return memo_file.sync_metadata_only(&updated).is_ok();
    }

    // 闈?defer_rename 璺緞: 鐪熸敼 title 鈫?瑙﹀彂鐗╃悊 rename
    drop(memo_file);
    if let Some(new_title) = filename {
        let new_title = new_title.trim_end_matches(".md").to_string();
        let mf = read_lock(&state.memo_file, "memo_file");
        match mf.rename_memo(&id, &new_title) {
            Ok(_) => {
                drop(mf);
                if let Some(body) = content {
                    let _ = read_lock(&state.memo_file, "memo_file").write_memo(&id, &body);
                }
                emit_updated_after_write(state.inner(), &app, &id);
                return true;
            }
            Err(e) => {
                eprintln!("[update_memo_db] rename_memo failed: {e}");
                return false;
            }
        }
    }
    // 浠?content 鏇存柊
    if let Some(body) = content {
        match read_lock(&state.memo_file, "memo_file").write_memo(&id, &body) {
            Ok(_) => {
                emit_updated_after_write(state.inner(), &app, &id);
                return true;
            }
            Err(e) => {
                eprintln!("[update_memo_db] write_memo failed: {e}");
                return false;
            }
        }
    }
    // 浠?metadata
    if preview.is_some() {
        let mut updated = current;
        if let Some(p) = preview {
            updated.preview = p;
        }
        updated.updated_at = chrono::Utc::now().timestamp_millis();
        return state
            .memo_file
            .read()
            .unwrap()
            .sync_metadata_only(&updated)
            .is_ok();
    }
    false
}

#[tauri::command]
pub fn finalize_memo_filename(id: String, state: State<AppState>, app: AppHandle) -> bool {
    // v3: 鏃х増 `finalize_memo_filename` 鐨?璇?.md 鈫?娲剧敓 title 鈫?鍐欏洖"璇箟,
    // 宸插悎骞惰繘 `write_memo` (姣忔鍐欓兘閲嶆柊娲剧敓 title/frontmatter)銆傝繖閲?    // 淇濈暀绌哄疄鐜? 鍏煎鑰佽皟鐢ㄦ柟, 鍐欎竴娆?no-op銆?    let _ = (id, state, app);
    true
}

#[tauri::command]
pub fn favorite_memo(id: String, state: State<AppState>, app: AppHandle) -> bool {
    let Some(mut memo) = read_memo_or_none(state.inner(), &id) else {
        return false;
    };
    memo.favorited = true;
    memo.updated_at = chrono::Utc::now().timestamp_millis();
    if read_lock(&state.memo_file, "memo_file")
        .sync_metadata_only(&memo)
        .is_err()
    {
        return false;
    }
    emit_updated_after_write(state.inner(), &app, &id);
    true
}

#[tauri::command]
pub fn unfavorite_memo(id: String, state: State<AppState>, app: AppHandle) -> bool {
    let Some(mut memo) = read_memo_or_none(state.inner(), &id) else {
        return false;
    };
    memo.favorited = false;
    memo.updated_at = chrono::Utc::now().timestamp_millis();
    if state
        .memo_file
        .read()
        .unwrap()
        .sync_metadata_only(&memo)
        .is_err()
    {
        return false;
    }
    emit_updated_after_write(state.inner(), &app, &id);
    true
}

#[tauri::command]
pub fn set_memo_colors(
    id: String,
    colors: Vec<MemoColor>,
    state: State<AppState>,
    app: AppHandle,
) -> bool {
    let Some(mut memo) = read_memo_or_none(state.inner(), &id) else {
        return false;
    };
    memo.colors = colors;
    memo.updated_at = chrono::Utc::now().timestamp_millis();
    if state
        .memo_file
        .read()
        .unwrap()
        .sync_metadata_only(&memo)
        .is_err()
    {
        return false;
    }
    emit_updated_after_write(state.inner(), &app, &id);
    true
}

// ==================== 版本 ====================

#[tauri::command]
pub fn list_memo_versions(id: String, state: State<AppState>) -> Vec<MemoVersionMeta> {
    read_lock(&state.memo_file, "memo_file").list_memo_versions(&id)
}

#[tauri::command]
pub fn read_memo_version(id: String, version_id: String, state: State<AppState>) -> Option<String> {
    read_lock(&state.memo_file, "memo_file").read_memo_version(&id, &version_id)
}

#[tauri::command]
pub fn create_memo_version(
    id: String,
    source: Option<MemoVersionSource>,
    state: State<AppState>,
) -> Option<MemoVersionMeta> {
    let path = read_lock(&state.memo_file, "memo_file").find_memo_file_path(&id)?;
    let content = fs::read_to_string(path).ok()?;
    match read_lock(&state.memo_file, "memo_file").create_memo_version(
        &id,
        &content,
        source.unwrap_or(MemoVersionSource::Manual),
    ) {
        Ok(version) => version,
        Err(e) => {
            eprintln!("[create_memo_version] failed for {id}: {e}");
            None
        }
    }
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn restore_memo_version(
    id: String,
    version_id: String,
    expectedContent: Option<String>,
    state: State<AppState>,
    app: AppHandle,
) -> Option<WriteDocumentResult> {
    let target_content =
        read_lock(&state.memo_file, "memo_file").read_memo_version(&id, &version_id)?;
    let current_path = read_lock(&state.memo_file, "memo_file").find_memo_file_path(&id)?;
    let current_content = fs::read_to_string(&current_path).ok()?;

    if let Some(expected) = expectedContent.as_deref() {
        if !cas_content_matches(&current_content, expected, &target_content) {
            eprintln!(
                "[restore_memo_version] CAS refused: key={} disk != expected",
                id
            );
            return None;
        }
    }

    if let Err(e) = read_lock(&state.memo_file, "memo_file").create_memo_version(
        &id,
        &current_content,
        MemoVersionSource::RestoreBackup,
    ) {
        eprintln!("[restore_memo_version] backup version failed for {id}: {e}");
        return None;
    }

    mark_self_write_for(&app, &current_path);
    match read_lock(&state.memo_file, "memo_file")
        .write_memo_renaming_on_title_change(&id, &target_content)
    {
        Ok(_) => {
            emit_updated_after_write(state.inner(), &app, &id);
            let final_path = read_lock(&state.memo_file, "memo_file").find_memo_file_path(&id)?;
            let final_content = fs::read_to_string(&final_path).ok()?;
            Some(WriteDocumentResult {
                path: final_path.to_string_lossy().to_string(),
                content: final_content,
            })
        }
        Err(e) => {
            eprintln!("[restore_memo_version] restore failed for {id}: {e}");
            None
        }
    }
}

#[tauri::command]
pub fn delete_memo_version(id: String, version_id: String, state: State<AppState>) -> bool {
    read_lock(&state.memo_file, "memo_file").delete_memo_version(&id, &version_id)
}

// ==================== 鍒犻櫎 ====================

#[tauri::command]
pub fn delete_memo(id: String, state: State<AppState>, app: AppHandle) -> bool {
    try_index_remove(state.inner(), &id);
    let abs_path = abs_path_for(state.inner(), &id);
    // Mark before deleting so the watcher suppresses our own remove event.
    if !abs_path.is_empty() {
        mark_self_write_for(&app, Path::new(&abs_path));
    }
    let ok = read_lock(&state.memo_file, "memo_file").delete_memo(&id);
    if ok {
        memo_events::emit(&app, MemoEvent::Deleted { id, path: abs_path });
    }
    ok
}

#[tauri::command]
pub fn clear_memos(notebook_id: Option<String>, state: State<AppState>, app: AppHandle) -> bool {
    let mut deleted_paths: Vec<(String, String)> = Vec::new();
    let success = {
        if let Some(ref id) = notebook_id {
            write_lock(&state.memo_file, "memo_file").set_current_notebook(Some(id.clone()));
        }
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let memos = memo_file.read_all_memos_filtered("all", "createdAt", None);
        drop(memo_file);
        let mut success = true;
        for memo in memos {
            let abs_path = {
                let mf = read_lock(&state.memo_file, "memo_file");
                mf.find_memo_file_path(&memo.id)
                    .map(|p| p.display().to_string())
                    .unwrap_or_default()
            };
            if !abs_path.is_empty() {
                mark_self_write_for(&app, Path::new(&abs_path));
            }
            if !read_lock(&state.memo_file, "memo_file").delete_memo(&memo.id) {
                success = false;
                continue;
            }
            deleted_paths.push((memo.id, abs_path));
        }
        success
    };
    if success {
        force_rebuild_index(state.inner(), &app);
    }
    for (id, path) in &deleted_paths {
        memo_events::emit(
            &app,
            MemoEvent::Deleted {
                id: id.clone(),
                path: path.clone(),
            },
        );
    }
    success
}

/// 鏆撮湶 `<notebook>/.metadata/index.json` 鐨勬枃浠跺悕甯搁噺缁欏墠绔€?///
/// 閬垮厤鍓嶇纭紪鐮?`index.json` (memo-list 鐩存帴璇昏繖涓枃浠跺仛 cold-start parse),
/// 鍚庣画鑻ユ崲鏂囦欢鍚?(鎴栨敮鎸?per-notebook 鏀瑰悕) 鍙渶鏀?`MEMO_INDEX_FILENAME` 涓€澶勩€?
#[tauri::command]
pub fn get_index_filename() -> String {
    flowix_core::memo_file::MEMO_INDEX_FILENAME.to_string()
}
