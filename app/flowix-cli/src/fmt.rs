//! CLI 输出格式化。
//!
//! M1 只用 `print_notebooks`, 打印一张对齐的表 (NAME / ID / PATH / NOTES / UPDATED)。
//! M2/M3 加 `print_notes` (list 命令) 和 `print_note` (show 命令)。
//!
//! 列对齐用简易 `display_width`: CJK 范围按 2, 其他按 1。够表格用即可,
//! 真要严格 unicode-width 等 M4+ 有需要再引入依赖。

use flowix_core::memo_file::NotebookConfig;

/// 计算字符串的显示宽度 (CJK 算 2)。
pub fn display_width(s: &str) -> usize {
    s.chars().map(cjk_width).sum()
}

fn cjk_width(c: char) -> usize {
    let cp = c as u32;
    // 简化的 CJK 范围判定 ── 覆盖中文 / 日文 / 韩文主要区间。
    // 严格 unicode 用 `unicode-width` crate, M1 不需要。
    if (0x1100..=0x115F).contains(&cp)        // Hangul Jamo
        || (0x2E80..=0x303E).contains(&cp)    // CJK Radicals / Punctuation
        || (0x3041..=0x33FF).contains(&cp)    // Hiragana / Katakana / CJK Symbols
        || (0x3400..=0x4DBF).contains(&cp)    // CJK Extension A
        || (0x4E00..=0x9FFF).contains(&cp)    // CJK Unified Ideographs
        || (0xA000..=0xA4CF).contains(&cp)    // Yi
        || (0xAC00..=0xD7A3).contains(&cp)    // Hangul Syllables
        || (0xF900..=0xFAFF).contains(&cp)    // CJK Compatibility Ideographs
        || (0xFE30..=0xFE4F).contains(&cp)    // CJK Compatibility Forms
        || (0xFF00..=0xFF60).contains(&cp)    // Fullwidth Forms
        || (0xFFE0..=0xFFE6).contains(&cp)
    {
        2
    } else {
        1
    }
}

/// 截断字符串到指定显示宽度, 超出加 `..` (按宽度算)。
pub fn truncate(s: &str, max_width: usize) -> String {
    let mut out = String::new();
    let mut w = 0;
    for c in s.chars() {
        let cw = cjk_width(c);
        if w + cw + 1 > max_width {
            out.push_str("..");
            return out;
        }
        w += cw;
        out.push(c);
    }
    out
}

fn pad_right(s: &str, width: usize) -> String {
    let w = display_width(s);
    if w >= width {
        s.to_string()
    } else {
        format!("{}{}", s, " ".repeat(width - w))
    }
}

/// 把 timestamp_millis 转成 `YYYY-MM-DD HH:MM` 短格式。
fn fmt_time(ms: i64) -> String {
    use chrono::{TimeZone, Utc};
    Utc.timestamp_millis_opt(ms)
        .single()
        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| "-".to_string())
}

/// 打印笔记本列表。
///
/// 表格列: NAME  ID  PATH  NOTES  UPDATED
/// `NOTES` 来自 `index.json` 的 entry 数; 暂不递归 (跟 desktop 端一致)。
pub fn print_notebooks(configs: &[NotebookConfig]) {
    if configs.is_empty() {
        println!("(no notebooks found)");
        return;
    }

    // 收集笔记数 ── 读每个 notebook 的 `.metadata/index.json` 拿 entry 数。
    // M1 简化: 没找到 index.json 就显示 `-`。
    let rows: Vec<Row> = configs
        .iter()
        .map(|c| {
            let notes = count_index_entries(&c.path);
            Row {
                name: c.name.clone(),
                id: c.id.clone(),
                path: c.path.trim_end_matches('/').to_string(),
                notes,
                updated: fmt_time(c.updated_at),
            }
        })
        .collect();

    // 算每列最大宽度 ── NAME / PATH 截断到 24 / 40, 避免过宽。
    // 列宽 = 实际 max + 2 (预留 .. 位置)
    let name_w = rows
        .iter()
        .map(|r| display_width(&r.name))
        .max()
        .unwrap_or(4)
        .saturating_add(2)
        .clamp(4, 24);
    let id_w = rows
        .iter()
        .map(|r| display_width(&r.id))
        .max()
        .unwrap_or(2)
        .max(2);
    let path_w = rows
        .iter()
        .map(|r| display_width(&r.path))
        .max()
        .unwrap_or(4)
        .saturating_add(2)
        .clamp(4, 40);
    let notes_w = "NOTES".len();

    // 表头。
    println!(
        "{}  {}  {}  {}  {}",
        pad_right("NAME", name_w),
        pad_right("ID", id_w),
        pad_right("PATH", path_w),
        pad_right("NOTES", notes_w),
        "UPDATED"
    );

    // 分隔线。
    println!(
        "{}  {}  {}  {}  {}",
        "-".repeat(name_w),
        "-".repeat(id_w),
        "-".repeat(path_w),
        "-".repeat(notes_w),
        "-".repeat(19)
    );

    // 数据行。
    for r in &rows {
        let name = truncate(&r.name, name_w);
        let path = truncate(&r.path, path_w);
        println!(
            "{}  {}  {}  {:>notes_w$}  {}",
            pad_right(&name, name_w),
            pad_right(&r.id, id_w),
            pad_right(&path, path_w),
            r.notes,
            r.updated,
            notes_w = notes_w
        );
    }
}

