//! Project-local instructions shared with runtimes that natively load
//! `AGENTS.md` from their working directory.

use crate::config::AiMemoryLocation;
use std::fs;
use std::path::Path;

const MANAGED_START: &str = "<!-- flowix:instructions:start -->";
const MANAGED_END: &str = "<!-- flowix:instructions:end -->";
const BLOCK_BEGIN: &str = "FLOWIX_MANAGED_INSTRUCTIONS_BEGIN";
const BLOCK_END: &str = "FLOWIX_MANAGED_INSTRUCTIONS_END";
const BLOCK_START: &str = "<!--\nFLOWIX_MANAGED_INSTRUCTIONS_BEGIN\n";
const BLOCK_FINISH: &str = "\nFLOWIX_MANAGED_INSTRUCTIONS_END\n-->";

const FLOWIX_INSTRUCTIONS: &str = r#"## Flowix CLI

- Use `flowix` for note operations only when explicitly requested. Use `--json` for machine-readable output.
- Note addresses are `<notebook-id>::<relative-path>` or absolute paths, not memo IDs. Read a note before editing or overwriting it. Include the current task tag in newly created notes when present.
- For `list`, follow `next_offset` with `--offset` and the first page’s `--snapshot`; restart if data changed. Search returns `truncated`; narrow the query or increase the limit if true. For `write` and `delete`, pass `show --json`’s `version` via `--if-version` to detect changes since reading.
- Commands: `flowix notebooks`; `flowix list [notebook] [--limit N] [--offset N] [--snapshot TOKEN]`; `flowix tags [notebook]`; `flowix show <address>`; `flowix search <query> [-b <notebook>] [--tag <tag-path>] [-l N]`; `flowix edit <address> --old <text> (--new <text> | --new-file <UTF-8-file> | --new-stdin) [--dry-run]`; `flowix write <address> --file <UTF-8-file> --if-version <version>`; `flowix create [notebook] --title <title> [--folder <relative-path>] --file <UTF-8-file>`; `flowix delete <address> --if-version <version>`.

## Databases (collections)

Notebook databases are exposed as collections in the CLI. Use when the user explicitly asks to inspect or query a database, or add a note to one. List collections, then describe a collection to inspect its fields and views before querying it. Use `collection add-note` only when asked to add a note to a collection; it creates and links the note.

- `flowix collection list [notebook]`
- `flowix collection describe --notebook <notebook> (--id <collection-id> | --path <path>)`
- `flowix collection query --notebook <notebook> (--id <collection-id> | --path <path>) [--domain <domain>] [--view <view-id>] [--query <text>] [--fields <field,...>] [--sort <field>] [--limit N] [--offset N]`
- `flowix collection read --notebook <notebook> (--id <collection-id> | --path <path>)`
- `flowix collection add-note --notebook <notebook> (--id <collection-id> | --path <path>) --title <title> (--file <UTF-8-file> | --stdin)`

## Plugin artifacts

Use when the user explicitly requests creation of a plugin artifact, such as a mind map. Run `flowix plugin --help`, then `flowix plugin describe <plugin-id>` for the tool's input contract before creating it."#;

const FLOWIX_ENVIRONMENT_CONTEXT: &str = r#"## Notebook HTML pages

Use when creating or modifying HTML pages that integrate with a Flowix notebook. Run `flowix html --help` for usage, then `flowix html` for the capability catalog and templates. Put pages inside the current notebook; query `window.flowix.request('capabilities')` for the running host's actual capabilities.

## Notebook components

Use when creating or managing reusable static HTML/CSS style blocks that users can insert into notes in the Flowix editor. These are editor components, not standalone notebook HTML pages or interactive apps. Run `flowix component --help` for usage, then `flowix component` for the format and constraints."#;

