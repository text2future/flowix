//! `WhitelistConfig` 鈥?watcher 鐧?榛戝悕鍗曢厤缃€?//!
//! 涓夌被瑙勫垯:
//! - **skip_dirs**: 璺緞鍓嶇紑鍖归厤 (component-level, 涓嶅仛 substring 閬垮厤璇潃)
//! - **skip_files**: 鏂囦欢鍚?glob 鍖归厤
//! - **allowed_extensions**: 鎵╁睍鍚嶇櫧鍚嶅崟 (绌?= 鍏ㄩ儴鍏佽)
//!
//! 闄勫姞: `max_file_size` / `watch_hidden` 闃叉宸ㄥ瀷鏂囦欢鍜岄殣钘忔枃浠惰 watcher
//! 璇鐞嗐€?//!
//! 閰嶇疆鍔犺浇: `preference.json::watcher` 瀛楁, 杩愯鏃朵互 `Arc<RwLock<WhitelistConfig>>`
//! 鐑洿鏂?(`MemoWatcher::set_whitelist` + `lib.rs::setup` 涓殑 `user-config-changed` 鐩戝惉)銆?//! 鏈鍒拌瀛楁鏃惰蛋 `Default::default()`銆?//!
//! 涓庢棫 watcher 纭紪鐮佽鍒欑殑鍏崇郴:
//! - 鏃? `if path.components().any(|c| c.as_os_str() == ".metadata")`
//! - 鏂? `whitelist.allows(path)?` 涓€琛岃鐩? 琛屼负瀹屽叏涓€鑷?(榛樿 skip_dirs
//!   鍖呭惈 `.metadata`)

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::event::DropReason;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhitelistConfig {
    /// 榛戝悕鍗曠洰褰?(component-level prefix)
    pub skip_dirs: Vec<String>,
    /// 榛戝悕鍗曟枃浠?glob (鍖归厤 file_name 閮ㄥ垎)
    pub skip_files: Vec<String>,
    /// 鎵╁睍鍚嶇櫧鍚嶅崟 (灏忓啓, 涓嶅惈 `.`)銆傜┖鏁扮粍 = 鍏ㄩ儴鍏佽
    pub allowed_extensions: Vec<String>,
    /// 鍗曟枃浠跺ぇ灏忎笂闄?(瀛楄妭), None = 涓嶉檺
    pub max_file_size: Option<u64>,
    /// 闅愯棌鏂囦欢 (`.xxx`) 鏄惁鐩戞帶
    pub watch_hidden: bool,
    /// 鏂囦欢鍚?glob 鐧藉悕鍗?(涓?allowed_extensions 鍙栦氦闆? 绌?= 涓嶉檺)
    pub allowed_filename_patterns: Vec<String>,
}

impl Default for WhitelistConfig {
    fn default() -> Self {
        Self {
            skip_dirs: vec![
                ".metadata".into(),
                ".git".into(),
                ".DS_Store".into(),
                "node_modules".into(),
                ".cache".into(),
                ".trash".into(),
                // 闄勪欢鐩綍: 鐢ㄦ埛浠庨檮浠堕€夋嫨鍣ㄩ€変簡涓€涓?.md 鏂囦欢鏃? 鍚庣
                // save_attachment / save_attachment_content 浼氭妸鏂囦欢澶嶅埗
                // 鍒?<notebook>/attachments/<name>.md. 璇ョ洰褰曚笅鐨?.md 涓?                // 鏄?memo, 涓嶅簲琚?watcher 瑙ｆ瀽涓烘柊绗旇 (浼氭薄鏌撳垪琛?
                // 浜х敓"鏃犳硶鎵撳紑"鐨勫绔嬭褰?. attachments-cache 鍚岀悊.
                "attachments".into(),
                "attachments-cache".into(),
            ],
            skip_files: vec![
                "*.tmp".into(),
                "*.swp".into(),
                "*~".into(),
                ".DS_Store".into(),
                "Thumbs.db".into(),
                "*.bak".into(),
                "*.lock".into(),
            ],
            allowed_extensions: vec!["md".into(), "markdown".into()],
            max_file_size: Some(50 * 1024 * 1024), // 50MB
            watch_hidden: false,
            allowed_filename_patterns: Vec::new(),
        }
    }
}