struct Row {
    name: String,
    id: String,
    path: String,
    notes: usize,
    updated: String,
}

/// 读 `<notebook>/.metadata/index.json`, 返回 entry 数。
/// 读不到 (新建空 notebook / 还没建索引) 返回 `-` 显示。
fn count_index_entries(notebook_path: &str) -> usize {
    let p = std::path::Path::new(notebook_path)
        .join(".metadata")
        .join("index.json");
    match std::fs::read_to_string(&p) {
        Ok(content) => serde_json::from_str::<serde_json::Value>(&content)
            .ok()
            .and_then(|v| v.get("memos").and_then(|e| e.as_array()).map(|a| a.len()))
            .unwrap_or(0),
        Err(_) => 0,
    }
}

// ============================================================
// M2: notes list + single note
// ============================================================

use flowix_core::memo_file::MemoIndexEntry;

/// 打印某 notebook 下的笔记列表 (来自 index.json 的 memos 数组)。
///
/// 表格列: ID  TITLE  TAGS  FAV  UPDATED
/// - TITLE 截断到 32 字符 (CJK 算 2)
/// - TAGS 显示逗号分隔, 截断到 16 字符
/// - FAV 布尔显示 ★ / -
pub fn print_notes(entries: &[MemoIndexEntry]) {
    if entries.is_empty() {
        println!("(no notes)");
        return;
    }

    // 收集 (id, title, tags 字符串) 提前算列宽。
    let rows: Vec<NoteRow> = entries
        .iter()
        .map(|e| NoteRow {
            id: e.id.clone(),
            // v3: filename 即磁盘文件名, 列表展示去掉 .md 后缀。
            title: e
                .filename
                .strip_suffix(".md")
                .unwrap_or(&e.filename)
                .to_string(),
            tags: e.tags.join(","),
            favorited: e.favorited,
            updated: fmt_time(e.updated_at),
        })
        .collect();

    let id_w = rows
        .iter()
        .map(|r| display_width(&r.id))
        .max()
        .unwrap_or(2)
        .max(2);
    let title_w = rows
        .iter()
        .map(|r| display_width(&r.title))
        .max()
        .unwrap_or(5)
        .saturating_add(2)
        .clamp(5, 32);
    let tags_w = rows
        .iter()
        .map(|r| display_width(&r.tags))
        .max()
        .unwrap_or(4)
        .saturating_add(2)
        .clamp(4, 16);

    println!(
        "{}  {}  {}  {}  {}",
        pad_right("ID", id_w),
        pad_right("TITLE", title_w),
        pad_right("TAGS", tags_w),
        "FAV",
        "UPDATED"
    );
    println!(
        "{}  {}  {}  ---  -------------------",
        "-".repeat(id_w),
        "-".repeat(title_w),
        "-".repeat(tags_w)
    );

    for r in &rows {
        let title = truncate(&r.title, title_w);
        let tags = truncate(&r.tags, tags_w);
        let fav = if r.favorited { "★" } else { "-" };
        println!(
            "{}  {}  {}  {:<3}  {}",
            pad_right(&r.id, id_w),
            pad_right(&title, title_w),
            pad_right(&tags, tags_w),
            fav,
            r.updated
        );
    }
}

struct NoteRow {
    id: String,
    title: String,
    tags: String,
    favorited: bool,
    updated: String,
}

