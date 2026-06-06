use chrono::Datelike;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::RwLock;

static FRONTMATTER_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^---\n([\s\S]*?)\n---\n?([\s\S]*)$").unwrap());

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Memo {
    pub id: String,
    pub filename: String,
    #[serde(rename = "preview")]
    pub preview: String,
    #[serde(rename = "tags")]
    pub tags: Vec<String>,
    #[serde(rename = "todos")]
    pub todos: Vec<TodoItem>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    pub favorited: bool,
    pub icon: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoItem {
    pub content: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoTag {
    pub id: String,
    pub name: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Notebook {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub path: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotebookConfig {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub path: String,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

// ============================================
// Memo List Entry (for .metadata/list.json)
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MemoFrontmatter {
    filename: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoListEntry {
    pub id: String,
    pub filename: String,
    pub preview: String,
    pub tags: Vec<String>,
    pub todos: Vec<TodoItem>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    pub favorited: bool,
    #[serde(rename = "icon")]
    pub icon: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoListFile {
    pub version: u32,
    pub last_updated: i64,
    pub memos: Vec<MemoListEntry>,
}

impl Default for MemoListFile {
    fn default() -> Self {
        Self {
            version: 1,
            last_updated: chrono::Utc::now().timestamp_millis(),
            memos: Vec::new(),
        }
    }
}

// ============================================
// Notebook-level memo metadata (for .metadata/memo.json)
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoTodoEntry {
    pub content: String,
    pub status: String,
    #[serde(rename = "memoId")]
    pub memo_id: String,
    pub priority: String,
    #[serde(rename = "timeRange")]
    pub time_range: String,
    pub owner: String,
    pub assignee: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoMetadataFile {
    pub version: u32,
    pub last_updated: i64,
    pub todos: Vec<MemoTodoEntry>,
}

impl Default for MemoMetadataFile {
    fn default() -> Self {
        Self {
            version: 1,
            last_updated: chrono::Utc::now().timestamp_millis(),
            todos: Vec::new(),
        }
    }
}

// Returns the current UTC time in milliseconds. Timestamps stored on memos
// are produced via `chrono::Utc::now().timestamp_millis()`, so we read them
// back against the same clock to keep time-based filters consistent.
fn chrono_now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// Start of the current ISO week (Monday 00:00 UTC) in epoch milliseconds.
fn start_of_this_week(now_ms: i64) -> i64 {
    let now = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now_ms)
        .unwrap_or_else(chrono::Utc::now);
    let date = now.date_naive();
    let weekday = date.weekday();
    let days_from_monday = weekday.num_days_from_monday() as i64;
    let monday = date - chrono::Duration::days(days_from_monday);
    let monday_midnight = monday
        .and_hms_opt(0, 0, 0)
        .unwrap_or_else(|| date.and_hms_opt(0, 0, 0).unwrap());
    monday_midnight
        .and_utc()
        .timestamp_millis()
}

// First instant of the current calendar month (UTC) in epoch milliseconds.
fn start_of_this_month(now_ms: i64) -> i64 {
    let now = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now_ms)
        .unwrap_or_else(chrono::Utc::now);
    let first = now
        .date_naive()
        .with_day(1)
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .unwrap_or_else(|| now.date_naive().and_hms_opt(0, 0, 0).unwrap());
    first.and_utc().timestamp_millis()
}

pub struct MemoFile {
    app_data_path: PathBuf,
    current_notebook_id: Option<String>,
    // 缂撳瓨鐨勭瑪璁版湰閰嶇疆
    notebook_configs: RwLock<Vec<NotebookConfig>>,
}

impl MemoFile {
    pub fn new(app_data_path: PathBuf) -> Self {
        Self {
            app_data_path,
            current_notebook_id: None,
            notebook_configs: RwLock::new(Vec::new()),
        }
    }

    pub fn set_current_notebook(&mut self, id: Option<String>) {
        self.current_notebook_id = id;
    }

    pub fn get_memo_base(&self) -> PathBuf {
        if let Some(ref notebook_id) = self.current_notebook_id {
            if let Some(config) = self.get_notebook_config_by_id(notebook_id) {
                return PathBuf::from(&config.path);
            }
        }
        self.get_default_notebook_path()
    }

    fn get_metadata_dir(&self) -> PathBuf {
        self.get_memo_base().join(".metadata")
    }

    fn get_list_json_path(&self) -> PathBuf {
        self.get_metadata_dir().join("list.json")
    }

    fn get_memo_json_path(&self) -> PathBuf {
        self.get_metadata_dir().join("memo.json")
    }

    fn read_list_json(&self) -> Option<MemoListFile> {
        let path = self.get_list_json_path();
        if !path.exists() {
            return None;
        }
        let content = fs::read_to_string(&path).ok()?;
        serde_json::from_str(&content).ok()
    }

    fn write_list_json(&self, list: &MemoListFile) -> std::io::Result<()> {
        self.ensure_dirs()?;
        let content = serde_json::to_string_pretty(list).unwrap();
        fs::write(self.get_list_json_path(), content)
    }

    fn read_memo_json(&self) -> Option<MemoMetadataFile> {
        let path = self.get_memo_json_path();
        if !path.exists() {
            return None;
        }
        let content = fs::read_to_string(&path).ok()?;
        serde_json::from_str(&content).ok()
    }

    fn write_memo_json(&self, metadata: &MemoMetadataFile) -> std::io::Result<()> {
        self.ensure_dirs()?;
        let content = serde_json::to_string_pretty(metadata).unwrap();
        fs::write(self.get_memo_json_path(), content)
    }

    fn memo_to_list_entry(memo: &Memo) -> MemoListEntry {
        MemoListEntry {
            id: memo.id.clone(),
            filename: memo.filename.clone(),
            preview: memo.preview.clone(),
            tags: memo.tags.clone(),
            todos: memo.todos.clone(),
            created_at: memo.created_at,
            updated_at: memo.updated_at,
            favorited: memo.favorited,
            icon: memo.icon.clone(),
            path: memo.path.clone(),
        }
    }

    fn extract_body_content(content: &str) -> &str {
        if let Some(captures) = FRONTMATTER_RE.captures(content) {
            captures.get(2).map(|m| m.as_str()).unwrap_or("")
        } else {
            content
        }
    }

    fn is_blank_line(line: &str) -> bool {
        line.replace("&nbsp;", "")
            .replace('\u{00a0}', "")
            .trim()
            .is_empty()
    }

    fn strip_markdown(text: &str) -> String {
        let mut value = text.trim().to_string();

        for prefix in ["#", "-", "*", "+", ">"] {
            while value.starts_with(prefix) {
                value = value[prefix.len()..].trim_start().to_string();
            }
        }

        for marker in ["[ ]", "[x]", "[X]"] {
            if value.starts_with(marker) {
                value = value[marker.len()..].trim_start().to_string();
            }
        }

        static MARKDOWN_LINK_RE: Lazy<Regex> =
            Lazy::new(|| Regex::new(r"\[([^\]]+)\]\([^)]+\)").unwrap());
        static MARKDOWN_DECORATION_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[*_`]").unwrap());
        static WHITESPACE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+").unwrap());

        let value = MARKDOWN_LINK_RE.replace_all(&value, "$1");
        let value = MARKDOWN_DECORATION_RE.replace_all(&value, "");
        WHITESPACE_RE.replace_all(value.trim(), " ").to_string()
    }

    fn extract_title_and_preview(content: &str) -> (String, String) {
        let body = Self::extract_body_content(content);
        let lines: Vec<String> = body
            .lines()
            .map(str::trim)
            .filter(|line| !Self::is_blank_line(line))
            .map(Self::strip_markdown)
            .filter(|line| !line.is_empty())
            .collect();

        let title = lines.first().cloned().unwrap_or_default();
        let preview = lines
            .get(1)
            .cloned()
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect();
        (title, preview)
    }

    fn extract_tags_from_body(content: &str) -> Vec<String> {
        static TAG_RE: Lazy<Regex> =
            Lazy::new(|| Regex::new(r"(?m)(^|[\s])#([^\s[:punct:]]+)").unwrap());

        let mut seen = HashSet::new();
        let mut tags = Vec::new();

        for captures in TAG_RE.captures_iter(Self::extract_body_content(content)) {
            if let Some(tag) = captures.get(2).map(|m| m.as_str().trim().to_string()) {
                if !tag.is_empty() && seen.insert(tag.clone()) {
                    tags.push(tag);
                }
            }
        }

        tags
    }

    fn extract_todos_from_body(content: &str) -> Vec<TodoItem> {
        static TODO_RE: Lazy<Regex> =
            Lazy::new(|| Regex::new(r"(?m)^\s*-\s*\[([ xX])\]\s*(.+)$").unwrap());

        TODO_RE
            .captures_iter(Self::extract_body_content(content))
            .filter_map(|captures| {
                let content = captures.get(2)?.as_str().trim();
                if Self::is_blank_line(content) {
                    return None;
                }

                let checked = captures.get(1)?.as_str().eq_ignore_ascii_case("x");
                Some(TodoItem {
                    content: content.to_string(),
                    status: if checked { "completed" } else { "pending" }.to_string(),
                })
            })
            .collect()
    }

    fn apply_derived_memo_fields(memo: &mut Memo, full_content: &str) {
        let (derived_title, preview) = Self::extract_title_and_preview(full_content);
        if memo.filename.trim().is_empty() && !derived_title.is_empty() {
            memo.filename = derived_title;
        }
        memo.preview = preview;
        memo.tags = Self::extract_tags_from_body(full_content);
        memo.todos = Self::extract_todos_from_body(full_content);
    }

    fn sync_list_json_on_write(&self, memo: &Memo) -> std::io::Result<()> {
        let mut list = self.read_list_json().unwrap_or_default();

        list.memos.retain(|e| e.id != memo.id);
        list.memos.push(Self::memo_to_list_entry(memo));
        list.last_updated = chrono::Utc::now().timestamp_millis();

        self.write_list_json(&list)?;
        self.sync_memo_json_todos_on_write(memo)
    }

    // Sync memo fields to notebook metadata without modifying the markdown file.
    pub fn sync_to_list_json_only(&self, memo: &Memo) -> std::io::Result<()> {
        self.sync_list_json_on_write(memo)
    }

    fn sync_memo_json_todos_on_write(&self, memo: &Memo) -> std::io::Result<()> {
        let mut metadata = self.read_memo_json().unwrap_or_default();
        let now = chrono::Utc::now().timestamp_millis();
        let existing_todos = metadata.todos.clone();

        metadata.todos.retain(|todo| todo.memo_id != memo.id);
        metadata.todos.extend(memo.todos.iter().map(|todo| {
            let existing = existing_todos
                .iter()
                .find(|entry| entry.memo_id == memo.id && entry.content == todo.content);

            let created_at = existing
                .map(|entry| entry.created_at)
                .unwrap_or(memo.created_at);
            let updated_at = existing
                .filter(|entry| entry.status == todo.status)
                .map(|entry| entry.updated_at)
                .unwrap_or(now);

            MemoTodoEntry {
                content: todo.content.clone(),
                status: todo.status.clone(),
                memo_id: memo.id.clone(),
                priority: existing
                    .map(|entry| entry.priority.clone())
                    .unwrap_or_default(),
                time_range: existing
                    .map(|entry| entry.time_range.clone())
                    .unwrap_or_default(),
                owner: existing
                    .map(|entry| entry.owner.clone())
                    .unwrap_or_default(),
                assignee: existing
                    .map(|entry| entry.assignee.clone())
                    .unwrap_or_default(),
                created_at,
                updated_at,
            }
        }));

        metadata.last_updated = now;
        self.write_memo_json(&metadata)
    }

    fn sync_list_json_on_delete(&self, memo_id: &str) -> std::io::Result<()> {
        let mut list = match self.read_list_json() {
            Some(l) => l,
            None => return self.sync_memo_json_todos_on_delete(memo_id),
        };

        list.memos.retain(|e| e.id != memo_id);
        list.last_updated = chrono::Utc::now().timestamp_millis();

        self.write_list_json(&list)?;
        self.sync_memo_json_todos_on_delete(memo_id)
    }

    fn sync_memo_json_todos_on_delete(&self, memo_id: &str) -> std::io::Result<()> {
        let mut metadata = match self.read_memo_json() {
            Some(m) => m,
            None => return Ok(()),
        };

        metadata.todos.retain(|todo| todo.memo_id != memo_id);
        metadata.last_updated = chrono::Utc::now().timestamp_millis();

        self.write_memo_json(&metadata)
    }

    fn get_notebook_file_path(&self) -> PathBuf {
        self.app_data_path.join("notebook.json")
    }

    fn get_default_notebook_path(&self) -> PathBuf {
        dirs::document_dir()
            .unwrap_or_else(|| PathBuf::from("/tmp"))
            .join("woop notebook")
    }

    fn ensure_dirs(&self) -> std::io::Result<()> {
        let base = self.get_memo_base();
        fs::create_dir_all(&base)?;
        fs::create_dir_all(self.get_metadata_dir())?;
        fs::create_dir_all(self.get_memo_base().join("attachments"))?;
        Ok(())
    }

    fn get_notebook_config_by_id(&self, id: &str) -> Option<NotebookConfig> {
        let configs = self.read_notebook_configs().ok()?;
        configs.into_iter().find(|c| c.id == id)
    }

    pub fn read_notebook_configs(&self) -> std::io::Result<Vec<NotebookConfig>> {
        let path = self.get_notebook_file_path();
        if !path.exists() {
            return Ok(vec![]);
        }
        let content = fs::read_to_string(&path)?;
        let configs: Vec<NotebookConfig> = serde_json::from_str(&content).unwrap_or_default();

        // 鏇存柊缂撳瓨
        *self.notebook_configs.write().unwrap() = configs.clone();

        Ok(configs)
    }

    pub fn registered_notebook_paths(&self) -> Vec<PathBuf> {
        let mut paths: Vec<PathBuf> = self
            .read_notebook_configs()
            .unwrap_or_default()
            .into_iter()
            .map(|config| PathBuf::from(config.path))
            .collect();

        let default_path = self.get_default_notebook_path();
        if !paths.iter().any(|path| path == &default_path) {
            paths.push(default_path);
        }

        paths
    }

    pub fn derived_tags(&self) -> Vec<MemoTag> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut seen = HashSet::new();
        let mut tags = Vec::new();

        for memo in self.read_all_memos() {
            for name in memo.tags {
                if seen.insert(name.clone()) {
                    tags.push(MemoTag {
                        id: name.clone(),
                        name,
                        created_at: now,
                    });
                }
            }
        }

        tags.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        tags
    }

    pub fn write_notebook_configs(&self, notebooks: &[NotebookConfig]) -> std::io::Result<()> {
        fs::create_dir_all(self.app_data_path.as_path())?;
        let content = serde_json::to_string_pretty(notebooks).unwrap();
        fs::write(self.get_notebook_file_path(), content)
    }

    pub fn init_default_notebook(&self) -> NotebookConfig {
        if let Ok(configs) = self.read_notebook_configs() {
            if let Some(nb) = configs.iter().find(|n| n.is_default) {
                return nb.clone();
            }
        }

        let default_nb = NotebookConfig {
            id: "nb_default".to_string(),
            name: "Default Notebook".to_string(),
            icon: Some("馃摀".to_string()),
            path: format!("{}/", self.get_default_notebook_path().to_string_lossy()),
            is_default: true,
            created_at: chrono::Utc::now().timestamp_millis(),
            updated_at: chrono::Utc::now().timestamp_millis(),
        };

        let mut configs = self.read_notebook_configs().unwrap_or_default();
        configs.push(default_nb.clone());
        let _ = self.write_notebook_configs(&configs);
        default_nb
    }

    fn generate_unique_filename(
        title: &str,
        memoid: &str,
        old_actual_filename: Option<&str>,
    ) -> String {
        let base = if title.is_empty() {
            chrono::Local::now().format("untitled-%Y-%m-%d").to_string()
        } else {
            title.to_string()
        };

        let filename = format!("{}-{}.md", base, memoid);

        // If unchanged, skip rename
        if Some(filename.as_str()) == old_actual_filename {
            return filename;
        }

        filename
    }

    pub(crate) fn find_memo_file_by_id(&self, id: &str) -> Option<PathBuf> {
        if let Some(list) = self.read_list_json() {
            if let Some(entry) = list.memos.iter().find(|e| e.id == id) {
                if let Some(ref rel_path) = entry.path {
                    let base = self.get_memo_base();
                    let full_path = base.join(rel_path);
                    eprintln!(
                        "[find_memo_file_by_id] id: {}, path in list.json: {:?}, full_path: {}",
                        id,
                        rel_path,
                        full_path.display()
                    );
                    if full_path.exists() {
                        return Some(full_path);
                    }
                    eprintln!(
                        "[find_memo_file_by_id] File does not exist: {}",
                        full_path.display()
                    );
                }
            }
        }
        eprintln!("[find_memo_file_by_id] No file found for id: {}", id);
        None
    }

    fn list_entry_to_memo(entry: &MemoListEntry) -> Memo {
        Memo {
            id: entry.id.clone(),
            filename: entry.filename.clone(),
            preview: entry.preview.clone(),
            tags: entry.tags.clone(),
            todos: entry.todos.clone(),
            created_at: entry.created_at,
            updated_at: entry.updated_at,
            favorited: entry.favorited,
            icon: entry.icon.clone(),
            path: entry.path.clone(),
        }
    }

    pub fn read_all_memos(&self) -> Vec<Memo> {
        let _ = self.ensure_dirs();

        let base = self.get_memo_base();
        if !base.exists() {
            return Vec::new();
        }

        // Try reading from list.json first - no file I/O needed
        if let Some(list) = self.read_list_json() {
            let mut memos: Vec<Memo> = list
                .memos
                .iter()
                .filter(|entry| !entry.id.is_empty())
                .map(Self::list_entry_to_memo)
                .collect();

            memos.sort_by_key(|b| std::cmp::Reverse(b.created_at));
            return memos;
        }

        // Fallback: scan .md files directly
        let mut memos = Vec::new();
        if let Ok(entries) = fs::read_dir(&base) {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_file() && path.extension().is_some_and(|ext| ext == "md") {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        // Filename format: "{title}-{id}.md", id starts with "m_"
                        if let Some(id) = name
                            .rsplit('-')
                            .next()
                            .filter(|s| s.starts_with("m_"))
                            .map(|s| s.to_string())
                        {
                            let rel_path = path
                                .strip_prefix(&base)
                                .unwrap_or(&path)
                                .to_string_lossy()
                                .to_string();
                            let now = chrono::Utc::now().timestamp_millis();
                            memos.push(Memo {
                                id,
                                filename: name
                                    .trim_end_matches(".md")
                                    .rsplit('-')
                                    .next()
                                    .map(|s| s.to_string())
                                    .unwrap_or_default(),
                                preview: String::new(),
                                tags: vec![],
                                todos: vec![],
                                created_at: now,
                                updated_at: now,
                                favorited: false,
                                icon: None,
                                path: Some(rel_path),
                            });
                        }
                    }
                }
            }
        }

        memos.sort_by_key(|b| std::cmp::Reverse(b.created_at));

        memos
    }

    pub fn read_all_memos_filtered(
        &self,
        filter: &str,
        sort: &str,
        tag_id: Option<&str>,
    ) -> Vec<Memo> {
        let all_memos = self.read_all_memos();

        // Compute time-range boundaries once so time-based filters can share them.
        let now = chrono_now();
        let week_start = start_of_this_week(now);
        let month_start = start_of_this_month(now);

        // Filter
        let filtered: Vec<Memo> = match filter {
            "todos" => all_memos
                .into_iter()
                .filter(|m| !m.todos.is_empty())
                .collect(),
            "favorited" => all_memos.into_iter().filter(|m| m.favorited).collect(),
            "tagged" => {
                if let Some(tid) = tag_id {
                    all_memos
                        .into_iter()
                        .filter(|m| m.tags.contains(&tid.to_string()))
                        .collect()
                } else {
                    all_memos
                        .into_iter()
                        .filter(|m| !m.tags.is_empty())
                        .collect()
                }
            }
            "thisWeek" => all_memos
                .into_iter()
                .filter(|m| m.created_at >= week_start && m.created_at <= now)
                .collect(),
            // "thisMonth" intentionally uses month_start (the 1st of the month) rather
            // than week_start, so memos created earlier in the month are still visible.
            // Because month_start <= week_start, anything in thisWeek is also in thisMonth.
            "thisMonth" => all_memos
                .into_iter()
                .filter(|m| m.created_at >= month_start && m.created_at <= now)
                .collect(),
            _ => all_memos, // "all" - no filter
        };

        // Sort. In the main list, favorited memos behave as pinned items.
        match sort {
            "updatedAt" => {
                let mut sorted = filtered;
                sorted.sort_by(|a, b| {
                    if filter == "all" {
                        b.favorited
                            .cmp(&a.favorited)
                            .then_with(|| b.updated_at.cmp(&a.updated_at))
                    } else {
                        b.updated_at.cmp(&a.updated_at)
                    }
                });
                sorted
            }
            _ => {
                // "createdAt" or default
                let mut sorted = filtered;
                sorted.sort_by(|a, b| {
                    if filter == "all" {
                        b.favorited
                            .cmp(&a.favorited)
                            .then_with(|| b.created_at.cmp(&a.created_at))
                    } else {
                        b.created_at.cmp(&a.created_at)
                    }
                });
                sorted
            }
        }
    }

    pub fn read_memo(&self, id: &str) -> Option<Memo> {
        let list = self.read_list_json()?;
        let entry = list.memos.iter().find(|e| e.id == id)?;
        Some(Self::list_entry_to_memo(entry))
    }

    pub fn update_memo_item(&self, memo: &Memo, content: Option<&str>) -> std::io::Result<String> {
        self.ensure_dirs()?;

        // Find old file path using list.json + filename
        let old_file_path = self.find_memo_file_by_id(&memo.id);
        let old_actual_filename: Option<String> = old_file_path
            .as_ref()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .map(|s| s.to_string());

        // Generate filename from memo.filename (title, without .md extension)
        let new_filename = Self::generate_unique_filename(
            &memo.filename,
            &memo.id,
            old_actual_filename.as_deref(),
        );
        eprintln!("[update_memo_item] id: {}, memo.filename: {}, old_actual_filename: {:?}, new_filename: {}", memo.id, memo.filename, old_actual_filename, new_filename);

        // If old file exists and filename changed, rename it
        if let Some(ref old_path) = old_file_path {
            if let Some(old_name) = old_path.file_name().and_then(|n| n.to_str()) {
                if old_name != new_filename && old_path.exists() {
                    let new_path = self.get_memo_base().join(&new_filename);
                    eprintln!(
                        "[update_memo_item] Renaming file: {} -> {}",
                        old_path.display(),
                        new_path.display()
                    );
                    fs::rename(old_path, &new_path)?;
                }
            }
        }

        let file_path = self.get_memo_base().join(&new_filename);

        let fm = MemoFrontmatter {
            filename: memo.filename.clone(),
        };

        let fm_yaml = serde_yaml::to_string(&fm).unwrap_or_default();
        let file_content = if let Some(c) = content {
            format!("---\n{}\n---\n{}", fm_yaml.trim(), c)
        } else {
            let existing = fs::read_to_string(&file_path).unwrap_or_default();
            if let Some(captures) = FRONTMATTER_RE.captures(&existing) {
                let body = captures.get(2).map(|m| m.as_str()).unwrap_or("");
                format!("---\n{}\n---\n{}", fm_yaml.trim(), body)
            } else {
                format!("---\n{}\n---\n{}", fm_yaml.trim(), existing)
            }
        };

        fs::write(&file_path, &file_content)?;

        // Set relative path for list.json sync
        let mut memo_to_sync = memo.clone();
        memo_to_sync.path = Some(new_filename.clone());
        Self::apply_derived_memo_fields(&mut memo_to_sync, &file_content);

        // Sync list.json with memo.filename (display title, no memoid)
        self.sync_list_json_on_write(&memo_to_sync)?;

        Ok(new_filename)
    }

    pub fn delete_memo_file(&self, id: &str) -> bool {
        if let Some(path) = self.find_memo_file_by_id(id) {
            let result = fs::remove_file(path).is_ok();

            // Sync list.json
            if result {
                let _ = self.sync_list_json_on_delete(id);
            }

            result
        } else {
            false
        }
    }
}