fn effective_ai_memory_folder(value: &str) -> &str {
    let folder = value.trim();
    if folder.is_empty()
        || folder == "."
        || folder == ".."
        || folder
            .chars()
            .any(|ch| ch == '/' || ch == '\\' || ch.is_control() || "<>:\"|?*".contains(ch))
        || folder.ends_with('.')
        || folder.ends_with(' ')
    {
        "Memory"
    } else {
        folder
    }
}

fn normalize_ai_memory_path(value: &str) -> Option<String> {
    let path = value.trim().trim_end_matches('/');
    if path.is_empty()
        || path.starts_with('/')
        || path.contains('\\')
        || path.contains("//")
        || path
            .chars()
            .any(|ch| ch.is_control() || "<>:\"|?*`".contains(ch))
        || path.split('/').any(|part| {
            part.is_empty()
                || part == "."
                || part == ".."
                || part.ends_with('.')
                || part.ends_with(' ')
        })
    {
        return None;
    }
    Some(path.to_string())
}

fn effective_ai_memory_locations(
    locations: &[AiMemoryLocation],
    legacy_folder: &str,
) -> Vec<(&'static str, String, String)> {
    let root = effective_ai_memory_folder(legacy_folder);
    let builtins = [
        ("general", "通用记忆", "通用"),
        ("solution", "方案", "方案"),
        ("workflow", "工作流", "工作流"),
    ];
    let mut resolved = Vec::new();

    for (id, name, old_default_suffix) in builtins {
        let location = locations.iter().find(|location| location.id == id);
        if id != "general" && location.is_none() && !locations.is_empty() {
            continue;
        }
        let configured = location.and_then(|location| normalize_ai_memory_path(&location.path));
        let default_path = if id == "general" {
            root.to_string()
        } else {
            format!("{root}/{old_default_suffix}")
        };
        let path = configured.unwrap_or(default_path);
        let display_name = if id == "general" {
            name
        } else {
            location
                .map(|location| location.name.trim())
                .filter(|name| {
                    !name.is_empty()
                        && !name.chars().any(|ch| ch.is_control() || "/\\".contains(ch))
                })
                .unwrap_or(name)
        };
        resolved.push((id, display_name.to_string(), path));
    }

    for location in locations {
        if matches!(location.id.as_str(), "general" | "solution" | "workflow") {
            continue;
        }
        let name = location.name.trim();
        if name.is_empty() || name.chars().any(|ch| ch.is_control() || "/\\".contains(ch)) {
            continue;
        }
        let Some(path) = normalize_ai_memory_path(&location.path) else {
            continue;
        };
        resolved.push(("custom", name.to_string(), path));
    }
    resolved
}

fn workspace_scope_with_ai_memory_locations(
    cwd: &Path,
    workspace_paths: &[String],
    ai_memory_locations: &[AiMemoryLocation],
    legacy_ai_memory_folder: &str,
    ai_personality: &str,
) -> String {
    let mut notebook_folders = Vec::new();
    if let Ok(entries) = fs::read_dir(cwd) {
        for entry in entries.flatten() {
            if entry
                .metadata()
                .map(|metadata| metadata.is_dir())
                .unwrap_or(false)
            {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name != ".flowix" {
                    notebook_folders.push(name);
                }
            }
        }
    }
    notebook_folders.sort();
    let cwd = cwd.display().to_string();

    let mut folders = Vec::new();
    for raw in workspace_paths {
        let path = raw.trim();
        if path.is_empty() || path == cwd {
            continue;
        }
        if !folders.iter().any(|existing: &String| existing == path) {
            folders.push(path.to_string());
        }
    }

    let mut section = String::from("## Workspace\n\n");
    section.push_str(&format!(
        "- Current notebook & CWD: {}\n",
        safe_json_string(&cwd)
    ));
    if notebook_folders.is_empty() {
        section.push_str("  - Top-level folders: none\n\n");
    } else {
        section.push_str("  - Top-level folders:\n");
        for folder in notebook_folders {
            section.push_str(&format!(
                "    - {}\n",
                safe_json_string(&format!("{folder}/"))
            ));
        }
        section.push('\n');
    }
    if folders.is_empty() {
        section.push_str("- Additional Folders: none\n");
    } else {
        section.push_str("- Additional Folders:\n");
        for folder in folders {
            section.push_str(&format!("  - {}\n", safe_json_string(&folder)));
        }
    }
    section.push_str("\n## AI memory\n\n");
    section.push_str("- Use the matching folder below. Paths are relative to the notebook root; create folders as needed. Save general memory in a daily `YYYY-MM-DD.md` file.\n");
    for (kind, name, path) in
        effective_ai_memory_locations(ai_memory_locations, legacy_ai_memory_folder)
    {
        let location = if kind == "general" {
            format!("{path}/YYYY-MM-DD.md")
        } else {
            format!("{path}/")
        };
        section.push_str(&format!(
            "- {}: {}\n",
            safe_json_string(&name),
            safe_json_string(&location),
        ));
    }
    let personality = ai_personality.trim();
    if !personality.is_empty() {
        section.push_str("\n## Personality\n\n");
        section.push_str(&format!(
            "- Follow this user-provided personality guidance: {}\n",
            safe_json_string(personality),
        ));
    }
    section
}

