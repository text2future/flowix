//! Project-local instructions shared with runtimes that natively load
//! `AGENTS.md` from their working directory.

use std::fs;
use std::path::Path;

const MANAGED_START: &str = "<!-- flowix:instructions:start -->";
const MANAGED_END: &str = "<!-- flowix:instructions:end -->";

const FLOWIX_INSTRUCTIONS: &str = r#"## Flowix CLI

Flowix 是用于操作笔记和插件产物的非交互式 CLI，使用 `--json` 时返回 JSON。

只在显式触发时调：用户说“搜/列/改/删/新建笔记”，或给了笔记本及路径要求“看/改/删”。
如果上下文包含当前任务标签，创建新笔记时必须在正文写入该 #标签。
笔记地址使用 `<笔记本ID>::<笔记本内相对路径>`，也可传入笔记的绝对路径。笔记没有 memo ID。

- `flowix notebooks` — 列出所有笔记本
- `flowix list <notebook>` — 列出指定笔记本中的笔记
- `flowix show <地址>` — 查看指定笔记
- `flowix search <query> [-b <notebook>] [-l N]` — 全文搜索
- `flowix edit <地址> --old <text> --new <text>` — 精确替换文本，修改前必须先读取
- `flowix write <地址> --file <UTF-8文件>` — 覆盖笔记正文
- `flowix create <notebook> --file <UTF-8文件>` — 创建新笔记
- `flowix delete <地址>` — 删除笔记
- `flowix plugin create mindmap --notebook <name|id|path> [--source-note <地址>] --json` — 创建 Flowix 思维导图文档

仅当用户明确要求生成/创建思维导图时调用 mindmap 工具。调用前先整理最终 Markdown：

- 恰好一个一级根标题；
- 分支使用二/三级标题和无序列表；
- 不要手工创建 `.plugin-output` 文件；
- 成功后向用户返回 `title`、`notebookId` 和 `notePath`。"#;

fn workspace_scope(cwd: &Path, workspace_paths: &[String]) -> String {
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

    let mut section = String::from("## 工作空间范围\n\n");
    section.push_str("当前 agent 可访问的工作空间路径：\n\n");
    section.push_str(&format!("- 当前笔记本：{cwd}\n"));
    if folders.is_empty() {
        section.push_str("- 资料文件夹：无额外文件夹\n");
    } else {
        section.push_str("- 资料文件夹：\n");
        for folder in folders {
            section.push_str(&format!("  - {folder}\n"));
        }
    }
    section
}

pub(crate) fn sync_native_agent_instructions(
    cwd: &Path,
    agent_type: &str,
    workspace_paths: &[String],
) -> Result<(), String> {
    if !matches!(agent_type, "codex" | "deepseek-harness" | "pi") {
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
    let updated = upsert_managed_section(&existing, cwd, workspace_paths)?;
    if updated == existing {
        return Ok(());
    }

    flowix_core::memo_file::atomic_write_bytes(&path, updated.as_bytes())
        .map_err(|error| format!("failed to write {}: {error}", path.display()))
}

fn managed_section(cwd: &Path, workspace_paths: &[String]) -> String {
    format!(
        "{MANAGED_START}\n{FLOWIX_INSTRUCTIONS}\n\n{}\n{MANAGED_END}",
        workspace_scope(cwd, workspace_paths).trim_end()
    )
}

fn marker_count(content: &str, marker: &str) -> usize {
    content.match_indices(marker).count()
}

fn upsert_managed_section(
    existing: &str,
    cwd: &Path,
    workspace_paths: &[String],
) -> Result<String, String> {
    let start_count = marker_count(existing, MANAGED_START);
    let end_count = marker_count(existing, MANAGED_END);
    if start_count > 1 || end_count > 1 || start_count != end_count {
        return Err(
            "AGENTS.md contains an invalid or duplicated Flowix instruction section".to_string(),
        );
    }

    let section = managed_section(cwd, workspace_paths);
    if start_count == 1 {
        let start = existing.find(MANAGED_START).unwrap();
        let end = existing.find(MANAGED_END).unwrap();
        if end < start {
            return Err("AGENTS.md contains reversed Flowix instruction markers".to_string());
        }
        let after = end + MANAGED_END.len();
        let prefix = existing[..start].trim_end();
        let suffix = existing[after..].trim_start();
        return Ok(join_sections(prefix, &section, suffix));
    }

    if existing.trim().is_empty() {
        Ok(format!("{section}\n"))
    } else {
        Ok(join_sections(existing.trim_end(), &section, ""))
    }
}

fn join_sections(prefix: &str, section: &str, suffix: &str) -> String {
    let mut result = String::new();
    if !prefix.is_empty() {
        result.push_str(prefix);
        result.push_str("\n\n");
    }
    result.push_str(section);
    if !suffix.is_empty() {
        result.push_str("\n\n");
        result.push_str(suffix);
    }
    result.push('\n');
    result
}
