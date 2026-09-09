//! CLI 命令实现 ── 在 `memo_file` 之上做薄包装。
//!
//! M1: `cmd_notebooks`
//! M2: `cmd_list` / `cmd_show`
//! M3: `cmd_create` (面向 AI, body 从显式输入源读)

use crate::{
    errors::CliError,
    fmt,
    output::{
        print_pretty_json, NoteCreated, NoteDeleted, NoteEdited, NoteWritten, SearchMatch,
        SearchOutput,
    },
    paths,
};
use flowix_core::memo_file::{normalize_search_tag_filter, MemoFile, NotebookConfig};
use flowix_core::MemoService;
use std::{collections::HashMap, path::PathBuf};

/// 构造一个 `MemoFile`, 走 `paths::resolve()` 解析的数据目录。
pub fn open() -> Result<MemoFile, CliError> {
    let p = paths::resolve()?;
    Ok(MemoFile::new(p.config_dir))
}

fn read_notebook_configs_strict(mf: &MemoFile) -> Result<Vec<NotebookConfig>, CliError> {
    mf.read_notebook_configs().map_err(CliError::Io)
}

/// `flowix-cli notebooks --json` ── 输出 JSON 形式。
pub fn cmd_notebooks_json() -> Result<(), CliError> {
    let (configs, selected_notebook_id) = notebooks_list_data()?;
    let note_counts = notebook_note_counts(&configs)?;
    let tag_counts = notebook_tag_counts(&configs)?;
    fmt::print_notebooks_json(
        &configs,
        &note_counts,
        &tag_counts,
        selected_notebook_id.as_deref(),
    );
    Ok(())
}

/// notebook 列表和共享选择状态的数据源，供 CLI 和 MCP 命令层复用。
pub(crate) fn notebooks_list_data() -> Result<(Vec<NotebookConfig>, Option<String>), CliError> {
    let mf = open()?;
    let configs = MemoService::new(&mf).list_notebooks()?;
    let selected_notebook_id = mf.read_selected_notebook_id()?;
    Ok((configs, selected_notebook_id))
}

/// `flowix-cli notebooks` ── 列出所有 notebook。
pub fn cmd_notebooks() -> Result<(), CliError> {
    let mf = open()?;
    let configs = read_notebook_configs_strict(&mf)?;
    let selected_notebook_id = mf.read_selected_notebook_id()?;
    let note_counts = notebook_note_counts(&configs)?;
    let tag_counts = notebook_tag_counts(&configs)?;
    fmt::print_notebooks(
        &configs,
        &note_counts,
        &tag_counts,
        selected_notebook_id.as_deref(),
    );
    Ok(())
}

pub(crate) fn notebook_note_counts(
    configs: &[NotebookConfig],
) -> Result<HashMap<String, usize>, CliError> {
    let mf = open()?;
    MemoService::new(&mf)
        .notebook_note_counts(configs)
        .map_err(Into::into)
}

pub(crate) fn notebook_tag_counts(
    configs: &[NotebookConfig],
) -> Result<HashMap<String, usize>, CliError> {
    let mf = open()?;
    Ok(configs
        .iter()
        .map(|config| {
            let count = mf.derived_tags_for_notebook_id(Some(&config.id)).len();
            (config.id.clone(), count)
        })
        .collect())
}

/// 按 `name` 或 `id` 找 notebook。id 优先, 避免同名 notebook 歧义。
pub fn find_notebook<'a>(configs: &'a [NotebookConfig], key: &str) -> Option<&'a NotebookConfig> {
    configs
        .iter()
        .find(|c| c.id == key)
        .or_else(|| configs.iter().find(|c| c.name == key))
}

/// 给定 notebook key, 构造一个 set_current_notebook 完的 MemoFile。
pub(crate) fn open_in(notebook_key: &str) -> Result<(MemoFile, NotebookConfig), CliError> {
    let mf = open()?;
    let configs = read_notebook_configs_strict(&mf)?;
    let nb = find_notebook(&configs, notebook_key)
        .ok_or_else(|| {
            CliError::NotFound(format!(
                "notebook `{notebook_key}` (try `flowix notebooks` to list)"
            ))
        })?
        .clone();
    let mut mf = open()?;
    mf.set_current_notebook(Some(nb.id.clone()));
    Ok((mf, nb))
}

/// Resolve an explicit notebook or fall back to the shared desktop selection.
pub(crate) fn resolve_notebook_key(notebook: Option<&str>) -> Result<String, CliError> {
    if let Some(value) = notebook.filter(|value| !value.trim().is_empty()) {
        return Ok(value.to_string());
    }
    let mf = open()?;
    if let Some(selected) = mf.read_selected_notebook_id()? {
        return Ok(selected);
    }
    let configs = read_notebook_configs_strict(&mf)?;
    configs
        .iter()
        .find(|config| config.is_default)
        .or_else(|| configs.first())
        .map(|config| config.id.clone())
        .ok_or_else(|| CliError::NotFound("no notebook is configured".into()))
}

/// `flowix-cli list <notebook> --json` ── 输出 JSON 形式。
pub fn cmd_list_json(notebook_key: &str) -> Result<(), CliError> {
    let entries = notes_list_entries(notebook_key)?;
    fmt::print_notes_json(&entries);
    Ok(())
}

