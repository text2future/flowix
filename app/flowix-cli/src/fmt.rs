use flowix_core::memo_file::{MemoIndexEntry, NotebookConfig};
use std::collections::HashMap;

pub fn display_width(s: &str) -> usize {
    s.chars().map(cjk_width).sum()
}

fn cjk_width(c: char) -> usize {
    let cp = c as u32;
    if (0x1100..=0x115F).contains(&cp)
        || (0x2E80..=0x303E).contains(&cp)
        || (0x3041..=0x33FF).contains(&cp)
        || (0x3400..=0x4DBF).contains(&cp)
        || (0x4E00..=0x9FFF).contains(&cp)
        || (0xA000..=0xA4CF).contains(&cp)
        || (0xAC00..=0xD7A3).contains(&cp)
        || (0xF900..=0xFAFF).contains(&cp)
        || (0xFE30..=0xFE4F).contains(&cp)
        || (0xFF00..=0xFF60).contains(&cp)
        || (0xFFE0..=0xFFE6).contains(&cp)
    {
        2
    } else {
        1
    }
}

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

fn fmt_time(ms: i64) -> String {
    use chrono::{TimeZone, Utc};
    Utc.timestamp_millis_opt(ms)
        .single()
        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| "-".to_string())
}

pub fn print_notebooks(configs: &[NotebookConfig], note_counts: &HashMap<String, usize>) {
    if configs.is_empty() {
        println!("(no notebooks found)");
        return;
    }

    let rows: Vec<Row> = configs
        .iter()
        .map(|c| Row {
            name: c.name.clone(),
            id: c.id.clone(),
            path: c.path.trim_end_matches('/').to_string(),
            notes: *note_counts.get(&c.id).unwrap_or(&0),
            updated: fmt_time(c.updated_at),
        })
        .collect();

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

    println!(
        "{}  {}  {}  {}  {}",
        pad_right("NAME", name_w),
        pad_right("ID", id_w),
        pad_right("PATH", path_w),
        pad_right("NOTES", notes_w),
        "UPDATED"
    );
    println!(
        "{}  {}  {}  {}  {}",
        "-".repeat(name_w),
        "-".repeat(id_w),
        "-".repeat(path_w),
        "-".repeat(notes_w),
        "-".repeat(19)
    );

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

pub fn print_notes(entries: &[MemoIndexEntry]) {
    if entries.is_empty() {
        println!("(no notes)");
        return;
    }

    let rows: Vec<NoteRow> = entries
        .iter()
        .map(|e| NoteRow {
            id: e.id.clone(),
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
        let fav = if r.favorited { "*" } else { "-" };
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
    print!("{body}");
    if !body.ends_with('\n') {
        println!();
    }
}

pub fn notebooks_to_json(
    configs: &[NotebookConfig],
    note_counts: &HashMap<String, usize>,
) -> serde_json::Value {
    let arr: Vec<serde_json::Value> = configs
        .iter()
        .map(|c| {
            serde_json::json!({
                "name": c.name,
                "id": c.id,
                "path": c.path.trim_end_matches('/'),
                "notes": note_counts.get(&c.id).copied().unwrap_or(0),
                "updated_at": c.updated_at,
            })
        })
        .collect();
    serde_json::Value::Array(arr)
}

pub fn notes_to_json(entries: &[MemoIndexEntry]) -> serde_json::Value {
    serde_json::to_value(entries).unwrap_or(serde_json::Value::Null)
}

pub fn note_to_json(entry: &MemoIndexEntry, body: &str) -> serde_json::Value {
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

pub fn note_to_json_with_context(
    entry: &MemoIndexEntry,
    body: &str,
    notebook: &NotebookConfig,
    file_path: &std::path::Path,
) -> serde_json::Value {
    serde_json::json!({
        "id": entry.id,
        "key": entry.id,
        "notebook": notebook.name,
        "notebook_id": notebook.id,
        "filename": entry.filename,
        "file": file_path.display().to_string(),
        "path": file_path.display().to_string(),
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

pub fn print_notebooks_json(configs: &[NotebookConfig], note_counts: &HashMap<String, usize>) {
    println!(
        "{}",
        serde_json::to_string_pretty(&notebooks_to_json(configs, note_counts)).unwrap_or_default()
    );
}

pub fn print_notes_json(entries: &[MemoIndexEntry]) {
    let json = serde_json::to_string_pretty(&notes_to_json(entries)).unwrap_or_default();
    println!("{json}");
}

pub fn print_note_json(entry: &MemoIndexEntry, body: &str) {
    let obj = note_to_json(entry, body);
    println!("{}", serde_json::to_string_pretty(&obj).unwrap_or_default());
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
        assert_eq!(display_width("你好"), 4);
        assert_eq!(display_width("工作"), 4);
        assert_eq!(display_width("中文文件夹"), 10);
        assert_eq!(display_width("work 笔记"), 9);
    }

    #[test]
    fn truncate_short_string_unchanged() {
        assert_eq!(truncate("hi", 10), "hi");
        assert_eq!(truncate("", 5), "");
    }

    #[test]
    fn truncate_ascii_at_boundary() {
        assert_eq!(truncate("hello world", 5), "hell..");
        assert_eq!(display_width(&truncate("hello world", 5)), 6);
        assert_eq!(display_width(&truncate("hello world", 10)), 11);
    }

    #[test]
    fn truncate_cjk_respects_display_width() {
        assert_eq!(truncate("你好世界", 6), "你好..");
        assert_eq!(display_width(&truncate("你好世界", 6)), 6);
    }

    #[test]
    fn truncate_too_small_max_returns_just_dots() {
        assert_eq!(truncate("hello", 0), "..");
        assert_eq!(truncate("hello", 1), "..");
    }
}
