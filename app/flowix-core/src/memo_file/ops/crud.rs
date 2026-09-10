use super::*;

/// 判断当前文件名和派生标题是否仍代表同一个标题。
///
/// 文件名冲突时会在原始标题后追加 `-N`。因此 `Stable-1.md` 可能仍然
/// 对应正文标题 `Stable`；保存正文时不能因为这个系统生成的后缀而再次
/// 触发 rename。只接受无前导零的正整数后缀，避免把用户真正使用的
/// `Stable-01` / `Stable-0` 标题误判成冲突后缀。
fn same_title_with_generated_conflict_suffix(current_base: &str, derived_title: &str) -> bool {
    if current_base == derived_title {
        return true;
    }

    let Some((base, suffix)) = current_base.rsplit_once('-') else {
        return false;
    };

    base == derived_title
        && !suffix.is_empty()
        && suffix != "0"
        && !suffix.starts_with('0')
        && suffix.chars().all(|ch| ch.is_ascii_digit())
}

impl MemoFile {
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

    /// Create in an existing notebook subdirectory. The directory is expressed
    /// relative to the notebook root and is validated before any write occurs.
    pub fn create_memo_for_notebook_id_in_directory(
        &self,
        notebook_id: &str,
        parent_relative_path: &str,
        title: &str,
        body: &str,
        tag: Option<&str>,
    ) -> std::io::Result<Memo> {
        self.create_memo_inner_in_directory(
            Some(notebook_id),
            Some(parent_relative_path),
            title,
            body,
            tag,
            false,
        )
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
        self.create_memo_inner_in_directory(
            notebook_id,
            None,
            title,
            body,
            tag,
            mark_external_create,
        )
    }

    fn create_memo_inner_in_directory(
        &self,
        notebook_id: Option<&str>,
        parent_relative_path: Option<&str>,
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
            fs::create_dir_all(base.join(".flowix"))?;
            fs::create_dir_all(base.join("attachments"))?;
            (base, notebook_id.to_string())
        } else {
            self.ensure_dirs()?;
            (self.get_memo_base(), self.current_notebook_id_for_index())
        };

