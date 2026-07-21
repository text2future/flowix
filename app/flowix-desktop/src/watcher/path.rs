//! 璺?watcher manager / filter 鍏变韩鐨勮矾寰勫綊涓€宸ュ叿銆?//!
//! `MemoWatcher::mark_self_write` 鍜?`SelfWriteSuppressor` / `Debouncer`
//! 閮界敤杩欓噷鐢熸垚 HashMap key, 閬垮厤鍐欑洏绔笌 notify 绔矾寰勫彛寰勪笉涓€鑷淬€?
use std::path::{Path, PathBuf};

/// 鎶?`Path` 褰掍竴鍒?`HashMap<PathBuf, _>` 鏌ヨ〃鍙ｅ緞銆?///
/// 浼樺厛鐢?`dunce::canonicalize` 鎶樺彔 symlink / `\\?\` 鍓嶇紑; 澶辫触 (鏂囦欢灏氭湭
/// 鍒涘缓 鈥?鍐欑洏鍓?mark 鐨勫父瑙佹儏褰? 閫€鍒?鍙?canonicalize 鐖剁洰褰? 鍐?join
/// 鏂囦欢鍚?, 鐖剁洰褰曞湪 notebook 鍒涘缓鏃跺凡缁忓瓨鍦? 杩欎竴姝ュ繀鐒舵垚鍔熴€傚嵆渚跨埗鐩綍
/// canonicalize 涔熷け璐? 閫€鍥炲師 path 瀛楃涓? 鑷冲皯涓嶄涪鎶戝埗 (閫€鍖栧埌绮剧‘鍖归厤)銆?
pub fn normalize_for_compare(path: &Path) -> PathBuf {
    if let Ok(canon) = dunce::canonicalize(path) {
        return canon;
    }
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        if let Ok(canon_parent) = dunce::canonicalize(parent) {
            return canon_parent.join(name);
        }
    }
    path.to_path_buf()
}