/// memo 列表的数据源，读取 notebook 的 memo index。
pub(crate) fn notes_list_entries(
    notebook_key: &str,
) -> Result<Vec<flowix_core::memo_file::MemoIndexEntry>, CliError> {
    let mf = open()?;
    MemoService::new(&mf)
        .list_memos(notebook_key)
        .map_err(Into::into)
}

/// `flowix-cli list <notebook>` ── 列出某 notebook 下的笔记。
pub fn cmd_list(notebook_key: &str) -> Result<(), CliError> {
    let entries = notes_list_entries(notebook_key)?;
    fmt::print_notes(&entries);
    Ok(())
}

pub(crate) fn notebook_tags(notebook: Option<&str>) -> Result<serde_json::Value, CliError> {
    let notebook_key = resolve_notebook_key(notebook)?;
    let (memo_file, config) = open_in(&notebook_key)?;
    let tags = memo_file
        .derived_tags_for_notebook_id(Some(&config.id))
        .into_iter()
        .map(|tag| tag.name)
        .collect::<Vec<_>>();
    Ok(serde_json::json!({
        "ok": true,
        "action": "tags",
        "notebook": config.name,
        "notebook_id": config.id,
        "total": tags.len(),
        "tags": tags,
    }))
}

pub fn cmd_tags(notebook: Option<&str>, json: bool) -> Result<(), CliError> {
    let result = notebook_tags(notebook)?;
    if json {
        print_pretty_json(&result)
    } else {
        let tags = result["tags"].as_array().cloned().unwrap_or_default();
        if tags.is_empty() {
            println!("(no tags)");
        } else {
            for tag in tags {
                if let Some(name) = tag.as_str() {
                    println!("{name}");
                }
            }
        }
        Ok(())
    }
}

/// id 解析辅助: 把 `id_arg` (6 位 shortid / filename basename)
/// 落到某 notebook 的某条 memo 上。返回 `(MemoFile, 完整 shortid)`。
///
/// v3 改造: id 不再含 `nb#xxx` 分隔符 ── 直接是 6 位 shortid。
/// 解析顺序:
/// 1. shortid 完全匹配 (扫所有 notebook)
/// 2. filename basename (去 .md) (扫所有 notebook)
pub(crate) fn resolve_id(id_arg: &str) -> Result<(MemoFile, String), CliError> {
    let (mf, id, _) = resolve_id_with_notebook(id_arg)?;
    Ok((mf, id))
}

pub(crate) fn resolve_id_with_notebook(
    id_arg: &str,
) -> Result<(MemoFile, String, NotebookConfig), CliError> {
    let mut mf = open()?;
    let resolved = MemoService::new(&mf).resolve_memo(id_arg)?;
    mf.set_current_notebook(Some(resolved.notebook.id.clone()));
    Ok((mf, resolved.id, resolved.notebook))
}

/// `flowix-cli show <id>` ── 读一条笔记到 stdout。
pub fn cmd_show(id_arg: &str) -> Result<(), CliError> {
    let shown = note_show_data(id_arg)?;
    fmt::print_note(&shown.entry, &shown.body);
    Ok(())
}

/// `flowix-cli show <id> --json` ── 输出 JSON 形式。
pub fn cmd_show_json(id_arg: &str) -> Result<(), CliError> {
    let shown = note_show_data(id_arg)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&shown.to_json())
            .map_err(|e| CliError::Other(format!("json serialize: {e}")))?
    );
    Ok(())
}

pub(crate) struct NoteShowData {
    entry: flowix_core::memo_file::MemoIndexEntry,
    body: String,
    notebook: NotebookConfig,
    file_path: PathBuf,
}

impl NoteShowData {
    pub(crate) fn to_json(&self) -> serde_json::Value {
        fmt::note_to_json_with_context(&self.entry, &self.body, &self.notebook, &self.file_path)
    }
}

/// memo 读取的数据源：解析 id 并读取 body，供 CLI 和 MCP 命令层复用。
pub(crate) fn note_show_data(id_arg: &str) -> Result<NoteShowData, CliError> {
    let mf = open()?;
    let document = MemoService::new(&mf).get_memo(id_arg)?;
    Ok(NoteShowData {
        entry: document.entry,
        body: document.body,
        notebook: document.notebook,
        file_path: document.path,
    })
}