        let create_base = match parent_relative_path.filter(|path| !path.is_empty()) {
            Some(relative) => {
                let path = notebook_path_from_relative(&base, relative).map_err(|error| {
                    std::io::Error::new(std::io::ErrorKind::InvalidInput, error)
                })?;
                if !path.is_dir() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        format!("memo parent directory does not exist: {}", path.display()),
                    ));
                }
                let canonical_base = fs::canonicalize(&base)?;
                let canonical_path = fs::canonicalize(&path)?;
                if !canonical_path.starts_with(&canonical_base) {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "memo parent directory is outside the notebook root",
                    ));
                }
                path
            }
            None => base.clone(),
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
            .filter(|entry| {
                let parent = entry
                    .relative_path
                    .rsplit_once('/')
                    .map(|(parent, _)| parent);
                parent == parent_relative_path.filter(|path| !path.is_empty())
            })
            .map(|entry| entry.filename)
            .collect();

        let overrides: MergeOverrides = [("key".to_string(), id.clone())].into_iter().collect();
        let content_with_key = if super::super::frontmatter::FRONTMATTER_RE.is_match(body) {
            merge_frontmatter(body, &overrides)
        } else {
            build_md_content(&id, body)
        };
        let initial_content = match tag {
            Some(tag) if !tag.trim().is_empty() => {
                let mut tags = extract_document_metadata(&content_with_key)
                    .map_err(|error| {
                        std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string())
                    })?
                    .tags;
                tags.push(tag.to_string());
                replace_frontmatter_tags(&content_with_key, &tags).map_err(|error| {
                    std::io::Error::new(std::io::ErrorKind::InvalidInput, error.to_string())
                })?
            }
            _ => content_with_key,
        };
        validate_document_frontmatter(&initial_content)?;
        let persisted_id =
            super::super::frontmatter::extract_frontmatter_key(&initial_content).unwrap_or(id);
        if mark_external_create {
            self.mark_pending_external_memo_create(&persisted_id, &resolved_notebook_id)?;
        }
        let filename = loop {
            let filename = resolve_filename_conflict(&create_base, &candidate, &occupied);
            let path = create_base.join(&filename);
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
            relative_path: parent_relative_path
                .filter(|path| !path.is_empty())
                .map(|parent| format!("{parent}/{filename}"))
                .unwrap_or_else(|| filename.clone()),
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
            let path = notebook_path_from_relative(&base, &memo.relative_path)
                .map_err(std::io::Error::other)?;
            if fs::read_to_string(&path)
                .ok()
                .and_then(|content| super::super::frontmatter::extract_frontmatter_key(&content))
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
        let old_relative_path = memo.relative_path.clone();
        let base = self.get_memo_base();
        let parent_relative = std::path::Path::new(&old_relative_path)
            .parent()
            .unwrap_or(std::path::Path::new(""))
            .to_string_lossy()
            .replace('\\', "/");

        let old_base = old_filename.strip_suffix(".md").unwrap_or(&old_filename);
        let new_candidate = base_filename(new_title);
        let new_filename = if new_candidate == old_base {
            old_filename.clone()
        } else {
            // 锁内读 memo index: 跟 create_memo 同款, 排除本 memo 自身
            // (rename 自己的 entry 也占着 old_filename, 不应触发冲突)。
            let occupied: Vec<String> = self
                .read_index()
                .map(|l| {
                    l.memos
                        .into_iter()
                        .filter(|e| e.id != memo.id)
                        .map(|e| e.relative_path)
                        .collect()
                })
                .unwrap_or_default();
            resolve_relative_filename_conflict(&base, &parent_relative, &new_candidate, &occupied)
        };

        let parent = std::path::Path::new(&parent_relative);
        let new_relative_path = parent
            .join(&new_filename)
            .to_string_lossy()
            .replace('\\', "/");
        if new_relative_path != old_relative_path {
            let old_path = notebook_path_from_relative(&base, &old_relative_path)
                .map_err(std::io::Error::other)?;
            let new_path = notebook_path_from_relative(&base, &new_relative_path)
                .map_err(std::io::Error::other)?;
            if old_path.exists() {
                rename_file_noclobber(&old_path, &new_path)?;
            }
        }

        let path = notebook_path_from_relative(&base, &new_relative_path)
            .map_err(std::io::Error::other)?;
        let existing = fs::read_to_string(&path).unwrap_or_default();
        let overrides: MergeOverrides =
            [("key".to_string(), memo.id.clone())].into_iter().collect();
        let new_content = merge_frontmatter(&existing, &overrides);
        atomic_write_bytes(&path, new_content.as_bytes())?;

        memo.filename = new_filename;
        memo.relative_path = new_relative_path;
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
        fs::create_dir_all(base.join(".flowix"))?;
        fs::create_dir_all(base.join("attachments"))?;

        let mut memo = MemoFile::index_entry_to_memo(&location.memo);
        let overrides: MergeOverrides =
            [("key".to_string(), memo.id.clone())].into_iter().collect();
        let merged = merge_frontmatter(body, &overrides);
        validate_document_frontmatter(&merged)?;
        let path = notebook_path_from_relative(&base, &memo.relative_path)
            .map_err(std::io::Error::other)?;
        atomic_write_bytes(&path, merged.as_bytes())?;

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
        validate_document_frontmatter(&merged)?;
        let path = notebook_path_from_relative(&self.get_memo_base(), &memo.relative_path)
            .map_err(std::io::Error::other)?;
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
        let path = notebook_path_from_relative(&self.get_memo_base(), &memo.relative_path)
            .map_err(std::io::Error::other)?;
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
        if same_title_with_generated_conflict_suffix(&old_base, &new_candidate) {
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
                    .map(|e| e.relative_path)
                    .collect()
            })
            .unwrap_or_default();
        let old_relative_path = memo.relative_path.clone();
        let parent_relative = std::path::Path::new(&old_relative_path)
            .parent()
            .unwrap_or(std::path::Path::new(""))
            .to_string_lossy()
            .replace('\\', "/");
        let new_filename = resolve_relative_filename_conflict(
            &self.get_memo_base(),
            &parent_relative,
            &new_candidate,
            &occupied,
        );
        let parent = std::path::Path::new(&parent_relative);
        let new_relative_path = parent
            .join(&new_filename)
            .to_string_lossy()
            .replace('\\', "/");
        if new_relative_path != old_relative_path {
            let old_path = notebook_path_from_relative(&self.get_memo_base(), &old_relative_path)
                .map_err(std::io::Error::other)?;
            let new_path = notebook_path_from_relative(&self.get_memo_base(), &new_relative_path)
                .map_err(std::io::Error::other)?;
            if old_path.exists() {
                rename_file_noclobber(&old_path, &new_path)?;
            }
        }

        // 重写新路径的 frontmatter, 锁内保证 frontmatter key == id
        let new_path = notebook_path_from_relative(&self.get_memo_base(), &new_relative_path)
            .map_err(std::io::Error::other)?;
        let existing = fs::read_to_string(&new_path).unwrap_or_default();
        let overrides: MergeOverrides =
            [("key".to_string(), memo.id.clone())].into_iter().collect();
        let new_content = merge_frontmatter(&existing, &overrides);
        atomic_write_bytes(&new_path, new_content.as_bytes())?;

        let mut updated = memo;
        updated.filename = new_filename;
        updated.relative_path = new_relative_path;
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
        fs::create_dir_all(base.join(".flowix"))?;
        fs::create_dir_all(base.join("attachments"))?;

        let mut memo = MemoFile::index_entry_to_memo(&location.memo);
        let overrides: MergeOverrides =
            [("key".to_string(), memo.id.clone())].into_iter().collect();
        let merged = merge_frontmatter(body, &overrides);
        validate_document_frontmatter(&merged)?;
        let path = notebook_path_from_relative(&base, &memo.relative_path)
            .map_err(std::io::Error::other)?;
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
        if same_title_with_generated_conflict_suffix(&old_base, &new_candidate) {
            return Ok(memo);
        }

        let occupied: Vec<String> = self
            .read_index_for_notebook_id(Some(&notebook_id))?
            .map(|l| {
                l.memos
                    .into_iter()
                    .filter(|e| e.id != memo.id)
                    .map(|e| e.relative_path)
                    .collect()
            })
            .unwrap_or_default();
        let old_relative_path = memo.relative_path.clone();
        let parent_relative = std::path::Path::new(&old_relative_path)
            .parent()
            .unwrap_or(std::path::Path::new(""))
            .to_string_lossy()
            .replace('\\', "/");
        let new_filename =
            resolve_relative_filename_conflict(&base, &parent_relative, &new_candidate, &occupied);
        let parent = std::path::Path::new(&parent_relative);
        let new_relative_path = parent
            .join(&new_filename)
            .to_string_lossy()
            .replace('\\', "/");
        if new_relative_path != old_relative_path {
            let old_path = notebook_path_from_relative(&base, &old_relative_path)
                .map_err(std::io::Error::other)?;
            let new_path = notebook_path_from_relative(&base, &new_relative_path)
                .map_err(std::io::Error::other)?;
            if old_path.exists() {
                rename_file_noclobber(&old_path, &new_path)?;
            }
        }

        let new_path = notebook_path_from_relative(&base, &new_relative_path)
            .map_err(std::io::Error::other)?;
        let existing = fs::read_to_string(&new_path).unwrap_or_default();
        let overrides: MergeOverrides =
            [("key".to_string(), memo.id.clone())].into_iter().collect();
        let new_content = merge_frontmatter(&existing, &overrides);
        atomic_write_bytes(&new_path, new_content.as_bytes())?;

        let mut updated = memo;
        updated.filename = new_filename;
        updated.relative_path = new_relative_path;
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

        let path = self.read_current_memo(id).and_then(|m| {
            notebook_path_from_relative(&self.get_memo_base(), &m.relative_path).ok()
        });

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

        let path = notebook_path_from_relative(
            &PathBuf::from(&location.notebook.path),
            &location.memo.relative_path,
        )
        .map_err(std::io::Error::other)?;
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

    /// Delete a memo only when it belongs to the requested notebook.
    ///
    /// Cloud synchronization must never resolve an incoming note ID globally:
    /// a duplicate/malicious remote ID from another notebook must not remove
    /// that notebook's local file.
    pub fn delete_memo_result_for_notebook_id(
        &self,
        notebook_id: &str,
        id: &str,
    ) -> std::io::Result<bool> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        let Some(memo) = self.read_memo_for_notebook_id(notebook_id, id) else {
            return Ok(false);
        };
        let base = self
            .memo_base_for_notebook_id_result(notebook_id)
            .map_err(std::io::Error::other)?;
        let path = notebook_path_from_relative(&base, &memo.relative_path)
            .map_err(std::io::Error::other)?;
        if path.exists() {
            fs::remove_file(&path)?;
        }
        MemoFile::sync_index_on_delete_for_notebook_id_locked(self, notebook_id, id)?;
        Ok(true)
    }
}
