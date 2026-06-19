//! CLI 命令实现 ── 在 `memo_file` 之上做薄包装。
//!
//! M1: `cmd_notebooks`
//! M2: `cmd_list` / `cmd_show`
//! M3: `cmd_create` (面向 AI, body 从 stdin 读)

use crate::{errors::CliError, fmt, paths};
use flowix_core::memo_file::{MemoFile, NotebookConfig};

const MAX_SEARCH_LIMIT: usize = 200;

/// 构造一个 `MemoFile`, 走 `paths::resolve()` 解析的数据目录。
pub fn open() -> Result<MemoFile, CliError> {
    let p = paths::resolve()?;
    Ok(MemoFile::new(p.app_data, p.notebook_file))
}

fn read_notebook_configs_strict(mf: &MemoFile) -> Result<Vec<NotebookConfig>, CliError> {
    mf.read_notebook_configs().map_err(CliError::Io)
}

/// `flowix-cli notebooks --json` ── 输出 JSON 形式。
pub fn cmd_notebooks_json() -> Result<(), CliError> {
    let configs = notebooks_list_configs()?;
    fmt::print_notebooks_json(&configs);
    Ok(())
}

/// `notebooks.list` JSON-RPC method 的数据源 ── 走 `MemoFile::read_notebook_configs`
/// 拿原始 `NotebookConfig` 切片, serve 调 [`crate::fmt::notebooks_to_json`] 包装。
pub(crate) fn notebooks_list_configs() -> Result<Vec<NotebookConfig>, CliError> {
    let mf = open()?;
    read_notebook_configs_strict(&mf)
}

/// `flowix-cli notebooks` ── 列出所有 notebook。
pub fn cmd_notebooks() -> Result<(), CliError> {
    let mf = open()?;
    let configs = read_notebook_configs_strict(&mf)?;
    if configs.is_empty() {
        let path = paths::resolve()?.notebook_file;
        if !path.exists() {
            return Err(CliError::NotFound(format!(
                "notebook config not found at {}",
                path.display()
            )));
        }
    }
    fmt::print_notebooks(&configs);
    Ok(())
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
                "notebook `{notebook_key}` (try `flowix-cli notebooks` to list)"
            ))
        })?
        .clone();
    let mut mf = open()?;
    mf.set_current_notebook(Some(nb.id.clone()));
    Ok((mf, nb))
}

/// `flowix-cli list <notebook> --json` ── 输出 JSON 形式。
pub fn cmd_list_json(notebook_key: &str) -> Result<(), CliError> {
    let entries = notes_list_entries(notebook_key)?;
    fmt::print_notes_json(&entries);
    Ok(())
}

/// `memo.list` JSON-RPC method 的数据源 ── 读 notebook 的 `index.json` 拿 entries。
pub(crate) fn notes_list_entries(
    notebook_key: &str,
) -> Result<Vec<flowix_core::memo_file::MemoIndexEntry>, CliError> {
    let (mf, _nb) = open_in(notebook_key)?;
    Ok(mf.read_index_result()?.unwrap_or_default().memos)
}

/// `flowix-cli list <notebook>` ── 列出某 notebook 下的笔记。
pub fn cmd_list(notebook_key: &str) -> Result<(), CliError> {
    let (mf, _nb) = open_in(notebook_key)?;
    let list = mf.read_index_result()?.unwrap_or_default();
    fmt::print_notes(&list.memos);
    Ok(())
}