/// `flowix-cli create <notebook> --file <path>` ── 推荐从 UTF-8 文件读取 body。
/// `--stdin` 用于显式放行标准输入；Windows 上不再隐式读取 stdin。
///
/// 面向 AI agent 的接口 ── body 从明确的输入源读取, 不依赖 $EDITOR。
///
/// 标题与正文独立：创建时使用稳定的默认标题 `Untitled`，正文首行不会
/// 改变文件名。需要改名时使用独立的 rename 能力。
///
/// stdin 为空 → 报错, 不创建 (避免误操作)。
///
/// 写盘走 `MemoFile::create_memo` ── 自动写 .md + 同步 memo index + 派生字段。
///
/// 实际写盘逻辑在 [`create_note`]；本函数只是输入读取 + `create_note`
/// 的薄壳。MCP 命令层直接把工具输入传给 `create_note`。
pub fn cmd_create(
    notebook_key: Option<&str>,
    file: Option<&str>,
    stdin: bool,
    json: bool,
) -> Result<(), CliError> {
    // 先读取并校验输入，再解析 notebook，避免缺少输入时触碰存储状态。
    let source = resolve_text_input_source("create", file, stdin, cfg!(windows))?;
    let body = read_text_input(source)?;
    reject_empty_text("create", &body)?;
    let notebook_key = resolve_notebook_key(notebook_key)?;
    let (mut mf, nb) = open_in(&notebook_key)?;
    let payload = create_note(&mut mf, &nb, &body)?;
    if json {
        print_pretty_json(&payload)?;
    } else {
        println!("created: {}", payload.id);
        println!("  key:      {}", payload.id);
        println!("  notebook: {}", payload.notebook);
        println!("  title:    {}", payload.title);
        println!("  filename: {}", payload.filename);
        println!("  file:     {}", payload.file);
    }
    Ok(())
}

/// 创建一条笔记的纯函数 ── 接受 `&str body` 不读 stdin。
///
/// CLI 独立模式和 MCP 命令层共用本函数。
/// `cmd_create` 负责 human 打印或 JSON 序列化。
pub(crate) fn create_note(
    mf: &mut MemoFile,
    notebook: &NotebookConfig,
    body: &str,
) -> Result<NoteCreated, CliError> {
    let created = MemoService::new(mf).create_external_memo(&notebook.id, body)?;
    let memo = created.memo;
    let title = memo
        .filename
        .strip_suffix(".md")
        .unwrap_or(&memo.filename)
        .to_string();
    let file_path = created.path;
    let id = memo.id.clone();
    let file = file_path.display().to_string();
    Ok(NoteCreated {
        ok: true,
        action: "created",
        id: id.clone(),
        key: id,
        notebook: notebook.name.clone(),
        notebook_id: notebook.id.clone(),
        title,
        filename: memo.filename,
        file: file.clone(),
        path: file,
    })
}

fn read_stdin() -> Result<String, CliError> {
    use std::io::Read;
    let mut s = String::new();
    std::io::stdin()
        .read_to_string(&mut s)
        .map_err(CliError::Io)?;
    Ok(strip_utf8_bom(s))
}

/// Content input source for `create` and `write`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TextInputSource<'a> {
    File(&'a str),
    Stdin,
}

fn resolve_text_input_source<'a>(
    command: &str,
    file: Option<&'a str>,
    stdin: bool,
    is_windows: bool,
) -> Result<TextInputSource<'a>, CliError> {
    match (file, stdin) {
        (Some(_), true) => Err(CliError::Usage(format!(
            "{command}: --file and --stdin are mutually exclusive"
        ))),
        (Some(path), false) => Ok(TextInputSource::File(path)),
        (None, true) => Ok(TextInputSource::Stdin),
        (None, false) if is_windows => {
            let positional = if command == "create" {
                "<notebook>"
            } else {
                "<id>"
            };
            Err(CliError::Usage(format!(
                "{command}: stdin input is disabled by default on Windows because PowerShell may corrupt non-ASCII text.\n\nWrite the content to a UTF-8 file and use:\n\n  flowix {command} {positional} --file <path>\n\nIf the caller guarantees UTF-8 stdin, pass --stdin explicitly."
            )))
        }
        (None, false) => Ok(TextInputSource::Stdin),
    }
}

fn read_text_input(source: TextInputSource<'_>) -> Result<String, CliError> {
    match source {
        TextInputSource::File(path) => {
            let bytes = std::fs::read(path).map_err(|error| {
                CliError::Io(std::io::Error::new(
                    error.kind(),
                    format!("failed to read input file `{path}`: {error}"),
                ))
            })?;
            String::from_utf8(bytes)
                .map(strip_utf8_bom)
                .map_err(|error| {
                    CliError::Usage(format!(
                        "input file `{path}` is not valid UTF-8: {}",
                        error.utf8_error()
                    ))
                })
        }
        TextInputSource::Stdin => read_stdin(),
    }
}

fn reject_empty_text(command: &str, body: &str) -> Result<(), CliError> {
    if body.trim().is_empty() {
        let message = match command {
            "create" => "empty body, note not created",
            "write" => "empty body, note not modified",
            _ => "empty input",
        };
        return Err(CliError::Usage(message.into()));
    }
    Ok(())
}

/// 剥离首部 UTF-8 BOM (U+FEFF)。
///
/// `read_to_string` 不剥 BOM; Windows 上某些重定向 / 编辑器会给 stdin 塞一个,
/// 不剥会让首行变成 `\u{FEFF}# 标题`，影响 Markdown 内容解析。
/// MCP 路径不经此函数 (JSON-RPC 客户端不发 BOM)。
fn strip_utf8_bom(s: String) -> String {
    match s.strip_prefix('\u{FEFF}') {
        Some(rest) => rest.to_string(),
        None => s,
    }
}