impl WhitelistConfig {
    /// 鍔犺浇鎴栬繑鍥為粯璁ゃ€?瀹為檯璇诲彇鍦?`lib.rs::setup` 涓畬鎴?    /// (浠?`preference.json::watcher` 璇昏捣, 璋?`set_whitelist` 娉ㄥ叆),
    /// 鏈柟娉曚粎浣?fallback (鑰侀厤缃枃浠剁己瀛楁 鈫?榛樿)銆?
    pub fn load_or_default() -> Self {
        Self::default()
    }

    /// 璺緞鏄惁閫氳繃鐧藉悕鍗曟鏌ャ€傝繑鍥?`Ok(())` 鏀捐, `Err(DropReason)` 鎷掔粷銆?
    pub fn allows(&self, path: &Path) -> Result<(), DropReason> {
        // 1. 闅愯棌鏂囦欢
        if !self.watch_hidden {
            if path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with('.'))
                .unwrap_or(false)
            {
                return Err(DropReason::PathNotWhitelisted);
            }
        }

        // 2. 璺宠繃鐩綍 (component-level)
        for skip in &self.skip_dirs {
            // `.metadata` 鍗曠嫭鏍囪 (鍘嗗彶浠ｇ爜鏄惧紡 skip, 娌跨敤 DropReason::MetadataDirectory)
            let reason = if skip == ".metadata" {
                DropReason::MetadataDirectory
            } else {
                DropReason::PathBlacklisted
            };
            if path.components().any(|c| c.as_os_str() == skip.as_str()) {
                return Err(reason);
            }
        }

        // 3. 璺宠繃鏂囦欢 glob
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            for pattern in &self.skip_files {
                if glob_match(pattern, name) {
                    return Err(DropReason::PathBlacklisted);
                }
            }
        }

        // 4. 鎵╁睍鍚嶇櫧鍚嶅崟
        if !self.allowed_extensions.is_empty() {
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .unwrap_or_default();
            if !self
                .allowed_extensions
                .iter()
                .any(|e| e.to_ascii_lowercase() == ext)
            {
                return Err(DropReason::ExtensionMismatch);
            }
        }

        // 5. 鏂囦欢澶у皬 (浠呭綋鏂囦欢瀛樺湪)
        if let Some(max) = self.max_file_size {
            if let Ok(meta) = path.metadata() {
                if meta.len() > max {
                    return Err(DropReason::FileTooLarge);
                }
            }
        }

        Ok(())
    }
}

/// 绠€鏄?glob 鍖归厤 鈥?浠呮敮鎸?`*` (浠绘剰瀛楃搴忓垪)銆俙?` / `[..]` 涓嶆敮鎸?
/// 褰撳墠 `skip_files` 鍒楄〃閲岀敤涓嶅埌銆?///
/// 鏇夸唬 `glob` crate 鐨勫紑閿€: 鏂囦欢鍚嶉暱搴?< 256, 瀹屽叏鍙互鐢ㄦ墜鍐?DP,
/// 浣嗚繖閲?`glob_match` 绠€鍗曢€掑綊, 鎬ц兘瓒冲 (姣忕鍗冩绾у埆)銆?
fn glob_match(pattern: &str, name: &str) -> bool {
    glob_match_inner(pattern.as_bytes(), name.as_bytes())
}