/// id 解析辅助: 把 `id_arg` (6 位 shortid / filename basename)
/// 落到某 notebook 的某条 memo 上。返回 `(MemoFile, 完整 shortid)`。
///
/// v3 改造: id 不再含 `nb#xxx` 分隔符 ── 直接是 6 位 shortid。
/// 解析顺序:
/// 1. shortid 完全匹配 (扫所有 notebook)
/// 2. filename basename (去 .md) (扫所有 notebook)
pub(crate) fn resolve_id(id_arg: &str) -> Result<(MemoFile, String), CliError> {
    let root = open()?;
    let configs = read_notebook_configs_strict(&root)?;

    // 1. shortid 完全匹配
    for nb in &configs {
        let (mf, _) = open_in(&nb.id)?;
        if let Some(list) = mf.read_index_result()? {
            if list.memos.iter().any(|e| e.id == id_arg) {
                return Ok((mf, id_arg.to_string()));
            }
        }
    }

    // 2. filename 匹配 (含 .md, 因为 v3 后 entry.filename 始终带后缀)
    //    同时支持用户给 "xxx.md" 或只给 "xxx" 两种写法。
    let want_with_md = if id_arg.ends_with(".md") {
        id_arg.to_string()
    } else {
        format!("{id_arg}.md")
    };
    for nb in &configs {
        let (mf, _) = open_in(&nb.id)?;
        if let Some(list) = mf.read_index_result()? {
            for e in &list.memos {
                if e.filename == want_with_md {
                    return Ok((mf, e.id.clone()));
                }
            }
        }
    }

    Err(CliError::NotFound(format!(
        "note `{id_arg}` not found (try `flowix-cli list <notebook>` to see IDs)"
    )))
}

/// `flowix-cli show <id>` ── 读一条笔记到 stdout。
pub fn cmd_show(id_arg: &str) -> Result<(), CliError> {
    let (mf, id) = resolve_id(id_arg)?;
    let list = mf
        .read_index_result()?
        .ok_or_else(|| CliError::NotFound("index.json not readable in target notebook".into()))?;
    let entry = list
        .memos
        .iter()
        .find(|e| e.id == id)
        .cloned()
        .ok_or_else(|| CliError::NotFound(format!("note `{id}` not in index.json")))?;

    let file_path = mf
        .find_memo_file_path(&id)
        .ok_or_else(|| CliError::NotFound(format!("note `{id}` listed but no .md on disk")))?;
    let body = std::fs::read_to_string(&file_path).map_err(|e| {
        CliError::NotFound(format!("file not readable at {}: {e}", file_path.display()))
    })?;
    fmt::print_note(&entry, &body);
    Ok(())
}

/// `flowix-cli show <id> --json` ── 输出 JSON 形式。
pub fn cmd_show_json(id_arg: &str) -> Result<(), CliError> {
    let (entry, body) = note_show_data(id_arg)?;
    fmt::print_note_json(&entry, &body);
    Ok(())
}

/// `memo.show` JSON-RPC method 的数据源 ── 解析 id + 读 body, 跟 `cmd_show_json` 共用。
pub(crate) fn note_show_data(
    id_arg: &str,
) -> Result<(flowix_core::memo_file::MemoIndexEntry, String), CliError> {
    let (mf, id) = resolve_id(id_arg)?;
    let list = mf
        .read_index_result()?
        .ok_or_else(|| CliError::NotFound("index.json missing".into()))?;
    let entry = list
        .memos
        .iter()
        .find(|e| e.id == id)
        .cloned()
        .ok_or_else(|| CliError::NotFound(format!("note `{id}` not in index.json")))?;

    let file_path = mf
        .find_memo_file_path(&id)
        .ok_or_else(|| CliError::NotFound(format!("note `{id}` listed but no .md on disk")))?;
    let body = std::fs::read_to_string(&file_path)
        .map_err(|e| CliError::NotFound(format!("file missing: {e}")))?;
    Ok((entry, body))
}

/// `flowix-cli create <notebook>` ── 从 stdin 读 body, 创建一条新笔记。
///
/// 面向 AI agent 的接口 ── body 永远从 stdin 读, 不依赖 $EDITOR,
/// Windows / Linux / macOS 行为完全一致。
///
/// title 由 body 首行 (`# xxx`) 自动派生; body 没 `# ` 开头的行时
/// fallback 到 "untitled" (见 [`derive_title`])。
///
/// stdin 为空 → 报错, 不创建 (避免误操作)。
///
/// 写盘走 `MemoFile::create_memo` ── 自动写 .md + 同步 index.json + 派生字段。
///
/// 实际写盘逻辑在 [`create_note`] ── 本函数只是 `read_stdin() + create_note`
/// 的薄壳。serve 模式 (见 `serve.rs`) 跳过 stdin, 直接把 JSON-RPC params 里的
/// body 字段传 `create_note`, 避免把协议流排空。
pub fn cmd_create(notebook_key: &str, json: bool) -> Result<(), CliError> {
    let (mut mf, nb) = open_in(notebook_key)?;
    let body = read_stdin()?;
    let payload = create_note(&mut mf, &nb, &body)?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&payload)
                .map_err(|e| CliError::Other(format!("json serialize: {e}")))?
        );
    } else {
        // human 模式: 重新拼 (create_note 已落盘, payload 里都有)
        println!("created: {}", payload["id"].as_str().unwrap_or("?"));
        println!(
            "  notebook: {}",
            payload["notebook"].as_str().unwrap_or("?")
        );
        println!("  title:    {}", payload["title"].as_str().unwrap_or("?"));
        println!("  file:     {}", payload["file"].as_str().unwrap_or("?"));
    }
    Ok(())
}

