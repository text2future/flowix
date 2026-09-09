use super::*;

impl MemoFile {
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
        let base = self.get_memo_base();
        let relative_path = notebook_relative_path(&base, abs_path)?;
        let filename = filename_from_notebook_relative_path(&relative_path);

        if let Some(memo) = self.find_memo_by_relative_path(&relative_path) {
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
        if let Some(existing_id) = super::super::frontmatter::extract_frontmatter_key(&content) {
            if let Some(existing_memo) = self.read_current_memo(&existing_id) {
                if existing_memo.relative_path != relative_path {
                    // (a) 走 rename_memo_file 改 entry.filename, id 保留
                    drop(_index_io_guard);
                    return self.rename_memo_file(
                        &notebook_path_from_relative(&base, &existing_memo.relative_path)?,
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
                relative_path: relative_path.clone(),
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
            relative_path: relative_path.clone(),
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

    pub(super) fn register_existing_file_as_new_locked(
        &self,
        abs_path: &Path,
    ) -> Result<Memo, String> {
        if !abs_path.is_md() {
            return Err(format!("not a markdown file: {}", abs_path.display()));
        }
        if !abs_path.exists() {
            return Err(format!("file not found: {}", abs_path.display()));
        }
        let base = self.get_memo_base();
        let relative_path = notebook_relative_path(&base, abs_path)?;
        let filename = filename_from_notebook_relative_path(&relative_path);

        if let Some(memo) = self.find_memo_by_relative_path(&relative_path) {
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
            relative_path,
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
        let base = self.memo_base_for_notebook_id_result(notebook_id)?;
        let relative_path = notebook_relative_path(&base, abs_path)?;
        let filename = filename_from_notebook_relative_path(&relative_path);

        if let Some(memo) =
            self.find_memo_by_relative_path_for_notebook_id(notebook_id, &relative_path)
        {
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
            relative_path,
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
        let base = self.memo_base_for_notebook_id_result(notebook_id)?;
        let relative_path = notebook_relative_path(&base, abs_path)?;
        let filename = filename_from_notebook_relative_path(&relative_path);

        if let Some(memo) =
            self.find_memo_by_relative_path_for_notebook_id(notebook_id, &relative_path)
        {
            return self.reload_memo_inner_for_notebook_id_locked(notebook_id, memo);
        }

        let content = fs::read_to_string(abs_path).map_err(|e| e.to_string())?;
        if let Some(existing_id) = super::super::frontmatter::extract_frontmatter_key(&content) {
            if let Some(existing_memo) = self.read_memo_for_notebook_id(notebook_id, &existing_id) {
                if existing_memo.relative_path != relative_path {
                    return self.rename_memo_file_for_notebook_id_locked(
                        notebook_id,
                        &notebook_path_from_relative(&base, &existing_memo.relative_path)?,
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
                relative_path: relative_path.clone(),
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
            relative_path: relative_path.clone(),
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
    pub(super) fn register_existing_file_locked(&self, abs_path: &Path) -> Result<Memo, String> {
        if !abs_path.is_md() {
            return Err(format!("not a markdown file: {}", abs_path.display()));
        }
        if !abs_path.exists() {
            return Err(format!("file not found: {}", abs_path.display()));
        }
        let base = self.get_memo_base();
        let relative_path = notebook_relative_path(&base, abs_path)?;
        let filename = filename_from_notebook_relative_path(&relative_path);

        let content = fs::read_to_string(abs_path).map_err(|e| e.to_string())?;
        if let Some(existing_id) = super::super::frontmatter::extract_frontmatter_key(&content) {
            if let Some(existing_memo) = self.read_current_memo(&existing_id) {
                // 调用方已保证 filename 不在 memo index; 如果这里命中 read_memo,
                // 说明 entry 的 filename 跟当前不一致 (inode-tracker 漏命中场景),
                // 走 rename_memo_file_locked 保留 id, 改 entry.filename 为当前 filename。
                return self.rename_memo_file_locked(
                    &notebook_path_from_relative(&base, &existing_memo.relative_path)?,
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
                relative_path: relative_path.clone(),
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
            relative_path: relative_path.clone(),
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
        let base = self.get_memo_base();
        let old_relative_path = notebook_relative_path(&base, old_path)?;
        let new_relative_path = notebook_relative_path(&base, new_path)?;
        let mut memo = match self.find_memo_by_relative_path(&old_relative_path) {
            Some(m) => m.clone(),
            None => return Err(format!("old path not in memo index: {old_relative_path}")),
        };
        let id = memo.id.clone();

        let expected_old_abs = notebook_path_from_relative(&base, &old_relative_path)?;
        if normalize_for_compare(&expected_old_abs) != normalize_for_compare(old_path) {
            return Err(format!(
                "old path not under notebook base: {}",
                old_path.display()
            ));
        }

        if !new_path.is_md() {
            return Err(format!("new path is not markdown: {}", new_path.display()));
        }

        if let Some(existing) = self.find_memo_by_relative_path(&new_relative_path) {
            if existing.id != id {
                return Err(format!(
                    "new filename already occupied by another memo (id={})",
                    existing.id
                ));
            }
        }

        memo.filename = filename_from_notebook_relative_path(&new_relative_path);
        memo.relative_path = new_relative_path;
        let new_abs = notebook_path_from_relative(&base, &memo.relative_path)?;
        let content = std::fs::read_to_string(&new_abs)
            .map_err(|e| format!("failed to read new path {}: {e}", new_abs.display()))?;
        apply_derived_memo_fields(&mut memo, &content);
        let now = chrono::Utc::now().timestamp_millis();
        memo.updated_at = now;

        MemoFile::sync_index_on_write_locked(self, &memo)
            .map_err(|e| format!("sync memo index failed: {e}"))?;
        Ok(memo)
    }
}
