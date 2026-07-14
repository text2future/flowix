//! `parse_open_target` — 把 URL / 物理路径 解析成 [`OpenTarget`]。
//!
//! **纯函数, 无副作用**: 不查磁盘, 不读配置。 重复跑零成本, 单测全栈覆盖。
//!
//! ## URL scheme 设计
//!
//! - `flowix://memo/<6-char-id>`            — 主要场景
//! - `flowix://memo/<6-char-id>?nb=<nid>`   — 跨 notebook hint (resolver 优先用)
//! - `flowix://open?path=<encoded-abs>`     — 物理路径 (内部抽 id)
//! - `file://<abs>`                          — 物理路径的 URL 形式 (兼容 macOS Finder 复制)
//! - 裸绝对路径 (以 `/` 开头)               — 物理路径直传
//!
//! ## memo id 格式约束
//!
//! memo id 格式: 6 字符 `[0-9a-z]{6}`。
//! 6 位 × 36 种 = 21.7 亿唯一 id, 单实例内基本无碰撞。

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 解析后、待路由的"打开请求"。 不绑定具体 notebook / memo, 只表达
/// "用户想打开什么"。 resolver 层再查磁盘 / memo index 落到具体 notebook。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    rename_all = "camelCase",
    tag = "kind",
    rename_all_fields = "snake_case"
)]
pub enum OpenTarget {
    /// 物理路径 — 走 memo index 扫所有 notebook 找匹配的 .md。
    PhysicalPath {
        path: String,
        memo_id: Option<String>,
    },
    /// 深链 `flowix://...` — memo_id 是必填主键, notebook_hint 可选。
    DeepLink {
        url: String,
        memo_id: Option<String>,
        notebook_hint: Option<String>,
        /// `flowix://open?path=` 时携带
        physical_path: Option<String>,
    },
}

#[derive(Debug, Error, Serialize)]
pub enum OpenTargetError {
    #[error("empty input")]
    Empty,
    #[error("invalid memo id: {0}")]
    InvalidMemoId(String),
    #[error("unknown route: {0}")]
    UnknownRoute(String),
    #[error("missing path query parameter")]
    MissingPath,
}

/// memo id 6 字符 `[0-9a-z]{6}`。
pub fn is_valid_memo_id(s: &str) -> bool {
    matches!(s.len(), 6 | flowix_core::memo_file::MEMO_ID_LENGTH)
        && s.chars()
            .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase())
}

fn percent_decode(s: &str) -> String {
    // 兜底: JS 端 url.pathname 已经 percent-decode 大部分, 后端 url crate 解
    // query 时也会解, 这里再做一道对裸字符串鲁棒。 失败按原值返回。
    percent_decode_strict(s).unwrap_or_else(|| s.to_string())
}

fn percent_decode_strict(s: &str) -> Option<String> {
    let mut out = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn split_scheme<'a>(raw: &'a str) -> Option<(&'a str, &'a str)> {
    // `flowix://memo/<id>` — 拆 scheme + 之后部分。
    //   - scheme 部分 (`flowix`) 大小写不敏感 (OS 投递时大小写不固定)
    //   - rest **保留**原大小写 ── memo id 在 memo index 里走 `[0-9a-z]`,
    //     任何大写字符都是无效 id, 直接在 `is_valid_memo_id` 里拒掉,
    //     不要预 lowercase 否则 `flowix://memo/ABCDEF` 会被误判为合法。
    let lower = raw.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("flowix://") {
        // 同样偏移在原 `raw` 上取 rest, 保持原大小写
        let original_rest = &raw[raw.len() - rest.len()..];
        Some(("flowix", original_rest))
    } else {
        None
    }
}

fn split_path_query(rest: &str) -> (String, Vec<(String, String)>) {
    // 简单 query 解析: `?k=v&k=v` → `[(k, v), ...]`
    // 不依赖 url crate (避免引入 'url' 依赖)。
    match rest.find('?') {
        Some(idx) => {
            let path = rest[..idx].to_string();
            let query = rest[idx + 1..].to_string();
            let pairs: Vec<(String, String)> = query
                .split('&')
                .filter(|s| !s.is_empty())
                .filter_map(|kv| {
                    let mut parts = kv.splitn(2, '=');
                    let k = parts.next()?.to_string();
                    let v = parts.next().unwrap_or("").to_string();
                    Some((percent_decode(&k), percent_decode(&v)))
                })
                .collect();
            (path, pairs)
        }
        None => (rest.to_string(), Vec::new()),
    }
}

