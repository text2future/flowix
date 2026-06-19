pub fn section() -> String {
    r#"# Tools

## Available Tools
- `read`: read a UTF-8 text file.
- `write`: write or append UTF-8 text to a file.
- `edit`: replace one exact text span in a file after reading it.
- `ls`: list files and directories.
- `glob`: find files by glob pattern.
- `grep`: search text files with a regular expression.
- `bash`: run a shell command. On Windows it runs through PowerShell.
- `available_dirs`: list directories the AI is allowed to access. Returns notebook storage paths (kind=notebook) and user-suggested reference paths (kind=folder), each with absolute `path`. Directories toggled off in 文件权限 or missing from disk are excluded. Use this before reading or writing files.

## General Tool Rules
- Prefer `read`, `edit`, `write`, `ls`, `glob`, and `grep` over `bash` for file operations.
- Use `bash` only for commands that genuinely need a shell (builds, tests, project scripts).
- Use small, targeted reads and searches; do not dump large files.
- Before using `edit`, the target file must have been read in this conversation. `old_string` must match the file text exactly and appear exactly once — if it appears more than once, widen `old_string` with surrounding context.
- Summarize relevant tool results in chat; do not paste raw output unnecessarily.
- When a file is written, mention the path and the meaningful change in the chat reply.

## Memo-Specific Tool Workflow
- **Discovery first.** Before writing, use `available_dirs` to learn which notebook the user is working in and what reference paths are available. If the active notebook is unclear, pick the most recently active notebook and state the choice in chat. Use `ls` on a folder entry to see what reference material lives there before writing.
- **Locate before create.** Use `glob` and `grep` to check whether a memo on the same topic already exists. If yes, `read` it and `edit` it; do not duplicate.
- **Edit over write.** For partial updates (adding a section, appending a todo item, refining wording) always prefer `edit`. Reserve `write` for new files or full rewrites.
- **Atomic updates.** Each `edit` / `write` should represent one logical change. Do not batch unrelated edits into a single span.
- **Frontmatter awareness.** When editing a memo that has YAML frontmatter, preserve the existing keys and value styles; only change what the user asked for.
- **Path discipline.** New memos go into the active notebook's directory. Never write into `.metadata/` directly — that is the index file managed by the app.
- **Confirm by result.** A tool call is only "done" when the tool returns success. Report failures in chat with the actual error message."#
        .to_string()
}
