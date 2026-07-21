//! `parse_open_target` 鈥?鎶?URL / 鐗╃悊璺緞 瑙ｆ瀽鎴?[`OpenTarget`]銆?//!
//! **绾嚱鏁? 鏃犲壇浣滅敤**: 涓嶆煡纾佺洏, 涓嶈閰嶇疆銆?閲嶅璺戦浂鎴愭湰, 鍗曟祴鍏ㄦ爤瑕嗙洊銆?//!
//! ## URL scheme 璁捐
//!
//! - `flowix://memo/<memo-id>`              鈥?涓昏鍦烘櫙
//! - `flowix://open?path=<encoded-abs>`     鈥?鐗╃悊璺緞 (鍐呴儴鎶?id)
//! - `file://<abs>`                          鈥?鐗╃悊璺緞鐨?URL 褰㈠紡 (鍏煎 macOS Finder 澶嶅埗)
//! - 瑁哥粷瀵硅矾寰?(浠?`/` 寮€澶?               鈥?鐗╃悊璺緞鐩翠紶
//!
//! ## memo id 鏍煎紡绾︽潫
//!
//! memo id 鏍煎紡: 鍏煎鏃?6 瀛楃鎴栧綋鍓?[`flowix_core::memo_file::MEMO_ID_LENGTH`]
//! 瀛楃, 瀛楃闆嗕负 `[0-9a-z]`銆?
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 瑙ｆ瀽鍚庛€佸緟璺敱鐨?鎵撳紑璇锋眰"銆?涓嶇粦瀹氬叿浣?notebook / memo, 鍙〃杈?/// "鐢ㄦ埛鎯虫墦寮€浠€涔?銆?resolver 灞傚啀鏌ョ鐩?/ memo index 钀藉埌鍏蜂綋 notebook銆?
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    rename_all = "camelCase",
    tag = "kind",
    rename_all_fields = "snake_case"
)]
pub enum OpenTarget {
    /// 鐗╃悊璺緞 鈥?璧?memo index 鎵墍鏈?notebook 鎵惧尮閰嶇殑 .md銆?
    PhysicalPath {
        path: String,
        memo_id: Option<String>,
    },
    /// 娣遍摼 `flowix://...` 鈥?memo_id 鏄叏灞€鍞竴涓婚敭銆?
    DeepLink {
        url: String,
        memo_id: Option<String>,
        /// `flowix://open?path=` 鏃舵惡甯?
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

/// memo id: 鏃?6 瀛楃鎴栧綋鍓?MEMO_ID_LENGTH 瀛楃, 瀛楃闆?`[0-9a-z]`銆?
pub fn is_valid_memo_id(s: &str) -> bool {
    matches!(s.len(), 6 | flowix_core::memo_file::MEMO_ID_LENGTH)
        && s.chars()
            .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase())
}

fn percent_decode(s: &str) -> String {
    // 鍏滃簳: JS 绔?url.pathname 宸茬粡 percent-decode 澶ч儴鍒? 鍚庣 url crate 瑙?
    // query 鏃朵篃浼氳В, 杩欓噷鍐嶅仛涓€閬撳瑁稿瓧绗︿覆椴佹銆?澶辫触鎸夊師鍊艰繑鍥炪€?
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
    // `flowix://memo/<id>` 鈥?鎷?scheme + 涔嬪悗閮ㄥ垎銆?    //   - scheme 閮ㄥ垎 (`flowix`) 澶у皬鍐欎笉鏁忔劅 (OS 鎶曢€掓椂澶у皬鍐欎笉鍥哄畾)
    //   - rest **淇濈暀**鍘熷ぇ灏忓啓 鈹€鈹€ memo id 鍦?memo index 閲岃蛋 `[0-9a-z]`,
    //     浠讳綍澶у啓瀛楃閮芥槸鏃犳晥 id, 鐩存帴鍦?`is_valid_memo_id` 閲屾嫆鎺?
    //     涓嶈棰?lowercase 鍚﹀垯 `flowix://memo/ABCDEF` 浼氳璇垽涓哄悎娉曘€?
    let lower = raw.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("flowix://") {
        // 鍚屾牱鍋忕Щ鍦ㄥ師 `raw` 涓婂彇 rest, 淇濇寔鍘熷ぇ灏忓啓
        let original_rest = &raw[raw.len() - rest.len()..];
        Some(("flowix", original_rest))
    } else {
        None
    }
}

fn split_path_query(rest: &str) -> (String, Vec<(String, String)>) {
    // 绠€鍗?query 瑙ｆ瀽: `?k=v&k=v` 鈫?`[(k, v), ...]`
    // 涓嶄緷璧?url crate (閬垮厤寮曞叆 'url' 渚濊禆)銆?
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

/// 瑙ｆ瀽鍘熷杈撳叆 (URL / 鐗╃悊璺緞) 鈫?[`OpenTarget`]銆?
pub fn parse_open_target(raw: &str) -> Result<OpenTarget, OpenTargetError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(OpenTargetError::Empty);
    }

