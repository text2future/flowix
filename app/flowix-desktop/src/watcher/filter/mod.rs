//! Filter pipeline 鈥?`RawFsEvent` 涓叉帴澶氭 `Filter`銆?//!
//! 璁捐:
//! - `Filter::decide(event, &mut Ctx) -> FilterDecision`, `Pass` 鏀捐 (浜嬩欢琚?//!   鏇挎崲涓?`event` 鎴栨柊浜嬩欢), `Drop` 鎷掔粷骞惰 reason, `PassMutated` 鏀捐
//!   浣嗘浛鎹簨浠?(渚嬪璺緞瑙勮寖鍖栧悗)銆傜煭璺? 浠讳竴 Filter 杩斿洖 `Drop` 鍚庣画涓嶅啀鎵ц銆?//! - `FilterCtx` 鏄?filter 闂村叡浜殑鍙彉鐘舵€?(recent_self_writes / last_emit /
//!   watcher 鍙ユ焺) 鈥?鍚屼竴 watcher 鎸佹湁涓€浠? callback 闂寘
//!   寮曠敤瀹冦€?//! - 璺戦『搴忎负 PathFilter 鈫?SelfWriteSuppressor 鈫?Debouncer銆?//!   ExtensionFilter 鐢?WhitelistConfig 瑕嗙洊, 闆嗘垚鍦?//!   PathFilter 閲?(澶嶇敤鍚屼竴娆?path 妫€鏌?, 涓嶅崟鐙垚娈典互鐪佷竴娆?path 鎿嶄綔銆?//!
//! Concrete stages live in the sibling modules; this module owns shared state
//! and pipeline composition.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::event::{FilterDecision, RawFsEvent};
use debouncer::Debouncer;
use self_write::SelfWriteSuppressor;

pub mod debouncer;
pub mod id_dedup;
pub mod path_filter;
pub mod self_write;

pub use path_filter::PathFilter;

/// 鑷啓鎶戝埗鐨?TTL 鈥?2 绉掋€傝鐩栫粷澶ч儴鍒?IPC 鍛戒护缁撴潫 鈫?notify 鍥炶皟鍒拌揪鐨勯棿闅斻€?
pub const SELF_WRITE_TTL: Duration = Duration::from_secs(2);
/// 璺緞闃叉姈绐楀彛 鈥?150ms銆傝鐩?macOS FSEvents 鍦?save 鏃跺伓鍙戠殑鍙岃Е鍙戙€?
pub const DEBOUNCE: Duration = Duration::from_millis(150);
/// Filter 鍏变韩鐨?杩愯鏃朵笂涓嬫枃" 鈥?鐢?`MemoWatcher` 鍒涘缓, 闂寘鎹曡幏寮曠敤銆?///
/// 鍚?Filter 鑷敱璇诲啓鑷繁鍏冲績鐨勫瓧娈? 浜掍笉骞叉壈銆俙watcher` 鍙ユ焺淇濈暀
/// `mark_self_write` 鍏ュ彛銆?
pub struct FilterCtx {
    /// 鑷啓鎶戝埗琛? `normalized path -> 鏍囪鏃堕棿`銆傚懡涓嵆鍚? TTL 娓呯悊銆?
    pub recent_self_writes: Arc<Mutex<HashMap<PathBuf, Instant>>>,
    /// 璺緞闃叉姈琛? `normalized path -> 涓婃 emit 鏃堕棿`銆?50ms 鍐呭悶銆?
    pub last_emit: Arc<Mutex<HashMap<PathBuf, Instant>>>,
}

impl FilterCtx {
    /// 鏋勯€犱竴浠界┖ FilterCtx銆?棰勭暀 API, 涓昏矾寰勭敱 run_pipeline 鍐呴儴
    /// 浠?Arc 鎷艰涓嶈蛋 new(), 浣嗗閮ㄨ皟鐢ㄧ偣 (e.g. 鍗曟祴) 鍙互鐢ㄣ€?
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self {
            recent_self_writes: Arc::new(Mutex::new(HashMap::new())),
            last_emit: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// Filter trait 鈥?涓€娈垫鏌? 杩斿洖 Pass / PassMutated / Drop銆?
pub trait Filter: Send + Sync {
    /// `event` 鏄叆鍙備簨浠? 杩斿洖 `FilterDecision` 鍐冲畾鍘诲悜銆?
    fn decide(&self, event: &RawFsEvent, ctx: &mut FilterCtx) -> FilterDecision;
}

/// Pipeline 椤哄簭缁勮銆俙whitelist` 娉ㄥ叆鐧藉悕鍗? `ctx` 鏄?FilterCtx銆?///
/// 椤哄簭: PathFilter 鈫?SelfWriteSuppressor 鈫?Debouncer銆備换涓€ Drop 鐭矾銆?
pub fn run_pipeline(
    event: &RawFsEvent,
    recent: &Arc<Mutex<HashMap<PathBuf, Instant>>>,
    last_emit: &Arc<Mutex<HashMap<PathBuf, Instant>>>,
    path_filter: &PathFilter,
) -> FilterDecision {
    let mut ctx = FilterCtx {
        recent_self_writes: recent.clone(),
        last_emit: last_emit.clone(),
    };
    let stages: [&dyn Filter; 3] = [path_filter, &SelfWriteSuppressor, &Debouncer];
    for stage in stages {
        match stage.decide(event, &mut ctx) {
            FilterDecision::Pass => continue,
            other => return other,
        }
    }
    FilterDecision::Pass
}
