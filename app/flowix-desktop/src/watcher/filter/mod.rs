//! Filter pipeline — `RawFsEvent` 串接多段 `Filter`。
//!
//! 设计:
//! - `Filter::decide(event, &mut Ctx) -> FilterDecision`, `Pass` 放行 (事件被
//!   替换为 `event` 或新事件), `Drop` 拒绝并记 reason, `PassMutated` 放行
//!   但替换事件 (例如路径规范化后)。短路: 任一 Filter 返回 `Drop` 后续不再执行。
//! - `FilterCtx` 是 filter 间共享的可变状态 (recent_self_writes / last_emit /
//!   watcher 句柄) — 同一 watcher 持有一份, callback 闭包
//!   引用它。
//! - 跑顺序为 PathFilter → SelfWriteSuppressor → Debouncer。
//!   ExtensionFilter 由 WhitelistConfig 覆盖, 集成在
//!   PathFilter 里 (复用同一次 path 检查), 不单独成段以省一次 path 操作。
//!
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

/// 自写抑制的 TTL — 2 秒。覆盖绝大部分 IPC 命令结束 → notify 回调到达的间隔。
pub const SELF_WRITE_TTL: Duration = Duration::from_secs(2);
/// 路径防抖窗口 — 150ms。覆盖 macOS FSEvents 在 save 时偶发的双触发。
pub const DEBOUNCE: Duration = Duration::from_millis(150);
/// Filter 共享的"运行时上下文" — 由 `MemoWatcher` 创建, 闭包捕获引用。
///
/// 各 Filter 自由读写自己关心的字段; 互不干扰。`watcher` 句柄保留
/// `mark_self_write` 入口。
pub struct FilterCtx {
    /// 自写抑制表: `normalized path -> 标记时间`。命中即吞, TTL 清理。
    pub recent_self_writes: Arc<Mutex<HashMap<PathBuf, Instant>>>,
    /// 路径防抖表: `normalized path -> 上次 emit 时间`。150ms 内吞。
    pub last_emit: Arc<Mutex<HashMap<PathBuf, Instant>>>,
}

impl FilterCtx {
    /// 构造一份空 FilterCtx。 预留 API, 主路径由 run_pipeline 内部
    /// 从 Arc 拼装不走 new(), 但外部调用点 (e.g. 单测) 可以用。
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self {
            recent_self_writes: Arc::new(Mutex::new(HashMap::new())),
            last_emit: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// Filter trait — 一段检查, 返回 Pass / PassMutated / Drop。
pub trait Filter: Send + Sync {
    /// `event` 是入参事件; 返回 `FilterDecision` 决定去向。
    fn decide(&self, event: &RawFsEvent, ctx: &mut FilterCtx) -> FilterDecision;
}

/// Pipeline 顺序组装。`whitelist` 注入白名单, `ctx` 是 FilterCtx。
///
/// 顺序: PathFilter → SelfWriteSuppressor → Debouncer。任一 Drop 短路。
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
