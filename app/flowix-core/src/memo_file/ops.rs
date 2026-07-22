//! Memo CRUD 原语 — memo index 始终是全量索引的真源。
//!
//! 物理文件: `<notebook>/<filename>.md`, `filename` 即 memo index entry.filename。
//! 命名规则:
//! - 文件名由 `sanitize(title)` 派生, 后缀恒为 `.md`。
//! - 同 title 冲突时自动追加 `-1` / `-2` / ... (不去重 id 段, 6 位 shortid
//!   仅作为 memo index 的内部 key, 不再出现在文件名)。
//! - id 仍由 `generate_memo_id` 6 位 nanoid 生成, 字符集 `[0-9a-z]`。
//!
//! 所有写路径 (UI / Agent / 外部工具 / 文件监听器) 都过本模块, 唯一入口。
//! 跨 IPC 边界的 `Memo` / `MemoIndexEntry` 字段语义: `filename` 存磁盘文件名
//! (含 `.md`); 前端展示时去后缀; 旧版 `path` 字段删除。
//!
//! ## 锁模型
//!
//! 写路径 (`create` / `rename` / `write` / `delete` / `register_*` / `reconcile`)
//! 持有 `current_index_io` Mutex, 跨 "rename 物理文件 + 写 memo index" 全过程,
//! 串行化 memo index RMW, 杜绝 lost update。`std::sync::Mutex` 不可重入,
//! 内部 _locked 变体跳过自拿锁。

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::OptionalExtension;

use super::derivation::{apply_derived_memo_fields, extract_title_and_preview};
use super::frontmatter::{build_md_content, merge_frontmatter, MergeOverrides};
use super::notebook::sqlite_to_io;
use super::types::{DeleteTagReport, Memo, MoveTagReport, ReconcileReport};
use super::MemoFile;

/// title 派生 fallback: 空 body / 不可见首行时用 `untitled-YYYY-MM-DD`。
fn fallback_filename(now: chrono::DateTime<chrono::Local>) -> String {
    format!("{}.md", now.format("untitled-%Y-%m-%d"))
}

/// title 清洗: 替换文件系统非法字符 `\ / : * ? " < > |` 为空格,
/// 截到 200 字符, 去尾随 `.` (Windows 不接受 `name.`)。
pub fn sanitize_filename_component(title: &str) -> String {
    let mut sanitized: String = title
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            other => other,
        })
        .take(200)
        .collect();
    sanitized = sanitized.trim().to_string();
    if sanitized.ends_with('.') {
        sanitized.pop();
        sanitized.push(' ');
    }
    sanitized.trim().to_string()
}

/// 算基准 filename (不含冲突后缀): `<sanitized>.md`。
/// 空 title 时用 `untitled-YYYY-MM-DD.md` 兜底。
pub fn base_filename(title: &str) -> String {
    let sanitized = sanitize_filename_component(title);
    if sanitized.is_empty() {
        fallback_filename(chrono::Local::now())
    } else {
        sanitized
    }
}