    // 1. `flowix://` 娣遍摼
    if let Some((_, rest)) = split_scheme(trimmed) {
        return parse_deep_link(&rest, trimmed);
    }

    // 2. `file://` 鐗╃悊璺緞 (macOS Finder 澶嶅埗绮樿创甯歌)
    if let Some(rest) = trimmed
        .strip_prefix("file://")
        .or_else(|| trimmed.strip_prefix("file:///"))
    {
        let decoded = percent_decode(rest);
        // v3: 鐗╃悊 filename 涓嶅啀甯?`#<id>` 鍚庣紑, memo_id 鐢?resolver 璧?        // memo index filename 鈫?id 鍙嶆煡; parser 闃舵鏃犳硶缁?memo_id銆?
        return Ok(OpenTarget::PhysicalPath {
            path: decoded,
            memo_id: None,
        });
    }

    // 3. 瑁哥粷瀵硅矾寰?/ 浠绘剰瀛楃 (resolver 鎷掓帀闈炴硶)
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
            Ok(OpenTarget::DeepLink {
                url: full.to_string(),
                memo_id: Some(id.to_string()),
                physical_path: None,
            })
        }
        ["open"] => {
            let path_arg = get_query(&query, "path")
                .ok_or(OpenTargetError::MissingPath)?
                .to_string();
            // v3: 鐗╃悊 filename 涓嶅啀甯?`#<id>` 鍚庣紑, memo_id 璧?resolver
            // 璧?memo index filename 鈫?id 鍙嶆煡銆?
            Ok(OpenTarget::DeepLink {
                url: full.to_string(),
                memo_id: None,
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
                physical_path,
                ..
            } => {
                assert_eq!(memo_id.as_deref(), Some("abc12345"));
                assert_eq!(physical_path, None);
            }
            _ => panic!("expected DeepLink"),
        }
    }

    #[test]
    fn rejects_invalid_memo_id_length() {
        // 5 浣嶅拰 7 浣嶉兘鎷掔粷锛涙棫 6 浣嶅拰鏂?8 浣嶉兘鍏煎銆?
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
        // 鍚ぇ鍐?/ `_` / `-` 閮戒笉琛?
        let err = parse_open_target("flowix://memo/ABCDEF").unwrap_err();
        assert!(matches!(err, OpenTargetError::InvalidMemoId(_)));
        let err = parse_open_target("flowix://memo/ab_cde").unwrap_err();
        assert!(matches!(err, OpenTargetError::InvalidMemoId(_)));
    }

    #[test]
    fn parses_open_with_path_query() {
        // v3: 鐗╃悊 filename 涓嶅啀甯?`#<id>` 鍚庣紑, parser 闃舵 memo_id = None,
        // resolver 璧?memo index filename 鈫?id 鍙嶆煡銆?
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
        // v3: 鐗╃悊 filename 涓嶅啀甯?`#<id>` 鍚庣紑, parser 闃舵 memo_id = None銆?
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
        // v3: 鐗╃悊 filename 涓嶅啀甯?`#<id>` 鍚庣紑, parser 闃舵 memo_id = None銆?
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
        // 鐗╃悊璺緞閲屽惈涓枃, 蹇呴』璧?PhysicalPath 璺緞 (闈炴繁閾?銆?        // v3 鍚?filename 涓嶅啀甯?`#<id>`, parser 闃舵 memo_id = None銆?
        let t =
            parse_open_target("/Users/rop/Documents/flowix/寮€鍙戝緟鍔炰簨椤?绗旇.md").unwrap();
        match t {
            OpenTarget::PhysicalPath { path, memo_id } => {
                assert_eq!(
                    path,
                    "/Users/rop/Documents/flowix/寮€鍙戝緟鍔炰簨椤?绗旇.md"
                );
                assert_eq!(memo_id, None);
            }
            _ => panic!("expected PhysicalPath"),
        }
    }

    #[test]
    fn case_insensitive_scheme() {
        // macOS / Windows 鎶曢€掕繃鏉ョ殑 scheme 澶у皬鍐欎笉涓€瀹? 閮借鑳借В鏋?
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