/// 创建一条笔记的纯函数 ── 接受 `&str body` 不读 stdin。
///
/// CLI 独立模式 (走 stdin) 和 serve 模式 (走 JSON-RPC params.body) 共用本函数。
/// 返回 `serde_json::Value` 形态的 payload, `cmd_create` 负责 human 打印 / JSON 序列化,
/// `serve.rs` 直接包成 JSON-RPC `result`。
pub(crate) fn create_note(
    mf: &mut MemoFile,
    notebook: &NotebookConfig,
    body: &str,
) -> Result<serde_json::Value, CliError> {
    if body.trim().is_empty() {
        return Err(CliError::Other("empty body, note not created".into()));
    }

    let title = derive_title(body, None);
    let memo = mf
        .create_memo(&title, body, None)
        .map_err(|e| CliError::Other(format!("failed to create memo: {e}")))?;
    let file_path = mf.get_memo_base().join(&memo.filename);
    Ok(serde_json::json!({
        "ok": true,
        "action": "created",
        "id": memo.id,
        "notebook": notebook.name,
        "title": title,
        "filename": memo.filename,
        "file": file_path.display().to_string(),
    }))
}

fn read_stdin() -> Result<String, CliError> {
    use std::io::Read;
    let mut s = String::new();
    std::io::stdin()
        .read_to_string(&mut s)
        .map_err(CliError::Io)?;
    Ok(s)
}

/// 从 body 第一行非空内容提取 title, fallback 链:
/// body 第一行去掉 `# ` 前缀 → name 参数 → "untitled"
fn derive_title(body: &str, name: Option<&str>) -> String {
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let stripped = trimmed.trim_start_matches('#').trim();
        if !stripped.is_empty() {
            return stripped.chars().take(80).collect();
        }
    }
    name.unwrap_or("untitled").to_string()
}

/// `flowix-cli delete <id>` ── 删除一条笔记 (.md + index.json entry)。
pub fn cmd_delete(id_arg: &str, json: bool) -> Result<(), CliError> {
    let (mut mf, full_id) = resolve_id(id_arg)?;
    let file_path = mf.find_memo_file_path(&full_id);
    let payload = delete_note(&mut mf, &full_id, file_path.as_deref())?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&payload)
                .map_err(|e| CliError::Other(format!("json serialize: {e}")))?
        );
    } else {
        println!("deleted: {full_id}");
        println!(
            "  file:      {}",
            file_path
                .as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "(not on disk)".into())
        );
        println!(
            "  removed:   {}",
            payload["file_removed"].as_bool().unwrap_or(false)
        );
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
    file_path: Option<&std::path::Path>,
) -> Result<serde_json::Value, CliError> {
    let removed = mf.delete_memo_result(full_id)?;
    Ok(serde_json::json!({
        "ok": true,
        "action": "deleted",
        "id": full_id,
        "file": file_path.map(|p| p.display().to_string()),
        "file_removed": removed,
    }))
}

