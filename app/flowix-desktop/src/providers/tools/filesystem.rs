use rllm::chat::Tool;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use walkdir::WalkDir;

use super::{function_tool, ToolResult, ToolScope};

// ============== limits ==============
//
// 跟 LLM 调用的语义上限 (schema `maximum`) 对齐 ── 给 LLM 看到的"最多 100
// 条结果"就是真上限, 不让 LLM 误以为能拿到更多。 实际内部多收 1 条用作
// truncated 标记。
const DEFAULT_READ_LIMIT: usize = 20_000;
const MAX_READ_LIMIT: usize = 100_000;
const DEFAULT_LIST_LIMIT: usize = 200;
const MAX_LIST_LIMIT: usize = 1_000;
const DEFAULT_GREP_LIMIT: usize = 100;
const MAX_GREP_LIMIT: usize = 500;

// glob / grep 走 `spawn_blocking`, 内部加额外硬上限 ── 防 LLM 误传
// `limit=1000` 在百万文件目录里把 worker 卡死。 超出上限就标 truncated
// 让 LLM 自纠 (缩窄 path / 调高 specificity)。
const MAX_GLOB_FILES: usize = 10_000;
const MAX_GREP_FILES: usize = 5_000;
const MAX_GREP_FILE_BYTES: u64 = 4 * 1024 * 1024; // 单文件 > 4MB 跳过
const MAX_GREP_TOTAL_BYTES: u64 = 64 * 1024 * 1024; // 全局读盘字节预算
const MAX_GREP_WALLCLOCK: Duration = Duration::from_secs(2);

pub fn read_tool() -> Tool {
    function_tool(
        "read",
        "Read a UTF-8 text file. Use offset and limit to inspect large files in chunks.",
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Absolute path or path relative to the app process working directory." },
                "offset": { "type": "integer", "description": "Character offset to start reading from.", "minimum": 0 },
                "limit": { "type": "integer", "description": "Maximum characters to return.", "minimum": 1, "maximum": MAX_READ_LIMIT }
            },
            "required": ["path"]
        }),
    )
}

