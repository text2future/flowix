//! Filter pipeline — `RawFsEvent` 串接多段 `Filter`。
//!
//! 设计:
//! - `Filter::decide(event, &mut Ctx) -> FilterDecision`, `Pass` 放行 (事件被
//!   替换为 `event` 或新事件), `Drop` 拒绝并记 reason, `PassMutated` 放行
//!   但替换事件 (例如路径规范化后)。短路: 任一 Filter 返回 `Drop` 后续不再执行。
//! - `FilterCtx` 是 filter 间共享的可变状态 (recent_self_writes / last_emit /
//!   watcher 句柄) — 同一 watcher 持有一份, callback 闭包
//!   引用它。
//! - 跑顺序跟设计文档 PR2 一致: PathFilter → SelfWriteSuppressor → Debouncer
//!   ExtensionFilter 由 WhitelistConfig 覆盖, 集成在
//!   PathFilter 里 (复用同一次 path 检查), 不单独成段以省一次 path 操作。
//!
//! 测试: 每个 filter 一个 #[cfg(test)] 块, 用伪造 FilterCtx 单测。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::event::{DropReason, FilterDecision, RawFsEvent};
use super::whitelist::WhitelistConfig;

pub mod debouncer;
pub mod id_dedup;
pub mod path_filter;
pub mod self_write;

/// 自写抑制的 TTL — 2 秒。覆盖绝大部分 IPC 命令结束 → notify 回调到达的间隔。
pub const SELF_WRITE_TTL: Duration = Duration::from_secs(2);
/// 路径防抖窗口 — 150ms。覆盖 macOS FSEvents 在 save 时偶发的双触发。
pub const DEBOUNCE: Duration = Duration::from_millis(150);
/// Filter 共享的"运行时上下文" — 由 `MemoWatcher` 创建, 闭包捕获引用。
///
/// 各 Filter 自由读写自己关心的字段; 互不干扰。`watcher` 句柄保留
/// `mark_self_write` 入口 (注: 段 4 id 二级兜底在 v3 已删除, extract_memo_id_from_abs_path 永远 None, 无意义)。
pub struct FilterCtx {
    /// 自写抑制表: `normalized path -> 标记时间`。命中即吞 (remove 一次性)。
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

/// 段 1: 路径白名单。集成 WhitelistConfig (扩展名 + skip_dirs + skip_files +
/// 隐藏文件 + max_file_size) 到一次决定里。
pub struct PathFilter {
    pub whitelist: Arc<std::sync::RwLock<WhitelistConfig>>,
}

impl Filter for PathFilter {
    fn decide(&self, event: &RawFsEvent, _ctx: &mut FilterCtx) -> FilterDecision {
        let allow = self
            .whitelist
            .read()
            .map(|g| g.allows(&event.path))
            .unwrap_or(Ok(()));
        match allow {
            Ok(()) => FilterDecision::Pass,
            Err(reason) => FilterDecision::Drop { reason },
        }
    }
}

/// 段 2: 自写抑制。`mark_self_write` 写过的路径, 命中即吞 (remove 一次性)。
pub struct SelfWriteSuppressor;

impl Filter for SelfWriteSuppressor {
    fn decide(&self, event: &RawFsEvent, ctx: &mut FilterCtx) -> FilterDecision {
        let key = super::path::normalize_for_compare(&event.path);
        let Ok(mut map) = ctx.recent_self_writes.lock() else {
            return FilterDecision::Pass;
        };
        // 顺手剪枝过老条目。SELF_WRITE_TTL (2s) 覆盖 IPC 命令结束 → notify
        // 回调到达的间隔, FSEvents 双触发 (macOS 把一次 fs::write 拆成
        // Metadata(Any) + Data(Content) 两条 Modify) 也都在窗内。
        map.retain(|_, t| t.elapsed() < SELF_WRITE_TTL);

        // 不 remove 表项 — FSEvents 双触发两条事件都要吞, remove 后第二条
        // 会 MISS 漏到 processor 走 "外部修改" 路径。 表项由上面的 retain
        // 走 2s TTL 兜底清理, 不会无限占位。
        if map.contains_key(&key) {
            tracing::debug!(
                "[SelfWriteSuppressor] HIT path={} key={} table_size={}",
                event.path.display(),
                key.display(),
                map.len(),
            );
            FilterDecision::Drop {
                reason: DropReason::SelfWriteSuppressed,
            }
        } else {
            tracing::debug!(
                "[SelfWriteSuppressor] MISS path={} key={} table_size={}",
                event.path.display(),
                key.display(),
                map.len(),
            );
            FilterDecision::Pass
        }
    }
}

/// 段 3: 路径防抖。150ms 内同路径事件吞。
pub struct Debouncer;

impl Filter for Debouncer {
    fn decide(&self, event: &RawFsEvent, ctx: &mut FilterCtx) -> FilterDecision {
        let key = super::path::normalize_for_compare(&event.path);
        let Ok(mut map) = ctx.last_emit.lock() else {
            return FilterDecision::Pass;
        };
        // 1.5s 滚动窗口 (DEBOUNCE * 10) 保留, 跟原 fs_watcher 行为一致。
        map.retain(|_, t| t.elapsed() < DEBOUNCE.saturating_mul(10));
        if let Some(last) = map.get(&key) {
            if last.elapsed() < DEBOUNCE {
                return FilterDecision::Drop {
                    reason: DropReason::Debounced,
                };
            }
        }
        map.insert(key, Instant::now());
        FilterDecision::Pass
    }
}

/// Pipeline 顺序组装。`whitelist` 注入白名单, `ctx` 是 FilterCtx。
///
/// 设计文档 PR2 5 段顺序: PathFilter → SelfWriteSuppressor → Debouncer →
/// 任一 Drop 短路。
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
