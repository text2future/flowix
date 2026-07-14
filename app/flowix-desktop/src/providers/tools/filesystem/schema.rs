use rllm::chat::Tool;

use super::constants::{MAX_GREP_LIMIT, MAX_LIST_LIMIT, MAX_READ_LIMIT, MAX_READ_LINE_COUNT};
use crate::providers::tools::function_tool;

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