pub fn write_tool() -> Tool {
    function_tool(
        "write",
        "Write UTF-8 text to a file. Creates parent directories when create_dirs is true.",
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

pub fn edit_tool() -> Tool {
    function_tool(
        "edit",
        "Replace exactly one literal text span in a UTF-8 file. The file must have been read in the current conversation, must be unchanged since that read, and old_string must appear exactly once.",
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Absolute path or path relative to the app process working directory." },
                "old_string": { "type": "string", "description": "The exact literal text to replace. Whitespace, indentation, and line endings must match exactly." },
                "new_string": { "type": "string", "description": "The replacement text." }
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
        "Find files by glob pattern. Supports patterns such as **/*.rs.",
        serde_json::json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "Glob pattern. Relative patterns are resolved from the app process working directory." },
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

fn ensure_allowed(scope: &ToolScope, path: &Path) -> Result<(), ToolResult> {
    if scope.is_allowed(path) {
        Ok(())
    } else {
        // Include the canonical default notebook path so the LLM can
        // self-correct when it tries a stale path (e.g. the
        // pre-rename `~/Documents/woop notebook`).
        let hint = format!(
            " Hint: the current default notebook is at '{}'. If your target is inside it, retry with that path.",
            scope.default_root().display()
        );
        Err(ToolResult::error(format!(
            "Path is outside the registered notebook scope: {}.{}",
            path.display(),
            hint
        )))
    }
}

// ============== 4 高频工具: tokio::fs ==============
//
// 之前 v3 是 "async fn 但函数体从不 .await" 的伪 async, 整个 read/write/edit/ls
// 期间把 Tokio worker 线程卡死, 单次工具调用动辄几百 ms ── 期间 UI 滚动 /
// 菜单 / Tiptap 都不响应。 v4 改 tokio::fs 对位, 让 worker 真正能切出去。
// 错误处理把 `io::Error` 套成 `ToolResult::error(...)`, 公开签名仍是
// `async fn -> ToolResult` 不变。

async fn read(arguments: &str, scope: &ToolScope) -> ToolResult {
    #[derive(Deserialize)]
    struct Args {
        path: String,
        offset: Option<usize>,
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
    let content = match tokio::fs::read_to_string(&path).await {
        Ok(content) => content,
        Err(e) => {
            // When the file is missing, append a hint pointing at the
            // default notebook so the LLM doesn't keep guessing at the
            // same wrong path.
            let hint = if !scope.default_root().as_os_str().is_empty() {
                format!(
                    " Default notebook is at {}.",
                    scope.default_root().display()
                )
            } else {
                String::new()
            };
            return ToolResult::error(format!("Failed to read {}: {}.{}", path.display(), e, hint));
        }
    };

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

    let result: std::io::Result<()> = if args.append.unwrap_or(false) {
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
        file.write_all(args.content.as_bytes()).await.map(|_| ())
    } else {
        tokio::fs::write(&path, args.content.as_bytes()).await
    };

    match result {
        Ok(()) => ToolResult::success(serde_json::json!({
            "path": path.display().to_string(),
            "bytes_written": args.content.len(),
            "append": args.append.unwrap_or(false),
        })),
        Err(e) => ToolResult::error(format!("Failed to write {}: {}", path.display(), e)),
    }
}

async fn edit(arguments: &str, read_snapshot: Option<&str>, scope: &ToolScope) -> ToolResult {
    #[derive(Deserialize)]
    struct Args {
        path: String,
        old_string: String,
        new_string: String,
    }

    let args = match serde_json::from_str::<Args>(arguments) {
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

    let matches = current.matches(&args.old_string).count();
    if matches == 0 {
        return ToolResult::error(
            "old_string was not found exactly. Whitespace, indentation, and line endings must match",
        );
    }
    if matches > 1 {
        return ToolResult::error(format!(
            "old_string matched {} times. Provide a longer old_string with more surrounding context",
            matches
        ));
    }

    let updated = current.replacen(&args.old_string, &args.new_string, 1);
    match tokio::fs::write(&path, updated.as_bytes()).await {
        Ok(()) => ToolResult::success(serde_json::json!({
            "path": path.display().to_string(),
            "old_bytes": args.old_string.len(),
            "new_bytes": args.new_string.len(),
            "bytes_written": updated.len(),
        })),
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
// glob / grep 走 `glob::glob` / `WalkDir` 这类 crate-level 同步 API, 即便包
// `tokio::fs` 也不解决"遍历整棵目录树不让 worker 调度"的问题。 整段塞进
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

    let args = match serde_json::from_str::<Args>(arguments) {
        Ok(args) => args,
        Err(e) => return ToolResult::error(format!("Invalid arguments: {}", e)),
    };

    let pattern = if Path::new(&args.pattern).is_absolute() {
        args.pattern
    } else {
        resolve_path(&args.pattern).display().to_string()
    };
    let limit = clamp_limit(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    // scope.is_allowed 走 .is_allowed(path) 不能跨线程, 先把 is_allowed
    // 抽成可 Send 的 closure ── 实际上 ToolScope 内部数据是只读的, 直接
    // move 进去即可。 pattern / scope 都克隆一份供 spawn_blocking 闭包
    // 消费, 主作用域里的 `pattern` 仍要给到返回 payload 用。
    let pattern_for_blocking = pattern.clone();
    let scope_for_blocking = scope.clone();
    let blocking_result = tokio::task::spawn_blocking(move || -> Result<Vec<String>, String> {
        let paths = glob::glob(&pattern_for_blocking).map_err(|e| e.to_string())?;
        let mut out: Vec<String> = paths
            .filter_map(Result::ok)
            .filter(|path| scope_for_blocking.is_allowed(path))
            .take(MAX_GLOB_FILES + 1)
            .map(|path| path.display().to_string())
            .collect();
        let truncated = out.len() > MAX_GLOB_FILES;
        if truncated {
            out.truncate(MAX_GLOB_FILES);
        }
        Ok(out)
    })
    .await;

    let matches = match blocking_result {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => return ToolResult::error(e),
        Err(je) => return ToolResult::error(format!("glob task join failed: {je}")),
    };
    let truncated = matches.len() >= MAX_GLOB_FILES;
    // 二次截断到 LLM 实际请求的 limit, 内部截断的 truncated 标记仍透传
    let displayed: Vec<String> = matches.into_iter().take(limit).collect();

    ToolResult::success(serde_json::json!({
        "pattern": pattern,
        "matches": displayed,
        "limit": limit,
        "truncated": truncated,
        "scanned_files": displayed.len(),
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