/// `flowix-cli search <query> [--notebook <name|id>]` ── 跨 notebook 全文搜索。
pub fn cmd_search(
    query: &str,
    notebook_filter: Option<&str>,
    limit: usize,
    json: bool,
) -> Result<(), CliError> {
    let results = search_hits(query, notebook_filter, limit)?;

    if json {
        let payload = search_results_to_value(query, &results);
        println!(
            "{}",
            serde_json::to_string_pretty(&payload)
                .map_err(|e| CliError::Other(format!("json serialize: {e}")))?
        );
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

/// `memo.search` JSON-RPC method 的核心 ── 跑 `flowix_core::search::search_notebooks`
/// 拿原始 `NotebookSearchResults`, 然后由 [`search_results_to_value`] 包成 JSON。
pub(crate) fn search_hits(
    query: &str,
    notebook_filter: Option<&str>,
    limit: usize,
) -> Result<flowix_core::search::NotebookSearchResults, CliError> {
    if query.trim().is_empty() {
        return Err(CliError::Usage("search query cannot be empty".into()));
    }
    if limit == 0 {
        return Err(CliError::Usage(
            "search limit must be greater than 0".into(),
        ));
    }
    let limit = limit.min(MAX_SEARCH_LIMIT);

    let mut mf = open()?;
    let configs = read_notebook_configs_strict(&mf)?;

    let has_target = match notebook_filter {
        Some(name) => configs.iter().any(|c| c.name == name || c.id == name),
        None => !configs.is_empty(),
    };
    if !has_target {
        return Err(CliError::NotFound(format!(
            "no notebooks matched filter `{notebook_filter:?}`"
        )));
    }

    Ok(flowix_core::search::search_notebooks(
        &mut mf,
        &configs,
        notebook_filter,
        query,
        limit,
    ))
}

/// 把 `NotebookSearchResults` 拍平成跟 CLI `--json` 输出一致的 `Value`。
/// 协议契约 ── serve 和 `cmd_search --json` 共用同一份 shape。
pub(crate) fn search_results_to_value(
    query: &str,
    results: &flowix_core::search::NotebookSearchResults,
) -> serde_json::Value {
    let matches: Vec<serde_json::Value> = results
        .hits
        .iter()
        .map(|hit| {
            serde_json::json!({
                "notebook": hit.notebook_name,
                "notebook_id": hit.notebook_id,
                "id": hit.id,
                "title": hit.filename,
                "score": hit.score,
                "snippet": hit.snippet,
            })
        })
        .collect();
    serde_json::json!({
        "ok": true,
        "action": "search",
        "query": query,
        "matches": matches,
        "total": results.total,
        "shown": matches.len(),
    })
}

/// `flowix-cli edit <id> --old <text> --new <text>` ── 精确字符串替换增量编辑。
///
/// B 风格 (Anthropic Claude API / Cursor 风格), 跟 desktop 端 AI 工具
/// [`providers/tools/filesystem.rs::edit`] 完全同模型:
/// - `old_string` 必须**唯一**匹配 (0 / >1 都报错, 要求带更多上下文)
/// - `old_string` 不能为空
/// - 读当前 body, 校验, 替换, 走 `write_memo_renaming_on_title_change` 写回
/// - title 联动跟 `write` 一致: 第一行 `# xxx` 改了 → 自动 rename 物理文件
///
/// `--new` 可以走 stdin (用 `--new-stdin` 显式声明, 避免"stdin 到底给谁"歧义);
/// `--old` 强制参数 (必须先 read body 校验唯一性, 不能 stdin)。
///
/// 实际替换 + 写盘在 [`edit_note`] ── 本函数解析 argv / 处理 `--new-stdin`
/// 后调它。serve 模式跳过 stdin, 直接把 `old` / `new` 传给 `edit_note`。
pub fn cmd_edit(
    id_arg: &str,
    old: Option<&str>,
    new: Option<&str>,
    new_from_stdin: bool,
    json: bool,
) -> Result<(), CliError> {
    let (mut mf, full_id) = resolve_id(id_arg)?;

    // 参数必填校验
    let old = old.ok_or_else(|| {
        CliError::Usage(
            "edit: --old/-o is required\n\
             usage: flowix-cli edit <id> --old <text> --new <text> [--new-stdin]"
                .into(),
        )
    })?;
    if old.is_empty() {
        return Err(CliError::Usage(
            "edit: --old cannot be empty (provides no anchor for replacement)".into(),
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
    } else {
        match new {
            Some(n) => n.to_string(),
            None => {
                return Err(CliError::Usage(
                    "edit: --new/-n is required (or use --new-stdin)\n\
                     usage: flowix-cli edit <id> --old <text> --new <text> [--new-stdin]"
                        .into(),
                ))
            }
        }
    };

    let payload = edit_note(&mut mf, &full_id, &old, &new)?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&payload)
                .map_err(|e| CliError::Other(format!("json serialize: {e}")))?
        );
    } else {
        println!("edited: {}", payload["id"].as_str().unwrap_or("?"));
        println!("  file:      {}", payload["file"].as_str().unwrap_or("?"));
        println!("  replaced:  {} bytes -> {} bytes", old.len(), new.len());
    }
    Ok(())
}

/// 精确字符串替换的纯函数 ── 接受 `old: &str, new: &str`, 不读 stdin。
///
/// 唯一性校验、`write_memo_renaming_on_title_change` 写回全在本函数内。
/// 返回 `serde_json::Value` 形态的 payload, `cmd_edit` 负责 human / JSON 打印,
/// `serve.rs` 直接包成 JSON-RPC `result`。
pub(crate) fn edit_note(
    mf: &mut MemoFile,
    full_id: &str,
    old: &str,
    new: &str,
) -> Result<serde_json::Value, CliError> {
    if old.is_empty() {
        return Err(CliError::Usage(
            "edit: --old cannot be empty (provides no anchor for replacement)".into(),
        ));
    }

    // 读当前 body
    let file_path = mf
        .find_memo_file_path(full_id)
        .ok_or_else(|| CliError::NotFound(format!("note `{full_id}` listed but no .md on disk")))?;
    let current = std::fs::read_to_string(&file_path).map_err(|e| {
        CliError::NotFound(format!("file not readable at {}: {e}", file_path.display()))
    })?;

    // 校验 old_string 唯一性 (跟 desktop AI 工具 edit 完全一致的语义)
    let matches = current.matches(old).count();
    if matches == 0 {
        return Err(CliError::Other(format!(
            "edit: old_string not found in `{full_id}` (whitespace, indentation, and line endings must match)"
        )));
    }
    if matches > 1 {
        return Err(CliError::Other(format!(
            "edit: old_string matched {matches} times in `{full_id}`; provide more surrounding context to make it unique"
        )));
    }

    // 替换 + 写回 (title 联动)
    let body = current.replacen(old, new, 1);
    let memo = mf
        .write_memo_renaming_on_title_change(full_id, &body)
        .map_err(|e| CliError::Other(format!("failed to write memo: {e}")))?;

    let new_file_path = mf.get_memo_base().join(&memo.filename);

    Ok(serde_json::json!({
        "ok": true,
        "action": "edited",
        "id": full_id,
        "filename": memo.filename,
        "file": new_file_path.display().to_string(),
        "old_bytes": old.len(),
        "new_bytes": new.len(),
        "updated_at": memo.updated_at,
    }))
}

/// `flowix-cli write <id>` ── 从 stdin 读 body, 覆盖现有笔记内容。
///
/// `edit` 的非交互等价物 ── 适合脚本化批量改写、管道入内容、CI 注入等场景。
///
/// 跟 `edit` 共用底层 `write_memo` ── 但走的是 `_renaming_on_title_change`
/// 变体, 首行 `# title` 变化时自动物理 rename + 同步 index.json, 跟
/// 桌面端 IPC `write_document` 行为完全一致。 用户感觉就是"覆盖整个
/// 内容, 标题变了文件名也跟着变"。
///
/// 不读 $EDITOR, 不 spawn 子进程 ── Windows 上不需要任何额外环境变量。
///
/// stdin 为空 → 报错, 不写盘 (避免误操作清空笔记)。
///
/// 实际写盘在 [`write_note`] ── 本函数只是 `read_stdin() + write_note` 的薄壳。
/// serve 模式跳过 stdin, 直接传 `params.body` 给 `write_note`。
pub fn cmd_write(id_arg: &str, json: bool) -> Result<(), CliError> {
    let (mut mf, full_id) = resolve_id(id_arg)?;
    let body = read_stdin()?;
    let payload = write_note(&mut mf, &full_id, &body)?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&payload)
                .map_err(|e| CliError::Other(format!("json serialize: {e}")))?
        );
    } else {
        println!("written: {}", payload["id"].as_str().unwrap_or("?"));
        println!("  file:     {}", payload["file"].as_str().unwrap_or("?"));
        println!("  bytes:    {}", body.len());
    }
    Ok(())
}