fn safe_json_string(value: &str) -> String {
    // JSON escapes control characters; escaping > also prevents a path from
    // terminating the surrounding HTML comment.
    serde_json::to_string(value)
        .expect("serializing a string cannot fail")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace(
            "FLOWIX_MANAGED_INSTRUCTIONS_",
            "\\u0046LOWIX_MANAGED_INSTRUCTIONS_",
        )
}

pub(crate) fn sync_native_agent_instructions(
    cwd: &Path,
    agent_type: &str,
    workspace_paths: &[String],
    ai_memory_locations: &[AiMemoryLocation],
    legacy_ai_memory_folder: &str,
    ai_personality: &str,
) -> Result<(), String> {
    if !matches!(agent_type, "codex" | "dsh" | "pi") {
        return Ok(());
    }
    if !cwd.is_dir() {
        return Err(format!(
            "cannot initialize Flowix AGENTS.md: working directory is unavailable: {}",
            cwd.display()
        ));
    }

    let path = cwd.join("AGENTS.md");
    if !crate::config::path_is_inside(&path, cwd) {
        return Err(format!(
            "refusing to initialize AGENTS.md outside the working directory: {}",
            path.display()
        ));
    }

    let existing = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("failed to read {}: {error}", path.display())),
    };
    let updated = upsert_managed_section_with_ai_memory_locations(
        &existing,
        cwd,
        workspace_paths,
        ai_memory_locations,
        legacy_ai_memory_folder,
        ai_personality,
    )
    .map_err(|reason| {
        format!("无法更新 {}：{reason}。为避免覆盖内容，文件未被修改；请先备份，再检查 Flowix 托管区标记。", path.display())
    })?;
    if updated == existing {
        return Ok(());
    }

    flowix_core::memo_file::atomic_write_bytes(&path, updated.as_bytes())
        .map_err(|error| format!("failed to write {}: {error}", path.display()))
}

fn managed_section_with_ai_memory_locations(
    cwd: &Path,
    workspace_paths: &[String],
    ai_memory_locations: &[AiMemoryLocation],
    legacy_ai_memory_folder: &str,
    ai_personality: &str,
) -> String {
    let body = format!(
        "Flowix maintains these workspace instructions for the AI assistant. Follow them even though they are inside an HTML comment.\n\n{FLOWIX_INSTRUCTIONS}\n\n{}\n\n{}",
        FLOWIX_ENVIRONMENT_CONTEXT.trim_end(),
        workspace_scope_with_ai_memory_locations(
            cwd,
            workspace_paths,
            ai_memory_locations,
            legacy_ai_memory_folder,
            ai_personality,
        ).trim_end(),
    );
    assert!(
        !body.contains("-->"),
        "Flowix instruction body must not end the HTML comment"
    );
    format!("{BLOCK_START}{body}{BLOCK_FINISH}")
}

