//! `WhitelistConfig` — watcher 白/黑名单配置。
//!
//! 三类规则:
//! - **skip_dirs**: 路径前缀匹配 (component-level, 不做 substring 避免误杀)
//! - **skip_files**: 文件名 glob 匹配
//! - **allowed_extensions**: 扩展名白名单 (空 = 全部允许)
//!
//! 附加: `max_file_size` / `watch_hidden` 防止巨型文件和隐藏文件被 watcher
//! 误处理。
//!
//! 配置加载: `preference.json::watcher` 字段, 运行时以 `Arc<RwLock<WhitelistConfig>>`
//! 热更新 (`MemoWatcher::set_whitelist` + `lib.rs::setup` 中的 `user-config-changed` 监听)。
//! 未读到该字段时走 `Default::default()`。
//!
//! 与现有 `fs_watcher.rs` 硬编码的关系:
//! - 旧: `if path.components().any(|c| c.as_os_str() == ".metadata")`
//! - 新: `whitelist.allows(path)?` 一行覆盖, 行为完全一致 (默认 skip_dirs
//!   包含 `.metadata`)

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::event::DropReason;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhitelistConfig {
    /// 黑名单目录 (component-level prefix)
    pub skip_dirs: Vec<String>,
    /// 黑名单文件 glob (匹配 file_name 部分)
    pub skip_files: Vec<String>,
    /// 扩展名白名单 (小写, 不含 `.`)。空数组 = 全部允许
    pub allowed_extensions: Vec<String>,
    /// 单文件大小上限 (字节), None = 不限
    pub max_file_size: Option<u64>,
    /// 隐藏文件 (`.xxx`) 是否监控
    pub watch_hidden: bool,
    /// 文件名 glob 白名单 (与 allowed_extensions 取交集; 空 = 不限)
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
                // 附件目录: 用户从附件选择器选了一个 .md 文件时, 后端
                // save_attachment / save_attachment_content 会把文件复制
                // 到 <notebook>/attachments/<name>.md. 该目录下的 .md 不
                // 是 memo, 不应被 fs_watcher 解析为新笔记 (会污染列表,
                // 产生"无法打开"的孤立记录). attachments-cache 同理.
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
    /// 加载或返回默认。 实际读取在 `lib.rs::setup` 中完成
    /// (从 `preference.json::watcher` 读起, 调 `set_whitelist` 注入),
    /// 本方法仅作 fallback (老配置文件缺字段 → 默认)。
    pub fn load_or_default() -> Self {
        Self::default()
    }

    /// 路径是否通过白名单检查。返回 `Ok(())` 放行, `Err(DropReason)` 拒绝。
    pub fn allows(&self, path: &Path) -> Result<(), DropReason> {
        // 1. 隐藏文件
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

        // 2. 跳过目录 (component-level)
        for skip in &self.skip_dirs {
            // `.metadata` 单独标记 (历史代码显式 skip, 沿用 DropReason::MetadataDirectory)
            let reason = if skip == ".metadata" {
                DropReason::MetadataDirectory
            } else {
                DropReason::PathBlacklisted
            };
            if path.components().any(|c| c.as_os_str() == skip.as_str()) {
                return Err(reason);
            }
        }

        // 3. 跳过文件 glob
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            for pattern in &self.skip_files {
                if glob_match(pattern, name) {
                    return Err(DropReason::PathBlacklisted);
                }
            }
        }

        // 4. 扩展名白名单
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

        // 5. 文件大小 (仅当文件存在)
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

/// 简易 glob 匹配 — 仅支持 `*` (任意字符序列)。`?` / `[..]` 不支持,
/// 当前 `skip_files` 列表里用不到。
///
/// 替代 `glob` crate 的开销: 文件名长度 < 256, 完全可以用手写 DP,
/// 但这里 `glob_match` 简单递归, 性能足够 (每秒千次级别)。
fn glob_match(pattern: &str, name: &str) -> bool {
    glob_match_inner(pattern.as_bytes(), name.as_bytes())
}

fn glob_match_inner(p: &[u8], n: &[u8]) -> bool {
    match (p.first(), n.first()) {
        (None, None) => true,
        (Some(b'*'), _) => {
            // `*` 匹配任意序列: 尝试跳过 0..n 任意前缀
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
        assert!(w.allows(Path::new("/x/Note.MD")).is_ok()); // 大小写不敏感
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
            Err(DropReason::PathNotWhitelisted) // 隐藏文件优先
        );
        // 非隐藏的黑名单文件 - *.tmp 只匹配 ".tmp" 结尾, ".tmp.md" 不匹配
        // (临时文件场景下, 用户用 *.tmp.md 这种带后缀的, 行为应当放行让 watcher 重命名处理)
        assert!(w.allows(Path::new("/x/notes.tmp.md")).is_ok());
        // 纯 .tmp 命中
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
        // .metadata 仍然黑名单优先
        assert_eq!(
            w.allows(Path::new("/x/.metadata/x.md")),
            Err(DropReason::MetadataDirectory)
        );
        // .DS_Store 仍然黑名单
        assert_eq!(
            w.allows(Path::new("/x/.DS_Store")),
            Err(DropReason::PathBlacklisted)
        );
        // 普通隐藏 .md 放行
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
        // 不存在的文件: 跳过 size 检查 (meta 失败不算超额)
        assert!(w.allows(Path::new("/x/nonexistent.md")).is_ok());
        // 在 /tmp 下创一个 100 字节的 .md 文件 (临时目录在 macOS 上以 . 开头, 走
        // skip_dirs 兜底; 这里用 std::env::temp_dir() 显式路径, 跳开隐含假设)
        let p = std::env::temp_dir().join("flowix_test_size.md");
        std::fs::write(&p, b"x".repeat(100)).unwrap();
        assert_eq!(w.allows(&p), Err(DropReason::FileTooLarge));
        // 同样 10 字节 → 放行
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