fn glob_match_inner(p: &[u8], n: &[u8]) -> bool {
    match (p.first(), n.first()) {
        (None, None) => true,
        (Some(b'*'), _) => {
            // `*` 鍖归厤浠绘剰搴忓垪: 灏濊瘯璺宠繃 0..n 浠绘剰鍓嶇紑
            for i in 0..=n.len() {
                if glob_match_inner(&p[1..], &n[i..]) {
                    return true;
                }
            }
            false
        }
        (Some(a), Some(b)) if a == b => glob_match_inner(&p[1..], &n[1..]),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_allows_md_files() {
        let w = WhitelistConfig::default();
        assert!(w.allows(Path::new("/x/note.md")).is_ok());
        assert!(w.allows(Path::new("/x/Note.MD")).is_ok()); // 澶у皬鍐欎笉鏁忔劅
        assert!(w.allows(Path::new("/x/note.markdown")).is_ok());
    }

    #[test]
    fn default_rejects_non_md() {
        let w = WhitelistConfig::default();
        assert_eq!(
            w.allows(Path::new("/x/foo.txt")),
            Err(DropReason::ExtensionMismatch)
        );
        assert_eq!(
            w.allows(Path::new("/x/foo")),
            Err(DropReason::ExtensionMismatch)
        );
    }

    #[test]
    fn default_skips_metadata_dir() {
        let w = WhitelistConfig::default();
        assert_eq!(
            w.allows(Path::new("/x/.metadata/internal.tmp")),
            Err(DropReason::MetadataDirectory)
        );
    }

    #[test]
    fn default_skips_blacklisted_files() {
        let w = WhitelistConfig::default();
        assert_eq!(
            w.allows(Path::new("/x/.DS_Store")),
            Err(DropReason::PathNotWhitelisted) // 闅愯棌鏂囦欢浼樺厛
        );
        // 闈為殣钘忕殑榛戝悕鍗曟枃浠?- *.tmp 鍙尮閰?".tmp" 缁撳熬, ".tmp.md" 涓嶅尮閰?        // (涓存椂鏂囦欢鍦烘櫙涓? 鐢ㄦ埛鐢?*.tmp.md 杩欑甯﹀悗缂€鐨? 琛屼负搴斿綋鏀捐璁?watcher 閲嶅懡鍚嶅鐞?
        assert!(w.allows(Path::new("/x/notes.tmp.md")).is_ok());
        // 绾?.tmp 鍛戒腑
        assert_eq!(
            w.allows(Path::new("/x/notes.tmp")),
            Err(DropReason::PathBlacklisted)
        );
    }

    #[test]
    fn default_skips_hidden() {
        let w = WhitelistConfig::default();
        assert_eq!(
            w.allows(Path::new("/x/.hidden.md")),
            Err(DropReason::PathNotWhitelisted)
        );
    }

    #[test]
    fn watch_hidden_true_allows_dots() {
        let mut w = WhitelistConfig::default();
        w.watch_hidden = true;
        // .metadata 浠嶇劧榛戝悕鍗曚紭鍏?
        assert_eq!(
            w.allows(Path::new("/x/.metadata/x.md")),
            Err(DropReason::MetadataDirectory)
        );
        // .DS_Store 浠嶇劧榛戝悕鍗?
        assert_eq!(
            w.allows(Path::new("/x/.DS_Store")),
            Err(DropReason::PathBlacklisted)
        );
        // 鏅€氶殣钘?.md 鏀捐
        assert!(w.allows(Path::new("/x/.hidden.md")).is_ok());
    }

    #[test]
    fn custom_skip_dirs() {
        let mut w = WhitelistConfig::default();
        w.skip_dirs.push("attachments-cache".into());
        assert_eq!(
            w.allows(Path::new("/x/attachments-cache/1.png")),
            Err(DropReason::PathBlacklisted)
        );
    }

    #[test]
    fn file_size_limit() {
        let mut w = WhitelistConfig::default();
        w.max_file_size = Some(10);
        // 涓嶅瓨鍦ㄧ殑鏂囦欢: 璺宠繃 size 妫€鏌?(meta 澶辫触涓嶇畻瓒呴)
        assert!(w.allows(Path::new("/x/nonexistent.md")).is_ok());
        // 鍦?/tmp 涓嬪垱涓€涓?100 瀛楄妭鐨?.md 鏂囦欢 (涓存椂鐩綍鍦?macOS 涓婁互 . 寮€澶? 璧?        // skip_dirs 鍏滃簳; 杩欓噷鐢?std::env::temp_dir() 鏄惧紡璺緞, 璺冲紑闅愬惈鍋囪)
        let p = std::env::temp_dir().join("flowix_test_size.md");
        std::fs::write(&p, b"x".repeat(100)).unwrap();
        assert_eq!(w.allows(&p), Err(DropReason::FileTooLarge));
        // 鍚屾牱 10 瀛楄妭 鈫?鏀捐
        std::fs::write(&p, b"1234567890").unwrap();
        assert!(w.allows(&p).is_ok());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn glob_match_basic() {
        assert!(glob_match("*.tmp", "foo.tmp"));
        assert!(glob_match("*.tmp", "a.tmp"));
        assert!(!glob_match("*.tmp", "foo.txt"));
        assert!(glob_match("*~", "x~"));
        assert!(glob_match("Thumbs.db", "Thumbs.db"));
        assert!(!glob_match("Thumbs.db", "thumbs.db"));
    }
}
