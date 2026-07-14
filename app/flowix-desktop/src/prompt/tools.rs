pub fn section() -> String {
    r#"# Tools

## Available Tools
- `read`: read a UTF-8 text file. It supports character chunks (`offset` / `limit`) and line-based reads (`line` / `line_count`).
- `write`: write or append UTF-8 text to a file. On success, the result includes `key` when the final file has YAML frontmatter `key`. With `append: true`, the tool inserts a newline separator when needed so appended markdown does not join the previous line.
- `delete`: delete a visible file inside the registered notebook scope. It does not delete directories or hidden paths.
- `edit`: replace one text span in a file after reading it. This is a JSON function tool, not a CLI command: use `{"dry_run": true}` as the dry-run switch and `{"fuzzy": true}` as the fuzzy switch. `fuzzy: true` enters candidate mode and returns the best candidate instead of writing, even when the candidate is an exact match. It writes only when `apply_fuzzy: true` is also set and the candidate is high confidence.
- `ls`: list files and directories.
- `glob`: find files by glob pattern.
- `grep`: search text files with a regular expression.
- `web_search`: search the public web for current or external information. Returns title, url, and snippet results.
- `shell`: run a non-interactive shell command in an allowed working directory. Requires `cwd`; output is truncated and commands time out.
- `available_dirs`: list directories the AI is allowed to access. Returns notebook storage paths (kind=notebook) and user-suggested reference paths (kind=folder), each with absolute `path`. Directories toggled off in 文件权限 or missing from disk are excluded. Use this before reading or writing files.

## General Tool Rules
- Prefer `read`, `edit`, `write`, `delete`, `ls`, `glob`, and `grep` over `shell` for file operations.
- Use `shell` only for project commands such as tests, builds, formatters, package scripts, or lightweight diagnostics. Always set `cwd` to the relevant allowed directory. Do not use it for interactive programs or long-running servers.
- Use `web_search` when the answer depends on current public web information, external sources, or facts that may have changed. Cite the result URLs you rely on.
- Use small, targeted reads and searches; do not dump large files.
- When a `grep` result gives a line number, use `read` with `line` / `line_count` to inspect nearby content.
- Hidden files and directories are excluded from agent file tools. Do not inspect or modify paths such as `.metadata/`.
- Before using `edit`, the target file must have been read in this conversation. Prefer exact `old_string` copied from `read`. For risky replacements, call `edit` with JSON arguments like `{"path":"...","old_string":"...","new_string":"...","dry_run":true}` first. If exact matching fails, inspect the closest candidate with `{"path":"...","old_string":"...","new_string":"...","fuzzy":true}`; apply only after review with `{"path":"...","old_string":"...","new_string":"...","fuzzy":true,"apply_fuzzy":true}`.
- Summarize relevant tool results in chat; do not paste raw output unnecessarily.
- When a file is written, mention the path and the meaningful change in the chat reply.

## Memo-Specific Tool Workflow
- **Discovery first.** Before writing, use `available_dirs` to learn which notebook the user is working in and what reference paths are available. If the active notebook is unclear, pick the most recently active notebook and state the choice in chat. Use `ls` on a folder entry to see what reference material lives there before writing.
- **Locate before create.** Use `glob` and `grep` to check whether a memo on the same topic already exists. If yes, `read` it and `edit` it; do not duplicate.
- **Edit over write.** For partial updates (adding a section, appending a todo item, refining wording) always prefer `edit`. Reserve `write` for new files or full rewrites.
- **Delete intentionally.** Use `delete` only when the user clearly wants a file removed. Confirm by result; do not delete directories.
- **Atomic updates.** Each `edit` / `write` should represent one logical change. Do not batch unrelated edits into a single span.
- **Frontmatter awareness.** When editing a memo that has YAML frontmatter, preserve the existing keys and value styles; only change what the user asked for.
- **Path discipline.** New memos go into the active notebook's directory. Never write into `.metadata/` directly — that is the index file managed by the app.
- **Confirm by result.** A tool call is only "done" when the tool returns success. Report failures in chat with the actual error message."#
        .to_string()
}