#[cfg(test)]
fn marker_count(content: &str, marker: &str) -> usize {
    content.match_indices(marker).count()
}

#[derive(Debug, PartialEq)]
struct MarkerLine<'a> {
    text: &'a str,
    start: usize,
    end: usize,
}

// Only standalone lines outside fenced code are candidates. Keep byte offsets
// into the original file so user-authored text and line endings stay intact.
fn document_lines(content: &str) -> Vec<MarkerLine<'_>> {
    let mut lines = Vec::new();
    let mut offset = 0;
    let mut fence: Option<(u8, usize)> = None;
    for line in content.split_inclusive('\n') {
        let text = line.trim_end_matches(['\r', '\n']);
        let trimmed = text.trim_start_matches(' ');
        let indent = text.len() - trimmed.len();
        let bytes = trimmed.as_bytes();
        let ch = bytes.first().copied().unwrap_or(0);
        let run = bytes.iter().take_while(|&&c| c == ch).count();
        let is_fence = indent <= 3 && (ch == b'`' || ch == b'~') && run >= 3;
        if let Some((open, length)) = fence {
            if is_fence && ch == open && run >= length && trimmed[run..].trim().is_empty() {
                fence = None;
            }
        } else if is_fence && (ch != b'`' || !trimmed[run..].contains('`')) {
            fence = Some((ch, run));
        } else if indent <= 3 {
            lines.push(MarkerLine {
                text: text.trim(),
                start: offset,
                end: offset + text.len(),
            });
        }
        offset += line.len();
    }
    lines
}

fn upsert_managed_section_with_ai_memory_locations(
    existing: &str,
    cwd: &Path,
    workspace_paths: &[String],
    ai_memory_locations: &[AiMemoryLocation],
    legacy_ai_memory_folder: &str,
    ai_personality: &str,
) -> Result<String, String> {
    let lines = document_lines(existing);
    let positions = |marker: &str| -> Vec<usize> {
        lines
            .iter()
            .enumerate()
            .filter_map(|(i, line)| (line.text == marker).then_some(i))
            .collect()
    };
    let legacy_start = positions(MANAGED_START);
    let legacy_end = positions(MANAGED_END);
    let block_begin = positions(BLOCK_BEGIN);
    let block_end = positions(BLOCK_END);
    if [
        legacy_start.len(),
        legacy_end.len(),
        block_begin.len(),
        block_end.len(),
    ]
    .iter()
    .any(|&n| n > 1)
    {
        return Err("发现重复的 Flowix 托管区标记".into());
    }
    if legacy_start.len() != legacy_end.len() || block_begin.len() != block_end.len() {
        return Err("Flowix 托管区缺少起始或结束标记".into());
    }
    let block_range = if let (Some(&begin), Some(&end)) = (block_begin.first(), block_end.first()) {
        if begin == 0
            || end + 1 >= lines.len()
            || lines[begin - 1].text != "<!--"
            || lines[end + 1].text != "-->"
            || !matches!(
                &existing[lines[begin - 1].end..lines[begin].start],
                "\n" | "\r\n"
            )
            || !matches!(
                &existing[lines[end].end..lines[end + 1].start],
                "\n" | "\r\n"
            )
            || end <= begin
        {
            return Err("新版 Flowix 托管区格式或标记顺序无效".into());
        }
        let start = lines[begin - 1].start;
        let finish = lines[end + 1].end;
        if existing[lines[begin].end..lines[end].start].contains("-->") {
            return Err("新版 Flowix 托管区注释提前结束".into());
        }
        Some((start, finish))
    } else {
        None
    };
    let legacy_range =
        if let (Some(&begin), Some(&end)) = (legacy_start.first(), legacy_end.first()) {
            if end <= begin {
                return Err("旧版 Flowix 托管区标记顺序颠倒".into());
            }
            Some((lines[begin].start, lines[end].end))
        } else {
            None
        };
    if let (Some((a, b)), Some((c, d))) = (block_range, legacy_range) {
        if a < d && c < b {
            return Err("Flowix 托管区相互重叠".into());
        }
    }
    let newline = if existing.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let section = managed_section_with_ai_memory_locations(
        cwd,
        workspace_paths,
        ai_memory_locations,
        legacy_ai_memory_folder,
        ai_personality,
    )
    .replace('\n', newline);
    if let (Some((start, end)), Some((legacy_start, legacy_end))) = (block_range, legacy_range) {
        let mut updated = existing.to_string();
        let mut edits = [
            (start, end, section.as_str()),
            (legacy_start, legacy_end, ""),
        ];
        edits.sort_by_key(|(start, _, _)| std::cmp::Reverse(*start));
        for (start, end, replacement) in edits {
            updated.replace_range(start..end, replacement);
        }
        return Ok(updated);
    }
    if let Some((start, end)) = block_range.or(legacy_range) {
        return Ok(format!(
            "{}{section}{}",
            &existing[..start],
            &existing[end..]
        ));
    }
    if existing.is_empty() {
        Ok(format!("{section}{newline}"))
    } else {
        let separator = if existing.ends_with(&format!("{newline}{newline}")) {
            "".to_string()
        } else if existing.ends_with('\n') {
            newline.to_string()
        } else {
            format!("{newline}{newline}")
        };
        Ok(format!("{existing}{separator}{section}{newline}"))
    }
}

