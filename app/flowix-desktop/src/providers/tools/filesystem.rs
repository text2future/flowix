use rllm::chat::Tool;
use serde::Deserialize;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};
use walkdir::WalkDir;

use flowix_core::memo_file::{extract_body_content, extract_frontmatter_key};

use super::{function_tool, ToolResult, ToolScope};

// ============== limits ==============
//
// 跟 LLM 调用的语义上限 (schema `maximum`) 对齐 ── 给 LLM 看到的"最多 100
// 条结果"就是真上限, 不让 LLM 误以为能拿到更多。 实际内部多收 1 条用作
// truncated 标记。
const DEFAULT_READ_LIMIT: usize = 20_000;
const MAX_READ_LIMIT: usize = 100_000;
const DEFAULT_READ_LINE_COUNT: usize = 80;
const MAX_READ_LINE_COUNT: usize = 1_000;
const DEFAULT_LIST_LIMIT: usize = 200;
const MAX_LIST_LIMIT: usize = 1_000;
const DEFAULT_GREP_LIMIT: usize = 100;
const MAX_GREP_LIMIT: usize = 500;
const MAX_EDIT_MATCH_CANDIDATE_CHARS: usize = 500;
const MAX_EDIT_MATCH_SCAN_LINES: usize = 10_000;
const MAX_EDIT_FUZZY_DISTANCE: usize = 20;

// glob / grep 走 `spawn_blocking`, 内部加额外硬上限 ── 防 LLM 误传
// `limit=1000` 在百万文件目录里把 worker 卡死。 超出上限就标 truncated
// 让 LLM 自纠 (缩窄 path / 调高 specificity)。
const MAX_GLOB_FILES: usize = 3_000;
const MAX_GLOB_SCAN_FILES: usize = 30_000;
const GLOB_PRUNED_DIRS: &[&str] = &[
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
const MAX_GREP_FILES: usize = 5_000;
const MAX_GREP_FILE_BYTES: u64 = 4 * 1024 * 1024; // 单文件 > 4MB 跳过
const MAX_GREP_TOTAL_BYTES: u64 = 64 * 1024 * 1024; // 全局读盘字节预算
const MAX_GREP_WALLCLOCK: Duration = Duration::from_secs(2);
const WRITE_KEY_REREAD_INTERVAL: Duration = Duration::from_millis(100);
const WRITE_KEY_REREAD_TIMEOUT: Duration = Duration::from_secs(2);

pub fn read_tool() -> Tool {
    function_tool(
        "read",
        "Read a UTF-8 text file. Use offset/limit for character chunks or line/line_count for line-based reads.",
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Absolute path or path relative to the app process working directory." },
                "offset": { "type": "integer", "description": "Character offset to start reading from.", "minimum": 0 },
                "limit": { "type": "integer", "description": "Maximum characters to return.", "minimum": 1, "maximum": MAX_READ_LIMIT },
                "line": { "type": "integer", "description": "1-based line number to start reading from. When set, offset is ignored.", "minimum": 1 },
                "line_count": { "type": "integer", "description": "Maximum lines to return when line is set.", "minimum": 1, "maximum": MAX_READ_LINE_COUNT }
            },
            "required": ["path"]
        }),
    )
}

pub fn write_tool() -> Tool {
    function_tool(
        "write",
        "Write UTF-8 text to a file. Creates parent directories when create_dirs is true. When append=true, inserts a newline separator if needed so existing markdown and appended content do not join on the same line.",
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Absolute path or path relative to the app process working directory." },
                "content": { "type": "string", "description": "Full text content to write or append." },
                "append": { "type": "boolean", "description": "Append instead of replacing the file.", "default": false },
                "create_dirs": { "type": "boolean", "description": "Create parent directories if missing.", "default": true }
            },
            "required": ["path", "content"]
        }),
    )
}

pub fn delete_tool() -> Tool {
    function_tool(
        "delete",
        "Delete a visible file inside the registered notebook scope. Directories and hidden paths are not deleted.",
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "File path to delete." }
            },
            "required": ["path"]
        }),
    )
}

pub fn edit_tool() -> Tool {
    function_tool(
        "edit",
        "Replace one text span in a UTF-8 file. This is a JSON function tool: set dry_run=true to preview without writing, set fuzzy=true to enter explicit candidate mode, and set apply_fuzzy=true only to write a high-confidence fuzzy candidate. The file must have been read in the current conversation and must be unchanged since that read.",
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Absolute path or path relative to the app process working directory." },
                "old_string": { "type": "string", "description": "The exact literal text to replace. Whitespace, indentation, and line endings must match exactly." },
                "new_string": { "type": "string", "description": "The replacement text." },
                "dry_run": { "type": "boolean", "description": "JSON switch equivalent to --dry-run: preview the edit and return would_write/wrote metadata without writing to disk.", "default": false },
                "fuzzy": { "type": "boolean", "description": "JSON switch equivalent to --fuzzy: explicit candidate mode. Returns exact_candidate or fuzzy_candidate metadata without writing unless apply_fuzzy is also true.", "default": false },
                "apply_fuzzy": { "type": "boolean", "description": "Apply a high-confidence fuzzy candidate to disk. Requires fuzzy=true; pair with dry_run=true to preview the write decision.", "default": false }
            },
            "required": ["path", "old_string", "new_string"]
        }),
    )
}

pub fn ls_tool() -> Tool {
    function_tool(
        "ls",
        "List files and directories at a path.",
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Directory path to list." },
                "limit": { "type": "integer", "description": "Maximum entries to return.", "minimum": 1, "maximum": MAX_LIST_LIMIT }
            },
            "required": ["path"]
        }),
    )
}

pub fn glob_tool() -> Tool {
    function_tool(
        "glob",
        "Find files by glob pattern. Relative patterns search every registered accessible root. success=true means the glob ran; check found or match_count to know whether files matched.",
        serde_json::json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "Glob pattern. Relative patterns are expanded under every accessible root; absolute patterns are used as provided." },
                "limit": { "type": "integer", "description": "Maximum paths to return.", "minimum": 1, "maximum": MAX_LIST_LIMIT }
            },
            "required": ["pattern"]
        }),
    )
}

pub fn grep_tool() -> Tool {
    function_tool(
        "grep",
        "Search text files with a regular expression. For literal searches, escape regex metacharacters.",
        serde_json::json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "Regex pattern to search for." },
                "path": { "type": "string", "description": "File or directory to search." },
                "case_sensitive": { "type": "boolean", "description": "Whether matching is case sensitive.", "default": true },
                "limit": { "type": "integer", "description": "Maximum matches to return.", "minimum": 1, "maximum": MAX_GREP_LIMIT }
            },
            "required": ["pattern", "path"]
        }),
    )
}

pub async fn execute_tool(
    tool_name: &str,
    arguments: &str,
    read_snapshot: Option<&str>,
    scope: &ToolScope,
) -> ToolResult {
    match tool_name {
        "read" => read(arguments, scope).await,
        "write" => write(arguments, scope).await,
        "delete" => delete(arguments, scope).await,
        "edit" => edit(arguments, read_snapshot, scope).await,
        "ls" => ls(arguments, scope).await,
        "glob" => glob_paths(arguments, scope).await,
        "grep" => grep(arguments, scope).await,
        _ => ToolResult::error(format!("Unknown filesystem tool: {}", tool_name)),
    }
}