/// 打印单条笔记: frontmatter 头 (key: value) + 分隔线 + 正文。
pub fn print_note(entry: &MemoIndexEntry, body: &str) {
    println!("---");
    println!("id:        {}", entry.id);
    println!("filename:  {}", entry.filename);
    println!("preview:   {}", entry.preview);
    println!("created:   {}", fmt_time(entry.created_at));
    println!("updated:   {}", fmt_time(entry.updated_at));
    println!("tags:      [{}]", entry.tags.join(", "));
    println!("favorited: {}", entry.favorited);
    if let Some(icon) = &entry.icon {
        println!("icon:      {icon}");
    }
    println!("---");
    // 正文原样输出 ── 不渲染 Markdown, 方便管道。
    print!("{body}");
    if !body.ends_with('\n') {
        println!();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_width_ascii() {
        assert_eq!(display_width(""), 0);
        assert_eq!(display_width("hello"), 5);
        assert_eq!(display_width("Flowix 0.1"), 10);
    }

    #[test]
    fn display_width_cjk() {
        // CJK 字符按 2 算宽度
        assert_eq!(display_width("你好"), 4);
        assert_eq!(display_width("工作"), 4);
        assert_eq!(display_width("中文文件夹"), 10);
        // 混合 ASCII + CJK
        assert_eq!(display_width("work 笔记"), 9); // 4 ASCII + 1 space + 2*2 CJK = 9
    }

    #[test]
    fn truncate_short_string_unchanged() {
        assert_eq!(truncate("hi", 10), "hi");
        assert_eq!(truncate("", 5), "");
    }

    #[test]
    fn truncate_ascii_at_boundary() {
        // truncate 总是为 ".." 预留位置 (w + cw + 1 > max_width 时停止)
        assert_eq!(truncate("hello world", 5), "hell..");
        // 截断后总宽度 >= max_width - 1 (因为 .. 占 2 字符)
        assert_eq!(display_width(&truncate("hello world", 5)), 6);
        assert_eq!(display_width(&truncate("hello world", 10)), 11); // "hello worl.." = 11 字符宽
    }

    #[test]
    fn truncate_cjk_respects_display_width() {
        // CJK 字符按 2 算宽度
        // "你好世界" 第一个 "你" 占 2, 加 ".." = 3 总宽 -> w+cw+1=3 <= 6 放
        // 第 2 个 "好" -> w=2, 2+2+1=5 <= 6 放
        // 第 3 个 "世" -> w=4, 4+2+1=7 > 6 -> 加 ".." 返 "你好.."
        assert_eq!(truncate("你好世界", 6), "你好..");
        assert_eq!(display_width(&truncate("你好世界", 6)), 6);
    }

    #[test]
    fn truncate_too_small_max_returns_just_dots() {
        // max_width < 2: 第一个字符就放不下, 返 ".."
        assert_eq!(truncate("hello", 0), "..");
        assert_eq!(truncate("hello", 1), "..");
    }
}

// ============================================================
// --json 输出
// ============================================================

/// notebooks JSON 顶层数组的元素结构 ── 跟 `print_notebooks_json` 字段名一致。
///
/// 提取成纯函数让 `serve.rs` (JSON-RPC) 跟 `cmd_*_json` (CLI --json) 复用
/// 同一份 shape, 避免协议 / 命令输出两份定义不同步。
pub fn notebooks_to_json(configs: &[flowix_core::memo_file::NotebookConfig]) -> serde_json::Value {
    let arr: Vec<serde_json::Value> = configs
        .iter()
        .map(|c| {
            serde_json::json!({
                "name": c.name,
                "id": c.id,
                "path": c.path.trim_end_matches('/'),
                "notes": count_index_entries(&c.path),
                "updated_at": c.updated_at,
            })
        })
        .collect();
    serde_json::Value::Array(arr)
}

/// notes JSON 顶层数组, 每项是 MemoIndexEntry 完整字段。
pub fn notes_to_json(entries: &[flowix_core::memo_file::MemoIndexEntry]) -> serde_json::Value {
    serde_json::to_value(entries).unwrap_or(serde_json::Value::Null)
}

/// 单条 note JSON 顶层对象, 包含 metadata + body。
pub fn note_to_json(
    entry: &flowix_core::memo_file::MemoIndexEntry,
    body: &str,
) -> serde_json::Value {
    serde_json::json!({
        "id": entry.id,
        "filename": entry.filename,
        "preview": entry.preview,
        "created_at": entry.created_at,
        "updated_at": entry.updated_at,
        "tags": entry.tags,
        "todos": entry.todos,
        "favorited": entry.favorited,
        "icon": entry.icon,
        "colors": entry.colors,
        "body": body,
    })
}

/// 打印 notebooks JSON. 顶层是数组, 每项含 name / id / path / notes / updated_at。
/// 字段名跟 `list` / `show` 的 JSON 输出对齐, 方便 AI agent 通用解析。
pub fn print_notebooks_json(configs: &[flowix_core::memo_file::NotebookConfig]) {
    println!(
        "{}",
        serde_json::to_string_pretty(&notebooks_to_json(configs)).unwrap_or_default()
    );
}

/// 打印 notes JSON. 顶层数组, 每项是 MemoIndexEntry 完整字段。
pub fn print_notes_json(entries: &[flowix_core::memo_file::MemoIndexEntry]) {
    let json = serde_json::to_string_pretty(&notes_to_json(entries)).unwrap_or_default();
    println!("{json}");
}

/// 打印单条 note JSON. 顶层对象, 包含 metadata + body。
pub fn print_note_json(entry: &flowix_core::memo_file::MemoIndexEntry, body: &str) {
    let obj = note_to_json(entry, body);
    println!("{}", serde_json::to_string_pretty(&obj).unwrap_or_default());
}
