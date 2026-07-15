use serde::Deserialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Instant;

use walkdir::WalkDir;

use super::constants::{
    DEFAULT_GREP_LIMIT, DEFAULT_LIST_LIMIT, MAX_GLOB_FILES, MAX_GLOB_SCAN_FILES, MAX_GREP_FILES,
    MAX_GREP_FILE_BYTES, MAX_GREP_LIMIT, MAX_GREP_TOTAL_BYTES, MAX_GREP_WALLCLOCK, MAX_LIST_LIMIT,
};
use super::path::{
    canonicalize_absolute_glob_pattern, clamp_limit, display_canonical_path, ensure_allowed,
    ensure_visible, expand_braces, glob_pattern_string, glob_pattern_to_regex,
    normalize_relative_glob_pattern, normalized_relative_path, path_has_hidden_component,
    resolve_path, roots_for_absolute_pattern, should_descend_for_glob,
};
use crate::agent_flowix::tools::{ToolResult, ToolScope};

pub(super) async fn glob_paths(arguments: &str, scope: &ToolScope) -> ToolResult {
    #[derive(Deserialize)]
    struct Args {
        pattern: String,
        limit: Option<usize>,
    }
    #[derive(Clone)]
    struct SearchPattern {
        root: PathBuf,
        regex: regex::Regex,
        absolute: bool,
    }
    struct GlobScanResult {
        matches: Vec<PathBuf>,
        scanned_files: usize,
        scan_truncated: bool,
        match_truncated: bool,
    }

    let args = match serde_json::from_str::<Args>(arguments) {
        Ok(args) => args,
        Err(e) => return ToolResult::error(format!("Invalid arguments: {}", e)),
    };

    let raw_pattern = args.pattern;
    let expanded_patterns = expand_braces(&raw_pattern);
    let searched_roots: Vec<String> = if expanded_patterns
        .iter()
        .all(|pattern| Path::new(pattern).is_absolute())
    {
        Vec::new()
    } else {
        scope
            .allowed_roots
            .iter()
            .map(|root| root.display().to_string())
            .collect()
    };
    let mut patterns = Vec::new();
    let mut search_patterns = Vec::new();

    for pattern in &expanded_patterns {
        if Path::new(pattern).is_absolute() {
            let concrete = canonicalize_absolute_glob_pattern(pattern);
            let regex = match glob_pattern_to_regex(&concrete) {
                Ok(regex) => regex,
                Err(e) => return ToolResult::error(format!("Invalid glob pattern: {e}")),
            };
            patterns.push(concrete);
            for root in roots_for_absolute_pattern(pattern, &scope.allowed_roots) {
                search_patterns.push(SearchPattern {
                    root,
                    regex: regex.clone(),
                    absolute: true,
                });
            }
        } else {
            let normalized_pattern = normalize_relative_glob_pattern(pattern);
            let regex = match glob_pattern_to_regex(&normalized_pattern) {
                Ok(regex) => regex,
                Err(e) => return ToolResult::error(format!("Invalid glob pattern: {e}")),
            };
            for root in &scope.allowed_roots {
                patterns.push(glob_pattern_string(root.join(&normalized_pattern)));
                search_patterns.push(SearchPattern {
                    root: dunce::canonicalize(root).unwrap_or_else(|_| root.clone()),
                    regex: regex.clone(),
                    absolute: false,
                });
            }
        }
    }
    let limit = clamp_limit(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    let roots_for_blocking: Vec<PathBuf> = if search_patterns.iter().all(|pattern| pattern.absolute)
    {
        let mut seen = HashSet::new();
        search_patterns
            .iter()
            .filter_map(|pattern| {
                seen.insert(pattern.root.clone())
                    .then_some(pattern.root.clone())
            })
            .collect()
    } else {
        scope
            .allowed_roots
            .iter()
            .map(|root| dunce::canonicalize(root).unwrap_or_else(|_| root.clone()))
            .collect()
    };
    for root in &roots_for_blocking {
        scope.start_accessing_for_path(root);
    }
    let search_patterns_for_blocking = search_patterns.clone();
    let blocking_result = tokio::task::spawn_blocking(move || -> Result<GlobScanResult, String> {
        let mut seen = HashSet::new();
        let mut scanned = HashSet::new();
        let mut out = Vec::new();
        let mut scan_truncated = false;
        let mut match_truncated = false;

        for root in roots_for_blocking {
            for entry in WalkDir::new(&root)
                .follow_links(false)
                .into_iter()
                .filter_entry(should_descend_for_glob)
                .filter_map(Result::ok)
            {
                if !entry.file_type().is_file() {
                    continue;
                }

                let path = entry.path();
                if path_has_hidden_component(path) {
                    continue;
                }

                let path_key = path.display().to_string();
                if scanned.insert(path_key.clone()) && scanned.len() > MAX_GLOB_SCAN_FILES {
                    scan_truncated = true;
                    break;
                }

                let absolute_path = path_key.replace('\\', "/");
                for search in &search_patterns_for_blocking {
                    let target = if search.absolute {
                        absolute_path.clone()
                    } else {
                        match path.strip_prefix(&search.root) {
                            Ok(relative) => normalized_relative_path(relative),
                            Err(_) => continue,
                        }
                    };

                    if search.regex.is_match(&target) && seen.insert(path_key.clone()) {
                        out.push(path.to_path_buf());
                        if out.len() > MAX_GLOB_FILES {
                            match_truncated = true;
                            return Ok(GlobScanResult {
                                matches: out,
                                scanned_files: scanned.len(),
                                scan_truncated,
                                match_truncated,
                            });
                        }
                    }
                }
            }
            if scan_truncated {
                break;
            }
        }
        out.sort();
        Ok(GlobScanResult {
            matches: out,
            scanned_files: scanned.len(),
            scan_truncated,
            match_truncated,
        })
    })
    .await;

    let scan_result = match blocking_result {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => return ToolResult::error(e),
        Err(je) => return ToolResult::error(format!("glob task join failed: {je}")),
    };
    let match_count = scan_result.matches.len().min(MAX_GLOB_FILES);
    let displayed: Vec<String> = scan_result
        .matches
        .into_iter()
        .take(limit)
        .map(|path| display_canonical_path(&path))
        .collect();
    let displayed_count = displayed.len();
    let display_truncated = match_count > displayed_count;
    let truncated = scan_result.scan_truncated || scan_result.match_truncated || display_truncated;

    ToolResult::success(serde_json::json!({
        "pattern": raw_pattern,
        "patterns": patterns,
        "searched_roots": searched_roots,
        "matches": displayed,
        "found": match_count > 0,
        "match_count": match_count,
        "displayed_count": displayed_count,
        "limit": limit,
        "truncated": truncated,
        "scanned_files": scan_result.scanned_files,
        "scan_truncated": scan_result.scan_truncated,
        "match_truncated": scan_result.match_truncated,
        "display_truncated": display_truncated,
    }))
}

pub(super) async fn grep(arguments: &str, scope: &ToolScope) -> ToolResult {
    #[derive(Deserialize)]
    struct Args {
        pattern: String,
        path: String,
        case_sensitive: Option<bool>,
        limit: Option<usize>,
    }

    let args = match serde_json::from_str::<Args>(arguments) {
        Ok(args) => args,
        Err(e) => return ToolResult::error(format!("Invalid arguments: {}", e)),
    };

    let regex_pattern = if args.case_sensitive.unwrap_or(true) {
        args.pattern
    } else {
        format!("(?i){}", args.pattern)
    };
    let regex = match regex::Regex::new(&regex_pattern) {
        Ok(regex) => regex,
        Err(e) => return ToolResult::error(format!("Invalid regex: {}", e)),
    };

    let root = resolve_path(&args.path);
    if let Err(result) = ensure_allowed(scope, &root) {
        return result;
    }
    if let Err(result) = ensure_visible(&root) {
        return result;
    }
    scope.start_accessing_for_path(&root);
    let limit = clamp_limit(args.limit, DEFAULT_GREP_LIMIT, MAX_GREP_LIMIT);
    // scope.is_allowed 走 is_allowed(path) 在 blocking 闭包里调 ── scope
    // move 进闭包。
    let scope_for_blocking = scope.clone();
    let root_for_blocking = root.clone();
    let blocking_result = tokio::task::spawn_blocking(move || -> Result<GrepOutcome, String> {
        let start = Instant::now();
        let mut out = GrepOutcome::default();
        // WalkDir 走文件系统同步遍历, MAX_GREP_FILES 截断 + 文件级 +
        // 总字节 + 墙钟多重预算。
        let files: Vec<PathBuf> = if root_for_blocking.is_file() {
            vec![root_for_blocking.clone()]
        } else {
            WalkDir::new(&root_for_blocking)
                .max_depth(8)
                .into_iter()
                .filter_entry(|entry| !path_has_hidden_component(entry.path()))
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_file())
                .filter(|entry| scope_for_blocking.is_allowed(entry.path()))
                .take(MAX_GREP_FILES + 1)
                .map(|entry| entry.path().to_path_buf())
                .collect()
        };
        if files.len() > MAX_GREP_FILES {
            out.files_truncated = true;
        }
        let files: Vec<PathBuf> = files.into_iter().take(MAX_GREP_FILES).collect();

        for file in &files {
            if start.elapsed() > MAX_GREP_WALLCLOCK {
                out.wallclock_truncated = true;
                break;
            }
            let meta = std::fs::metadata(file).ok();
            if let Some(m) = &meta {
                if m.len() > MAX_GREP_FILE_BYTES {
                    out.skipped_large += 1;
                    continue;
                }
                if out.bytes_read + m.len() > MAX_GREP_TOTAL_BYTES {
                    out.wallclock_truncated = true;
                    break;
                }
            }
            let content = match std::fs::read_to_string(file) {
                Ok(c) => c,
                Err(_) => continue,
            };
            out.bytes_read = out.bytes_read.saturating_add(content.len() as u64);
            out.scanned_files += 1;
            for (line_index, line) in content.lines().enumerate() {
                if regex.is_match(line) {
                    out.matches.push(serde_json::json!({
                        "path": file.display().to_string(),
                        "line": line_index + 1,
                        "text": line,
                    }));
                    if out.matches.len() >= limit {
                        break;
                    }
                }
            }
            if out.matches.len() >= limit {
                break;
            }
        }
        Ok(out)
    })
    .await;

    let out = match blocking_result {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => return ToolResult::error(e),
        Err(je) => return ToolResult::error(format!("grep task join failed: {je}")),
    };

    ToolResult::success(serde_json::json!({
        "path": root.display().to_string(),
        "matches": out.matches,
        "limit": limit,
        "truncated": out.files_truncated || out.wallclock_truncated,
        "scanned_files": out.scanned_files,
        "skipped_large": out.skipped_large,
        "files_truncated": out.files_truncated,
        "wallclock_truncated": out.wallclock_truncated,
    }))
}

#[derive(Default)]
struct GrepOutcome {
    matches: Vec<serde_json::Value>,
    scanned_files: usize,
    bytes_read: u64,
    skipped_large: usize,
    files_truncated: bool,
    wallclock_truncated: bool,
}
