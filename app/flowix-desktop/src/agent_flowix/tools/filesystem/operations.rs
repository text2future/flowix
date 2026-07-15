use serde::Deserialize;

use super::constants::{
    DEFAULT_LIST_LIMIT, DEFAULT_READ_LIMIT, DEFAULT_READ_LINE_COUNT, MAX_LIST_LIMIT,
    MAX_READ_LIMIT, MAX_READ_LINE_COUNT,
};
use super::frontmatter::{content_for_write, reread_frontmatter_key_after_write};
use super::path::{
    clamp_limit, ensure_allowed, ensure_min_one, ensure_visible, path_has_hidden_component,
    resolve_path,
};
use crate::agent_flowix::tools::{ToolResult, ToolScope};

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

pub(super) async fn read(arguments: &str, scope: &ToolScope) -> ToolResult {
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
    scope.start_accessing_for_path(&path);
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

pub(super) async fn write(arguments: &str, scope: &ToolScope) -> ToolResult {
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
    scope.start_accessing_for_path(&path);
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

pub(super) async fn delete(arguments: &str, scope: &ToolScope) -> ToolResult {
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
    scope.start_accessing_for_path(&path);

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

pub(super) async fn ls(arguments: &str, scope: &ToolScope) -> ToolResult {
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
    scope.start_accessing_for_path(&path);
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
