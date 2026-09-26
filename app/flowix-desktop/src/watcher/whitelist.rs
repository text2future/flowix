//! `WhitelistConfig` —watcher �?黑名单配�?�?//!
//! 涓夌被瑙勫垯:
//! - **skip_dirs**: 璺緞鍓嶇紑鍖归厤 (component-level, 涓嶅仛 substring 閬垮厤璇潃)
//! - **skip_files**: 文件�?glob 匹配
//! - **allowed_extensions**: 扩展名白名单 (�?= 全部允�?)
//!
//! 闄勫姞: `max_file_size` / `watch_hidden` 闃叉宸ㄥ瀷鏂囦欢鍜岄殣钘忔枃浠惰 watcher
//! 璇鐞嗐€?//!
//! 閰嶇疆鍔犺浇: `preference.json::watcher` 瀛楁, 杩愯鏃朵互 `Arc<RwLock<WhitelistConfig>>`
//! �?���?(`MemoWatcher::set_whitelist` + `lib.rs::setup` �?�� `user-config-changed` 监听)�?//! �??到�?字�?时走 `Default::default()`�?//!
//! 涓庢棫 watcher 纭紪鐮佽鍒欑殑鍏崇郴:
//! - 鏃? `if path.components().any(|c| c.as_os_str() == ".metadata")`
//! - �? `whitelist.allows(path)?` 一行�?�? 行为完全一�?(默�? skip_dirs
//!   鍖呭惈 `.metadata`)

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::event::DropReason;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhitelistConfig {
    /// 黑名单目�?(component-level prefix)
    pub skip_dirs: Vec<String>,
    /// 黑名单文�?glob (匹配 file_name 部分)
    pub skip_files: Vec<String>,
    /// 鎵╁睍鍚嶇櫧鍚嶅崟 (灏忓啓, 涓嶅惈 `.`)銆傜┖鏁扮粍 = 鍏ㄩ儴鍏佽
    pub allowed_extensions: Vec<String>,
    /// 单文件大小上�?(字节), None = 不限
    pub max_file_size: Option<u64>,
    /// 闅愯棌鏂囦欢 (`.xxx`) 鏄惁鐩戞帶
    pub watch_hidden: bool,
    /// 文件�?glob 白名�?(�?allowed_extensions 取交�? �?= 不限)
    pub allowed_filename_patterns: Vec<String>,
}

impl Default for WhitelistConfig {
    fn default() -> Self {
        Self {
            skip_dirs: vec![
                ".flowix".into(),
                ".metadata".into(),
                ".git".into(),
                ".DS_Store".into(),
                "node_modules".into(),
                ".cache".into(),
                ".trash".into(),
                // Plugin artifacts are implementation files, not notebook
                // notes. Their Markdown must never be registered by the
                // generic watcher; the plugin pointer note is the user-facing
                // entry in the notebook root.
                ".plugin-output".into(),
                // 附件�?��: 用户从附件选择器选了一�?.md 文件�? 后�?
                // save_attachment / save_attachment_content 浼氭妸鏂囦欢澶嶅埗
                // �?<notebook>/attachments/<name>.md. 该目录下�?.md �?                // �?memo, 不应�?watcher 解析为新笔�? (会污染列�?
                // 产生"无法打开"的�?立�?�?. attachments-cache 同理.
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
    /// 加载或返回默认�?实际读取�?`lib.rs::setup` �?���?    /// (�?`preference.json::watcher` 读起, �?`set_whitelist` 注入),
    /// �?��法仅�?fallback (老配�?��件缺字�? �?默�?)�?
    pub fn load_or_default() -> Self {
        Self::default()
    }

    /// �?���?��通过白名单�?查。返�?`Ok(())` 放�?, `Err(DropReason)` 拒绝�?
    pub fn allows(&self, path: &Path) -> Result<(), DropReason> {
        // `.flowix` is always a system directory. This check intentionally
        // precedes `watch_hidden`, so enabling hidden-file watching can never
        // expose internal versions or plugin artifacts as notes.
        if path
            .components()
            .any(|component| component.as_os_str() == ".flowix")
        {
            return Err(DropReason::MetadataDirectory);
        }

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

/// 简�?glob 匹配 —仅支�?`*` (任意字�?序列)。`?` / `[..]` 不支�?
/// 当前 `skip_files` 列表里用不到�?///
/// 替代 `glob` crate 的开销: 文件名长�?< 256, 完全�?��用手�?DP,
/// 但这�?`glob_match` 简单递归, 性能足�? (每�?千�?级别)�?
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
    fn flowix_dir_is_always_skipped_when_hidden_watching_is_enabled() {
        let mut w = WhitelistConfig::default();
        w.watch_hidden = true;
        assert_eq!(
            w.allows(Path::new("/x/.flowix/versions/memo/v_1.md")),
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
        // 非隐藏的黑名单文�?- *.tmp �?���?".tmp" 结尾, ".tmp.md" 不匹�?        // (临时文件场景�? 用户�?*.tmp.md 这�?带后缀�? 行为应当放�?�?watcher 重命名�?�?
        assert!(w.allows(Path::new("/x/notes.tmp.md")).is_ok());
        // �?.tmp 命中
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
        // .metadata 仍然黑名单优�?
        assert_eq!(
            w.allows(Path::new("/x/.metadata/x.md")),
            Err(DropReason::MetadataDirectory)
        );
        // .DS_Store 仍然黑名�?
        assert_eq!(
            w.allows(Path::new("/x/.DS_Store")),
            Err(DropReason::PathBlacklisted)
        );
        // �?��隐�?.md 放�?
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
    fn default_skips_plugin_output_directory() {
        let w = WhitelistConfig::default();
        assert_eq!(
            w.allows(Path::new("/x/.plugin-output/mindmap/output.md")),
            Err(DropReason::PathBlacklisted)
        );
    }

    #[test]
    fn root_agents_file_is_allowed_as_a_notebook_memo() {
        let mut w = WhitelistConfig::default();
        w.skip_files.clear();
        w.watch_hidden = true;
        assert!(w.allows(Path::new("/x/AGENTS.md")).is_ok());
    }

    #[test]
    fn file_size_limit() {
        let mut w = WhitelistConfig::default();
        w.max_file_size = Some(10);
        // 不存在的文件: 跳过 size 检�?(meta 失败不算超�?)
        assert!(w.allows(Path::new("/x/nonexistent.md")).is_ok());
        // �?/tmp 下创一�?100 字节�?.md 文件 (临时�?���?macOS 上以 . 开�? �?        // skip_dirs 兜底; 这里�?std::env::temp_dir() 显式�?��, 跳开隐含假�?)
        let p = std::env::temp_dir().join("flowix_test_size.md");
        std::fs::write(&p, b"x".repeat(100)).unwrap();
        assert_eq!(w.allows(&p), Err(DropReason::FileTooLarge));
        // 同样 10 字节 �?放�?
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
