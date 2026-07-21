//! Tauri IPC 鍛戒护鎬诲叆鍙?鈥?鎸変笟鍔″煙鎷嗗垎鍒板瓙妯″潡銆?//!
//! ## 鎷嗗垎 (v2 鈥?2026/06 閲嶆瀯)
//!
//! 鏃?`commands.rs` 鍗曟枃浠?1645 琛? 52 涓?`#[tauri::command]` 璺?12 涓笟鍔″煙
//! 娣峰湪涓€璧枫€傛媶鎴?
//!
//! - [`mod@helpers`]   鈥?璺ㄥ煙 helper (绱㈠紩 / notebook 鍒囨崲 / 璺緞 scope / 鑷啓鎶戝埗 / markdown 瑙ｆ瀽)
//! - [`mod@settings`]  鈥?`~/.flowix/boot/preference.json` + `~/.flowix/agent-config.toml` 璇诲啓
//! - [`mod@kv`]        鈥?`~/.flowix/boot/system.json` system metadata
//! - [`mod@memo`]      鈥?绗旇 CRUD + 鎼滅储 + Doc 鍚堝苟(鍔?memo index / .md 鏂囦欢鐨勫叏杩涜繖)
//! - [`mod@tag`]       鈥?tag 娲剧敓 + (todo: 澧炲垹鏀?stub)
//! - [`mod@notebook`]  鈥?notebook 鍒囨崲 / 澧炲垹 / CRUD
//! - [`mod@file`]      鈥?浠绘剰鏂囦欢鐨?in-notebook tree / read / write
//! - [`mod@dialog`]    鈥?鍘熺敓 dialog + 闄勪欢淇濆瓨 + base64
//! - [`mod@agent`]     鈥?LLM 娴佸紡 chat + abort
//! - [`mod@thread`]    鈥?瀵硅瘽绾跨▼ CRUD
//! - [`mod@window`]    鈥?preferences 绐楀彛鎵撳紑/鑱氱劍
//!
//! ## 鍏叡 API 淇濇寔涓嶅彉
//!
//! `tauri::generate_handler![commands::xxx, ...]` (lib.rs:347-402) 涓?//! `crate::watcher::current_watcher` / `crate::commands::markdown_paths_from_args`
//! 鐨勫紩鐢ㄨ矾寰?*鍏ㄩ儴涓嶅彉** 鈥?鏈枃浠?`pub use` 鎶婃瘡涓瓙妯″潡鐨?IPC 鍑芥暟閲嶆柊
//! 鏆撮湶鍒?`commands::xxx` 鍛藉悕绌洪棿銆?//!
//! ## `AppState` 鏄墍鏈?IPC 鍛戒护鐨勫叡浜姸鎬?//!
//! 瀛愭ā鍧楅€氳繃 [`crate::app::state::AppState`] 璁块棶, 瀛楁鍏?`pub`, 鍚勫煙
//! 鑷绾﹀畾"璇?vs 鍐? 鈥?渚嬪 `memo_file` 鍐欏懡浠ゅ繀鎷?`write()`, 璇诲懡浠?`read()`銆?
// ==================== 瀛愭ā鍧?====================

// 瀛愭ā鍧椾竴寰?`pub` 鈥?`tauri::generate_handler![commands::<sub>::xxx]` 鍦?// `lib.rs::run()` 閲岃蛋瀹屾暣璺緞, 闇€瑕?`pub` 鍙鎬с€俙#[tauri::command]` 瀹?// 鐢熸垚鐨?`__cmd__xxx` 鍏勫紵瀹忎篃瑕佹眰瀛愭ā鍧楁槸 `pub`, 鍚﹀垯瀹忚В鏋愪笉鍒般€?
pub mod agent;
pub mod agent_access;
pub mod cli;
pub mod dialog;
pub mod external_document;
pub mod external_document_watch;
pub mod file;
pub mod font;
pub mod helpers;
pub mod kv;
pub mod memo;
pub mod notebook;
pub mod product;
pub mod settings;
pub mod tab_window;
pub mod tag;
pub mod thread;
pub mod web;
pub mod window;

// ==================== IPC 鍛戒护 re-export ====================
//
// `tauri::generate_handler![commands::<sub>::xxx]` 鍦?`lib.rs::run()` 閲岃蛋瀹屾暣
// 璺緞, 鎵€浠?`pub use` re-export 涓嶅啀琚?IPC handler 鐢ㄥ埌銆備絾鏈変袱涓緥澶栦粛淇濈暀:
//
// - `markdown_paths_from_args` 鈥?`lib.rs:324` 鍦?single_instance 闂寘閲岄€氳繃
//   `commands::markdown_paths_from_args` 璋? 鍚屾牱鐣?re-export銆?//
// 鍏朵粬 IPC 閮介€氳繃 `commands::<sub>::xxx` 璧板瓙妯″潡璺緞鐩存帴璁块棶, 涓嶅啀 re-export銆?// 鎯冲姞鏂?IPC 涓嶇敤鍔ㄨ繖涓枃浠? 璺?memo_file 鎷嗗垎鍚庣殑椋庢牸淇濇寔涓€鑷淬€?
// helpers (璺ㄦā鍧楁秷璐? 鐣?re-export)
pub use helpers::markdown_paths_from_args;
