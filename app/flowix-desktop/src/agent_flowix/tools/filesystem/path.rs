use std::path::{Component, Path, PathBuf};

use super::constants::GLOB_PRUNED_DIRS;
use crate::agent_flowix::tools::{ToolResult, ToolScope};

pub(super) fn resolve_path(path: &str) -> PathBuf {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

pub(super) fn clamp_limit(value: Option<usize>, default: usize, max: usize) -> usize {
    value.unwrap_or(default).clamp(1, max)
}

pub(super) fn ensure_min_one(name: &str, value: Option<usize>) -> Result<(), ToolResult> {
    if value == Some(0) {
        Err(ToolResult::error(format!("{name} must be >= 1")))
    } else {
        Ok(())
    }
}

pub(super) fn ensure_allowed(scope: &ToolScope, path: &Path) -> Result<(), ToolResult> {
    if scope.is_allowed(path) {
        Ok(())
    } else {
        Err(ToolResult::error(format!(
            "Path is outside the registered notebook scope: {}",
            path.display()
        )))
    }
}

pub(super) fn path_has_hidden_component(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(name) => name
            .to_str()
            .map(|name| name.starts_with('.') && name != "." && name != "..")
            .unwrap_or(false),
        _ => false,
    })
}

pub(super) fn is_glob_pruned_dir_name(name: &std::ffi::OsStr) -> bool {
    name.to_str()
        .map(|name| {
            GLOB_PRUNED_DIRS
                .iter()
                .any(|blocked| name.eq_ignore_ascii_case(blocked))
        })
        .unwrap_or(false)
}

pub(super) fn should_descend_for_glob(entry: &walkdir::DirEntry) -> bool {
    if entry.depth() == 0 || !entry.file_type().is_dir() {
        return true;
    }

    let name = entry.file_name();
    !name
        .to_str()
        .map(|name| name.starts_with('.'))
        .unwrap_or(false)
        && !is_glob_pruned_dir_name(name)
}

pub(super) fn ensure_visible(path: &Path) -> Result<(), ToolResult> {
    if path_has_hidden_component(path) {
        Err(ToolResult::error(format!(
            "Hidden files and directories are not accessible to agent tools: {}",
            path.display()
        )))
    } else {
        Ok(())
    }
}

pub(super) fn glob_pattern_string(path: PathBuf) -> String {
    path.display().to_string().replace('\\', "/")
}

pub(super) fn display_canonical_path(path: &Path) -> String {
    dunce::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .display()
        .to_string()
}

pub(super) fn normalized_relative_path(path: &Path) -> String {
    path.display().to_string().replace('\\', "/")
}

pub(super) fn normalize_relative_glob_pattern(pattern: &str) -> String {
    let mut normalized = pattern.replace('\\', "/");
    while let Some(rest) = normalized.strip_prefix("./") {
        normalized = rest.to_string();
    }
    normalized
}

pub(super) fn glob_static_prefix(pattern: &str) -> PathBuf {
    let normalized = pattern.replace('\\', "/");
    let wildcard = normalized
        .char_indices()
        .find_map(|(index, ch)| matches!(ch, '*' | '?').then_some(index));
    let prefix = match wildcard {
        Some(index) => normalized[..index]
            .rfind('/')
            .map(|slash| &normalized[..slash])
            .unwrap_or(""),
        None => normalized.as_str(),
    };
    PathBuf::from(prefix)
}

pub(super) fn canonicalize_absolute_glob_pattern(pattern: &str) -> String {
    let normalized = pattern.replace('\\', "/");
    let prefix = glob_static_prefix(&normalized);
    let Some(prefix_str) = prefix.to_str().filter(|value| !value.is_empty()) else {
        return normalized;
    };
    let suffix = normalized.strip_prefix(prefix_str).unwrap_or_default();
    let canonical_prefix = dunce::canonicalize(&prefix).unwrap_or(prefix);
    format!("{}{}", glob_pattern_string(canonical_prefix), suffix)
}