/// `flowix-cli delete <id>` ── 删除一条笔记 (.md + memo index entry)。
pub fn cmd_delete(id_arg: &str, json: bool) -> Result<(), CliError> {
    let (mut mf, full_id) = resolve_id(id_arg)?;
    let file_path = mf.find_memo_file_path(&full_id);
    let payload = delete_note(&mut mf, &full_id, file_path.as_deref())?;
    if json {
        print_pretty_json(&payload)?;
    } else {
        println!("deleted: {full_id}");
        println!(
            "  file:      {}",
            payload.file.as_deref().unwrap_or("(not on disk)")
        );
        println!("  removed:   {}", payload.file_removed);
    }
    Ok(())
}

/// 删除一条笔记的纯函数 ── 不读 stdin, 走 `MemoFile::delete_memo` 原语。
///
/// `file_path` 由调用方解析 (要展示给用户 / 写进 payload), 避免在 helper 内
/// 重复 `find_memo_file_path` 调用。返回 `serde_json::Value` 形态的 payload。
pub(crate) fn delete_note(
    mf: &mut MemoFile,
    full_id: &str,
    _file_path: Option<&std::path::Path>,
) -> Result<NoteDeleted, CliError> {
    let deleted = MemoService::new(mf).delete_memo(full_id)?;
    let file = Some(deleted.path.display().to_string());
    Ok(NoteDeleted {
        ok: true,
        action: "deleted",
        id: deleted.id.clone(),
        key: deleted.id,
        file: file.clone(),
        path: file,
        file_removed: deleted.file_removed,
    })
}

/// `flowix-cli search <query> [--notebook <name|id>] [--tag <path>]` ── 跨 notebook 全文搜索。
pub fn cmd_search(
    query: &str,
    notebook_filter: Option<&str>,
    tag_filter: Option<&str>,
    limit: usize,
    json: bool,
) -> Result<(), CliError> {
    let results = search_hits(query, notebook_filter, tag_filter, limit)?;

    if json {
        let payload = search_results_to_value(query, tag_filter, &results);
        print_pretty_json(&payload)?;
    } else if results.hits.is_empty() {
        println!("(no matches for `{query}`)");
    } else {
        for hit in &results.hits {
            println!("[{}] {} ", hit.notebook_name, hit.id);
            println!("    {}", hit.snippet);
        }
        println!("\n{} match(es)", results.hits.len());
    }
    Ok(())
}

/// memo 搜索的数据源，供 CLI 和 MCP 命令层复用。
pub(crate) fn search_hits(
    query: &str,
    notebook_filter: Option<&str>,
    tag_filter: Option<&str>,
    limit: usize,
) -> Result<flowix_core::search::NotebookSearchResults, CliError> {
    let mf = open()?;
    MemoService::new(&mf)
        .search_memos(query, notebook_filter, tag_filter, limit)
        .map_err(Into::into)
}

/// 把 `NotebookSearchResults` 拍平成 CLI / MCP `--json` 输出一致的 `Value`。
/// MCP 和 `cmd_search --json` 共用同一份输出 shape。
pub(crate) fn search_results_to_value(
    query: &str,
    tag_filter: Option<&str>,
    results: &flowix_core::search::NotebookSearchResults,
) -> SearchOutput {
    let matches: Vec<SearchMatch> = results
        .hits
        .iter()
        .map(|hit| SearchMatch {
            notebook: hit.notebook_name.clone(),
            notebook_id: hit.notebook_id.clone(),
            id: hit.id.clone(),
            title: hit.filename.clone(),
            score: hit.score,
            snippet: hit.snippet.clone(),
        })
        .collect();
    let shown = matches.len();
    SearchOutput {
        ok: true,
        action: "search",
        query: query.to_string(),
        tag: tag_filter.and_then(normalize_search_tag_filter),
        matches,
        total: results.total,
        shown,
    }
}

/// `flowix-cli edit <id> --old <text> --new <text>` ── 精确字符串替换增量编辑。
///
/// B 风格 (Anthropic Claude API / Cursor 风格), 跟 desktop 端 AI 工具
/// [`providers/tools/filesystem.rs::edit`] 完全同模型:
/// - `old_string` 必须**唯一**匹配 (0 / >1 都报错, 要求带更多上下文)
/// - `old_string` 不能为空
/// - 读当前 body, 校验, 替换, 按原文件名写回
/// - 正文改动不会触发文件名变化；改名使用独立的 rename 能力
///
/// `--new` 可以走 stdin (用 `--new-stdin` 显式声明, 避免"stdin 到底给谁"歧义);
/// `--old` 强制参数 (必须先 read body 校验唯一性, 不能 stdin)。
///
/// 实际替换和写盘在 [`edit_note`]；本函数解析 argv / 处理 `--new-stdin`
/// 后调用它，MCP 命令层则直接传入 `old` / `new`。
pub fn cmd_edit(
    id_arg: &str,
    old: Option<&str>,
    new: Option<&str>,
    new_from_stdin: bool,
    new_file: Option<&str>,
    dry_run: bool,
    json: bool,
) -> Result<(), CliError> {
    let (mut mf, full_id) = resolve_id(id_arg)?;

    // 参数必填校验
    let old = old.ok_or_else(|| {
        CliError::Usage(
            "edit: --old/-o is required\n\
             usage: flowix edit <id> --old <text> --new <text> [--new-stdin]"
                .into(),
        )
    })?;
    if old.is_empty() {
        return Err(CliError::Usage(
            "edit: --old cannot be empty (provides no anchor for replacement)".into(),
        ));
    }

    let input_count =
        usize::from(new.is_some()) + usize::from(new_from_stdin) + usize::from(new_file.is_some());
    if input_count != 1 {
        return Err(CliError::Usage(
            "edit: use exactly one of --new/-n, --new-stdin, or --new-file <path>".into(),
        ));
    }

    let new = if new_from_stdin {
        let s = read_stdin()?;
        if s.is_empty() {
            return Err(CliError::Other(
                "edit: empty stdin for --new-stdin, note not modified".into(),
            ));
        }
        s
    } else if let Some(path) = new_file {
        read_text_input(TextInputSource::File(path))?
    } else {
        match new {
            Some(n) => n.to_string(),
            None => {
                return Err(CliError::Usage(
                    "edit: --new/-n is required (or use --new-stdin)\n\
                     usage: flowix edit <id> --old <text> --new <text> [--new-stdin]"
                        .into(),
                ))
            }
        }
    };

    let payload = edit_note_impl(&mut mf, &full_id, old, &new, dry_run)?;
    if json {
        print_pretty_json(&payload)?;
    } else {
        if dry_run {
            println!("edit preview: {}", payload.id);
        } else {
            println!("edited: {}", payload.id);
        }
        println!("  file:      {}", payload.file);
        println!("  replaced:  {} bytes -> {} bytes", old.len(), new.len());
        if dry_run {
            println!("  wrote:     false");
        }
    }
    Ok(())
}