/// 覆盖一条笔记的纯函数 ── 接受 `&str body` 不读 stdin。
///
/// 返回 `serde_json::Value` 形态的 payload, `cmd_write` 负责 human / JSON 打印,
/// `serve.rs` 直接包成 JSON-RPC `result`。
pub(crate) fn write_note(
    mf: &mut MemoFile,
    full_id: &str,
    body: &str,
) -> Result<serde_json::Value, CliError> {
    if body.trim().is_empty() {
        return Err(CliError::Other("empty body, note not modified".into()));
    }
    let memo = mf
        .write_memo_renaming_on_title_change(full_id, body)
        .map_err(|e| CliError::Other(format!("failed to write memo: {e}")))?;
    let file_path = mf.get_memo_base().join(&memo.filename);
    Ok(serde_json::json!({
        "ok": true,
        "action": "written",
        "id": full_id,
        "filename": memo.filename,
        "file": file_path.display().to_string(),
        "updated_at": memo.updated_at,
    }))
}

/// `flowix-cli completion <shell>` ── 输出 shell 补全脚本到 stdout。
pub fn cmd_completion(shell: &str) -> Result<(), CliError> {
    let mut cmd = crate::cli_command();
    let bin_name = "flowix-cli";
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

    fn write_notebook_config(config_dir: &std::path::Path, nb_dir: &std::path::Path) {
        std::fs::create_dir_all(config_dir).unwrap();
        let cfg = NotebookConfig {
            id: "work".to_string(),
            name: "work".to_string(),
            icon: None,
            path: format!("{}/", nb_dir.display()),
            is_default: true,
            created_at: 1,
            updated_at: 1,
        };
        std::fs::write(
            config_dir.join("notebook.json"),
            serde_json::to_string_pretty(&vec![cfg]).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn corrupt_notebook_config_is_reported() {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = tmp.path().join("config");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(config_dir.join("notebook.json"), "{not json").unwrap();

        let err = with_flowix_env(&config_dir, &data_dir, || {
            notebooks_list_configs().unwrap_err()
        });
        assert_eq!(err.exit_code(), 5);
        assert!(err.to_string().contains("failed to parse"));
    }

    #[test]
    fn corrupt_index_is_reported_for_list() {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = tmp.path().join("config");
        let data_dir = tmp.path().join("data");
        let nb_dir = tmp.path().join("notebooks").join("work");
        std::fs::create_dir_all(nb_dir.join(".metadata")).unwrap();
        write_notebook_config(&config_dir, &nb_dir);
        std::fs::write(nb_dir.join(".metadata").join("index.json"), "{not json").unwrap();

        let err = with_flowix_env(&config_dir, &data_dir, || {
            notes_list_entries("work").unwrap_err()
        });
        assert_eq!(err.exit_code(), 5);
        assert!(err.to_string().contains("failed to parse"));
    }

    #[test]
    fn delete_note_reports_real_payload() {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = tmp.path().join("config");
        let data_dir = tmp.path().join("data");
        let nb_dir = tmp.path().join("notebooks").join("work");
        std::fs::create_dir_all(nb_dir.join(".metadata")).unwrap();
        write_notebook_config(&config_dir, &nb_dir);

        with_flowix_env(&config_dir, &data_dir, || {
            let (mut mf, nb) = open_in("work").unwrap();
            let created = create_note(&mut mf, &nb, "# Hello\nbody\n").unwrap();
            let id = created["id"].as_str().unwrap().to_string();
            let file_path = mf.find_memo_file_path(&id);
            let deleted = delete_note(&mut mf, &id, file_path.as_deref()).unwrap();
            assert_eq!(deleted["ok"], true);
            assert_eq!(deleted["file_removed"], true);
            assert!(mf.read_memo(&id).is_none());
        });
    }
}
