//! Tauri IPC: `open_memo_by_target` 鈥?鎺ユ敹浠绘剰褰㈠紡鐨?鎵撳紑鐩爣", 瑙ｆ瀽 +
//! 钀界洏鏍￠獙 + emit `flowix:open-target` 缁欏墠绔€?鍓嶇鍋氱湡姝ｇ殑 UI 鍒囨崲銆?//!
//! 杩欐槸鍚庣"鏉冨▉瑙ｆ瀽"杈圭晫 鈹€鈹€ 鍓嶇鐑矾寰?绮樿创 / Agent / 璺ㄧ獥鍙?鎷夸笉鍒板畬鏁?//! notebook 淇℃伅, 涓€寰嬭蛋杩欎釜 IPC 璁╁悗绔煡纾佺洏銆?//!
//! ## 澶辫触璇箟
//!
//! - `Err(String)` 鈫?鍓嶇 await 鎶涢敊, 璋冪敤鏂?`try/catch` 闈欓粯 return銆?//! - 瑙ｆ瀽澶辫触 (`OpenTargetError`) / 瑙ｆ瀽鍚庢煡涓嶅埌 (`ResolveError`) 閮芥槧灏勫埌 `None`,
//!   鍓嶇瑙嗕负"鐢ㄦ埛绮樿创浜嗕笉瀛樺湪鐨勮矾寰?鎴?memo 宸茶鍒?, 闈欓粯 no-op銆?
use crate::events as dispatcher;
use tauri::{AppHandle, State};

use super::parser::parse_open_target;
use super::resolver::resolve_open_target;
use super::ResolvedOpenTarget;

/// Tauri command: 鎺ユ敹浠绘剰 `OpenTarget` 鍘熷瀛楃涓? 杩斿洖 `ResolvedOpenTarget`銆?///
/// 鍓綔鐢?
/// - emit `flowix:open-target` 浜嬩欢缁欐墍鏈夌獥鍙?(涓荤獥鍙ｄ紭鍏堝鐞?銆?
#[tauri::command]
pub fn open_memo_by_target(
    raw: String,
    emit_event: Option<bool>,
    state: State<'_, crate::app::state::AppState>,
    app: AppHandle,
) -> Option<ResolvedOpenTarget> {
    let parsed = match parse_open_target(&raw) {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!("[open_target] parse failed: {e}");
            return None;
        }
    };

    let resolved = match resolve_open_target(parsed, state.memo_file.as_ref()) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("[open_target] resolve failed: {e}");
            return None;
        }
    };

    // 鎺ㄥ墠绔? 涓荤獥鍙?+ 鍋忓ソ绐楀彛閮借兘鏀跺埌, 鐢卞墠绔?listener 鑷鍒ゆ柇鏄惁澶勭悊銆?    // 涓荤獥鍙?prefs 绐楀彛閮芥寕浜?listener (椤跺眰 app.tsx), 涓荤獥鍙ｈ礋璐ｇ湡姝ｆ墦寮€,
    // 鍋忓ソ绐楀彛鏀跺埌鍚庣洿鎺ュ拷鐣ャ€?    // emit_to 杩斿洖 bool 鐢ㄤ簬璇婃柇, 閿欒璺?agent.rs::emit_chunk 涓€鑷寸暀杩借釜銆?
    if emit_event.unwrap_or(true) && !dispatcher::emit_to(&app, "flowix:open-target", &resolved) {
        tracing::warn!("[open_target] emit failed (no subscribers or transport error)");
    }

    Some(resolved)
}
