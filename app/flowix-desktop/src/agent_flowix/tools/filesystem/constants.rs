use std::time::Duration;

// ============== limits ==============
//
// 跟 LLM 调用的语义上限 (schema `maximum`) 对齐 ── 给 LLM 看到的"最多 100
// 条结果"就是真上限, 不让 LLM 误以为能拿到更多。 实际内部多收 1 条用作
// truncated 标记。
pub(super) const DEFAULT_READ_LIMIT: usize = 20_000;
pub(super) const MAX_READ_LIMIT: usize = 100_000;
pub(super) const DEFAULT_READ_LINE_COUNT: usize = 80;
pub(super) const MAX_READ_LINE_COUNT: usize = 1_000;
pub(super) const DEFAULT_LIST_LIMIT: usize = 200;
pub(super) const MAX_LIST_LIMIT: usize = 1_000;
pub(super) const DEFAULT_GREP_LIMIT: usize = 100;
pub(super) const MAX_GREP_LIMIT: usize = 500;
pub(super) const MAX_EDIT_MATCH_CANDIDATE_CHARS: usize = 500;
pub(super) const MAX_EDIT_MATCH_SCAN_LINES: usize = 10_000;
pub(super) const MAX_EDIT_FUZZY_DISTANCE: usize = 20;

// glob / grep 走 `spawn_blocking`, 内部加额外硬上限 ── 防 LLM 误传
// `limit=1000` 在百万文件目录里把 worker 卡死。 超出上限就标 truncated
// 让 LLM 自纠 (缩窄 path / 调高 specificity)。
pub(super) const MAX_GLOB_FILES: usize = 3_000;
pub(super) const MAX_GLOB_SCAN_FILES: usize = 30_000;
pub(super) const GLOB_PRUNED_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".metadata",
    ".cache",
    ".next",
    ".nuxt",
    ".turbo",
    ".vite",
    "node_modules",
    "target",
    "dist",
    "build",
    "coverage",
];
pub(super) const MAX_GREP_FILES: usize = 5_000;
pub(super) const MAX_GREP_FILE_BYTES: u64 = 4 * 1024 * 1024; // 单文件 > 4MB 跳过
pub(super) const MAX_GREP_TOTAL_BYTES: u64 = 64 * 1024 * 1024; // 全局读盘字节预算
pub(super) const MAX_GREP_WALLCLOCK: Duration = Duration::from_secs(2);
pub(super) const WRITE_KEY_REREAD_INTERVAL: Duration = Duration::from_millis(100);
pub(super) const WRITE_KEY_REREAD_TIMEOUT: Duration = Duration::from_secs(2);