#[cfg(test)]
fn managed_section(cwd: &Path, workspace_paths: &[String]) -> String {
    managed_section_with_ai_memory_locations(cwd, workspace_paths, &[], "", "")
}

#[cfg(test)]
fn upsert_managed_section(
    existing: &str,
    cwd: &Path,
    workspace_paths: &[String],
) -> Result<String, String> {
    upsert_managed_section_with_ai_memory_locations(existing, cwd, workspace_paths, &[], "", "")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_and_updates_a_single_hidden_block() {
        let cwd = Path::new("/book");
        let first = upsert_managed_section("User notes\n", cwd, &[]).unwrap();
        assert!(first.starts_with("User notes\n\n<!--\nFLOWIX_MANAGED_INSTRUCTIONS_BEGIN\n"));
        assert_eq!(marker_count(&first, "<!--"), 1);
        assert_eq!(marker_count(&first, "-->"), 1);
        assert_eq!(upsert_managed_section(&first, cwd, &[]).unwrap(), first);
        let updated = upsert_managed_section(&first, cwd, &["/other".into()]).unwrap();
        assert!(updated.contains("\"/other\""));
        assert!(updated.starts_with("User notes\n\n"));
    }

    #[test]
    fn migrates_legacy_without_changing_surrounding_content() {
        let old = format!("before \n\n{MANAGED_START}\nold\n<!-- flowix:enviroment\ncontext\n-->\n{MANAGED_END}\n\n after\n");
        let migrated = upsert_managed_section(&old, Path::new("/book"), &[]).unwrap();
        assert!(migrated.starts_with("before \n\n<!--\nFLOWIX_MANAGED_INSTRUCTIONS_BEGIN"));
        assert!(migrated.ends_with("-->\n\n after\n"));
        assert!(!migrated.contains(MANAGED_START));
    }

    #[test]
    fn rejects_ambiguous_or_damaged_sections() {
        let cwd = Path::new("/book");
        let valid = managed_section(cwd, &[]);
        for input in [
            MANAGED_START.to_string(),
            format!("{MANAGED_END}\n{MANAGED_START}"),
            format!("{valid}\n{valid}"),
            valid.replace(BLOCK_FINISH, ""),
            valid.replace("## Flowix CLI", "-->\n## Flowix CLI"),
        ] {
            assert!(
                upsert_managed_section(&input, cwd, &[]).is_err(),
                "accepted {input}"
            );
        }
    }

    #[test]
    fn replaces_coexisting_legacy_and_new_sections_in_either_order() {
        let cwd = Path::new("/book");
        let old = format!("{MANAGED_START}\nold\n{MANAGED_END}");
        let new = managed_section(cwd, &[]);
        for input in [
            format!("before\n{old}\nmiddle\n{new}\nafter\n"),
            format!("before\n{new}\nmiddle\n{old}\nafter\n"),
        ] {
            let updated = upsert_managed_section(&input, cwd, &["/other".into()]).unwrap();
            assert!(updated.contains("before\n"));
            assert!(updated.contains("\nmiddle\n"));
            assert!(updated.ends_with("\nafter\n"));
            assert!(!updated.contains(MANAGED_START));
            assert_eq!(marker_count(&updated, BLOCK_BEGIN), 1);
            assert!(updated.contains("\"/other\""));
            assert_eq!(
                upsert_managed_section(&updated, cwd, &["/other".into()]).unwrap(),
                updated
            );
        }
    }

    #[test]
    fn sync_migrates_both_sections_and_preserves_damaged_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("AGENTS.md");
        let old = format!("{MANAGED_START}\nold\n{MANAGED_END}");
        let new = managed_section(dir.path(), &[]);
        fs::write(&path, format!("before\n{new}\nmiddle\n{old}\nafter\n")).unwrap();
        sync_native_agent_instructions(dir.path(), "codex", &[], &[], "", "").unwrap();
        let migrated = fs::read_to_string(&path).unwrap();
        assert!(!migrated.contains(MANAGED_START));
        assert_eq!(marker_count(&migrated, BLOCK_BEGIN), 1);
        assert!(migrated.contains("\nmiddle\n"));
        assert!(migrated.ends_with("\nafter\n"));

        let damaged = format!("user content\n{MANAGED_START}\nunfinished");
        fs::write(&path, &damaged).unwrap();
        assert!(sync_native_agent_instructions(dir.path(), "codex", &[], &[], "", "").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), damaged);
    }

    #[test]
    fn supports_crlf_and_preserves_it_on_migration_and_refresh() {
        let cwd = Path::new("/book");
        let old = format!("before\r\n\r\n{MANAGED_START}\r\nold\r\n{MANAGED_END}\r\nafter\r\n");
        let migrated = upsert_managed_section(&old, cwd, &[]).unwrap();
        assert!(migrated.contains("<!--\r\nFLOWIX_MANAGED_INSTRUCTIONS_BEGIN\r\n"));
        assert!(!migrated.replace("\r\n", "").contains('\n'));
        assert_eq!(
            upsert_managed_section(&migrated, cwd, &[]).unwrap(),
            migrated
        );
        assert!(migrated.ends_with("-->\r\nafter\r\n"));
    }

    #[test]
    fn ignores_marker_examples_in_fenced_code_and_inline_prose() {
        let examples = format!("Example: {BLOCK_BEGIN}\n\n```md\n{MANAGED_START}\nexample\n{MANAGED_END}\n{BLOCK_BEGIN}\n```\n\n~~~\n{BLOCK_END}\n~~~\n");
        let result = upsert_managed_section(&examples, Path::new("/book"), &[]).unwrap();
        assert!(result.starts_with(&examples));
        assert_eq!(
            upsert_managed_section(&result, Path::new("/book"), &[]).unwrap(),
            result
        );
    }

    #[test]
    fn paths_are_json_encoded_without_breaking_markers_or_comment() {
        let raw = "/test/-->\nFLOWIX_MANAGED_INSTRUCTIONS_BEGIN/<!-- flowix:instructions:start -->";
        let section = managed_section(Path::new("/book"), &[raw.into()]);
        assert_eq!(marker_count(&section, "-->"), 1);
        assert_eq!(marker_count(&section, BLOCK_BEGIN), 1);
        assert!(!section.contains(MANAGED_START));
        let encoded = safe_json_string(raw);
        assert_eq!(serde_json::from_str::<String>(&encoded).unwrap(), raw);
        assert!(upsert_managed_section(&section, Path::new("/book"), &[raw.into()]).is_ok());
    }
}