/// 冲突检测: 在 base 目录下, `candidate.md` 是否已存在, 或已被 memo index
/// 某条 entry 占用。 任意一种情况都视为冲突, 自动追加 `-1` / `-2` / ...。
///
/// 关键: 之前只看 `fs::exists` 是不够的 ── 两次并发 `create_memo` 在
/// `current_index_io` 锁内串行, 但 `resolve_filename_conflict` 不读
/// memo index, 导致两个不同 id 写到同一个磁盘文件 (前一个 entry 的
/// filename 跟后一个冲突但磁盘文件已存在 → 仍报 "不冲突", 后一个
/// 覆盖前一个文件)。 现在加 memo index 维度, 跟 `apply_derived_memo_fields`
/// / `sync_index_on_write` 走同一真源。
pub fn resolve_filename_conflict(
    base: &Path,
    candidate_base: &str,
    occupied_filenames: &[String],
) -> String {
    let primary = format!("{candidate_base}.md");
    if !base.join(&primary).exists() && !occupied_filenames.contains(&primary) {
        return primary;
    }
    let mut n = 1u32;
    loop {
        let candidate = format!("{candidate_base}-{n}.md");
        if !base.join(&candidate).exists() && !occupied_filenames.contains(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// `.md` / `.markdown` 后缀判定 (大小写不敏感)。
pub trait IsMd {
    fn is_md(&self) -> bool;
}

impl IsMd for Path {
    fn is_md(&self) -> bool {
        self.extension()
            .and_then(|e| e.to_str())
            .map(|e| {
                let lower = e.to_ascii_lowercase();
                lower == "md" || lower == "markdown"
            })
            .unwrap_or(false)
    }
}

/// 原子写: temp file + fsync + rename ── 中途崩溃看到的永远是完整旧文件或
/// 完整新文件。跟 `index_store::atomic_write_json` 同源, 推广到任意路径 + bytes
/// 供 `.md` 写路径复用。
///
/// Windows 上 `MoveFileExW + MOVEFILE_REPLACE_EXISTING` 跨同一目录是原子;
/// `dunce::canonicalize` 去除 `\\?\` UNC 前缀, 确保 tmp 与 final 落在同一
/// canonical 根下, 否则跨盘符 rename 会失败。`canonicalize` 失败时 (文件
/// 还没创建 ── e.g. 全新 register_existing_file 场景) 退回原路径, 这时
/// rename 在同一目录下仍然原子。
pub fn atomic_write_bytes(final_path: &Path, content: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let final_path = dunce::canonicalize(final_path).unwrap_or_else(|_| final_path.to_path_buf());
    if let Some(parent) = final_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = final_path.with_extension(format!(
        "tmp.{}.{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    ));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(content)?;
        f.sync_all()?;
    }
    if let Err(e) = fs::rename(&tmp, &final_path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// Atomically create a new file without replacing an entry created by another process.
fn atomic_create_bytes(final_path: &Path, content: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    let parent = final_path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "file path has no parent")
    })?;
    fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(content)?;
    temp.as_file().sync_all()?;
    temp.persist_noclobber(final_path)
        .map(|_| ())
        .map_err(|error| error.error)
}

/// 跟 `flowix-desktop::fs_watcher::normalize_for_compare` 同口径的路径归一。
fn normalize_for_compare(path: &Path) -> PathBuf {
    if let Ok(canon) = dunce::canonicalize(path) {
        return canon;
    }
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        if let Ok(canon_parent) = dunce::canonicalize(parent) {
            return canon_parent.join(name);
        }
    }
    path.to_path_buf()
}

impl MemoFile {
    /// 生成一个新的 6 位 memo id (字符集 `[0-9a-z]`)。同 id 已存在时循环重抽。
    pub fn generate_memo_id(&self) -> String {
        loop {
            let id = nanoid::nanoid!(8, &super::MEMO_ID_ALPHABET);
            if self.read_current_memo(&id).is_none() {
                return id;
            }
        }
    }

    fn generate_global_memo_id(&self) -> String {
        loop {
            let id = nanoid::nanoid!(8, &super::MEMO_ID_ALPHABET);
            if self.resolve_memo_location(&id).ok().flatten().is_none() {
                return id;
            }
        }
    }

    fn memo_base_for_notebook_id_result(&self, notebook_id: &str) -> Result<PathBuf, String> {
        self.get_notebook_config_by_id(notebook_id)
            .map(|config| PathBuf::from(config.path))
            .ok_or_else(|| format!("notebook {notebook_id} not found"))
    }

    pub fn read_memo_for_notebook_id(&self, notebook_id: &str, id: &str) -> Option<Memo> {
        self.read_index_for_notebook_id(Some(notebook_id))
            .ok()
            .flatten()?
            .memos
            .into_iter()
            .find(|entry| entry.id == id)
            .map(|entry| MemoFile::index_entry_to_memo(&entry))
    }

    pub fn find_memo_by_filename_for_notebook_id(
        &self,
        notebook_id: &str,
        filename: &str,
    ) -> Option<Memo> {
        self.read_index_for_notebook_id(Some(notebook_id))
            .ok()
            .flatten()?
            .memos
            .into_iter()
            .find(|entry| entry.filename == filename)
            .map(|entry| MemoFile::index_entry_to_memo(&entry))
    }

    /// 公开 title 清洗工具: 供 index_store 复用, 行为等同 `sanitize_filename_component`。
    pub fn sanitize_memo_filename_component(title: &str) -> String {
        sanitize_filename_component(title)
    }

    /// 创建一个 memo: 写 .md + 写 memo index。返回新建的 Memo (含 id / filename)。
    pub fn create_memo(&self, title: &str, body: &str, tag: Option<&str>) -> std::io::Result<Memo> {
        self.create_memo_inner(None, title, body, tag, false)
    }

    /// Create in a registered notebook without changing the process-local current notebook.
    pub fn create_memo_for_notebook_id(
        &self,
        notebook_id: &str,
        title: &str,
        body: &str,
        tag: Option<&str>,
    ) -> std::io::Result<Memo> {
        self.create_memo_inner(Some(notebook_id), title, body, tag, false)
    }

    /// Create from a separate CLI/MCP process and leave an explicit marker for
    /// Desktop's filesystem watcher before the markdown file becomes visible.
    pub fn create_external_memo_for_notebook_id(
        &self,
        notebook_id: &str,
        title: &str,
        body: &str,
        tag: Option<&str>,
    ) -> std::io::Result<Memo> {
        self.create_memo_inner(Some(notebook_id), title, body, tag, true)
    }

    fn create_memo_inner(
        &self,
        notebook_id: Option<&str>,
        title: &str,
        body: &str,
        tag: Option<&str>,
        mark_external_create: bool,
    ) -> std::io::Result<Memo> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        let (base, resolved_notebook_id) = if let Some(notebook_id) = notebook_id {
            let base = self
                .memo_base_for_notebook_id_result(notebook_id)
                .map_err(|message| std::io::Error::new(std::io::ErrorKind::NotFound, message))?;
            fs::create_dir_all(&base)?;
            fs::create_dir_all(base.join("attachments"))?;
            (base, notebook_id.to_string())
        } else {
            self.ensure_dirs()?;
            (self.get_memo_base(), self.current_notebook_id_for_index())
        };

        let id = self.generate_global_memo_id();
        let now = chrono::Utc::now().timestamp_millis();
        let candidate = base_filename(title);
        // 读 memo index 拿已占用 filenames ── 跟 `fs::exists` 双维度检测冲突,
        // 杜绝并发 create_memo 写到同一文件 (前一个 entry 已 memo index
        // 但磁盘文件被覆盖)。
        let mut occupied: Vec<String> = self
            .read_index_for_notebook_id(Some(&resolved_notebook_id))?
            .unwrap_or_default()
            .memos
            .into_iter()
            .map(|entry| entry.filename)
            .collect();

        let final_body = match tag {
            Some(t) if !t.is_empty() => {
                if body.is_empty() {
                    format!("#{}", t)
                } else {
                    format!("{}\n#{}", body, t)
                }
            }
            _ => body.to_string(),
        };

        let overrides: MergeOverrides = [("key".to_string(), id.clone())].into_iter().collect();
        let initial_content = if super::frontmatter::FRONTMATTER_RE.is_match(&final_body) {
            merge_frontmatter(&final_body, &overrides)
        } else {
            build_md_content(&id, &final_body)
        };
        let persisted_id =
            super::frontmatter::extract_frontmatter_key(&initial_content).unwrap_or(id);
        if mark_external_create {
            self.mark_pending_external_memo_create(&persisted_id, &resolved_notebook_id)?;
        }
        let filename = loop {
            let filename = resolve_filename_conflict(&base, &candidate, &occupied);
            let path = base.join(&filename);
            match atomic_create_bytes(&path, initial_content.as_bytes()) {
                Ok(()) => break filename,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    occupied.push(filename);
                }
                Err(error) => {
                    if mark_external_create {
                        let _ = self.clear_pending_external_memo_create(&persisted_id);
                    }
                    return Err(error);
                }
            }
        };

        let mut memo = Memo {
            id: persisted_id,
            filename: filename.clone(),
            preview: String::new(),
            thumbnail: None,
            tags: vec![],
            todos: vec![],
            agents: vec![],
            created_at: now,
            updated_at: now,
            favorited: false,
            icon: None,
            colors: vec![],
            properties: serde_json::json!({}),
        };
        apply_derived_memo_fields(&mut memo, &initial_content);
        if let Err(error) =
            MemoFile::sync_index_on_write_for_notebook_id_locked(self, &resolved_notebook_id, &memo)
        {
            let path = base.join(&memo.filename);
            if fs::read_to_string(&path)
                .ok()
                .and_then(|content| super::frontmatter::extract_frontmatter_key(&content))
                .as_deref()
                == Some(memo.id.as_str())
            {
                let _ = fs::remove_file(path);
            }
            if mark_external_create {
                let _ = self.clear_pending_external_memo_create(&memo.id);
            }
            return Err(error);
        }
        Ok(memo)
    }

    /// 改名: 物理文件可能 rename, memo index entry.filename 同步更新。
    /// `new_title` 为空字符串时**不**重命名, 仅刷新派生字段 (no-op)。
    /// 冲突自动追加 `-1` / `-2`。
    pub fn rename_memo(&self, id: &str, new_title: &str) -> std::io::Result<Memo> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        self.ensure_dirs()?;

        let mut memo = self.read_current_memo(id).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, format!("memo {id} not found"))
        })?;
        let old_filename = memo.filename.clone();

        let old_base = old_filename.strip_suffix(".md").unwrap_or(&old_filename);
        let new_candidate = base_filename(new_title);
        let new_filename = if new_candidate == old_base {
            old_filename.clone()
        } else {
            let base = self.get_memo_base();
            // 锁内读 memo index: 跟 create_memo 同款, 排除本 memo 自身
            // (rename 自己的 entry 也占着 old_filename, 不应触发冲突)。
            let occupied: Vec<String> = self
                .read_index()
                .map(|l| {
                    l.memos
                        .into_iter()
                        .filter(|e| e.id != memo.id)
                        .map(|e| e.filename)
                        .collect()
                })
                .unwrap_or_default();
            resolve_filename_conflict(&base, &new_candidate, &occupied)
        };

        if new_filename != old_filename {
            let old_path = self.get_memo_base().join(&old_filename);
            let new_path = self.get_memo_base().join(&new_filename);
            if old_path.exists() {
                fs::rename(&old_path, &new_path)?;
            }
        }

        let path = self.get_memo_base().join(&new_filename);
        let existing = fs::read_to_string(&path).unwrap_or_default();
        let overrides: MergeOverrides =
            [("key".to_string(), memo.id.clone())].into_iter().collect();
        let new_content = merge_frontmatter(&existing, &overrides);
        atomic_write_bytes(&path, new_content.as_bytes())?;

        memo.filename = new_filename;
        memo.updated_at = chrono::Utc::now().timestamp_millis();
        apply_derived_memo_fields(&mut memo, &new_content);
        MemoFile::sync_index_on_write_locked(self, &memo)?;
        Ok(memo)
    }

    /// 写入 body (不改 title)。物理文件不 rename, 仅重写 .md + 同步 memo index 派生字段。
    pub fn write_memo(&self, id: &str, body: &str) -> std::io::Result<Memo> {
        let _guard = self.current_index_io.lock().expect("index_io poisoned");
        self.ensure_dirs()?;
        self.write_memo_inner_locked(id, body)
    }

    /// Write a globally resolved memo without renaming its file or switching notebooks.
    pub fn write_memo_preserving_filename_global(
        &self,
        id: &str,
        body: &str,
    ) -> std::io::Result<Memo> {
        let _guard = self.current_index_io.lock().expect("index_io poisoned");
        let location = self.resolve_memo_location(id)?.ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, format!("memo {id} not found"))
        })?;
        let base = PathBuf::from(&location.notebook.path);
        fs::create_dir_all(&base)?;
        fs::create_dir_all(base.join("attachments"))?;

        let mut memo = MemoFile::index_entry_to_memo(&location.memo);
        let overrides: MergeOverrides =
            [("key".to_string(), memo.id.clone())].into_iter().collect();
        let merged = merge_frontmatter(body, &overrides);
        atomic_write_bytes(&base.join(&memo.filename), merged.as_bytes())?;

        memo.updated_at = chrono::Utc::now().timestamp_millis();
        apply_derived_memo_fields(&mut memo, &merged);
        MemoFile::sync_index_on_write_for_notebook_id_locked(self, &location.notebook.id, &memo)?;
        Ok(memo)
    }

    /// 无锁版本的 [`Self::write_memo`]。调用方已持 `current_index_io` 锁。
    /// 抽出供 [`Self::write_memo_renaming_on_title_change`] 单事务合用。
    fn write_memo_inner_locked(&self, id: &str, body: &str) -> std::io::Result<Memo> {
        let mut memo = self.read_current_memo(id).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, format!("memo {id} not found"))
        })?;
        let overrides: MergeOverrides =
            [("key".to_string(), memo.id.clone())].into_iter().collect();
        let merged = merge_frontmatter(body, &overrides);
        let path = self.get_memo_base().join(&memo.filename);
        atomic_write_bytes(&path, merged.as_bytes())?;

        memo.updated_at = chrono::Utc::now().timestamp_millis();
        apply_derived_memo_fields(&mut memo, &merged);
        MemoFile::sync_index_on_write_locked(self, &memo)?;
        Ok(memo)
    }

    /// 写 body, 并从最终磁盘内容抽首行 title, 若跟当前 filename 不一致
    /// 触发物理 rename + memo index 同步。整段持单把 `current_index_io` 锁,
    /// 杜绝 "write_memo 释放锁后 fs_watcher 误判外部改名" 的窗口期。
    ///
    /// title 派生走 [`extract_title_and_preview`] ── 跟 memo index `preview`
    /// / `tags` / `todos` 同一流水线, 同源派生。空 body / 不可见首行时
    /// 派生 title 为空, 跳过改名 (避免把已有 title 改回 `untitled-` 兜底)。
    ///
    /// 调用方: `commands::memo::write_document` (Tiptap 编辑保存 IPC 入口)。
    pub fn write_memo_renaming_on_title_change(
        &self,
        id: &str,
        body: &str,
    ) -> std::io::Result<Memo> {
        let _guard = self.current_index_io.lock().expect("index_io poisoned");
        self.ensure_dirs()?;

        // 先 write_memo (含 key 注入 + memo index 同步)
        let memo = self.write_memo_inner_locked(id, body)?;

        // 抽最终磁盘内容(同锁内, 写盘已完成, 文件可读)
        let path = self.get_memo_base().join(&memo.filename);
        let final_content = fs::read_to_string(&path).unwrap_or_default();
        let (derived_title, _) = extract_title_and_preview(&final_content);
        let derived_title = if derived_title.is_empty() {
            "Untitled Memo"
        } else {
            derived_title.as_str()
        };

        // 跟当前 memo index.filename 比对, 变了 → 复用 rename_memo 同款判定
        let old_base = memo
            .filename
            .strip_suffix(".md")
            .unwrap_or(&memo.filename)
            .to_string();
        let new_candidate = base_filename(derived_title);
        if new_candidate == old_base {
            return Ok(memo);
        }

        // 走跟 rename_memo 完全相同的派生 + 物理 rename + memo index 同步路径
        // 锁内读 memo index 排除本 memo 自身, 跟 create_memo / rename_memo
        // 同源。
        let occupied: Vec<String> = self
            .read_index()
            .map(|l| {
                l.memos
                    .into_iter()
                    .filter(|e| e.id != memo.id)
                    .map(|e| e.filename)
                    .collect()
            })
            .unwrap_or_default();
        let new_filename =
            resolve_filename_conflict(&self.get_memo_base(), &new_candidate, &occupied);
        let old_filename = memo.filename.clone();
        if new_filename != old_filename {
            let old_path = self.get_memo_base().join(&old_filename);
            let new_path = self.get_memo_base().join(&new_filename);
            if old_path.exists() {
                fs::rename(&old_path, &new_path)?;
            }
        }

        // 重写新路径的 frontmatter, 锁内保证 frontmatter key == id
        let new_path = self.get_memo_base().join(&new_filename);
        let existing = fs::read_to_string(&new_path).unwrap_or_default();
        let overrides: MergeOverrides =
            [("key".to_string(), memo.id.clone())].into_iter().collect();
        let new_content = merge_frontmatter(&existing, &overrides);
        atomic_write_bytes(&new_path, new_content.as_bytes())?;

        let mut updated = memo;
        updated.filename = new_filename;
        updated.updated_at = chrono::Utc::now().timestamp_millis();
        apply_derived_memo_fields(&mut updated, &new_content);
        MemoFile::sync_index_on_write_locked(self, &updated)?;
        Ok(updated)
    }

    pub fn write_memo_renaming_on_title_change_global(
        &self,
        id: &str,
        body: &str,
    ) -> std::io::Result<Memo> {
        let _guard = self.current_index_io.lock().expect("index_io poisoned");
        let location = self.resolve_memo_location(id)?.ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, format!("memo {id} not found"))
        })?;
        let notebook_id = location.notebook.id;
        let base = PathBuf::from(location.notebook.path);
        fs::create_dir_all(&base)?;
        fs::create_dir_all(base.join("attachments"))?;

        let mut memo = MemoFile::index_entry_to_memo(&location.memo);
        let overrides: MergeOverrides =
            [("key".to_string(), memo.id.clone())].into_iter().collect();
        let merged = merge_frontmatter(body, &overrides);
        let path = base.join(&memo.filename);
        atomic_write_bytes(&path, merged.as_bytes())?;

        memo.updated_at = chrono::Utc::now().timestamp_millis();
        apply_derived_memo_fields(&mut memo, &merged);
        MemoFile::sync_index_on_write_for_notebook_id_locked(self, &notebook_id, &memo)?;

        let final_content = fs::read_to_string(&path).unwrap_or_default();
        let (derived_title, _) = extract_title_and_preview(&final_content);
        let derived_title = if derived_title.is_empty() {
            "Untitled Memo"
        } else {
            derived_title.as_str()
        };

        let old_base = memo
            .filename
            .strip_suffix(".md")
            .unwrap_or(&memo.filename)
            .to_string();
        let new_candidate = base_filename(derived_title);
        if new_candidate == old_base {
            return Ok(memo);
        }

        let occupied: Vec<String> = self
            .read_index_for_notebook_id(Some(&notebook_id))?
            .map(|l| {
                l.memos
                    .into_iter()
                    .filter(|e| e.id != memo.id)
                    .map(|e| e.filename)
                    .collect()
            })
            .unwrap_or_default();
        let new_filename = resolve_filename_conflict(&base, &new_candidate, &occupied);
        let old_filename = memo.filename.clone();
        if new_filename != old_filename {
            let old_path = base.join(&old_filename);
            let new_path = base.join(&new_filename);
            if old_path.exists() {
                fs::rename(&old_path, &new_path)?;
            }
        }

        let new_path = base.join(&new_filename);
        let existing = fs::read_to_string(&new_path).unwrap_or_default();
        let overrides: MergeOverrides =
            [("key".to_string(), memo.id.clone())].into_iter().collect();
        let new_content = merge_frontmatter(&existing, &overrides);
        atomic_write_bytes(&new_path, new_content.as_bytes())?;

        let mut updated = memo;
        updated.filename = new_filename;
        updated.updated_at = chrono::Utc::now().timestamp_millis();
        apply_derived_memo_fields(&mut updated, &new_content);
        MemoFile::sync_index_on_write_for_notebook_id_locked(self, &notebook_id, &updated)?;
        Ok(updated)
    }

    /// 删除: 删 .md + memo index 移除 entry。
    /// 物理文件已不在 (例如外部 `rm`) 但 memo index 仍残留 → 清 list, 视为成功。
    /// 完全找不到 (list 也没有) → false。
    pub fn delete_memo(&self, id: &str) -> bool {
        self.delete_memo_result(id).unwrap_or(false)
    }

    /// 删除并返回真实 IO 结果。
    ///
    /// 保留 [`Self::delete_memo`] 的布尔兼容 API，CLI/JSON-RPC 使用本方法避免
    /// 把 remove/index 写入失败伪装成成功。
    pub fn delete_memo_result(&self, id: &str) -> std::io::Result<bool> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");

        let path = self
            .read_current_memo(id)
            .map(|m| self.get_memo_base().join(&m.filename));

        let removed = match path {
            Some(p) if p.exists() => {
                fs::remove_file(&p)?;
                true
            }
            _ => {
                // 物理文件已无, 但 memo index 仍残留 → 兜底清 list
                self.read_current_memo(id).is_some()
            }
        };
        if removed {
            MemoFile::sync_index_on_delete_locked(self, id)?;
        }
        Ok(removed)
    }

    pub fn delete_memo_result_global(&self, id: &str) -> std::io::Result<bool> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        let Some(location) = self.resolve_memo_location(id)? else {
            return Ok(false);
        };

        let path = PathBuf::from(&location.notebook.path).join(&location.memo.filename);
        let removed = if path.exists() {
            fs::remove_file(&path)?;
            true
        } else {
            true
        };
        if removed {
            MemoFile::sync_index_on_delete_for_notebook_id_locked(self, &location.notebook.id, id)?;
        }
        Ok(removed)
    }

    /// 把磁盘上已存在的 .md 注册为 memo, **不**重命名磁盘文件, **不**覆盖 body。
    /// 失败: 路径非 .md; 文件不存在; 文件名已在 memo index 走 reload 路径 (不重复 push)。
    ///
    /// Rename/reconcile 入口: 如果文件 frontmatter 里已有 `key: <id>` 字段, 以磁盘
    /// key 为真相修复 memo index。
    ///
    /// - key 命中已有 entry 且 filename 不同: 视为物理 rename, 保留 id 并更新 filename。
    /// - key 不在 memo index: 用磁盘 key 重建 entry, 用于启动/切换 notebook 对账。
    /// - 无 key: 生成新 id 并写入 frontmatter。
    ///
    /// 粘贴/复制导入不要走这个函数, 应走 `register_existing_file_as_new`, 以免沿用
    /// 被复制文件的 key。
    pub fn register_existing_file(&self, abs_path: &Path) -> Result<Memo, String> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");

        if !abs_path.is_md() {
            return Err(format!("not a markdown file: {}", abs_path.display()));
        }
        if !abs_path.exists() {
            return Err(format!("file not found: {}", abs_path.display()));
        }
        let filename = abs_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid path: {}", abs_path.display()))?
            .to_string();

        if let Some(memo) = self.find_memo_by_filename(&filename) {
            return self.reload_memo_inner_locked(memo);
        }

        // v2: 优先从 frontmatter 抽 key 反查 memo index, 命中则改 filename 保留 id。
        // 三种情况, 都是用磁盘 frontmatter key 当真相, 不生成新 id:
        // (a) read_memo 命中 + filename 不一致 → inode tracker 漏命中 / Windows 场景
        //     走 rename_memo_file 改 entry.filename
        // (b) read_memo 命中 + filename 一致 → 幂等, 不做任何事
        // (c) read_memo 没命中 (memo index 已被前面的 Remove 事件清掉) → 用磁盘 key
        //     重建 memo index entry, 这是 "Remove + Create 配对" 场景下避免 id 漂移的关键
        //     路径: 删了的 entry 仍然能靠磁盘 frontmatter key 复活, id 不变。
        let content = fs::read_to_string(abs_path).map_err(|e| e.to_string())?;
        if let Some(existing_id) = super::frontmatter::extract_frontmatter_key(&content) {
            if let Some(existing_memo) = self.read_current_memo(&existing_id) {
                if existing_memo.filename != filename {
                    // (a) 走 rename_memo_file 改 entry.filename, id 保留
                    drop(_index_io_guard);
                    return self.rename_memo_file(
                        &self.get_memo_base().join(&existing_memo.filename),
                        abs_path,
                    );
                }
                // (b) filename 一致: 幂等 no-op, 不重新生成
                return Ok(existing_memo);
            }
            if self
                .resolve_memo_location(&existing_id)
                .ok()
                .flatten()
                .is_some()
            {
                return self.register_existing_file_as_new_locked(abs_path);
            }
            // (c) read_memo 没命中: 重建 memo index entry, 保留磁盘 key 对应的 id
            // 物理文件已存在 (前面 if !abs_path.exists() 早返回), 跳到下方
            // "let id = existing_id" 分支处理 (替换原来的 generate_memo_id)。
            let id = existing_id;
            let now = chrono::Utc::now().timestamp_millis();
            // 磁盘 frontmatter 已经有正确的 key, 不需要再 merge_frontmatter 写盘。
            let mut memo = Memo {
                id: id.clone(),
                filename: filename.clone(),
                preview: String::new(),
                thumbnail: None,
                tags: vec![],
                todos: vec![],
                agents: vec![],
                created_at: now,
                updated_at: now,
                favorited: false,
                icon: None,
                colors: vec![],
                properties: serde_json::json!({}),
            };
            apply_derived_memo_fields(&mut memo, &content);
            MemoFile::sync_index_on_write_locked(self, &memo)
                .map_err(|e| format!("sync memo index failed: {e}"))?;
            return Ok(memo);
        }

        let id = self.generate_memo_id();
        let now = chrono::Utc::now().timestamp_millis();

        // 把生成的 key 就地注入到 frontmatter 块: 有 key 行就替换,
        // 没有就追加 (头部)。其它字段 (用户手写的 tags / description /
        // 注释 / 空行) 字节级保留。
        let overrides: MergeOverrides = [("key".to_string(), id.clone())].into_iter().collect();
        let stamped = merge_frontmatter(&content, &overrides);
        atomic_write_bytes(abs_path, stamped.as_bytes()).map_err(|e| e.to_string())?;

        let mut memo = Memo {
            id: id.clone(),
            filename: filename.clone(),
            preview: String::new(),
            thumbnail: None,
            tags: vec![],
            todos: vec![],
            agents: vec![],
            created_at: now,
            updated_at: now,
            favorited: false,
            icon: None,
            colors: vec![],
            properties: serde_json::json!({}),
        };
        apply_derived_memo_fields(&mut memo, &stamped);
        MemoFile::sync_index_on_write_locked(self, &memo)
            .map_err(|e| format!("sync memo index failed: {e}"))?;
        Ok(memo)
    }

    /// Copy/import 入口: 把磁盘上的 .md 按“新文档”注册，忽略已有 frontmatter
    /// `key` 并写入新 key。
    ///
    /// 粘贴/复制导入的文件可能带着另一个 memo 的 key。此时不能按 rename 处理，
    /// 否则会把原 memo 的 index entry 移到新文件名上，而不是创建副本。
    pub fn register_existing_file_as_new(&self, abs_path: &Path) -> Result<Memo, String> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        self.register_existing_file_as_new_locked(abs_path)
    }

    fn register_existing_file_as_new_locked(&self, abs_path: &Path) -> Result<Memo, String> {
        if !abs_path.is_md() {
            return Err(format!("not a markdown file: {}", abs_path.display()));
        }
        if !abs_path.exists() {
            return Err(format!("file not found: {}", abs_path.display()));
        }
        let filename = abs_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid path: {}", abs_path.display()))?
            .to_string();

        if let Some(memo) = self.find_memo_by_filename(&filename) {
            return self.reload_memo_inner_locked(memo);
        }

        let content = fs::read_to_string(abs_path).map_err(|e| e.to_string())?;
        let id = self.generate_memo_id();
        let now = chrono::Utc::now().timestamp_millis();
        let overrides: MergeOverrides = [("key".to_string(), id.clone())].into_iter().collect();
        let stamped = merge_frontmatter(&content, &overrides);
        atomic_write_bytes(abs_path, stamped.as_bytes()).map_err(|e| e.to_string())?;

        let mut memo = Memo {
            id: id.clone(),
            filename,
            preview: String::new(),
            thumbnail: None,
            tags: vec![],
            todos: vec![],
            agents: vec![],
            created_at: now,
            updated_at: now,
            favorited: false,
            icon: None,
            colors: vec![],
            properties: serde_json::json!({}),
        };
        apply_derived_memo_fields(&mut memo, &stamped);
        MemoFile::sync_index_on_write_locked(self, &memo)
            .map_err(|e| format!("sync memo index failed: {e}"))?;
        Ok(memo)
    }

    pub fn register_existing_file_for_notebook_id(
        &self,
        notebook_id: &str,
        abs_path: &Path,
    ) -> Result<Memo, String> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        self.register_existing_file_for_notebook_id_locked(notebook_id, abs_path)
    }

    pub fn register_existing_file_as_new_for_notebook_id(
        &self,
        notebook_id: &str,
        abs_path: &Path,
    ) -> Result<Memo, String> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        self.register_existing_file_as_new_for_notebook_id_locked(notebook_id, abs_path)
    }

    fn register_existing_file_as_new_for_notebook_id_locked(
        &self,
        notebook_id: &str,
        abs_path: &Path,
    ) -> Result<Memo, String> {
        if !abs_path.is_md() {
            return Err(format!("not a markdown file: {}", abs_path.display()));
        }
        if !abs_path.exists() {
            return Err(format!("file not found: {}", abs_path.display()));
        }
        let filename = abs_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid path: {}", abs_path.display()))?
            .to_string();

        if let Some(memo) = self.find_memo_by_filename_for_notebook_id(notebook_id, &filename) {
            return self.reload_memo_inner_for_notebook_id_locked(notebook_id, memo);
        }

        let content = fs::read_to_string(abs_path).map_err(|e| e.to_string())?;
        let id = self.generate_global_memo_id();
        let now = chrono::Utc::now().timestamp_millis();
        let overrides: MergeOverrides = [("key".to_string(), id.clone())].into_iter().collect();
        let stamped = merge_frontmatter(&content, &overrides);
        atomic_write_bytes(abs_path, stamped.as_bytes()).map_err(|e| e.to_string())?;

        let mut memo = Memo {
            id: id.clone(),
            filename,
            preview: String::new(),
            thumbnail: None,
            tags: vec![],
            todos: vec![],
            agents: vec![],
            created_at: now,
            updated_at: now,
            favorited: false,
            icon: None,
            colors: vec![],
            properties: serde_json::json!({}),
        };
        apply_derived_memo_fields(&mut memo, &stamped);
        MemoFile::sync_index_on_write_for_notebook_id_locked(self, notebook_id, &memo)
            .map_err(|e| format!("sync memo index failed: {e}"))?;
        Ok(memo)
    }

    fn register_existing_file_for_notebook_id_locked(
        &self,
        notebook_id: &str,
        abs_path: &Path,
    ) -> Result<Memo, String> {
        if !abs_path.is_md() {
            return Err(format!("not a markdown file: {}", abs_path.display()));
        }
        if !abs_path.exists() {
            return Err(format!("file not found: {}", abs_path.display()));
        }
        let filename = abs_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid path: {}", abs_path.display()))?
            .to_string();

        if let Some(memo) = self.find_memo_by_filename_for_notebook_id(notebook_id, &filename) {
            return self.reload_memo_inner_for_notebook_id_locked(notebook_id, memo);
        }

        let content = fs::read_to_string(abs_path).map_err(|e| e.to_string())?;
        if let Some(existing_id) = super::frontmatter::extract_frontmatter_key(&content) {
            if let Some(existing_memo) = self.read_memo_for_notebook_id(notebook_id, &existing_id) {
                if existing_memo.filename != filename {
                    let base = self.memo_base_for_notebook_id_result(notebook_id)?;
                    return self.rename_memo_file_for_notebook_id_locked(
                        notebook_id,
                        &base.join(&existing_memo.filename),
                        abs_path,
                    );
                }
                return Ok(existing_memo);
            }
            if self
                .resolve_memo_location(&existing_id)
                .ok()
                .flatten()
                .is_some()
            {
                return self
                    .register_existing_file_as_new_for_notebook_id_locked(notebook_id, abs_path);
            }

            let id = existing_id;
            let now = chrono::Utc::now().timestamp_millis();
            let mut memo = Memo {
                id: id.clone(),
                filename: filename.clone(),
                preview: String::new(),
                thumbnail: None,
                tags: vec![],
                todos: vec![],
                agents: vec![],
                created_at: now,
                updated_at: now,
                favorited: false,
                icon: None,
                colors: vec![],
                properties: serde_json::json!({}),
            };
            apply_derived_memo_fields(&mut memo, &content);
            MemoFile::sync_index_on_write_for_notebook_id_locked(self, notebook_id, &memo)
                .map_err(|e| format!("sync memo index failed: {e}"))?;
            return Ok(memo);
        }

        let id = self.generate_global_memo_id();
        let now = chrono::Utc::now().timestamp_millis();
        let overrides: MergeOverrides = [("key".to_string(), id.clone())].into_iter().collect();
        let stamped = merge_frontmatter(&content, &overrides);
        atomic_write_bytes(abs_path, stamped.as_bytes()).map_err(|e| e.to_string())?;

        let mut memo = Memo {
            id: id.clone(),
            filename: filename.clone(),
            preview: String::new(),
            thumbnail: None,
            tags: vec![],
            todos: vec![],
            agents: vec![],
            created_at: now,
            updated_at: now,
            favorited: false,
            icon: None,
            colors: vec![],
            properties: serde_json::json!({}),
        };
        apply_derived_memo_fields(&mut memo, &stamped);
        MemoFile::sync_index_on_write_for_notebook_id_locked(self, notebook_id, &memo)
            .map_err(|e| format!("sync memo index failed: {e}"))?;
        Ok(memo)
    }

    /// 无锁版本的 [`Self::register_existing_file`]。调用方**必须**已持有
    /// `current_index_io` 锁, 函数内不再 lock, 避免自重入死锁
    /// (`std::sync::Mutex` 不可重入)。
    ///
    /// 调用方约束: `abs_path` 的 `filename` 必须**不在** memo index (已被
    /// `reconcile_with_disk_bidirectional` 之类用集合差过滤过)。函数内不再走
    /// `find_memo_by_filename → reload_memo_from_disk` 的早期返回分支。
    ///
    /// 行为:
    /// - 磁盘 frontmatter 含 `key: <id>` 且 memo index 已存在同 id 的另一条 entry
    ///   (意味着 inode-tracker 漏命中场景: entry.filename != 当前 filename) →
    ///   走 `rename_memo_file_locked` 改 entry.filename, **保留 id**。
    /// - 磁盘 frontmatter 含 `key: <id>` 且 memo index 没记录 → 用磁盘 key 作为 id
    ///   重建 entry, 避免 id 漂移。
    /// - 磁盘无 key → 生成新 id, 通过 `merge_frontmatter` 注入到文件头。
    fn register_existing_file_locked(&self, abs_path: &Path) -> Result<Memo, String> {
        if !abs_path.is_md() {
            return Err(format!("not a markdown file: {}", abs_path.display()));
        }
        if !abs_path.exists() {
            return Err(format!("file not found: {}", abs_path.display()));
        }
        let filename = abs_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid path: {}", abs_path.display()))?
            .to_string();

        let content = fs::read_to_string(abs_path).map_err(|e| e.to_string())?;
        if let Some(existing_id) = super::frontmatter::extract_frontmatter_key(&content) {
            if let Some(existing_memo) = self.read_current_memo(&existing_id) {
                // 调用方已保证 filename 不在 memo index; 如果这里命中 read_memo,
                // 说明 entry 的 filename 跟当前不一致 (inode-tracker 漏命中场景),
                // 走 rename_memo_file_locked 保留 id, 改 entry.filename 为当前 filename。
                return self.rename_memo_file_locked(
                    &self.get_memo_base().join(&existing_memo.filename),
                    abs_path,
                );
            }
            if self
                .resolve_memo_location(&existing_id)
                .ok()
                .flatten()
                .is_some()
            {
                return self.register_existing_file_as_new_locked(abs_path);
            }
            // read_memo 没命中: 重建 entry, 用磁盘 frontmatter key 作为 id
            let id = existing_id;
            let now = chrono::Utc::now().timestamp_millis();
            let mut memo = Memo {
                id: id.clone(),
                filename: filename.clone(),
                preview: String::new(),
                thumbnail: None,
                tags: vec![],
                todos: vec![],
                agents: vec![],
                created_at: now,
                updated_at: now,
                favorited: false,
                icon: None,
                colors: vec![],
                properties: serde_json::json!({}),
            };
            apply_derived_memo_fields(&mut memo, &content);
            MemoFile::sync_index_on_write_locked(self, &memo)
                .map_err(|e| format!("sync memo index failed: {e}"))?;
            return Ok(memo);
        }

        let id = self.generate_memo_id();
        let now = chrono::Utc::now().timestamp_millis();

        let overrides: MergeOverrides = [("key".to_string(), id.clone())].into_iter().collect();
        let stamped = merge_frontmatter(&content, &overrides);
        atomic_write_bytes(abs_path, stamped.as_bytes()).map_err(|e| e.to_string())?;

        let mut memo = Memo {
            id: id.clone(),
            filename: filename.clone(),
            preview: String::new(),
            thumbnail: None,
            tags: vec![],
            todos: vec![],
            agents: vec![],
            created_at: now,
            updated_at: now,
            favorited: false,
            icon: None,
            colors: vec![],
            properties: serde_json::json!({}),
        };
        apply_derived_memo_fields(&mut memo, &stamped);
        MemoFile::sync_index_on_write_locked(self, &memo)
            .map_err(|e| format!("sync memo index failed: {e}"))?;
        Ok(memo)
    }

    /// 无锁版本的 [`Self::rename_memo_file`]。调用方**必须**已持有
    /// `current_index_io` 锁。
    fn rename_memo_file_locked(&self, old_path: &Path, new_path: &Path) -> Result<Memo, String> {
        let old_filename = old_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid old path: {}", old_path.display()))?
            .to_string();
        let new_filename = new_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid new path: {}", new_path.display()))?
            .to_string();

        let mut memo = match self.find_memo_by_filename(&old_filename) {
            Some(m) => m.clone(),
            None => return Err(format!("old filename not in memo index: {old_filename}")),
        };
        let id = memo.id.clone();

        let base = self.get_memo_base();
        let expected_old_abs = base.join(&old_filename);
        if normalize_for_compare(&expected_old_abs) != normalize_for_compare(old_path) {
            return Err(format!(
                "old path not under notebook base: {}",
                old_path.display()
            ));
        }

        if !new_path.is_md() {
            return Err(format!("new path is not markdown: {}", new_path.display()));
        }

        if let Some(existing) = self.find_memo_by_filename(&new_filename) {
            if existing.id != id {
                return Err(format!(
                    "new filename already occupied by another memo (id={})",
                    existing.id
                ));
            }
        }

        memo.filename = new_filename.clone();
        let new_abs = base.join(&new_filename);
        let content = std::fs::read_to_string(&new_abs)
            .map_err(|e| format!("failed to read new path {}: {e}", new_abs.display()))?;
        apply_derived_memo_fields(&mut memo, &content);
        let now = chrono::Utc::now().timestamp_millis();
        memo.updated_at = now;

        MemoFile::sync_index_on_write_locked(self, &memo)
            .map_err(|e| format!("sync memo index failed: {e}"))?;
        Ok(memo)
    }

    /// 启动 / 切 notebook 时调用: 扫当前 notebook 根目录 .md, 把 memo index 没记录的补进来。
    /// **不**重命名磁盘文件, 保留外部工具的句柄。
    /// 跳过 `.metadata/` 目录; 已在 memo index 里的 .md 跳过 (按 filename 精确比对)。
    pub fn reconcile_with_disk(&self) -> Result<usize, String> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");

        let base = self.get_memo_base();
        if !base.exists() {
            return Ok(0);
        }
        let entries = match fs::read_dir(&base) {
            Ok(e) => e,
            Err(e) => return Err(format!("read_dir failed: {e}")),
        };

        let known_filenames: std::collections::HashSet<String> = self
            .read_index()
            .map(|l| l.memos.into_iter().map(|e| e.filename).collect())
            .unwrap_or_default();

        // 收齐所有候选文件, 排完序再批量注册, 减少锁反复获取。
        let mut to_register: Vec<PathBuf> = Vec::new();
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if !path.is_file() || !path.is_md() {
                continue;
            }
            if path
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                == Some(".metadata")
            {
                continue;
            }
            let filename = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if known_filenames.contains(&filename) {
                continue;
            }
            to_register.push(path);
        }
        drop(_index_io_guard);

        let mut added = 0usize;
        for path in to_register {
            if self.register_existing_file(&path).is_ok() {
                added += 1;
            }
        }
        Ok(added)
    }

    /// 双向对账: 注册 memo index 缺失的 .md **同时**清理指向已不存在文件的
    /// 幽灵条目 (memo index 里有但磁盘上无对应 .md)。
    ///
    /// 设计动机:
    /// - [`Self::reconcile_with_disk`] 纯加法 — 应用关闭期间被外部 `rm` /
    ///   同步盘删除的 .md, memo index 里的 entry 永远不会被清, 影响列表 /
    ///   tag 聚合 / 筛选正确性。
    /// - 删方向用「`disk_filenames - list_filenames`」反向集合差, 不需要 stat
    ///   每个 memo index entry; 10K memos 时一次 read_dir + 集合差 <500ms,
    ///   比 10K 次 stat 快一个数量级。
    /// - 单锁单 RMW: 整个函数在 `current_index_io` 锁内完成, 跟 IPC 写 / watcher
    ///   处理路径互斥, 不存在并发漂移。
    ///
    /// 调用方:
    /// - [`crate::commands::helpers::switch_notebook_and_rebuild`] (替换原来的
    ///   `reconcile_with_disk` 调用)
    /// - [`crate::lib::run`] `.setup()` 阶段启动不变量
    ///
    /// 幂等: `added == 0 && removed == 0` 时是 no-op。
    ///
    /// 实现注意: 注册阶段 (`register_existing_file_locked` 内部走
    /// `sync_index_on_write_locked`) 会改写 memo index on disk, 我们局部
    /// 持有的 `list` 副本会过时。 因此**注册完后必须重新读 memo index**, 再
    /// 算 prune 的差集 — 否则会把注册阶段刚加的 entry 误当成幽灵条目删掉。
    pub fn reconcile_with_disk_bidirectional(&self) -> Result<ReconcileReport, String> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");

        let base = self.get_memo_base();
        if !base.exists() {
            return Ok(ReconcileReport::default());
        }

        // 1. 单次 read_dir: 收齐磁盘上所有 .md 文件名 (跳过 `.metadata/`)
        let disk_filenames: std::collections::HashSet<String> = match fs::read_dir(&base) {
            Ok(rd) => rd
                .filter_map(|e| e.ok())
                .filter_map(|entry| {
                    let path = entry.path();
                    if !path.is_file() || !path.is_md() {
                        return None;
                    }
                    if path
                        .parent()
                        .and_then(|p| p.file_name())
                        .and_then(|n| n.to_str())
                        == Some(".metadata")
                    {
                        return None;
                    }
                    path.file_name().and_then(|n| n.to_str()).map(String::from)
                })
                .collect(),
            Err(e) => return Err(format!("read_dir failed: {e}")),
        };

        // 2. 读 memo index (锁内, 仅用作算 to_register; 注册后会再读一次)
        let initial_list = self.read_index().unwrap_or_default();

        // 3. 算「需要注册」的文件名集合
        let to_register: Vec<String> = disk_filenames
            .iter()
            .filter(|f| !initial_list.memos.iter().any(|e| &e.filename == *f))
            .cloned()
            .collect();

        // 4. 串行注册新文件; 单条失败仅记 warn 不中断整批
        let mut added = 0usize;
        for filename in &to_register {
            let path = base.join(filename);
            match self.register_existing_file_locked(&path) {
                Ok(_) => added += 1,
                Err(e) => tracing::warn!(
                    "[reconcile_with_disk_bidirectional] register {} failed: {e}",
                    filename
                ),
            }
        }

        // 5. 重新读 memo index — 注册阶段 (含可能的 inode-rename 走
        //    rename_memo_file_locked) 已改写过磁盘, 局部 `initial_list` 已过时。
        //    基于磁盘最新状态算 prune 差集, 避免误删刚注册的 entry。
        let mut list = self.read_index().unwrap_or_default();
        let before = list.memos.len();
        list.memos.retain(|e| disk_filenames.contains(&e.filename));
        let removed = before - list.memos.len();
        if removed > 0 {
            list.last_updated = chrono::Utc::now().timestamp_millis();
            self.write_index(&list)
                .map_err(|e| format!("write_index failed: {e}"))?;
        }

        Ok(ReconcileReport { added, removed })
    }

    /// 重新读 .md 派生 preview / tags / todos, 同步到 memo index。
    pub fn reconcile_with_disk_bidirectional_as_new(&self) -> Result<ReconcileReport, String> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");

        let base = self.get_memo_base();
        if !base.exists() {
            return Ok(ReconcileReport::default());
        }

        let disk_filenames: std::collections::HashSet<String> = match fs::read_dir(&base) {
            Ok(rd) => rd
                .filter_map(|e| e.ok())
                .filter_map(|entry| {
                    let path = entry.path();
                    if !path.is_file() || !path.is_md() {
                        return None;
                    }
                    if path
                        .parent()
                        .and_then(|p| p.file_name())
                        .and_then(|n| n.to_str())
                        == Some(".metadata")
                    {
                        return None;
                    }
                    path.file_name().and_then(|n| n.to_str()).map(String::from)
                })
                .collect(),
            Err(e) => return Err(format!("read_dir failed: {e}")),
        };

        let initial_list = self.read_index().unwrap_or_default();
        let to_register: Vec<String> = disk_filenames
            .iter()
            .filter(|f| !initial_list.memos.iter().any(|e| &e.filename == *f))
            .cloned()
            .collect();

        let mut added = 0usize;
        for filename in &to_register {
            let path = base.join(filename);
            match self.register_existing_file_as_new_locked(&path) {
                Ok(_) => added += 1,
                Err(e) => tracing::warn!(
                    "[reconcile_with_disk_bidirectional_as_new] register {} failed: {e}",
                    filename
                ),
            }
        }

        let mut list = self.read_index().unwrap_or_default();
        let before = list.memos.len();
        list.memos.retain(|e| disk_filenames.contains(&e.filename));
        let removed = before - list.memos.len();
        if removed > 0 {
            list.last_updated = chrono::Utc::now().timestamp_millis();
            self.write_index(&list)
                .map_err(|e| format!("write_index failed: {e}"))?;
        }

        Ok(ReconcileReport { added, removed })
    }

    pub fn reload_memo_from_disk(&self, id: &str) -> Result<Memo, String> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        let memo = self
            .read_current_memo(id)
            .ok_or_else(|| format!("memo {id} not in memo index"))?;
        self.reload_memo_inner_locked(memo)
    }

    /// 同 `reload_memo_from_disk`, 但定位用 `filename`。
    pub fn reload_memo_from_disk_by_filename(&self, filename: &str) -> Result<Memo, String> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        let memo = self
            .find_memo_by_filename(filename)
            .ok_or_else(|| format!("memo with filename {filename} not in memo index"))?;
        self.reload_memo_inner_locked(memo)
    }

    pub fn reload_memo_from_disk_by_filename_for_notebook_id(
        &self,
        notebook_id: &str,
        filename: &str,
    ) -> Result<Memo, String> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        let memo = self
            .find_memo_by_filename_for_notebook_id(notebook_id, filename)
            .ok_or_else(|| format!("memo with filename {filename} not in memo index"))?;
        self.reload_memo_inner_for_notebook_id_locked(notebook_id, memo)
    }

    fn reload_memo_inner_locked(&self, mut memo: Memo) -> Result<Memo, String> {
        let path = self.get_memo_base().join(&memo.filename);
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        memo.updated_at = chrono::Utc::now().timestamp_millis();
        apply_derived_memo_fields(&mut memo, &content);
        MemoFile::sync_index_on_write_locked(self, &memo)
            .map_err(|e| format!("sync memo index failed: {e}"))?;
        Ok(memo)
    }

    fn reload_memo_inner_for_notebook_id_locked(
        &self,
        notebook_id: &str,
        mut memo: Memo,
    ) -> Result<Memo, String> {
        let path = self
            .memo_base_for_notebook_id_result(notebook_id)?
            .join(&memo.filename);
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        memo.updated_at = chrono::Utc::now().timestamp_millis();
        apply_derived_memo_fields(&mut memo, &content);
        MemoFile::sync_index_on_write_for_notebook_id_locked(self, notebook_id, &memo)
            .map_err(|e| format!("sync memo index failed: {e}"))?;
        Ok(memo)
    }

    /// 按 filename 在 memo index 找 entry, 返回 Memo。
    pub fn find_memo_by_filename(&self, filename: &str) -> Option<Memo> {
        let list = self.read_index()?;
        list.memos
            .into_iter()
            .find(|e| e.filename == filename)
            .map(|e| MemoFile::index_entry_to_memo(&e))
    }

    /// 按 id 找 memo 物理文件绝对路径。文件可能已不在 (返回路径不保证存在)。
    pub fn find_memo_file_path(&self, id: &str) -> Option<PathBuf> {
        let location = self.resolve_memo_location(id).ok().flatten()?;
        Some(PathBuf::from(location.notebook.path).join(location.memo.filename))
    }

    /// 按 filename 拼绝对路径。
    pub fn file_path_for(&self, filename: &str) -> PathBuf {
        self.get_memo_base().join(filename)
    }

    /// 同步 memo index 中某条 memo 的非文件字段 (favorited / colors / icon 等)。
    /// 不动磁盘文件, 不重写派生字段 (preview / tags / todos)。
    pub fn sync_metadata_only(&self, memo: &Memo) -> std::io::Result<()> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        MemoFile::sync_index_on_write_locked(self, memo)
    }

    pub fn sync_metadata_only_global(&self, memo: &Memo) -> std::io::Result<()> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        let notebook_id = self
            .resolve_memo_location(&memo.id)?
            .map(|location| location.notebook.id)
            .unwrap_or_else(|| self.current_notebook_id_for_index());
        MemoFile::sync_index_on_write_for_notebook_id_locked(self, &notebook_id, memo)
    }

    /// 按绝对路径找 memo index entry 并移除 (memo index 同步)。物理文件删除由 caller 负责。
    /// 防御性 invariant guard: entry.filename 拼出的绝对路径规范化后, 跟 `abs_path`
    /// 规范化相等才删 (避免 rename 旧文件 Remove 事件误删 entry)。
    pub fn unregister_memo_by_path(&self, abs_path: &Path) -> bool {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        let filename = abs_path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string());
        let Some(filename) = filename else {
            return false;
        };
        let Some(memo) = self.find_memo_by_filename(&filename) else {
            return false;
        };
        let expected_abs = self.get_memo_base().join(&memo.filename);
        if normalize_for_compare(&expected_abs) != normalize_for_compare(abs_path) {
            tracing::debug!(
                "[unregister_memo_by_path] refused: memo index entry.filename={} but abs_path={}",
                expected_abs.display(),
                abs_path.display()
            );
            return false;
        }
        MemoFile::sync_index_on_delete_locked(self, &memo.id).is_ok()
    }

    pub fn unregister_memo_by_path_for_notebook_id(
        &self,
        notebook_id: &str,
        abs_path: &Path,
    ) -> bool {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        let filename = abs_path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string());
        let Some(filename) = filename else {
            return false;
        };
        let Some(memo) = self.find_memo_by_filename_for_notebook_id(notebook_id, &filename) else {
            return false;
        };
        let Ok(base) = self.memo_base_for_notebook_id_result(notebook_id) else {
            return false;
        };
        let expected_abs = base.join(&memo.filename);
        if normalize_for_compare(&expected_abs) != normalize_for_compare(abs_path) {
            tracing::debug!(
                "[unregister_memo_by_path_for_notebook_id] refused: memo index entry.filename={} but abs_path={}",
                expected_abs.display(),
                abs_path.display()
            );
            return false;
        }
        MemoFile::sync_index_on_delete_for_notebook_id_locked(self, notebook_id, &memo.id).is_ok()
    }

    /// Idempotently sync an existing memo entry to the filename currently on disk.
    ///
    /// The watcher can observe `Create/Modify(new_path)` while an internal save is
    /// still holding `current_index_io`. By the time this method obtains the lock,
    /// the save path may already have updated the index to `new_path`. Resolve by
    /// memo id inside the lock so both states converge and still produce an update.
    pub fn sync_memo_filename_from_disk_key(
        &self,
        id: &str,
        new_path: &Path,
    ) -> Result<Memo, String> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        let location = self
            .resolve_memo_location(id)
            .map_err(|e| format!("resolve memo location failed: {e}"))?
            .ok_or_else(|| format!("memo id not in index: {id}"))?;

        let new_filename = new_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid new path: {}", new_path.display()))?
            .to_string();
        if !new_path.is_md() {
            return Err(format!("new path is not markdown: {}", new_path.display()));
        }

        let base = PathBuf::from(&location.notebook.path);
        let expected_new_abs = base.join(&new_filename);
        if normalize_for_compare(&expected_new_abs) != normalize_for_compare(new_path) {
            return Err(format!(
                "new path not under memo notebook base: {}",
                new_path.display()
            ));
        }

        let current_filename = location.memo.filename.clone();
        if current_filename != new_filename {
            let old_abs = base.join(&current_filename);
            if old_abs.exists() {
                return Err(format!(
                    "indexed file still exists; treating as copy instead of rename: {}",
                    old_abs.display()
                ));
            }
        }

        let list = self
            .read_index_for_notebook_id(Some(&location.notebook.id))
            .map_err(|e| format!("read memo index failed: {e}"))?
            .unwrap_or_default();
        if let Some(existing) = list
            .memos
            .iter()
            .find(|entry| entry.filename == new_filename && entry.id != id)
        {
            return Err(format!(
                "new filename already occupied by another memo (id={})",
                existing.id
            ));
        }

        let content = std::fs::read_to_string(new_path)
            .map_err(|e| format!("failed to read new path {}: {e}", new_path.display()))?;
        let mut memo = MemoFile::index_entry_to_memo(&location.memo);
        memo.filename = new_filename;
        apply_derived_memo_fields(&mut memo, &content);
        memo.updated_at = chrono::Utc::now().timestamp_millis();

        MemoFile::sync_index_on_write_for_notebook_id_locked(self, &location.notebook.id, &memo)
            .map_err(|e| format!("sync memo index failed: {e}"))?;
        Ok(memo)
    }

    pub fn sync_memo_filename_from_disk_key_for_notebook_id(
        &self,
        notebook_id: &str,
        id: &str,
        new_path: &Path,
    ) -> Result<Memo, String> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        let existing = self
            .read_memo_for_notebook_id(notebook_id, id)
            .ok_or_else(|| format!("memo id not in notebook {notebook_id}: {id}"))?;

        let new_filename = new_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid new path: {}", new_path.display()))?
            .to_string();
        if !new_path.is_md() {
            return Err(format!("new path is not markdown: {}", new_path.display()));
        }

        let base = self.memo_base_for_notebook_id_result(notebook_id)?;
        let expected_new_abs = base.join(&new_filename);
        if normalize_for_compare(&expected_new_abs) != normalize_for_compare(new_path) {
            return Err(format!(
                "new path not under memo notebook base: {}",
                new_path.display()
            ));
        }

        if existing.filename != new_filename {
            let old_abs = base.join(&existing.filename);
            if old_abs.exists() {
                return Err(format!(
                    "indexed file still exists; treating as copy instead of rename: {}",
                    old_abs.display()
                ));
            }
        }

        let list = self
            .read_index_for_notebook_id(Some(notebook_id))
            .map_err(|e| format!("read memo index failed: {e}"))?
            .unwrap_or_default();
        if let Some(occupied) = list
            .memos
            .iter()
            .find(|entry| entry.filename == new_filename && entry.id != id)
        {
            return Err(format!(
                "new filename already occupied by another memo (id={})",
                occupied.id
            ));
        }

        let content = std::fs::read_to_string(new_path)
            .map_err(|e| format!("failed to read new path {}: {e}", new_path.display()))?;
        let mut memo = existing;
        memo.filename = new_filename;
        apply_derived_memo_fields(&mut memo, &content);
        memo.updated_at = chrono::Utc::now().timestamp_millis();

        MemoFile::sync_index_on_write_for_notebook_id_locked(self, notebook_id, &memo)
            .map_err(|e| format!("sync memo index failed: {e}"))?;
        Ok(memo)
    }

    /// 物理 rename 同步: 把 memo index entry 从 old_filename 改成 new_filename,
    /// **保留 id**。 物理文件已由调用方 (OS / 用户) 搬好, 我们不动磁盘。
    ///
    /// 跟 `unregister_memo_by_path` + `register_existing_file` 的"双 register"
    /// 区别: 后者会生成**新** id, 把同一份磁盘内容当新 memo 入库;
    /// rename_memo_file 保留 id, 让 memo index 跟着物理 mv 走, 触发
    /// `MemoEvent::Updated` (id 永不变, 前端 store 按 id patch 即可)。
    ///
    /// 失败条件:
    /// - old_filename 不在 memo index (没记录)
    /// - new_filename 已在 memo index (新路径被另一条 entry 占用, 防覆盖)
    /// - new_filename 不是 .md 后缀
    /// - 任一路径规范化后不在当前 notebook base 下
    ///
    /// 物理文件 invariant: 调用方负责保证 new_path 实际指向同 id 的内容
    /// (即 OS 层 mv 已经完成)。 我们只更新 memo index 索引。
    pub fn rename_memo_file(&self, old_path: &Path, new_path: &Path) -> Result<Memo, String> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");

        let old_filename = old_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid old path: {}", old_path.display()))?
            .to_string();
        let new_filename = new_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid new path: {}", new_path.display()))?
            .to_string();

        // 1. 找旧 entry
        let mut memo = match self.find_memo_by_filename(&old_filename) {
            Some(m) => m.clone(),
            None => return Err(format!("old filename not in memo index: {old_filename}")),
        };
        let id = memo.id.clone();

        // 2. 旧路径在不在当前 notebook base 下 (规范化检查)
        let base = self.get_memo_base();
        let expected_old_abs = base.join(&old_filename);
        if normalize_for_compare(&expected_old_abs) != normalize_for_compare(old_path) {
            return Err(format!(
                "old path not under notebook base: {}",
                old_path.display()
            ));
        }

        // 3. new_filename 后缀必须是 .md / .markdown
        if !new_path.is_md() {
            return Err(format!("new path is not markdown: {}", new_path.display()));
        }

        // 4. new_filename 不能已在 memo index (会跟另一条 entry 撞名)
        if let Some(existing) = self.find_memo_by_filename(&new_filename) {
            if existing.id != id {
                return Err(format!(
                    "new filename already occupied by another memo (id={})",
                    existing.id
                ));
            }
        }

        // 5. 改 entry.filename + 重新派生 preview / tags / todos (frontmatter 跟着物理文件
        //    一起被 mv 搬过来了, 重新读)
        memo.filename = new_filename.clone();
        let new_abs = base.join(&new_filename);
        let content = std::fs::read_to_string(&new_abs)
            .map_err(|e| format!("failed to read new path {}: {e}", new_abs.display()))?;
        apply_derived_memo_fields(&mut memo, &content);
        let now = chrono::Utc::now().timestamp_millis();
        memo.updated_at = now;

        // 6. 同步 memo index (沿用 sync_index_on_write_locked, 它走 filename 做索引)
        MemoFile::sync_index_on_write_locked(self, &memo)
            .map_err(|e| format!("sync memo index failed: {e}"))?;
        Ok(memo)
    }

    pub fn rename_memo_file_for_notebook_id(
        &self,
        notebook_id: &str,
        old_path: &Path,
        new_path: &Path,
    ) -> Result<Memo, String> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        self.rename_memo_file_for_notebook_id_locked(notebook_id, old_path, new_path)
    }

    fn rename_memo_file_for_notebook_id_locked(
        &self,
        notebook_id: &str,
        old_path: &Path,
        new_path: &Path,
    ) -> Result<Memo, String> {
        let old_filename = old_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid old path: {}", old_path.display()))?
            .to_string();
        let new_filename = new_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid new path: {}", new_path.display()))?
            .to_string();

        let mut memo = match self.find_memo_by_filename_for_notebook_id(notebook_id, &old_filename)
        {
            Some(m) => m,
            None => return Err(format!("old filename not in memo index: {old_filename}")),
        };
        let id = memo.id.clone();

        let base = self.memo_base_for_notebook_id_result(notebook_id)?;
        let expected_old_abs = base.join(&old_filename);
        if normalize_for_compare(&expected_old_abs) != normalize_for_compare(old_path) {
            return Err(format!(
                "old path not under notebook base: {}",
                old_path.display()
            ));
        }

        if !new_path.is_md() {
            return Err(format!("new path is not markdown: {}", new_path.display()));
        }

        if let Some(existing) =
            self.find_memo_by_filename_for_notebook_id(notebook_id, &new_filename)
        {
            if existing.id != id {
                return Err(format!(
                    "new filename already occupied by another memo (id={})",
                    existing.id
                ));
            }
        }

        memo.filename = new_filename.clone();
        let new_abs = base.join(&new_filename);
        let content = std::fs::read_to_string(&new_abs)
            .map_err(|e| format!("failed to read new path {}: {e}", new_abs.display()))?;
        apply_derived_memo_fields(&mut memo, &content);
        memo.updated_at = chrono::Utc::now().timestamp_millis();

        MemoFile::sync_index_on_write_for_notebook_id_locked(self, notebook_id, &memo)
            .map_err(|e| format!("sync memo index failed: {e}"))?;
        Ok(memo)
    }

    /// 移动 subtag: 把 `old_path` 整棵子树重命名 (含 prefix 替换),
    /// 批量改写所有受影响 memo 的 `.md` body + 同步 memo index。
    ///
    /// **语义**:
    /// - `old_path` 自身: 重命名为 `new_path`。
    /// - `old_path/<...>` 子树 (任意深度): 全部重命名, 把 `old_path/`
    ///   前缀替换为 `new_path/`, 子段保持不变。
    /// - 其它 tag / 普通文本: 不变。
    ///
    /// **约束** (调用方应已大致校验, 这里再兜底):
    /// 1. `old_path` / `new_path` 必须走 [`normalize_tag_path`] 通过
    ///    (合法路径, 无空段 / `//` / 首尾 `/`)。
    /// 2. `old_path != new_path` (相同 → no-op, 返回空 report)。
    /// 3. `new_path` 在该 notebook 内不能已存在 (否则冲突, 报错)。
    ///
    /// **锁**: 进入即持 `current_index_io` 锁, 整段操作串行化, 跟
    /// `write_memo` / `create_memo` / `rename_memo` / `reconcile_*` 互斥。
    /// 单条 memo 改写走 `atomic_write_bytes` + `sync_index_on_write_*`,
    /// 文件写和 index 写各自原子, 中途崩溃靠下次 `reconcile_with_disk_bidirectional`
    /// 的派生迁移自愈。
    pub fn move_memo_tag_locked(
        &self,
        notebook_id: Option<&str>,
        old_path: &str,
        new_path: &str,
    ) -> std::io::Result<MoveTagReport> {
        // 旧入口 (无 hook): 保持原签名, 委托 with_hooks 传 no-op 回调。
        // core 单测与无 watcher 需求的调用方 (CLI) 走这个, 不感知 hook。
        self.move_memo_tag_locked_with_hooks(notebook_id, old_path, new_path, |_| {}, |_, _| {})
    }

    /// [`move_memo_tag_locked`] 的带 hook 版: desktop 在每个 memo 写盘前后
    /// 注入回调 ── `on_before_write` 用于 mark_self_write 抑制 watcher 自写,
    /// `on_after_write` 用于收集 (id, before) 供调用方在释放 memo_file read
    /// lock 后 emit MemoEvent::Updated。core 不依赖 tauri / watcher /
    /// memo_events, 通过回调与 desktop 解耦 (保持零 Tauri 依赖)。
    pub fn move_memo_tag_locked_with_hooks<F, G>(
        &self,
        notebook_id: Option<&str>,
        old_path: &str,
        new_path: &str,
        on_before_write: F,
        mut on_after_write: G,
    ) -> std::io::Result<MoveTagReport>
    where
        F: Fn(&Path),
        G: FnMut(&str, &Memo),
    {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");

        // 1. 校验 + 规范化
        let old_path = match super::derivation::normalize_tag_path(old_path) {
            Some(p) => p,
            None => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("invalid old path: {old_path}"),
                ));
            }
        };
        let new_path = match super::derivation::normalize_tag_path(new_path) {
            Some(p) => p,
            None => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("invalid new path: {new_path}"),
                ));
            }
        };

        // 2. no-op: old == new
        if old_path == new_path {
            return Ok(MoveTagReport::default());
        }

        // 3. 解析目标 notebook
        let notebook_id_owned = notebook_id
            .map(str::to_string)
            .unwrap_or_else(|| self.current_notebook_id_for_index());

        // 4. 冲突检查: new_path 在该 notebook 是否已存在
        let conn = self.open_memo_index_db()?;
        let new_exists: bool = conn
            .query_row(
                "SELECT 1 FROM memo_tags mt
                 JOIN memos m ON m.id = mt.memo_id
                 WHERE m.notebook_id = ?1 AND mt.tag = ?2
                 LIMIT 1",
                rusqlite::params![&notebook_id_owned, &new_path],
                |_| Ok(true),
            )
            .optional()
            .map_err(sqlite_to_io)?
            .unwrap_or(false);
        if new_exists {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                format!("target tag already exists in notebook: {new_path}"),
            ));
        }

        // 5. 找所有 affected memo_id (memo_tags 里有 old_path 或 old_path/*)
        let prefix = format!("{old_path}/");
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT mt.memo_id FROM memo_tags mt
                 JOIN memos m ON m.id = mt.memo_id
                 WHERE m.notebook_id = ?1
                   AND (mt.tag = ?2 OR mt.tag LIKE ?3 ESCAPE '\\')",
            )
            .map_err(sqlite_to_io)?;
        let affected_ids: Vec<String> = stmt
            .query_map(
                rusqlite::params![&notebook_id_owned, &old_path, format!("{prefix}%")],
                |row| row.get(0),
            )
            .map_err(sqlite_to_io)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_to_io)?;

        drop(stmt);

        // 6. 逐 memo 改写 body + 同步 memo index
        let mut report = MoveTagReport::default();
        let mut renamed_seen = std::collections::HashSet::new();
        for memo_id in &affected_ids {
            let location = self.resolve_memo_location(memo_id)?.ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("memo {memo_id} not found"),
                )
            })?;
            let path =
                std::path::PathBuf::from(&location.notebook.path).join(&location.memo.filename);
            let body = std::fs::read_to_string(&path)?;
            let new_body =
                super::derivation::replace_tag_paths_in_body(&body, &old_path, &new_path);
            if new_body == body {
                continue;
            }

            // 改写前的 memo 快照: on_after_write 把它交回调用方, 用于 emit
            // memo-event 时算 derived_changed (before -> after)。
            let before_memo = MemoFile::index_entry_to_memo(&location.memo);

            // 收集实际改写涉及的 (old, new) 路径对, 用于报告
            for old_tag in &location.memo.tags {
                let new_tag = if old_tag == &old_path {
                    Some(new_path.clone())
                } else if let Some(suffix) = old_tag.strip_prefix(&prefix) {
                    Some(format!("{new_path}/{suffix}"))
                } else {
                    None
                };
                if let Some(new_tag) = new_tag {
                    if renamed_seen.insert((old_tag.clone(), new_tag.clone())) {
                        report.renamed_tags.push((old_tag.clone(), new_tag));
                    }
                }
            }

            // 写回 .md: 走 merge_frontmatter 保留 key, atomic_write_bytes
            let overrides: MergeOverrides =
                [("key".to_string(), memo_id.clone())].into_iter().collect();
            let merged = merge_frontmatter(&new_body, &overrides);

            // 写盘前通知调用方 mark_self_write ── 抑制 watcher 把这次自写
            // 误判为外部修改 (否则 N 个 memo 触发 N 次 reload + 事件轰击)。
            on_before_write(&path);

            atomic_write_bytes(&path, merged.as_bytes())?;

            // 重新派生 + 同步 memo index
            let mut memo = before_memo.clone();
            apply_derived_memo_fields(&mut memo, &merged);
            memo.updated_at = chrono::Utc::now().timestamp_millis();
            MemoFile::sync_index_on_write_for_notebook_id_locked(
                self,
                &location.notebook.id,
                &memo,
            )?;

            // 写盘 + index 同步完成后, 把 (id, before) 交回调用方 ── 调用方
            // 在释放 memo_file read lock 后据此 emit MemoEvent::Updated,
            // 避免持锁期间递归 read_lock (std RwLock 不支持递归 read)。
            on_after_write(memo_id.as_str(), &before_memo);

            report.affected_memos += 1;
        }

        Ok(report)
    }

    /// Delete tag: remove `tag_path` itself + all subtree tags (any depth
    /// under `tag_path/`) from both memo index and document body.
    ///
    /// Semantics:
    /// - `tag_path` itself: removed from `memo_tags` table; the matching
    ///   `#tag_path` token (with preceding whitespace) is stripped from
    ///   every affected .md body.
    /// - `tag_path/<...>` subtree (any depth): all of them are removed in
    ///   one shot -- both from `memo_tags` table and from .md bodies.
    /// - Other tags / plain text: untouched.
    ///
    /// Constraints (caller has roughly validated; we re-validate defensively):
    /// 1. `tag_path` must pass [`normalize_tag_path`] (legal path).
    /// 2. `tag_path` must exist in this notebook (`memo_tags` table has at
    ///    least one `tag = tag_path` or `tag LIKE tag_path/%` entry);
    ///    otherwise we error out.
    ///
    /// Locking: same as `move_memo_tag_locked` -- enters holding
    /// `current_index_io`, serialising with `write_memo` / `create_memo` /
    /// `rename_memo` / `reconcile_*`. Per-memo write goes through
    /// `atomic_write_bytes` + `sync_index_on_write_*`, so file write and
    /// index write are each atomic; mid-flight crash self-heals on next
    /// `reconcile_with_disk_bidirectional`.
    pub fn delete_memo_tag_locked(
        &self,
        notebook_id: Option<&str>,
        tag_path: &str,
    ) -> std::io::Result<DeleteTagReport> {
        self.delete_memo_tag_locked_with_hooks(notebook_id, tag_path, |_| {}, |_, _| {})
    }

    /// Hooked variant of [`delete_memo_tag_locked`]. Desktop injects
    /// `on_before_write` to suppress watcher self-writes and an
    /// `on_after_write` to collect `(id, before)` pairs for downstream
    /// emit. Core stays Tauri-free.
    ///
    /// Note: unlike `move_memo_tag_locked_with_hooks`, this command does
    /// NOT call `on_after_write` -- the upstream `TagsDeleted` event does
    /// not need a `before` snapshot (the only thing that matters is the
    /// affected id list, already collected up front). Kept the signature
    /// symmetric so future expansion (e.g. emit per-memo before/after)
    /// stays possible without breaking the contract.
    pub fn delete_memo_tag_locked_with_hooks<F, G>(
        &self,
        notebook_id: Option<&str>,
        tag_path: &str,
        on_before_write: F,
        _on_after_write: G,
    ) -> std::io::Result<DeleteTagReport>
    where
        F: Fn(&Path),
        G: FnMut(&str, &Memo),
    {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");

        // 1. validate + normalise
        let tag_path = match super::derivation::normalize_tag_path(tag_path) {
            Some(p) => p,
            None => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("invalid tag path: {tag_path}"),
                ));
            }
        };

        // 2. resolve target notebook
        let notebook_id_owned = notebook_id
            .map(str::to_string)
            .unwrap_or_else(|| self.current_notebook_id_for_index());

        let conn = self.open_memo_index_db()?;

        // 3. collect every tag path to delete: `tag_path` itself + every
        //    subtree tag at any depth.
        let prefix = format!("{tag_path}/");
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT mt.tag FROM memo_tags mt
                 JOIN memos m ON m.id = mt.memo_id
                 WHERE m.notebook_id = ?1
                   AND (mt.tag = ?2 OR mt.tag LIKE ?3 ESCAPE '\\')",
            )
            .map_err(sqlite_to_io)?;
        let deleted_tags: Vec<String> = stmt
            .query_map(
                rusqlite::params![&notebook_id_owned, &tag_path, format!("{prefix}%")],
                |row| row.get(0),
            )
            .map_err(sqlite_to_io)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_to_io)?;
        drop(stmt);

        if deleted_tags.is_empty() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("tag not found in notebook: {tag_path}"),
            ));
        }

        // 4. collect affected memo_ids
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT mt.memo_id FROM memo_tags mt
                 JOIN memos m ON m.id = mt.memo_id
                 WHERE m.notebook_id = ?1
                   AND (mt.tag = ?2 OR mt.tag LIKE ?3 ESCAPE '\\')",
            )
            .map_err(sqlite_to_io)?;
        let affected_ids: Vec<String> = stmt
            .query_map(
                rusqlite::params![&notebook_id_owned, &tag_path, format!("{prefix}%")],
                |row| row.get(0),
            )
            .map_err(sqlite_to_io)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_to_io)?;
        drop(stmt);

        // 5. per-memo body rewrite + memo index sync.
        let mut report = DeleteTagReport {
            affected_memos: 0,
            deleted_tags,
        };
        for memo_id in &affected_ids {
            let location = self.resolve_memo_location(memo_id)?.ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("memo {memo_id} not found"),
                )
            })?;
            let path =
                std::path::PathBuf::from(&location.notebook.path).join(&location.memo.filename);
            let body = std::fs::read_to_string(&path)?;
            let new_body =
                super::derivation::remove_tag_paths_in_body(&body, &tag_path);

            // body may not change if memo_tags had stale entries for this
            // tag while body never mentioned it (rare historical dirt).
            // We still need to write so apply_derived_memo_fields +
            // sync_index_on_write run, which prunes the stale memo_tags row.
            let _ = new_body == body;

            let overrides: MergeOverrides =
                [("key".to_string(), memo_id.clone())].into_iter().collect();
            let merged = merge_frontmatter(&new_body, &overrides);

            // notify caller to mark_self_write -- otherwise the watcher
            // would mistake this for an external edit and emit a wave of
            // reload events.
            on_before_write(&path);

            atomic_write_bytes(&path, merged.as_bytes())?;

            // re-derive + sync index. apply_derived_memo_fields re-runs
            // extract_tags_from_body so memo.tags stays in lockstep with
            // the rewritten body; sync_index_on_write prunes the deleted
            // memo_tags rows.
            let mut memo = MemoFile::index_entry_to_memo(&location.memo);
            apply_derived_memo_fields(&mut memo, &merged);
            memo.updated_at = chrono::Utc::now().timestamp_millis();
            MemoFile::sync_index_on_write_for_notebook_id_locked(
                self,
                &location.notebook.id,
                &memo,
            )?;

            report.affected_memos += 1;
        }

        Ok(report)
    }
}