/// 精确字符串替换的纯函数 ── 接受 `old: &str, new: &str`, 不读 stdin。
///
/// 唯一性校验和按原文件名写回全在本函数内。
/// `cmd_edit` 负责 human / JSON 打印，MCP 命令层复用返回结果。
pub(crate) fn edit_note(
    mf: &mut MemoFile,
    full_id: &str,
    old: &str,
    new: &str,
) -> Result<NoteEdited, CliError> {
    edit_note_impl(mf, full_id, old, new, false)
}

pub(crate) fn preview_edit_note(
    mf: &mut MemoFile,
    full_id: &str,
    old: &str,
    new: &str,
) -> Result<NoteEdited, CliError> {
    edit_note_impl(mf, full_id, old, new, true)
}

fn edit_note_impl(
    mf: &mut MemoFile,
    full_id: &str,
    old: &str,
    new: &str,
    dry_run: bool,
) -> Result<NoteEdited, CliError> {
    let edited = MemoService::new(mf).edit_memo_exact(full_id, old, new, dry_run)?;
    if edited.dry_run {
        let file = edited.path.display().to_string();
        return Ok(NoteEdited {
            ok: true,
            action: "edit_preview",
            id: full_id.to_string(),
            key: full_id.to_string(),
            filename: edited
                .path
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_string),
            file: file.clone(),
            path: file,
            old_bytes: old.len(),
            new_bytes: new.len(),
            dry_run: true,
            would_write: true,
            wrote: false,
            match_type: "exact",
            updated_at: None,
        });
    }
    let memo = edited
        .memo
        .ok_or_else(|| CliError::Other("edit completed without memo metadata".into()))?;
    let file = edited.path.display().to_string();

    Ok(NoteEdited {
        ok: true,
        action: "edited",
        id: full_id.to_string(),
        key: full_id.to_string(),
        filename: Some(memo.filename),
        file: file.clone(),
        path: file,
        old_bytes: old.len(),
        new_bytes: new.len(),
        dry_run: false,
        would_write: true,
        wrote: true,
        match_type: "exact",
        updated_at: Some(memo.updated_at),
    })
}

/// `flowix-cli write <id> --file <path>` ── 推荐从 UTF-8 文件读取 body 并覆盖。
/// `--stdin` 用于显式放行标准输入；Windows 上不再隐式读取 stdin。
///
/// `edit` 的非交互等价物 ── 适合脚本化批量改写、管道入内容、CI 注入等场景。
///
/// 跟 `edit` 共用按原文件名写回的底层流程。覆盖 Markdown 内容不会改变
/// 文件名；标题改名通过独立的 rename 操作完成。
///
/// 不读 $EDITOR, 不 spawn 子进程 ── Windows 上不需要任何额外环境变量。
///
/// stdin 为空 → 报错, 不写盘 (避免误操作清空笔记)。
///
/// 实际写盘在 [`write_note`]；本函数只是输入读取 + `write_note` 的薄壳。
/// MCP 命令层直接把工具输入传给 `write_note`。
pub fn cmd_write(
    id_arg: &str,
    file: Option<&str>,
    stdin: bool,
    json: bool,
) -> Result<(), CliError> {
    // 与 create 一致，输入错误优先于 id / 存储解析，保证失败不会改写笔记。
    let source = resolve_text_input_source("write", file, stdin, cfg!(windows))?;
    let body = read_text_input(source)?;
    reject_empty_text("write", &body)?;
    let (mut mf, full_id) = resolve_id(id_arg)?;
    let payload = write_note(&mut mf, &full_id, &body)?;
    if json {
        print_pretty_json(&payload)?;
    } else {
        println!("written: {}", payload.id);
        println!("  file:     {}", payload.file);
        println!("  bytes:    {}", body.len());
    }
    Ok(())
}