fn get_query<'a>(pairs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    pairs
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v.as_str())
}

/// 解析原始输入 (URL / 物理路径) → [`OpenTarget`]。
pub fn parse_open_target(raw: &str) -> Result<OpenTarget, OpenTargetError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(OpenTargetError::Empty);
    }

    // 1. `flowix://` 深链
    if let Some((_, rest)) = split_scheme(trimmed) {
        return parse_deep_link(&rest, trimmed);
    }

    // 2. `file://` 物理路径 (macOS Finder 复制粘贴常见)
    if let Some(rest) = trimmed
        .strip_prefix("file://")
        .or_else(|| trimmed.strip_prefix("file:///"))
    {
        let decoded = percent_decode(rest);
        // v3: 物理 filename 不再带 `#<id>` 后缀, memo_id 由 resolver 走
        // memo index filename → id 反查; parser 阶段无法给 memo_id。
        return Ok(OpenTarget::PhysicalPath {
            path: decoded,
            memo_id: None,
        });
    }

    // 3. 裸绝对路径 / 任意字符 (resolver 拒掉非法)
    Ok(OpenTarget::PhysicalPath {
        path: trimmed.to_string(),
        memo_id: None,
    })
}

fn parse_deep_link(rest: &str, full: &str) -> Result<OpenTarget, OpenTargetError> {
    let (path, query) = split_path_query(rest);
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

    match segments.as_slice() {
        ["memo", id] => {
            if !is_valid_memo_id(id) {
                return Err(OpenTargetError::InvalidMemoId(id.to_string()));
            }
            let notebook_hint = get_query(&query, "nb").map(str::to_string);
            Ok(OpenTarget::DeepLink {
                url: full.to_string(),
                memo_id: Some(id.to_string()),
                notebook_hint,
                physical_path: None,
            })
        }
        ["open"] => {
            let path_arg = get_query(&query, "path")
                .ok_or(OpenTargetError::MissingPath)?
                .to_string();
            // v3: 物理 filename 不再带 `#<id>` 后缀, memo_id 走 resolver
            // 走 memo index filename → id 反查。
            Ok(OpenTarget::DeepLink {
                url: full.to_string(),
                memo_id: None,
                notebook_hint: get_query(&query, "nb").map(str::to_string),
                physical_path: Some(path_arg),
            })
        }
        _ => Err(OpenTargetError::UnknownRoute(path)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_returns_error() {
        assert!(matches!(parse_open_target(""), Err(OpenTargetError::Empty)));
        assert!(matches!(
            parse_open_target("   "),
            Err(OpenTargetError::Empty)
        ));
    }

    #[test]
    fn parses_deep_link_memo_with_id() {
        let t = parse_open_target("flowix://memo/abc12345").unwrap();
        match t {
            OpenTarget::DeepLink {
                memo_id,
                notebook_hint,
                physical_path,
                ..
            } => {
                assert_eq!(memo_id.as_deref(), Some("abc12345"));
                assert_eq!(notebook_hint, None);
                assert_eq!(physical_path, None);
            }
            _ => panic!("expected DeepLink"),
        }
    }

    #[test]
    fn parses_deep_link_memo_with_notebook_hint() {
        let t = parse_open_target("flowix://memo/abc12345?nb=nb_xyz").unwrap();
        match t {
            OpenTarget::DeepLink {
                memo_id,
                notebook_hint,
                ..
            } => {
                assert_eq!(memo_id.as_deref(), Some("abc12345"));
                assert_eq!(notebook_hint.as_deref(), Some("nb_xyz"));
            }
            _ => panic!("expected DeepLink"),
        }
    }

    #[test]
    fn rejects_invalid_memo_id_length() {
        // 5 位和 7 位都拒绝；旧 6 位和新 8 位都兼容。
        let err = parse_open_target("flowix://memo/abc12").unwrap_err();
        assert!(matches!(err, OpenTargetError::InvalidMemoId(_)));
        let err = parse_open_target("flowix://memo/abc1234").unwrap_err();
        assert!(matches!(err, OpenTargetError::InvalidMemoId(_)));
        let err = parse_open_target("flowix://memo/abc123456").unwrap_err();
        assert!(matches!(err, OpenTargetError::InvalidMemoId(_)));
        assert!(parse_open_target("flowix://memo/abc123").is_ok());
        assert!(parse_open_target("flowix://memo/abc12345").is_ok());
    }

    #[test]
    fn rejects_invalid_memo_id_chars() {
        // 含大写 / `_` / `-` 都不行
        let err = parse_open_target("flowix://memo/ABCDEF").unwrap_err();
        assert!(matches!(err, OpenTargetError::InvalidMemoId(_)));
        let err = parse_open_target("flowix://memo/ab_cde").unwrap_err();
        assert!(matches!(err, OpenTargetError::InvalidMemoId(_)));
    }

    #[test]
    fn parses_open_with_path_query() {
        // v3: 物理 filename 不再带 `#<id>` 后缀, parser 阶段 memo_id = None,
        // resolver 走 memo index filename → id 反查。
        let t = parse_open_target(
            "flowix://open?path=%2FUsers%2Frop%2FDocuments%2Fflowix%2Fnotebook%2Fhello.md",
        )
        .unwrap();
        match t {
            OpenTarget::DeepLink {
                memo_id,
                physical_path,
                ..
            } => {
                assert_eq!(memo_id, None);
                assert_eq!(
                    physical_path.as_deref(),
                    Some("/Users/rop/Documents/flowix/notebook/hello.md")
                );
            }
            _ => panic!("expected DeepLink"),
        }
    }

    #[test]
    fn parses_file_scheme() {
        // v3: 物理 filename 不再带 `#<id>` 后缀, parser 阶段 memo_id = None。
        let t = parse_open_target("file:///Users/rop/Documents/flowix/nb/hello.md").unwrap();
        match t {
            OpenTarget::PhysicalPath { path, memo_id } => {
                assert_eq!(path, "/Users/rop/Documents/flowix/nb/hello.md");
                assert_eq!(memo_id, None);
            }
            _ => panic!("expected PhysicalPath"),
        }
    }

    #[test]
    fn parses_raw_absolute_path() {
        // v3: 物理 filename 不再带 `#<id>` 后缀, parser 阶段 memo_id = None。
        let t = parse_open_target("/Users/rop/Documents/flowix/nb/hello.md").unwrap();
        match t {
            OpenTarget::PhysicalPath { path, memo_id } => {
                assert_eq!(path, "/Users/rop/Documents/flowix/nb/hello.md");
                assert_eq!(memo_id, None);
            }
            _ => panic!("expected PhysicalPath"),
        }
    }

    #[test]
    fn raw_path_without_memo_id_extracts_none() {
        let t = parse_open_target("/Users/rop/Documents/flowix/nb/random.txt").unwrap();
        match t {
            OpenTarget::PhysicalPath { memo_id, .. } => assert_eq!(memo_id, None),
            _ => panic!("expected PhysicalPath"),
        }
    }

    #[test]
    fn unknown_route_returns_error() {
        let err = parse_open_target("flowix://other/abc").unwrap_err();
        assert!(matches!(err, OpenTargetError::UnknownRoute(_)));
    }

    #[test]
    fn memo_id_with_unicode_path() {
        // 物理路径里含中文, 必须走 PhysicalPath 路径 (非深链)。
        // v3 后 filename 不再带 `#<id>`, parser 阶段 memo_id = None。
        let t = parse_open_target("/Users/rop/Documents/flowix/开发待办事项/笔记.md").unwrap();
        match t {
            OpenTarget::PhysicalPath { path, memo_id } => {
                assert_eq!(path, "/Users/rop/Documents/flowix/开发待办事项/笔记.md");
                assert_eq!(memo_id, None);
            }
            _ => panic!("expected PhysicalPath"),
        }
    }

    #[test]
    fn case_insensitive_scheme() {
        // macOS / Windows 投递过来的 scheme 大小写不一定, 都要能解析
        let t = parse_open_target("FLOWIX://memo/abc12345").unwrap();
        assert!(matches!(t, OpenTarget::DeepLink { .. }));
    }

    #[test]
    fn is_valid_memo_id_strict() {
        assert!(is_valid_memo_id("abc123"));
        assert!(is_valid_memo_id("000000"));
        assert!(is_valid_memo_id("abc12345"));
        assert!(is_valid_memo_id("00000000"));
        assert!(!is_valid_memo_id("ABCDEF"));
        assert!(!is_valid_memo_id("ab_cde"));
        assert!(!is_valid_memo_id("abc12"));
        assert!(!is_valid_memo_id("abc1234"));
        assert!(!is_valid_memo_id("abc123456"));
        assert!(!is_valid_memo_id(""));
    }
}