fn resolve_path(path: &str) -> PathBuf {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn clamp_limit(value: Option<usize>, default: usize, max: usize) -> usize {
    value.unwrap_or(default).clamp(1, max)
}

fn ensure_min_one(name: &str, value: Option<usize>) -> Result<(), ToolResult> {
    if value == Some(0) {
        Err(ToolResult::error(format!("{name} must be >= 1")))
    } else {
        Ok(())
    }
}

fn ensure_allowed(scope: &ToolScope, path: &Path) -> Result<(), ToolResult> {
    if scope.is_allowed(path) {
        Ok(())
    } else {
        Err(ToolResult::error(format!(
            "Path is outside the registered notebook scope: {}",
            path.display()
        )))
    }
}

fn path_has_hidden_component(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(name) => name
            .to_str()
            .map(|name| name.starts_with('.') && name != "." && name != "..")
            .unwrap_or(false),
        _ => false,
    })
}

fn is_glob_pruned_dir_name(name: &std::ffi::OsStr) -> bool {
    name.to_str()
        .map(|name| {
            GLOB_PRUNED_DIRS
                .iter()
                .any(|blocked| name.eq_ignore_ascii_case(blocked))
        })
        .unwrap_or(false)
}

fn should_descend_for_glob(entry: &walkdir::DirEntry) -> bool {
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

fn ensure_visible(path: &Path) -> Result<(), ToolResult> {
    if path_has_hidden_component(path) {
        Err(ToolResult::error(format!(
            "Hidden files and directories are not accessible to agent tools: {}",
            path.display()
        )))
    } else {
        Ok(())
    }
}

fn glob_pattern_string(path: PathBuf) -> String {
    path.display().to_string().replace('\\', "/")
}

fn display_canonical_path(path: &Path) -> String {
    dunce::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .display()
        .to_string()
}

fn normalized_relative_path(path: &Path) -> String {
    path.display().to_string().replace('\\', "/")
}

fn normalize_relative_glob_pattern(pattern: &str) -> String {
    let mut normalized = pattern.replace('\\', "/");
    while let Some(rest) = normalized.strip_prefix("./") {
        normalized = rest.to_string();
    }
    normalized
}

fn glob_static_prefix(pattern: &str) -> PathBuf {
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

fn roots_for_absolute_pattern(pattern: &str, roots: &[PathBuf]) -> Vec<PathBuf> {
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

fn expand_braces(pattern: &str) -> Vec<String> {
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

fn glob_pattern_to_regex(pattern: &str) -> Result<regex::Regex, String> {
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

// ============== 4 高频工具: tokio::fs ==============
//
// 之前 v3 是 "async fn 但函数体从不 .await" 的伪 async, 整个 read/write/edit/ls
// 期间把 Tokio worker 线程卡死, 单次工具调用动辄几百 ms ── 期间 UI 滚动 /
// 菜单 / Tiptap 都不响应。 v4 改 tokio::fs 对位, 让 worker 真正能切出去。
// 错误处理把 `io::Error` 套成 `ToolResult::error(...)`, 公开签名仍是
// `async fn -> ToolResult` 不变。

fn frontmatter_key_value(content: &str) -> serde_json::Value {
    extract_frontmatter_key(content)
        .map(serde_json::Value::String)
        .unwrap_or(serde_json::Value::Null)
}

fn split_frontmatter_block(content: &str) -> Option<(&str, &str)> {
    let mut offset = 0usize;
    let mut lines = content.split_inclusive('\n');
    let first = lines.next()?;
    if first.trim_end_matches(['\r', '\n']) != "---" {
        return None;
    }
    offset += first.len();

    for line in lines {
        offset += line.len();
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return Some((&content[..offset], &content[offset..]));
        }
    }
    None
}

async fn content_for_append(path: &Path, requested_content: &str) -> String {
    if requested_content.is_empty() {
        return String::new();
    }

    let Ok(existing_content) = tokio::fs::read_to_string(path).await else {
        return requested_content.to_string();
    };
    if existing_content.is_empty()
        || existing_content.ends_with('\n')
        || requested_content.starts_with('\n')
    {
        requested_content.to_string()
    } else {
        format!("\n{requested_content}")
    }
}

async fn content_for_write(path: &Path, requested_content: &str, append: bool) -> String {
    if append {
        return content_for_append(path, requested_content).await;
    }

    let Ok(existing_content) = tokio::fs::read_to_string(path).await else {
        return requested_content.to_string();
    };
    let Some((existing_frontmatter, _)) = split_frontmatter_block(&existing_content) else {
        return requested_content.to_string();
    };

    let requested_body = extract_body_content(requested_content);
    format!("{existing_frontmatter}{requested_body}")
}

async fn reread_frontmatter_key_after_write(path: &Path) -> Option<String> {
    let deadline = Instant::now() + WRITE_KEY_REREAD_TIMEOUT;
    loop {
        if let Ok(content) = tokio::fs::read_to_string(path).await {
            if let Some(key) = extract_frontmatter_key(&content) {
                return Some(key);
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(WRITE_KEY_REREAD_INTERVAL).await;
    }
}

fn read_lines(content: &str, start_line: usize, line_count: usize) -> (String, usize, usize, bool) {
    debug_assert!(start_line >= 1);
    let total_lines = content.lines().count();
    let start_index = start_line - 1;
    let lines: Vec<&str> = content.lines().skip(start_index).take(line_count).collect();
    let returned_lines = lines.len();
    let text = lines.join("\n");
    let truncated = start_index + returned_lines < total_lines;
    (text, returned_lines, total_lines, truncated)
}

fn line_start_offsets(content: &str) -> Vec<usize> {
    let mut offsets = vec![0usize];
    for (index, ch) in content.char_indices() {
        if ch == '\n' {
            offsets.push(index + ch.len_utf8());
        }
    }
    offsets
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

fn levenshtein_chars(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }

    let mut previous: Vec<usize> = (0..=b.len()).collect();
    let mut current = vec![0usize; b.len() + 1];
    for (i, a_ch) in a.iter().enumerate() {
        current[0] = i + 1;
        for (j, b_ch) in b.iter().enumerate() {
            let cost = usize::from(a_ch != b_ch);
            current[j + 1] = (current[j] + 1)
                .min(previous[j + 1] + 1)
                .min(previous[j] + cost);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[b.len()]
}

fn common_edit_mismatch_hint(needle: &str, candidate: &str) -> Option<&'static str> {
    if needle.replace("\r\n", "\n") == candidate.replace("\r\n", "\n") {
        return Some("line endings differ");
    }
    if needle.split_whitespace().collect::<String>()
        == candidate.split_whitespace().collect::<String>()
    {
        return Some("whitespace differs");
    }
    if needle.replace(['“', '”'], "\"").replace(['‘', '’'], "'")
        == candidate.replace(['“', '”'], "\"").replace(['‘', '’'], "'")
    {
        return Some("quote style differs");
    }
    None
}

fn is_boundary_punctuation(ch: char) -> bool {
    ch.is_ascii_punctuation()
        || matches!(
            ch,
            '。' | '，'
                | '、'
                | '；'
                | '：'
                | '！'
                | '？'
                | '）'
                | '（'
                | '《'
                | '》'
                | '「'
                | '」'
                | '『'
                | '』'
                | '“'
                | '”'
                | '‘'
                | '’'
                | '…'
        )
}

fn neighboring_chars(content: &str, start: usize, end: usize) -> (Option<char>, Option<char>) {
    let before = content[..start].chars().next_back();
    let after = content[end..].chars().next();
    (before, after)
}

fn exact_match_boundary_error(content: &str, matched: &str, start: usize) -> Option<ToolResult> {
    let end = start + matched.len();
    let (before, after) = neighboring_chars(content, start, end);
    let missing_leading = before
        .filter(|ch| is_boundary_punctuation(*ch))
        .filter(|_| {
            !matched
                .chars()
                .next()
                .map(is_boundary_punctuation)
                .unwrap_or(false)
        });
    let missing_trailing = after.filter(|ch| is_boundary_punctuation(*ch)).filter(|_| {
        !matched
            .chars()
            .next_back()
            .map(is_boundary_punctuation)
            .unwrap_or(false)
    });

    if let Some(ch) = missing_trailing {
        return Some(ToolResult::error(format!(
            "old_string matched a substring that is immediately followed by punctuation {:?}; refusing to edit because the old_string likely omitted trailing punctuation. match_type=fuzzy_trailing. Possible cause: trailing punctuation differs. Matched text: {:?}",
            ch, matched
        )));
    }
    if let Some(ch) = missing_leading {
        return Some(ToolResult::error(format!(
            "old_string matched a substring that is immediately preceded by punctuation {:?}; refusing to edit because the old_string likely omitted leading punctuation. match_type=fuzzy_leading. Possible cause: leading punctuation differs. Matched text: {:?}",
            ch, matched
        )));
    }
    None
}

fn best_edit_match_for_line(
    needle: &str,
    line: &str,
    line_number: usize,
    line_byte_offset: usize,
) -> EditMatchCandidates {
    let needle_len = needle.chars().count();
    if needle_len == 0 {
        return EditMatchCandidates::default();
    }

    let chars: Vec<(usize, char)> = line.char_indices().collect();
    let window_len = needle_len
        .min(MAX_EDIT_MATCH_CANDIDATE_CHARS)
        .min(chars.len());
    if window_len == 0 {
        return EditMatchCandidates::default();
    }
    let needle_sample = truncate_chars(needle, MAX_EDIT_MATCH_CANDIDATE_CHARS);
    let step = if chars.len() <= 1_000 {
        1
    } else {
        (window_len / 4).max(1)
    };
    let mut candidates = EditMatchCandidates::default();
    let mut start = 0usize;
    while start < chars.len() {
        let end = (start + window_len).min(chars.len());
        let byte_start = chars[start].0;
        let byte_end = if end < chars.len() {
            chars[end].0
        } else {
            line.len()
        };
        let text = line[byte_start..byte_end].to_string();
        let distance = levenshtein_chars(&needle_sample, &text);
        candidates.push(EditMatchCandidate {
            line: line_number,
            byte_offset: line_byte_offset + byte_start,
            byte_len: byte_end - byte_start,
            text,
            distance,
        });
        if end == chars.len() {
            break;
        }
        start += step;
    }
    candidates
}

fn find_closest_edit_matches(content: &str, needle: &str) -> EditMatchCandidates {
    let line_offsets = line_start_offsets(content);
    let needle_line_count = needle.lines().count().max(1);
    let lines: Vec<&str> = content.lines().take(MAX_EDIT_MATCH_SCAN_LINES).collect();
    let needle_sample = truncate_chars(needle, MAX_EDIT_MATCH_CANDIDATE_CHARS);
    let mut candidates = EditMatchCandidates::default();

    if needle_line_count > 1 {
        for index in 0..lines.len() {
            let end = (index + needle_line_count).min(lines.len());
            let byte_offset = *line_offsets.get(index).unwrap_or(&0);
            let byte_end = if end < line_offsets.len() {
                line_offsets[end]
            } else {
                content.len()
            };
            let candidate_text = &content[byte_offset..byte_end];
            let text = truncate_chars(candidate_text, MAX_EDIT_MATCH_CANDIDATE_CHARS);
            let distance = levenshtein_chars(&needle_sample, &text);
            let candidate = EditMatchCandidate {
                line: index + 1,
                byte_offset,
                byte_len: byte_end - byte_offset,
                text,
                distance,
            };
            candidates.push(candidate);
        }
        return candidates;
    }

    for (index, line) in lines.iter().enumerate() {
        let line_candidates = best_edit_match_for_line(
            needle,
            line,
            index + 1,
            *line_offsets.get(index).unwrap_or(&0),
        );
        candidates.extend(line_candidates);
    }
    candidates
}

fn edit_not_found_error(content: &str, needle: &str) -> String {
    let candidates = find_closest_edit_matches(content, needle);
    let Some(candidate) = candidates.best.as_ref() else {
        return "old_string was not found exactly. Whitespace, indentation, and line endings must match".to_string();
    };
    let hint = common_edit_mismatch_hint(needle, &candidate.text)
        .map(|hint| format!(" Possible cause: {hint}."))
        .unwrap_or_default();
    format!(
        "old_string was not found exactly. Closest match starts at line {}, byte {} and differs by about {} characters.{} Closest text: {:?}",
        candidate.line,
        candidate.byte_offset,
        candidate.distance,
        hint,
        candidate.text
    )
}

fn fuzzy_distance_threshold(needle: &str) -> usize {
    (needle.chars().count() / 10)
        .max(2)
        .min(MAX_EDIT_FUZZY_DISTANCE)
}

fn fuzzy_confidence(candidate: &EditMatchCandidate, needle: &str) -> f64 {
    let len = needle
        .chars()
        .count()
        .max(candidate.text.chars().count())
        .max(1);
    1.0 - (candidate.distance as f64 / len as f64)
}

fn fuzzy_candidate_is_confident(
    candidate: &EditMatchCandidate,
    second_best_distance: Option<usize>,
    needle: &str,
) -> bool {
    let threshold = fuzzy_distance_threshold(needle);
    if candidate.distance > threshold || fuzzy_confidence(candidate, needle) < 0.9 {
        return false;
    }
    second_best_distance
        .map(|distance| distance >= candidate.distance.saturating_add(3))
        .unwrap_or(true)
}

fn edit_match_result(
    path: &Path,
    updated: &str,
    args: &EditArgs,
    match_type: &str,
    line: Option<usize>,
    byte_offset: Option<usize>,
    matched_text: Option<&str>,
    distance: Option<usize>,
) -> serde_json::Value {
    serde_json::json!({
        "path": path.display().to_string(),
        "key": frontmatter_key_value(updated),
        "dry_run": args.dry_run(),
        "would_write": true,
        "wrote": !args.dry_run(),
        "match_type": match_type,
        "line": line,
        "byte_offset": byte_offset,
        "matched_text": matched_text,
        "distance": distance,
        "old_bytes": args.old_string.len(),
        "new_bytes": args.new_string.len(),
        "bytes_written": if args.dry_run() { 0 } else { updated.len() },
    })
}

struct EditMatchCandidate {
    line: usize,
    byte_offset: usize,
    byte_len: usize,
    text: String,
    distance: usize,
}

#[derive(Default)]
struct EditMatchCandidates {
    best: Option<EditMatchCandidate>,
    second_best: Option<EditMatchCandidate>,
}

impl EditMatchCandidates {
    fn push(&mut self, candidate: EditMatchCandidate) {
        if self
            .best
            .as_ref()
            .map(|best| candidate.distance < best.distance)
            .unwrap_or(true)
        {
            self.second_best = self.best.take();
            self.best = Some(candidate);
            return;
        }
        if self
            .second_best
            .as_ref()
            .map(|second| candidate.distance < second.distance)
            .unwrap_or(true)
        {
            self.second_best = Some(candidate);
        }
    }

    fn extend(&mut self, other: EditMatchCandidates) {
        if let Some(candidate) = other.best {
            self.push(candidate);
        }
        if let Some(candidate) = other.second_best {
            self.push(candidate);
        }
    }
}

#[derive(Deserialize)]
struct EditArgs {
    path: String,
    old_string: String,
    new_string: String,
    dry_run: Option<bool>,
    fuzzy: Option<bool>,
    apply_fuzzy: Option<bool>,
}

impl EditArgs {
    fn dry_run(&self) -> bool {
        self.dry_run.unwrap_or(false)
    }

    fn fuzzy(&self) -> bool {
        self.fuzzy.unwrap_or(false)
    }

    fn apply_fuzzy(&self) -> bool {
        self.apply_fuzzy.unwrap_or(false)
    }
}

async fn read(arguments: &str, scope: &ToolScope) -> ToolResult {
    #[derive(Deserialize)]
    struct Args {
        path: String,
        offset: Option<usize>,
        limit: Option<usize>,
        line: Option<usize>,
        line_count: Option<usize>,
    }

    let args = match serde_json::from_str::<Args>(arguments) {
        Ok(args) => args,
        Err(e) => return ToolResult::error(format!("Invalid arguments: {}", e)),
    };

    if let Err(result) = ensure_min_one("line", args.line) {
        return result;
    }
    if let Err(result) = ensure_min_one("line_count", args.line_count) {
        return result;
    }

    let path = resolve_path(&args.path);
    if let Err(result) = ensure_allowed(scope, &path) {
        return result;
    }
    if let Err(result) = ensure_visible(&path) {
        return result;
    }
    let content = match tokio::fs::read_to_string(&path).await {
        Ok(content) => content,
        Err(e) => return ToolResult::error(format!("Failed to read {}: {}", path.display(), e)),
    };

    if let Some(line) = args.line {
        let line_count = clamp_limit(
            args.line_count,
            DEFAULT_READ_LINE_COUNT,
            MAX_READ_LINE_COUNT,
        );
        let (text, returned_lines, total_lines, truncated) = read_lines(&content, line, line_count);
        return ToolResult::success(serde_json::json!({
            "path": path.display().to_string(),
            "content": text,
            "line": line,
            "line_count": line_count,
            "returned_lines": returned_lines,
            "total_lines": total_lines,
            "truncated": truncated,
        }));
    }

    let offset = args.offset.unwrap_or(0);
    let limit = clamp_limit(args.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
    let total_chars = content.chars().count();
    let text: String = content.chars().skip(offset).take(limit).collect();

    ToolResult::success(serde_json::json!({
        "path": path.display().to_string(),
        "content": text,
        "offset": offset,
        "returned_chars": text.chars().count(),
        "total_chars": total_chars,
        "truncated": offset + limit < total_chars,
    }))
}

async fn write(arguments: &str, scope: &ToolScope) -> ToolResult {
    #[derive(Deserialize)]
    struct Args {
        path: String,
        content: String,
        append: Option<bool>,
        create_dirs: Option<bool>,
    }

    let args = match serde_json::from_str::<Args>(arguments) {
        Ok(args) => args,
        Err(e) => return ToolResult::error(format!("Invalid arguments: {}", e)),
    };

    let path = resolve_path(&args.path);
    if let Err(result) = ensure_allowed(scope, &path) {
        return result;
    }
    if let Err(result) = ensure_visible(&path) {
        return result;
    }
    if args.create_dirs.unwrap_or(true) {
        if let Some(parent) = path.parent() {
            if let Err(e) = tokio::fs::create_dir_all(parent).await {
                return ToolResult::error(format!(
                    "Failed to create parent directory {}: {}",
                    parent.display(),
                    e
                ));
            }
        }
    }

    let append = args.append.unwrap_or(false);
    let content_to_write = content_for_write(&path, &args.content, append).await;

    let result: std::io::Result<()> = if append {
        use tokio::io::AsyncWriteExt;
        let mut file = match tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
        {
            Ok(f) => f,
            Err(e) => {
                return ToolResult::error(format!(
                    "Failed to open {} for append: {}",
                    path.display(),
                    e
                ))
            }
        };
        file.write_all(content_to_write.as_bytes())
            .await
            .map(|_| ())
    } else {
        tokio::fs::write(&path, content_to_write.as_bytes()).await
    };

    match result {
        Ok(()) => {
            let key = reread_frontmatter_key_after_write(&path).await;
            ToolResult::success(serde_json::json!({
                "path": path.display().to_string(),
                "key": key.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null),
                "bytes_written": content_to_write.len(),
                "append": append,
            }))
        }
        Err(e) => ToolResult::error(format!("Failed to write {}: {}", path.display(), e)),
    }
}

async fn delete(arguments: &str, scope: &ToolScope) -> ToolResult {
    #[derive(Deserialize)]
    struct Args {
        path: String,
    }

    let args = match serde_json::from_str::<Args>(arguments) {
        Ok(args) => args,
        Err(e) => return ToolResult::error(format!("Invalid arguments: {}", e)),
    };

    let path = resolve_path(&args.path);
    if let Err(result) = ensure_allowed(scope, &path) {
        return result;
    }
    if let Err(result) = ensure_visible(&path) {
        return result;
    }

    let metadata = match tokio::fs::metadata(&path).await {
        Ok(metadata) => metadata,
        Err(e) => return ToolResult::error(format!("Failed to inspect {}: {}", path.display(), e)),
    };
    if !metadata.is_file() {
        return ToolResult::error(format!(
            "delete only supports files, not directories: {}",
            path.display()
        ));
    }

    match tokio::fs::remove_file(&path).await {
        Ok(()) => ToolResult::success(serde_json::json!({
            "path": path.display().to_string(),
            "deleted": true,
        })),
        Err(e) => ToolResult::error(format!("Failed to delete {}: {}", path.display(), e)),
    }
}

async fn edit(arguments: &str, read_snapshot: Option<&str>, scope: &ToolScope) -> ToolResult {
    let args = match serde_json::from_str::<EditArgs>(arguments) {
        Ok(args) => args,
        Err(e) => return ToolResult::error(format!("Invalid arguments: {}", e)),
    };

    if args.old_string.is_empty() {
        return ToolResult::error("old_string cannot be empty");
    }

    let snapshot = match read_snapshot {
        Some(snapshot) => snapshot,
        None => {
            return ToolResult::error(
                "File must be read in the current conversation before using edit",
            )
        }
    };

    let path = resolve_path(&args.path);
    if let Err(result) = ensure_allowed(scope, &path) {
        return result;
    }
    if let Err(result) = ensure_visible(&path) {
        return result;
    }
    let current = match tokio::fs::read_to_string(&path).await {
        Ok(content) => content,
        Err(e) => return ToolResult::error(format!("Failed to read {}: {}", path.display(), e)),
    };

    if current != snapshot {
        return ToolResult::error(format!(
            "File changed on disk since it was last read in this conversation: {}",
            path.display()
        ));
    }

    let mut exact_matches = current.match_indices(&args.old_string);
    let first_exact = exact_matches.next();
    let second_exact = exact_matches.next();
    if second_exact.is_some() {
        return ToolResult::error(format!(
            "old_string matched {} times. Provide a longer old_string with more surrounding context",
            current.matches(&args.old_string).count()
        ));
    }

    if args.fuzzy() {
        if let Some((offset, matched)) = first_exact {
            if let Some(result) = exact_match_boundary_error(&current, matched, offset) {
                return result;
            }
            if !args.apply_fuzzy() || args.dry_run() {
                return ToolResult::success(serde_json::json!({
                    "path": path.display().to_string(),
                    "dry_run": args.dry_run(),
                    "would_write": args.apply_fuzzy(),
                    "wrote": false,
                    "match_type": "exact_candidate",
                    "line": None::<usize>,
                    "byte_offset": offset,
                    "matched_text": matched,
                    "replacement_text": args.new_string,
                    "distance": 0,
                    "second_best_distance": None::<usize>,
                    "confidence": 1.0,
                    "can_apply": true,
                    "error": serde_json::Value::Null,
                }));
            }
        }
    }

    let (updated, match_type, line, byte_offset, matched_text, distance) = if let Some((
        offset,
        matched,
    )) = first_exact
    {
        if let Some(result) = exact_match_boundary_error(&current, matched, offset) {
            return result;
        }
        (
            current.replacen(&args.old_string, &args.new_string, 1),
            "exact",
            None,
            Some(offset),
            Some(matched.to_string()),
            None,
        )
    } else {
        let candidates = find_closest_edit_matches(&current, &args.old_string);
        let Some(candidate) = candidates.best else {
            return ToolResult::error(edit_not_found_error(&current, &args.old_string));
        };
        let threshold = fuzzy_distance_threshold(&args.old_string);
        let second_best_distance = candidates
            .second_best
            .as_ref()
            .map(|candidate| candidate.distance);
        let confidence = fuzzy_confidence(&candidate, &args.old_string);
        let fuzzy_confident =
            fuzzy_candidate_is_confident(&candidate, second_best_distance, &args.old_string);

        if !args.fuzzy() {
            return ToolResult::error(edit_not_found_error(&current, &args.old_string));
        }

        if !args.apply_fuzzy() || args.dry_run() {
            return ToolResult::success(serde_json::json!({
                "path": path.display().to_string(),
                "dry_run": args.dry_run(),
                "would_write": args.apply_fuzzy() && fuzzy_confident,
                "wrote": false,
                "match_type": "fuzzy_candidate",
                "line": candidate.line,
                "byte_offset": candidate.byte_offset,
                "matched_text": candidate.text,
                "replacement_text": args.new_string,
                "distance": candidate.distance,
                "second_best_distance": second_best_distance,
                "confidence": confidence,
                "max_allowed_distance": threshold,
                "can_apply": fuzzy_confident,
                "error": if fuzzy_confident {
                    serde_json::Value::Null
                } else {
                    serde_json::Value::String("No exact match. Closest fuzzy candidate is below the confidence threshold.".to_string())
                },
            }));
        }

        if !fuzzy_confident {
            return ToolResult::error(format!(
                "No exact match. Closest fuzzy candidate is below the confidence threshold: distance={}, second_best_distance={:?}, confidence={:.3}, max_allowed_distance={}",
                candidate.distance,
                second_best_distance,
                confidence,
                threshold
            ));
        }

        let start = candidate.byte_offset;
        let end = candidate.byte_offset + candidate.byte_len;
        if start > current.len()
            || end > current.len()
            || !current.is_char_boundary(start)
            || !current.is_char_boundary(end)
        {
            return ToolResult::error("Fuzzy edit candidate did not align to UTF-8 boundaries");
        }
        let mut updated = current.clone();
        updated.replace_range(start..end, &args.new_string);
        (
            updated,
            "fuzzy_close",
            Some(candidate.line),
            Some(candidate.byte_offset),
            Some(candidate.text),
            Some(candidate.distance),
        )
    };

    if args.dry_run() {
        return ToolResult::success(edit_match_result(
            &path,
            &updated,
            &args,
            match_type,
            line,
            byte_offset,
            matched_text.as_deref(),
            distance,
        ));
    }

    match tokio::fs::write(&path, updated.as_bytes()).await {
        Ok(()) => ToolResult::success(edit_match_result(
            &path,
            &updated,
            &args,
            match_type,
            line,
            byte_offset,
            matched_text.as_deref(),
            distance,
        )),
        Err(e) => ToolResult::error(format!("Failed to write {}: {}", path.display(), e)),
    }
}

async fn ls(arguments: &str, scope: &ToolScope) -> ToolResult {
    #[derive(Deserialize)]
    struct Args {
        path: String,
        limit: Option<usize>,
    }

    let args = match serde_json::from_str::<Args>(arguments) {
        Ok(args) => args,
        Err(e) => return ToolResult::error(format!("Invalid arguments: {}", e)),
    };

    let path = resolve_path(&args.path);
    if let Err(result) = ensure_allowed(scope, &path) {
        return result;
    }
    if let Err(result) = ensure_visible(&path) {
        return result;
    }
    let limit = clamp_limit(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    let mut entries = match tokio::fs::read_dir(&path).await {
        Ok(entries) => entries,
        Err(e) => return ToolResult::error(format!("Failed to list {}: {}", path.display(), e)),
    };

    let mut result = Vec::new();
    // `take(limit)` 在 async iter 上不能直接调 ── tokio::fs::ReadDir 的
    // `next_entry` 一次返回一条, 手动控制上限。
    let mut count = 0usize;
    loop {
        if count >= limit {
            break;
        }
        let entry = match entries.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(_) => continue,
        };
        if path_has_hidden_component(&entry.path()) {
            continue;
        }
        let meta = entry.metadata().await.ok();
        result.push(serde_json::json!({
            "name": entry.file_name().to_string_lossy(),
            "path": entry.path().display().to_string(),
            "is_dir": meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
            "is_file": meta.as_ref().map(|m| m.is_file()).unwrap_or(false),
            "size": meta.as_ref().map(|m| m.len()),
        }));
        count += 1;
    }

    ToolResult::success(serde_json::json!({
        "path": path.display().to_string(),
        "entries": result,
        "limit": limit,
    }))
}

// ============== glob / grep: spawn_blocking + 上限 ==============
//
// glob / grep 走 `WalkDir` 这类 crate-level 同步 API, 即便包
// `tokio::fs` 也不解决"遍历目录树不让 worker 调度"的问题。 整段塞进
// `tokio::task::spawn_blocking`, 让 worker 真正能跑别的 task; 同时加
// MAX_GLOB_FILES / MAX_GREP_FILES / MAX_GREP_TOTAL_BYTES /
// MAX_GREP_FILE_BYTES / MAX_GREP_WALLCLOCK 多重硬上限, 触发上限时
// truncated 标记, LLM 据此自纠 (缩窄 path)。

async fn glob_paths(arguments: &str, scope: &ToolScope) -> ToolResult {
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
            let concrete = glob_pattern_string(PathBuf::from(pattern));
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

async fn grep(arguments: &str, scope: &ToolScope) -> ToolResult {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_scope(root: PathBuf) -> ToolScope {
        ToolScope {
            allowed_roots: vec![root.clone()],
            _default_root: root,
        }
    }

    fn test_scope_many(roots: Vec<PathBuf>) -> ToolScope {
        ToolScope {
            _default_root: roots.first().cloned().unwrap_or_default(),
            allowed_roots: roots,
        }
    }

    fn unique_temp_dir(name: &str) -> PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!("flowix-{}-{}", name, suffix))
    }

    #[tokio::test]
    async fn read_line_zero_returns_parameter_error() {
        let root = unique_temp_dir("read-line-zero");
        std::fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("note.md");
        std::fs::write(&path, "first\nsecond\n").expect("write fixture");

        let args = serde_json::json!({
            "path": path.display().to_string(),
            "line": 0
        })
        .to_string();
        let result = read(&args, &test_scope(root.clone())).await;

        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some("line must be >= 1"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn read_missing_file_error_omits_default_notebook_hint() {
        let root = unique_temp_dir("read-missing-file");
        std::fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("missing.md");

        let args = serde_json::json!({
            "path": path.display().to_string()
        })
        .to_string();
        let result = read(&args, &test_scope(root.clone())).await;

        assert!(!result.success);
        let message = result.error.unwrap_or_default();
        assert!(message.contains("Failed to read"));
        assert!(!message.contains("Default notebook is at"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn ls_outside_scope_error_omits_default_notebook_hint() {
        let root = unique_temp_dir("ls-scope-root");
        let outside = unique_temp_dir("ls-outside-scope");
        std::fs::create_dir_all(&root).expect("create root dir");
        std::fs::create_dir_all(&outside).expect("create outside dir");

        let args = serde_json::json!({
            "path": outside.display().to_string()
        })
        .to_string();
        let result = ls(&args, &test_scope(root.clone())).await;

        assert!(!result.success);
        let message = result.error.unwrap_or_default();
        assert!(message.contains("outside the registered notebook scope"));
        assert!(!message.contains("Hint:"));
        assert!(!message.contains("Default notebook"));
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[tokio::test]
    async fn glob_relative_pattern_searches_all_allowed_roots() {
        let root_a = unique_temp_dir("glob-root-a");
        let root_b = unique_temp_dir("glob-root-b");
        std::fs::create_dir_all(root_a.join("nested")).expect("create root a");
        std::fs::create_dir_all(root_b.join("nested")).expect("create root b");
        std::fs::write(root_a.join("nested").join("a.md"), "# A\n").expect("write a");
        std::fs::write(root_b.join("nested").join("b.md"), "# B\n").expect("write b");

        let args = serde_json::json!({
            "pattern": "**/*.md",
            "limit": 10
        })
        .to_string();
        let result = glob_paths(
            &args,
            &test_scope_many(vec![root_a.clone(), root_b.clone()]),
        )
        .await;

        assert!(result.success, "glob should succeed: {:?}", result);
        let data = result.data.expect("glob data");
        let matches = data["matches"].as_array().expect("matches array");
        let match_text = matches
            .iter()
            .filter_map(|value| value.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(match_text.contains("a.md"), "matches: {match_text}");
        assert!(match_text.contains("b.md"), "matches: {match_text}");
        assert_eq!(data["pattern"].as_str(), Some("**/*.md"));
        assert_eq!(data["searched_roots"].as_array().unwrap().len(), 2);

        let _ = std::fs::remove_dir_all(root_a);
        let _ = std::fs::remove_dir_all(root_b);
    }

    #[tokio::test]
    async fn glob_zero_matches_reports_not_found() {
        let root = unique_temp_dir("glob-zero");
        std::fs::create_dir_all(&root).expect("create root");
        std::fs::write(root.join("visible.md"), "# Visible\n").expect("write visible");

        let args = serde_json::json!({
            "pattern": "**/*.missing",
            "limit": 10
        })
        .to_string();
        let result = glob_paths(&args, &test_scope(root.clone())).await;

        assert!(result.success, "glob should succeed: {:?}", result);
        let data = result.data.expect("glob data");
        assert_eq!(data["found"].as_bool(), Some(false));
        assert_eq!(data["match_count"].as_u64(), Some(0));
        assert_eq!(data["displayed_count"].as_u64(), Some(0));
        assert_eq!(data["scanned_files"].as_u64(), Some(1));
        assert!(data["matches"].as_array().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn glob_chinese_pattern_with_recursive_prefix_matches() {
        let root = unique_temp_dir("glob-chinese");
        std::fs::create_dir_all(root.join("资料")).expect("create root");
        std::fs::write(root.join("资料").join("测试文档.md"), "# 中文\n").expect("write chinese");

        let args = serde_json::json!({
            "pattern": "**/测试文档.md",
            "limit": 10
        })
        .to_string();
        let result = glob_paths(&args, &test_scope(root.clone())).await;

        assert!(result.success, "glob should succeed: {:?}", result);
        let data = result.data.expect("glob data");
        assert_eq!(data["found"].as_bool(), Some(true));
        assert_eq!(data["match_count"].as_u64(), Some(1));
        let first = data["matches"][0].as_str().expect("first match");
        assert!(first.contains("测试文档.md"), "match: {first}");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn glob_chinese_pattern_without_recursive_prefix_matches() {
        let root = unique_temp_dir("glob-chinese-flat");
        std::fs::create_dir_all(&root).expect("create root");
        std::fs::write(root.join("创新药研究.md"), "# 中文\n").expect("write chinese");

        let args = serde_json::json!({
            "pattern": "创新药*.md",
            "limit": 10
        })
        .to_string();
        let result = glob_paths(&args, &test_scope(root.clone())).await;

        assert!(result.success, "glob should succeed: {:?}", result);
        let data = result.data.expect("glob data");
        assert_eq!(data["found"].as_bool(), Some(true));
        assert_eq!(data["match_count"].as_u64(), Some(1));
        let first = data["matches"][0].as_str().expect("first match");
        assert!(first.contains("创新药研究.md"), "match: {first}");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn glob_dot_slash_pattern_outputs_canonical_paths() {
        let root = unique_temp_dir("glob-dot-slash");
        std::fs::create_dir_all(&root).expect("create root");
        std::fs::write(root.join("note.md"), "# Note\n").expect("write note");

        let args = serde_json::json!({
            "pattern": "./*.md",
            "limit": 10
        })
        .to_string();
        let result = glob_paths(&args, &test_scope(root.clone())).await;

        assert!(result.success, "glob should succeed: {:?}", result);
        let data = result.data.expect("glob data");
        let first = data["matches"][0].as_str().expect("first match");
        let first_pattern = data["patterns"][0].as_str().expect("first pattern");
        assert!(
            !first_pattern.contains("\\.\\"),
            "pattern should be normalized: {first_pattern}"
        );
        assert!(
            !first_pattern.contains("/./"),
            "pattern should be normalized: {first_pattern}"
        );
        assert!(
            !first.contains("\\.\\"),
            "match should be canonical: {first}"
        );
        assert!(!first.contains("/./"), "match should be canonical: {first}");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn glob_expands_brace_alternatives() {
        let root = unique_temp_dir("glob-brace");
        std::fs::create_dir_all(&root).expect("create root");
        std::fs::write(root.join("innovative-drug-one.md"), "# One\n").expect("write one");
        std::fs::write(root.join("workflow-sop.md"), "# Sop\n").expect("write sop");

        let args = serde_json::json!({
            "pattern": "{innovative-drug-*.md,*-sop.md}",
            "limit": 10
        })
        .to_string();
        let result = glob_paths(&args, &test_scope(root.clone())).await;

        assert!(result.success, "glob should succeed: {:?}", result);
        let data = result.data.expect("glob data");
        assert_eq!(data["found"].as_bool(), Some(true));
        assert_eq!(data["match_count"].as_u64(), Some(2));
        assert_eq!(data["patterns"].as_array().unwrap().len(), 2);
        let matches = data["matches"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|value| value.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(matches.contains("innovative-drug-one.md"));
        assert!(matches.contains("workflow-sop.md"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn glob_expands_absolute_brace_alternatives() {
        let root = unique_temp_dir("glob-absolute-brace");
        std::fs::create_dir_all(&root).expect("create root");
        std::fs::write(root.join("innovative-drug-one.md"), "# One\n").expect("write one");
        std::fs::write(root.join("workflow-sop.md"), "# Sop\n").expect("write sop");

        let pattern = format!(
            "{}/{{innovative-drug-*.md,*-sop.md}}",
            glob_pattern_string(root.clone())
        );
        let args = serde_json::json!({
            "pattern": pattern,
            "limit": 10
        })
        .to_string();
        let result = glob_paths(&args, &test_scope(root.clone())).await;

        assert!(result.success, "glob should succeed: {:?}", result);
        let data = result.data.expect("glob data");
        assert_eq!(data["found"].as_bool(), Some(true));
        assert_eq!(data["match_count"].as_u64(), Some(2));
        assert_eq!(data["patterns"].as_array().unwrap().len(), 2);
        assert!(data["searched_roots"].as_array().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn glob_absolute_pattern_scans_only_matching_root() {
        let root_a = unique_temp_dir("glob-absolute-root-a");
        let root_b = unique_temp_dir("glob-absolute-root-b");
        std::fs::create_dir_all(&root_a).expect("create root a");
        std::fs::create_dir_all(&root_b).expect("create root b");
        std::fs::write(root_a.join("target.md"), "# Target\n").expect("write target");
        std::fs::write(root_b.join("unrelated.md"), "# Unrelated\n").expect("write unrelated");

        let args = serde_json::json!({
            "pattern": glob_pattern_string(root_a.join("*.md")),
            "limit": 10
        })
        .to_string();
        let result = glob_paths(
            &args,
            &test_scope_many(vec![root_a.clone(), root_b.clone()]),
        )
        .await;

        assert!(result.success, "glob should succeed: {:?}", result);
        let data = result.data.expect("glob data");
        assert_eq!(data["match_count"].as_u64(), Some(1));
        assert_eq!(data["scanned_files"].as_u64(), Some(1));
        let first = data["matches"][0].as_str().expect("first match");
        assert!(first.contains("target.md"));
        assert!(!first.contains("unrelated.md"));
        let _ = std::fs::remove_dir_all(root_a);
        let _ = std::fs::remove_dir_all(root_b);
    }

    #[tokio::test]
    async fn glob_prunes_heavy_and_hidden_directories() {
        let root = unique_temp_dir("glob-pruned-dirs");
        std::fs::create_dir_all(root.join("node_modules").join("pkg"))
            .expect("create node_modules");
        std::fs::create_dir_all(root.join(".metadata")).expect("create metadata");
        std::fs::write(root.join("visible.md"), "# Visible\n").expect("write visible");
        std::fs::write(
            root.join("node_modules").join("pkg").join("hidden.md"),
            "# Hidden\n",
        )
        .expect("write node_modules file");
        std::fs::write(root.join(".metadata").join("index.md"), "# Index\n")
            .expect("write metadata file");

        let args = serde_json::json!({
            "pattern": "**/*.md",
            "limit": 10
        })
        .to_string();
        let result = glob_paths(&args, &test_scope(root.clone())).await;

        assert!(result.success, "glob should succeed: {:?}", result);
        let data = result.data.expect("glob data");
        assert_eq!(data["match_count"].as_u64(), Some(1));
        assert_eq!(data["scanned_files"].as_u64(), Some(1));
        let matches = data["matches"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|value| value.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(matches.contains("visible.md"));
        assert!(!matches.contains("node_modules"));
        assert!(!matches.contains(".metadata"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn write_new_markdown_without_frontmatter_returns_null_key() {
        let root = unique_temp_dir("write-new-null-key");
        std::fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("note.md");

        let args = serde_json::json!({
            "path": path.display().to_string(),
            "content": "# Title\nbody\n"
        })
        .to_string();
        let result = write(&args, &test_scope(root.clone())).await;

        assert!(result.success, "write should succeed: {:?}", result);
        let data = result.data.expect("write data");
        assert!(data["key"].is_null());
        let content = std::fs::read_to_string(&path).expect("read fixture");
        assert_eq!(content, "# Title\nbody\n");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn write_existing_markdown_preserves_frontmatter_when_content_omits_it() {
        let root = unique_temp_dir("write-preserve-frontmatter");
        std::fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("note.md");
        std::fs::write(
            &path,
            "---\nkey: abcdefgh\ntags: [old]\n---\n# Old\nold body\n",
        )
        .expect("write fixture");

        let args = serde_json::json!({
            "path": path.display().to_string(),
            "content": "# Replacement\nnew body\n"
        })
        .to_string();
        let result = write(&args, &test_scope(root.clone())).await;

        assert!(result.success, "write should succeed: {:?}", result);
        let data = result.data.expect("write data");
        assert_eq!(data["key"].as_str(), Some("abcdefgh"));
        let content = std::fs::read_to_string(&path).expect("read fixture");
        assert_eq!(
            content,
            "---\nkey: abcdefgh\ntags: [old]\n---\n# Replacement\nnew body\n"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn write_existing_markdown_uses_new_body_but_preserves_original_frontmatter() {
        let root = unique_temp_dir("write-preserve-frontmatter-with-input-fm");
        std::fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("note.md");
        std::fs::write(&path, "---\nkey: abcdefgh\ntags: [old]\n---\n# Old\n")
            .expect("write fixture");

        let args = serde_json::json!({
            "path": path.display().to_string(),
            "content": "---\nkey: zzzzzzzz\ntags: [new]\n---\n# Replacement\n"
        })
        .to_string();
        let result = write(&args, &test_scope(root.clone())).await;

        assert!(result.success, "write should succeed: {:?}", result);
        let data = result.data.expect("write data");
        assert_eq!(data["key"].as_str(), Some("abcdefgh"));
        let content = std::fs::read_to_string(&path).expect("read fixture");
        assert_eq!(
            content,
            "---\nkey: abcdefgh\ntags: [old]\n---\n# Replacement\n"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn write_returns_key_from_delayed_disk_reread() {
        let root = unique_temp_dir("write-reread-key");
        std::fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("note.md");
        let path_for_update = path.clone();

        let delayed_update = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            tokio::fs::write(&path_for_update, "---\nkey: zzzzzzzz\n---\n# Replacement\n")
                .await
                .expect("simulate watcher key rewrite");
        });

        let args = serde_json::json!({
            "path": path.display().to_string(),
            "content": "# Replacement\n"
        })
        .to_string();
        let result = write(&args, &test_scope(root.clone())).await;
        delayed_update.await.expect("delayed update task");

        assert!(result.success, "write should succeed: {:?}", result);
        let data = result.data.expect("write data");
        assert_eq!(data["key"].as_str(), Some("zzzzzzzz"));
        let content = std::fs::read_to_string(&path).expect("read fixture");
        assert_eq!(
            extract_frontmatter_key(&content).as_deref(),
            Some("zzzzzzzz")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn write_append_inserts_newline_separator_when_needed() {
        let root = unique_temp_dir("write-append-separator");
        std::fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("note.md");
        std::fs::write(&path, "first paragraph").expect("write fixture");

        let args = serde_json::json!({
            "path": path.display().to_string(),
            "content": "second paragraph",
            "append": true
        })
        .to_string();
        let result = write(&args, &test_scope(root.clone())).await;

        assert!(result.success, "append should succeed: {:?}", result);
        assert_eq!(
            std::fs::read_to_string(&path).expect("read fixture"),
            "first paragraph\nsecond paragraph"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn delete_removes_visible_file() {
        let root = unique_temp_dir("delete-file");
        std::fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("note.md");
        std::fs::write(&path, "content").expect("write fixture");

        let args = serde_json::json!({
            "path": path.display().to_string()
        })
        .to_string();
        let result = delete(&args, &test_scope(root.clone())).await;

        assert!(result.success, "delete should succeed: {:?}", result);
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn delete_rejects_directories() {
        let root = unique_temp_dir("delete-dir");
        let dir = root.join("nested");
        std::fs::create_dir_all(&dir).expect("create dir");

        let args = serde_json::json!({
            "path": dir.display().to_string()
        })
        .to_string();
        let result = delete(&args, &test_scope(root.clone())).await;

        assert!(!result.success);
        assert!(dir.exists());
        assert!(result
            .error
            .unwrap_or_default()
            .contains("delete only supports files"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn edit_dry_run_does_not_write_file() {
        let root = unique_temp_dir("edit-dry-run");
        std::fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("note.md");
        let original = "---\nkey: abcdefgh\n---\nhello world\n";
        std::fs::write(&path, original).expect("write fixture");

        let args = serde_json::json!({
            "path": path.display().to_string(),
            "old_string": "hello world",
            "new_string": "hello flowix",
            "dry_run": true
        })
        .to_string();
        let result = edit(&args, Some(original), &test_scope(root.clone())).await;

        assert!(result.success, "dry-run edit should succeed: {:?}", result);
        let data = result.data.expect("dry-run data");
        assert_eq!(data["dry_run"].as_bool(), Some(true));
        assert_eq!(data["would_write"].as_bool(), Some(true));
        assert_eq!(data["wrote"].as_bool(), Some(false));
        assert_eq!(
            std::fs::read_to_string(&path).expect("read fixture"),
            original
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn edit_fuzzy_requires_explicit_apply_to_write() {
        let root = unique_temp_dir("edit-fuzzy");
        std::fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("note.md");
        let original = "---\nkey: abcdefgh\n---\nalpha beta gamma\n";
        std::fs::write(&path, original).expect("write fixture");

        let args = serde_json::json!({
            "path": path.display().to_string(),
            "old_string": "alpha beta gamma",
            "new_string": "alpha beta delta",
            "fuzzy": true
        })
        .to_string();
        let result = edit(&args, Some(original), &test_scope(root.clone())).await;

        assert!(
            result.success,
            "fuzzy candidate should succeed: {:?}",
            result
        );
        let data = result.data.expect("fuzzy data");
        assert_eq!(data["match_type"].as_str(), Some("exact_candidate"));
        assert_eq!(data["can_apply"].as_bool(), Some(true));
        assert_eq!(data["wrote"].as_bool(), Some(false));
        assert_eq!(
            std::fs::read_to_string(&path).expect("read fixture"),
            original
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn edit_rejects_missing_trailing_punctuation_by_default() {
        let root = unique_temp_dir("edit-trailing-punctuation");
        std::fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("note.md");
        let original = "---\nkey: abcdefgh\n---\nTarget text. Next\n";
        std::fs::write(&path, original).expect("write fixture");

        let args = serde_json::json!({
            "path": path.display().to_string(),
            "old_string": "Target text",
            "new_string": "Replacement"
        })
        .to_string();
        let result = edit(&args, Some(original), &test_scope(root.clone())).await;

        assert!(!result.success, "missing punctuation must be rejected");
        let message = result.error.unwrap_or_default();
        assert!(message.contains("match_type=fuzzy_trailing"));
        assert!(message.contains("Possible cause: trailing punctuation differs"));
        assert_eq!(
            std::fs::read_to_string(&path).expect("read fixture"),
            original
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn exact_match_rejects_missing_trailing_punctuation() {
        let content = "目标文本。后续";
        let matched = "目标文本";
        let error = exact_match_boundary_error(content, matched, 0)
            .expect("missing trailing punctuation must be rejected");

        assert!(!error.success);
        let message = error.error.unwrap_or_default();
        assert!(message.contains("match_type=fuzzy_trailing"));
        assert!(message.contains("Possible cause: trailing punctuation differs"));
    }

    #[test]
    fn exact_match_allows_whitespace_boundary() {
        let content = "目标文本 后续";
        let matched = "目标文本";
        assert!(exact_match_boundary_error(content, matched, 0).is_none());
    }
}