pub(super) fn roots_for_absolute_pattern(pattern: &str, roots: &[PathBuf]) -> Vec<PathBuf> {
    let prefix = glob_static_prefix(pattern);
    let prefix = dunce::canonicalize(&prefix).unwrap_or(prefix);
    roots
        .iter()
        .filter_map(|root| {
            let root = dunce::canonicalize(root).unwrap_or_else(|_| root.clone());
            (prefix.starts_with(&root) || root.starts_with(&prefix)).then_some(root)
        })
        .collect()
}

pub(super) fn expand_braces(pattern: &str) -> Vec<String> {
    let Some(start) = pattern.find('{') else {
        return vec![pattern.to_string()];
    };

    let mut depth = 0usize;
    let mut end = None;
    for (index, ch) in pattern
        .char_indices()
        .skip_while(|(index, _)| *index < start)
    {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    end = Some(index);
                    break;
                }
            }
            _ => {}
        }
    }

    let Some(end) = end else {
        return vec![pattern.to_string()];
    };

    let prefix = &pattern[..start];
    let body = &pattern[start + 1..end];
    let suffix = &pattern[end + 1..];
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut nested = 0usize;

    for ch in body.chars() {
        match ch {
            ',' if nested == 0 => {
                parts.push(current);
                current = String::new();
            }
            '{' => {
                nested += 1;
                current.push(ch);
            }
            '}' => {
                nested = nested.saturating_sub(1);
                current.push(ch);
            }
            _ => current.push(ch),
        }
    }
    parts.push(current);

    if parts.len() <= 1 {
        return vec![pattern.to_string()];
    }

    let mut expanded = Vec::new();
    for part in parts {
        let combined = format!("{prefix}{part}{suffix}");
        expanded.extend(expand_braces(&combined));
    }
    expanded
}

pub(super) fn glob_pattern_to_regex(pattern: &str) -> Result<regex::Regex, String> {
    let pattern = pattern.replace('\\', "/");
    let chars: Vec<char> = pattern.chars().collect();
    let mut regex = String::from("^");
    let mut index = 0usize;

    while index < chars.len() {
        match chars[index] {
            '*' => {
                if index + 1 < chars.len() && chars[index + 1] == '*' {
                    if index + 2 < chars.len() && chars[index + 2] == '/' {
                        regex.push_str("(?:.*/)?");
                        index += 3;
                    } else {
                        regex.push_str(".*");
                        index += 2;
                    }
                } else {
                    regex.push_str("[^/]*");
                    index += 1;
                }
            }
            '?' => {
                regex.push_str("[^/]");
                index += 1;
            }
            '/' => {
                regex.push('/');
                index += 1;
            }
            ch => {
                regex.push_str(&regex::escape(&ch.to_string()));
                index += 1;
            }
        }
    }

    regex.push('$');
    regex::Regex::new(&regex).map_err(|e| e.to_string())
}

// ============== 4 楂橀宸ュ叿: tokio::fs ==============
//
// 涔嬪墠 v3 鏄?"async fn 浣嗗嚱鏁颁綋浠庝笉 .await" 鐨勪吉 async, 鏁翠釜 read/write/edit/ls
// 鏈熼棿鎶?Tokio worker 绾跨▼鍗℃, 鍗曟宸ュ叿璋冪敤鍔ㄨ緞鍑犵櫨 ms 鈹€鈹€ 鏈熼棿 UI 婊氬姩 /
// 鑿滃崟 / Tiptap 閮戒笉鍝嶅簲銆?v4 鏀?tokio::fs 瀵逛綅, 璁?worker 鐪熸鑳藉垏鍑哄幓銆?// 閿欒澶勭悊鎶?`io::Error` 濂楁垚 `ToolResult::error(...)`, 鍏紑绛惧悕浠嶆槸
// `async fn -> ToolResult` 涓嶅彉銆?
