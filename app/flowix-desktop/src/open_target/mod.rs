//! 鍏ㄥ眬"閫氳繃閾炬帴鎵撳紑绗旇"妯″潡 鈥?瑕嗙洊 3 涓満鏅?
//!
//! 1. 澶栭儴娣遍摼 `flowix://memo/<id>` (娴忚鍣?/ 缁堢 / 鍏跺畠 app 瑙﹀彂, 鍐峰惎鍔?+ 浜屾鍚姩)
//! 2. 浜у搧鍐呯墿鐞嗚矾寰?(e.g. `/Users/.../xxx#vex4v.md`)
//! 3. 浜у搧鍐呮繁閾?(Agent 杈撳嚭 / 璺ㄧ獥鍙?/ 澶嶅埗绮樿创)
//!
//! ## 鍒嗗眰
//!
//! - [`parser`]    鈥?绾瓧绗︿覆瑙ｆ瀽 (URL / 鐗╃悊璺緞 鈫?[`OpenTarget`])銆?鏃犲壇浣滅敤銆?//! - [`resolver`]  鈥?[`OpenTarget`] 鈫?[`ResolvedOpenTarget`] (鏌ョ鐩? 璺?notebook)銆?//! - [`handler`]   鈥?`#[tauri::command] open_memo_by_target` + emit `flowix:open-target`銆?//!
//! ## URL scheme
//!
//! - `flowix://memo/<memo-id>`              鈥?涓昏鍦烘櫙
//! - `flowix://open?path=<encoded-abs>`     鈥?鐗╃悊璺緞 (鍐呴儴璧?id 鎶?
//!
//! 鍚庣 IPC 鍛戒护鎺ユ敹**浠绘剰**鏍囪瘑绗﹀舰鎬?(URL / 鐗╃悊璺緞), 鍐呴儴缁?[`parse_open_target`]
//! 瑙勬暣鎴?[`OpenTarget`], 缁?[`resolve_open_target`] 鎷垮埌 [`ResolvedOpenTarget`],
//! 鎺?`flowix:open-target` 浜嬩欢缁欏墠绔€?鍓嶇鍋?鍒囨崲 notebook + 鎵撳紑 document"銆?
pub mod handler;
pub mod parser;
pub mod resolver;

// Re-exports 鐣欑粰娴嬭瘯 / 鏂囨。鐢? 鐪熸娉ㄥ唽鍒?Tauri IPC 鐨?`open_memo_by_target`
// 鍦?`lib.rs` 璧板畬鏁磋矾寰?`open_target::handler::open_memo_by_target`, 杩欐牱
// `#[tauri::command]` 瀹忕敓鎴愮殑 `__cmd__` 鍏勫紵绗﹀彿鎵嶈兘琚?`generate_handler!` 鎵惧埌銆?
#[allow(unused_imports)]
pub use parser::{parse_open_target, OpenTarget, OpenTargetError};
#[allow(unused_imports)]
pub use resolver::{resolve_open_target, ResolveError, ResolvedOpenTarget};
