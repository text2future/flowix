use std::time::Duration;

// ============== limits ==============
//
// 璺?LLM 璋冪敤鐨勮涔変笂闄?(schema `maximum`) 瀵归綈 鈹€鈹€ 缁?LLM 鐪嬪埌鐨?鏈€澶?100
// 鏉＄粨鏋?灏辨槸鐪熶笂闄? 涓嶈 LLM 璇互涓鸿兘鎷垮埌鏇村銆?瀹為檯鍐呴儴澶氭敹 1 鏉＄敤浣?// truncated 鏍囪銆?
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

// glob / grep 璧?`spawn_blocking`, 鍐呴儴鍔犻澶栫‖涓婇檺 鈹€鈹€ 闃?LLM 璇紶
// `limit=1000` 鍦ㄧ櫨涓囨枃浠剁洰褰曢噷鎶?worker 鍗℃銆?瓒呭嚭涓婇檺灏辨爣 truncated
// 璁?LLM 鑷籂 (缂╃獎 path / 璋冮珮 specificity)銆?
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
pub(super) const MAX_GREP_FILE_BYTES: u64 = 4 * 1024 * 1024; // 鍗曟枃浠?> 4MB 璺宠繃
pub(super) const MAX_GREP_TOTAL_BYTES: u64 = 64 * 1024 * 1024; // 鍏ㄥ眬璇荤洏瀛楄妭棰勭畻
pub(super) const MAX_GREP_WALLCLOCK: Duration = Duration::from_secs(2);
pub(super) const WRITE_KEY_REREAD_INTERVAL: Duration = Duration::from_millis(100);
pub(super) const WRITE_KEY_REREAD_TIMEOUT: Duration = Duration::from_secs(2);