/// 覆盖一条笔记的纯函数 ── 接受 `&str body` 不读 stdin。
///
/// `cmd_write` 负责 human / JSON 打印，MCP 命令层复用返回结果。
pub(crate) fn write_note(
    mf: &mut MemoFile,
    full_id: &str,
    body: &str,
) -> Result<NoteWritten, CliError> {
    let edited = MemoService::new(mf).replace_memo(full_id, body)?;
    let memo = edited
        .memo
        .ok_or_else(|| CliError::Other("write completed without memo metadata".into()))?;
    let file = edited.path.display().to_string();
    Ok(NoteWritten {
        ok: true,
        action: "written",
        id: full_id.to_string(),
        key: full_id.to_string(),
        filename: memo.filename,
        file: file.clone(),
        path: file,
        updated_at: memo.updated_at,
    })
}

/// `flowix-cli completion <shell>` ── 输出 shell 补全脚本到 stdout。
pub fn cmd_completion(shell: &str) -> Result<(), CliError> {
    let mut cmd = crate::cli::cli_command();
    let bin_name = "flowix";
    let mut stdout = std::io::stdout();
    match shell {
        "bash" => {
            clap_complete::generate(clap_complete::shells::Bash, &mut cmd, bin_name, &mut stdout)
        }
        "zsh" => {
            clap_complete::generate(clap_complete::shells::Zsh, &mut cmd, bin_name, &mut stdout)
        }
        "fish" => {
            clap_complete::generate(clap_complete::shells::Fish, &mut cmd, bin_name, &mut stdout)
        }
        other => {
            return Err(CliError::Usage(format!(
                "unknown shell: `{other}` (use bash/zsh/fish)"
            )))
        }
    };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flowix_core::memo_file::NotebookConfig;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_flowix_env<T>(
        home: &std::path::Path,
        data: &std::path::Path,
        f: impl FnOnce() -> T,
    ) -> T {
        let _guard = ENV_LOCK.lock().unwrap();
        let old_home = std::env::var_os("FLOWIX_HOME");
        let old_data = std::env::var_os("FLOWIX_DATA");
        std::env::set_var("FLOWIX_HOME", home);
        std::env::set_var("FLOWIX_DATA", data);
        let result = f();
        match old_home {
            Some(value) => std::env::set_var("FLOWIX_HOME", value),
            None => std::env::remove_var("FLOWIX_HOME"),
        }
        match old_data {
            Some(value) => std::env::set_var("FLOWIX_DATA", value),
            None => std::env::remove_var("FLOWIX_DATA"),
        }
        result
    }

    fn seed_notebook_config(
        _data_dir: &std::path::Path,
        config_dir: &std::path::Path,
        nb_dir: &std::path::Path,
    ) {
        std::fs::create_dir_all(nb_dir).unwrap();
        let mf = MemoFile::new(config_dir.to_path_buf());
        let cfg = NotebookConfig {
            id: "work".to_string(),
            name: "work".to_string(),
            icon: None,
            path: format!("{}/", nb_dir.display()),
            is_default: true,
            sort: 0,
            created_at: 1,
            updated_at: 1,
        };
        mf.write_notebook_configs(&[cfg]).unwrap();
    }

    #[test]
    fn strip_utf8_bom_removes_leading_bom_only() {
        // 首部 BOM 剥掉，保证 Markdown 首行内容不带隐藏字符
        assert_eq!(strip_utf8_bom("\u{FEFF}# 标题\n".into()), "# 标题\n");
        // 无 BOM 原样返回
        assert_eq!(strip_utf8_bom("# 标题\n".into()), "# 标题\n");
        assert_eq!(strip_utf8_bom("".into()), "");
        // 中间的 U+FEFF 不是 BOM, 不动
        assert_eq!(strip_utf8_bom("a\u{FEFF}b".into()), "a\u{FEFF}b");
    }

    #[test]
    fn windows_requires_an_explicit_input_source() {
        let error = resolve_text_input_source("create", None, false, true)
            .unwrap_err()
            .to_string();
        assert!(error.contains("stdin input is disabled by default on Windows"));
        assert!(error.contains("flowix create <notebook> --file <path>"));
        assert!(error.contains("pass --stdin explicitly"));

        assert_eq!(
            resolve_text_input_source("create", Some("body.md"), false, true).unwrap(),
            TextInputSource::File("body.md")
        );
        assert_eq!(
            resolve_text_input_source("create", None, true, true).unwrap(),
            TextInputSource::Stdin
        );
    }

    #[test]
    fn non_windows_keeps_legacy_stdin_fallback() {
        assert_eq!(
            resolve_text_input_source("write", None, false, false).unwrap(),
            TextInputSource::Stdin
        );
    }

    #[test]
    fn input_sources_are_mutually_exclusive_even_before_clap() {
        let error = resolve_text_input_source("write", Some("body.md"), true, false)
            .unwrap_err()
            .to_string();
        assert!(error.contains("--file and --stdin are mutually exclusive"));
    }

    #[test]
    fn empty_create_and_write_input_is_rejected_before_storage_lookup() {
        assert_eq!(
            reject_empty_text("create", "\n  ").unwrap_err().to_string(),
            "empty body, note not created"
        );
        assert_eq!(
            reject_empty_text("write", "\n\t").unwrap_err().to_string(),
            "empty body, note not modified"
        );
        assert!(reject_empty_text("create", "# 中文\n正文").is_ok());
    }

    #[test]
    fn file_input_reads_cjk_utf8_and_strips_bom() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("中文说明.md");
        std::fs::write(&path, "\u{FEFF}# 首次正确生成\n正文内容").unwrap();

        let body = read_text_input(TextInputSource::File(path.to_str().unwrap())).unwrap();
        assert_eq!(body, "# 首次正确生成\n正文内容");
    }

    #[test]
    fn file_input_rejects_non_utf8_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("invalid.md");
        std::fs::write(&path, [0xff, 0xfe, 0xfd]).unwrap();

        let error = read_text_input(TextInputSource::File(path.to_str().unwrap()))
            .unwrap_err()
            .to_string();
        assert!(error.contains("not valid UTF-8"));
    }

    #[test]
    fn file_input_reports_missing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("missing.md");

        let error = read_text_input(TextInputSource::File(path.to_str().unwrap())).unwrap_err();
        assert!(matches!(&error, CliError::Io(_)));
        assert!(error.to_string().contains("failed to read input file"));
    }

    #[test]
    fn file_input_preserves_markdown_content_for_create_and_write() {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = tmp.path().join("config");
        let data_dir = tmp.path().join("data");
        let nb_dir = tmp.path().join("notebooks").join("work");
        seed_notebook_config(&data_dir, &config_dir, &nb_dir);
        let source = "# 中文标题\n\n😀 **加粗**\n\n| 列一 | 列二 |\n| --- | --- |\n| 内容 | ✅ |\n\n```rust\nprintln!(\"你好\");\n```\n";
        let path = tmp.path().join("body.md");
        std::fs::write(&path, source.as_bytes()).unwrap();

        with_flowix_env(&config_dir, &data_dir, || {
            let body = read_text_input(TextInputSource::File(path.to_str().unwrap())).unwrap();
            assert_eq!(body, source);

            let (mut mf, notebook) = open_in("work").unwrap();
            let created = create_note(&mut mf, &notebook, &body).unwrap();
            let created_body = std::fs::read_to_string(&created.file).unwrap();
            assert!(created_body.ends_with(source));

            let replacement =
                read_text_input(TextInputSource::File(path.to_str().unwrap())).unwrap();
            write_note(&mut mf, &created.id, &replacement).unwrap();
            let written_body = std::fs::read_to_string(&created.file).unwrap();
            assert!(written_body.ends_with(source));
        });
    }

    #[test]
    fn notebook_tags_returns_sorted_unique_tags() {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = tmp.path().join("config");
        let data_dir = tmp.path().join("data");
        let nb_dir = tmp.path().join("notebooks").join("work");
        seed_notebook_config(&data_dir, &config_dir, &nb_dir);

        with_flowix_env(&config_dir, &data_dir, || {
            let (mut mf, nb) = open_in("work").unwrap();
            create_note(&mut mf, &nb, "---\ntags: [产品, 产品/设计]\n---\n# A").unwrap();
            create_note(&mut mf, &nb, "---\ntags: [产品, 测试]\n---\n# B").unwrap();
            let result = notebook_tags(Some("work")).unwrap();
            assert_eq!(result["total"], 3);
            assert_eq!(
                result["tags"],
                serde_json::json!(["产品", "产品/设计", "测试"])
            );
        });
    }

    #[test]
    fn corrupt_legacy_index_json_is_ignored_for_list() {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = tmp.path().join("config");
        let data_dir = tmp.path().join("data");
        let nb_dir = tmp.path().join("notebooks").join("work");
        std::fs::create_dir_all(nb_dir.join(".metadata")).unwrap();
        seed_notebook_config(&data_dir, &config_dir, &nb_dir);
        std::fs::write(nb_dir.join(".metadata").join("memo index"), "{not json").unwrap();

        let entries = with_flowix_env(&config_dir, &data_dir, || {
            notes_list_entries("work").unwrap()
        });
        assert!(entries.is_empty());
    }

    #[test]
    fn delete_note_reports_real_payload() {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = tmp.path().join("config");
        let data_dir = tmp.path().join("data");
        let nb_dir = tmp.path().join("notebooks").join("work");
        std::fs::create_dir_all(nb_dir.join(".metadata")).unwrap();
        seed_notebook_config(&data_dir, &config_dir, &nb_dir);

        with_flowix_env(&config_dir, &data_dir, || {
            let (mut mf, nb) = open_in("work").unwrap();
            let created = create_note(&mut mf, &nb, "# Hello\nbody\n").unwrap();
            let id = created.id.clone();
            let file_path = mf.find_memo_file_path(&id);
            let deleted = delete_note(&mut mf, &id, file_path.as_deref()).unwrap();
            assert!(deleted.ok);
            assert!(deleted.file_removed);
            assert!(mf.read_memo(&id).is_none());
        });
    }

    #[test]
    fn create_note_returns_frontmatter_key_that_resolves_for_later_commands() {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = tmp.path().join("config");
        let data_dir = tmp.path().join("data");
        let nb_dir = tmp.path().join("notebooks").join("work");
        seed_notebook_config(&data_dir, &config_dir, &nb_dir);

        with_flowix_env(&config_dir, &data_dir, || {
            let (mut mf, nb) = open_in("work").unwrap();
            let created = create_note(
                &mut mf,
                &nb,
                "# flowix-cli-edit-write-test\nline A: original alpha\n",
            )
            .unwrap();
            let id = created.id.clone();
            let file = created.file.as_str();
            let content = std::fs::read_to_string(file).unwrap();
            let frontmatter_key =
                flowix_core::memo_file::extract_frontmatter_key(&content).unwrap();

            assert_eq!(id, frontmatter_key);

            let (_resolved_mf, resolved_id) = resolve_id(&id).unwrap();
            assert_eq!(resolved_id, id);

            let listed = notes_list_entries("work").unwrap();
            assert!(listed.iter().any(|entry| entry.id == id));
            let before_edit = listed
                .iter()
                .find(|entry| entry.id == id)
                .map(|entry| entry.updated_at)
                .unwrap();

            std::thread::sleep(std::time::Duration::from_millis(5));

            let edited = edit_note(
                &mut mf,
                &id,
                "line A: original alpha",
                "line A: EDITED alpha",
            )
            .unwrap();
            assert_eq!(edited.id, id);

            let after_edit = notes_list_entries("work")
                .unwrap()
                .into_iter()
                .find(|entry| entry.id == id)
                .unwrap();
            assert!(
                after_edit.updated_at > before_edit,
                "successful edit must refresh updated_at"
            );
            let edited_content = std::fs::read_to_string(file).unwrap();
            assert!(edited_content.contains("line A: EDITED alpha\n"));
            assert!(!edited_content.contains("line A: EDITED alpha\n\n"));
        });
    }

    #[test]
    fn edit_note_preserves_replacement_without_adding_trailing_newline() {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = tmp.path().join("config");
        let data_dir = tmp.path().join("data");
        let nb_dir = tmp.path().join("notebooks").join("work");
        seed_notebook_config(&data_dir, &config_dir, &nb_dir);

        with_flowix_env(&config_dir, &data_dir, || {
            let (mut mf, nb) = open_in("work").unwrap();
            let created = create_note(&mut mf, &nb, "# T\nalpha beta gamma").unwrap();
            let id = created.id.clone();
            let file = created.file.as_str();

            edit_note(&mut mf, &id, "gamma", "gammaXX").unwrap();

            let edited_content = std::fs::read_to_string(file).unwrap();
            assert!(
                edited_content.ends_with("alpha beta gammaXX"),
                "replacement should be written exactly without appending a newline: {edited_content:?}"
            );
        });
    }

    #[test]
    fn cli_json_payloads_include_agent_compatible_aliases_and_dry_run_preview() {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = tmp.path().join("config");
        let data_dir = tmp.path().join("data");
        let nb_dir = tmp.path().join("notebooks").join("work");
        seed_notebook_config(&data_dir, &config_dir, &nb_dir);

        with_flowix_env(&config_dir, &data_dir, || {
            let (mut mf, nb) = open_in("work").unwrap();
            let created = create_note(&mut mf, &nb, "# Alias Test\nalpha beta gamma").unwrap();
            let id = created.id.clone();
            let file = created.file.clone();

            assert_eq!(created.key, id);
            assert_eq!(created.path, file);
            assert_eq!(created.notebook, "work");
            assert_eq!(created.notebook_id, nb.id.as_str());

            let created_json = crate::output::to_json_value(&created).unwrap();
            assert_eq!(created_json["key"].as_str(), Some(id.as_str()));
            assert_eq!(created_json["path"].as_str(), Some(file.as_str()));
            assert_eq!(created_json["notebook"].as_str(), Some("work"));
            assert_eq!(created_json["notebook_id"].as_str(), Some(nb.id.as_str()));

            let shown = note_show_data(&id).unwrap().to_json();
            assert_eq!(shown["id"].as_str(), Some(id.as_str()));
            assert_eq!(shown["key"].as_str(), Some(id.as_str()));
            assert_eq!(shown["file"].as_str(), Some(file.as_str()));
            assert_eq!(shown["path"].as_str(), Some(file.as_str()));
            assert_eq!(shown["notebook"].as_str(), Some("work"));

            let before = std::fs::read_to_string(&file).unwrap();
            let preview = preview_edit_note(&mut mf, &id, "gamma", "gammaXX").unwrap();
            assert_eq!(preview.action, "edit_preview");
            assert_eq!(preview.key, id);
            assert_eq!(preview.path, file);
            assert!(preview.dry_run);
            assert!(preview.would_write);
            assert!(!preview.wrote);
            assert_eq!(std::fs::read_to_string(&file).unwrap(), before);

            let written = write_note(&mut mf, &id, "# Alias Test\nreplacement body").unwrap();
            assert_eq!(written.key, id);
            assert_eq!(written.path, written.file);

            let deleted_file = mf.find_memo_file_path(&id);
            let deleted = delete_note(&mut mf, &id, deleted_file.as_deref()).unwrap();
            assert_eq!(deleted.key, id);
            assert_eq!(deleted.path, deleted.file);
        });
    }
}
