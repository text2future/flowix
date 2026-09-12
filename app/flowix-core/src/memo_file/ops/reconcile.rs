use super::*;

impl MemoFile {
    /// 启动 / 切 notebook 时调用: 递归扫描 notebook 内 .md, 把 memo index 没记录的补进来。
    /// **不**重命名磁盘文件, 保留外部工具的句柄。
    /// 跳过 notebook 内部目录; 已在 memo index 里的 .md 跳过 (按 filename 精确比对)。
    pub fn reconcile_with_disk(&self) -> Result<usize, String> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");

        let base = self.get_memo_base();
        if !base.exists() {
            return Ok(0);
        }
        let mut markdown_paths = Vec::new();
        collect_markdown_paths(&base, &base, &mut markdown_paths)?;

        let known_paths: std::collections::HashSet<String> = self
            .read_index()
            .map(|l| {
                l.memos
                    .into_iter()
                    .map(|e| {
                        if e.relative_path.is_empty() {
                            e.filename
                        } else {
                            e.relative_path
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();

        // 收齐所有候选文件, 排完序再批量注册, 减少锁反复获取。
        let mut to_register: Vec<PathBuf> = Vec::new();
        for path in markdown_paths {
            let relative = notebook_relative_path(&base, &path)?;
            if known_paths.contains(&relative) {
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
        let mut markdown_paths = Vec::new();
        collect_markdown_paths(&base, &base, &mut markdown_paths)?;
        let disk_paths: std::collections::HashSet<String> = markdown_paths
            .iter()
            .map(|path| notebook_relative_path(&base, path))
            .collect::<Result<_, _>>()?;

        // 2. 读 memo index (锁内, 仅用作算 to_register; 注册后会再读一次)
        let initial_list = self.read_index().unwrap_or_default();

        // 3. 算「需要注册」的文件名集合
        let to_register: Vec<String> = disk_paths
            .iter()
            .filter(|path| {
                !initial_list.memos.iter().any(|e| {
                    let indexed = if e.relative_path.is_empty() {
                        &e.filename
                    } else {
                        &e.relative_path
                    };
                    indexed == *path
                })
            })
            .cloned()
            .collect();

        // 4. 串行注册新文件; 单条失败仅记 warn 不中断整批
        let mut added = 0usize;
        for filename in &to_register {
            let path = notebook_path_from_relative(&base, filename)?;
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
        list.memos.retain(|e| {
            let indexed = if e.relative_path.is_empty() {
                &e.filename
            } else {
                &e.relative_path
            };
            disk_paths.contains(indexed)
        });
        let removed = before - list.memos.len();
        if removed > 0 {
            list.last_updated = chrono::Utc::now().timestamp_millis();
            self.write_index(&list)
                .map_err(|e| format!("write_index failed: {e}"))?;
        }

        Ok(ReconcileReport { added, removed })
    }

    /// Reconcile one configured notebook without changing the current
    /// notebook selection. This is used by recursive file watchers when a
    /// directory-level event does not contain individual child file events.
    pub fn reconcile_notebook_with_disk_bidirectional(
        &self,
        notebook_id: &str,
    ) -> Result<ReconcileReport, String> {
        self.reconcile_notebook_with_disk_bidirectional_inner(notebook_id, true)
    }

    /// Reconcile a newly imported notebook without modifying existing
    /// Markdown files. The index receives generated IDs for documents that do
    /// not already have a Flowix key, but their frontmatter/body is preserved.
    pub fn reconcile_notebook_with_disk_bidirectional_for_import(
        &self,
        notebook_id: &str,
    ) -> Result<ReconcileReport, String> {
        self.reconcile_notebook_with_disk_bidirectional_inner(notebook_id, false)
    }

    fn reconcile_notebook_with_disk_bidirectional_inner(
        &self,
        notebook_id: &str,
        stamp_missing_key: bool,
    ) -> Result<ReconcileReport, String> {
        let base = self.memo_base_for_notebook_id_result(notebook_id)?;
        if !base.exists() {
            return Ok(ReconcileReport::default());
        }

        let mut markdown_paths = Vec::new();
        collect_markdown_paths(&base, &base, &mut markdown_paths)?;
        let disk_paths: std::collections::HashSet<String> = markdown_paths
            .iter()
            .map(|path| notebook_relative_path(&base, path))
            .collect::<Result<_, _>>()?;
        let initial = self
            .read_index_for_notebook_id(Some(notebook_id))
            .map_err(|error| format!("read_index failed: {error}"))?
            .unwrap_or_default();
        let known: std::collections::HashSet<String> = initial
            .memos
            .iter()
            .map(|entry| {
                if entry.relative_path.is_empty() {
                    entry.filename.clone()
                } else {
                    entry.relative_path.clone()
                }
            })
            .collect();

        let mut added = 0;
        for relative_path in disk_paths.difference(&known) {
            let path = notebook_path_from_relative(&base, relative_path)?;
            let registered = if stamp_missing_key {
                self.register_existing_file_for_notebook_id(notebook_id, &path)
            } else {
                self.register_existing_file_for_notebook_id_without_frontmatter(notebook_id, &path)
            };
            match registered {
                Ok(_) => added += 1,
                Err(error) => tracing::warn!(
                    notebook_id,
                    relative_path,
                    %error,
                    "directory reconciliation could not register note"
                ),
            }
        }

        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        let mut current = self
            .read_index_for_notebook_id(Some(notebook_id))
            .map_err(|error| format!("read_index failed: {error}"))?
            .unwrap_or_default();
        let before = current.memos.len();
        current.memos.retain(|entry| {
            let relative_path = if entry.relative_path.is_empty() {
                &entry.filename
            } else {
                &entry.relative_path
            };
            disk_paths.contains(relative_path)
        });
        let removed = before - current.memos.len();
        if removed > 0 {
            current.last_updated = chrono::Utc::now().timestamp_millis();
            self.write_index_for_notebook_id(notebook_id, &current)
                .map_err(|error| format!("write_index failed: {error}"))?;
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

        let mut markdown_paths = Vec::new();
        collect_markdown_paths(&base, &base, &mut markdown_paths)?;
        let disk_paths: std::collections::HashSet<String> = markdown_paths
            .iter()
            .map(|path| notebook_relative_path(&base, path))
            .collect::<Result<_, _>>()?;

        let initial_list = self.read_index().unwrap_or_default();
        let to_register: Vec<String> = disk_paths
            .iter()
            .filter(|path| {
                !initial_list.memos.iter().any(|e| {
                    let indexed = if e.relative_path.is_empty() {
                        &e.filename
                    } else {
                        &e.relative_path
                    };
                    indexed == *path
                })
            })
            .cloned()
            .collect();

        let mut added = 0usize;
        for filename in &to_register {
            let path = notebook_path_from_relative(&base, filename)?;
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
        list.memos.retain(|e| {
            let indexed = if e.relative_path.is_empty() {
                &e.filename
            } else {
                &e.relative_path
            };
            disk_paths.contains(indexed)
        });
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
            .find_memo_by_relative_path_for_notebook_id(notebook_id, filename)
            .ok_or_else(|| format!("memo with filename {filename} not in memo index"))?;
        self.reload_memo_inner_for_notebook_id_locked(notebook_id, memo)
    }

    pub(super) fn reload_memo_inner_locked(&self, mut memo: Memo) -> Result<Memo, String> {
        let path = notebook_path_from_relative(&self.get_memo_base(), &memo.relative_path)?;
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        memo.updated_at = chrono::Utc::now().timestamp_millis();
        apply_derived_memo_fields(&mut memo, &content);
        MemoFile::sync_index_on_write_locked(self, &memo)
            .map_err(|e| format!("sync memo index failed: {e}"))?;
        Ok(memo)
    }

    pub(super) fn reload_memo_inner_for_notebook_id_locked(
        &self,
        notebook_id: &str,
        mut memo: Memo,
    ) -> Result<Memo, String> {
        let base = self.memo_base_for_notebook_id_result(notebook_id)?;
        let path = notebook_path_from_relative(&base, &memo.relative_path)?;
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

    pub fn find_memo_by_relative_path(&self, relative_path: &str) -> Option<Memo> {
        let list = self.read_index()?;
        list.memos
            .into_iter()
            .find(|e| {
                e.relative_path == relative_path
                    || (e.relative_path.is_empty() && e.filename == relative_path)
            })
            .map(|e| MemoFile::index_entry_to_memo(&e))
    }

    pub fn find_memo_by_relative_path_for_notebook_id(
        &self,
        notebook_id: &str,
        relative_path: &str,
    ) -> Option<Memo> {
        let list = self.read_index_for_notebook_id(Some(notebook_id)).ok()??;
        list.memos
            .into_iter()
            .find(|e| {
                e.relative_path == relative_path
                    || (e.relative_path.is_empty() && e.filename == relative_path)
            })
            .map(|e| MemoFile::index_entry_to_memo(&e))
    }

    /// 按 id 找 memo 物理文件绝对路径。文件可能已不在 (返回路径不保证存在)。
    pub fn find_memo_file_path(&self, id: &str) -> Option<PathBuf> {
        let location = self.resolve_memo_location(id).ok().flatten()?;
        Some(
            notebook_path_from_relative(
                &PathBuf::from(location.notebook.path),
                &location.memo.relative_path,
            )
            .ok()?,
        )
    }

    /// 按 filename 拼绝对路径。
    pub fn file_path_for(&self, filename: &str) -> PathBuf {
        self.get_memo_base().join(filename)
    }

    fn persist_memo_metadata_to_markdown(
        &self,
        notebook_id: &str,
        memo: &Memo,
    ) -> std::io::Result<Memo> {
        let base = self
            .memo_base_for_notebook_id_result(notebook_id)
            .map_err(std::io::Error::other)?;
        let path = notebook_path_from_relative(&base, &memo.relative_path)
            .map_err(std::io::Error::other)?;
        let content = fs::read_to_string(&path)?;
        let content = replace_frontmatter_tags(&content, &memo.tags)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
        let colors = serde_json::to_string(&memo.colors).map_err(std::io::Error::other)?;
        let icon = serde_json::to_string(&memo.icon).map_err(std::io::Error::other)?;
        let mut overrides: MergeOverrides = [
            ("flowix_favorited".to_string(), memo.favorited.to_string()),
            ("flowix_icon".to_string(), icon),
            ("flowix_colors".to_string(), colors),
        ]
        .into_iter()
        .collect();
        if let serde_json::Value::Object(properties) = &memo.properties {
            for (key, value) in properties {
                if matches!(
                    key.as_str(),
                    "key" | "tag" | "tags" | "flowix_favorited" | "flowix_icon" | "flowix_colors"
                ) {
                    continue;
                }
                overrides.insert(
                    key.clone(),
                    serde_json::to_string(value).map_err(std::io::Error::other)?,
                );
            }
        }
        let updated_content = merge_frontmatter(&content, &overrides);
        atomic_write_bytes(&path, updated_content.as_bytes())?;
        let mut rebuilt = memo.clone();
        apply_derived_memo_fields(&mut rebuilt, &updated_content);
        Ok(rebuilt)
    }

    /// Persist user-visible metadata into Markdown frontmatter, then refresh
    /// the derived SQLite cache. Deleting the cache must never lose metadata.
    pub fn sync_metadata_only(&self, memo: &Memo) -> std::io::Result<()> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        let notebook_id = self.current_notebook_id_for_index();
        let rebuilt = self.persist_memo_metadata_to_markdown(&notebook_id, memo)?;
        MemoFile::sync_index_on_write_locked(self, &rebuilt)
    }

    pub fn sync_metadata_only_global(&self, memo: &Memo) -> std::io::Result<()> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        let notebook_id = self
            .resolve_memo_location(&memo.id)?
            .map(|location| location.notebook.id)
            .unwrap_or_else(|| self.current_notebook_id_for_index());
        let rebuilt = self.persist_memo_metadata_to_markdown(&notebook_id, memo)?;
        MemoFile::sync_index_on_write_for_notebook_id_locked(self, &notebook_id, &rebuilt)
    }

    /// 按绝对路径找 memo index entry 并移除 (memo index 同步)。物理文件删除由 caller 负责。
    /// 防御性 invariant guard: entry.filename 拼出的绝对路径规范化后, 跟 `abs_path`
    /// 规范化相等才删 (避免 rename 旧文件 Remove 事件误删 entry)。
    pub fn unregister_memo_by_path(&self, abs_path: &Path) -> bool {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        let base = self.get_memo_base();
        let Ok(relative_path) = notebook_relative_path(&base, abs_path) else {
            return false;
        };
        let Some(memo) = self.find_memo_by_relative_path(&relative_path) else {
            return false;
        };
        let Ok(expected_abs) = notebook_path_from_relative(&base, &memo.relative_path) else {
            return false;
        };
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
        let Ok(base) = self.memo_base_for_notebook_id_result(notebook_id) else {
            return false;
        };
        let Ok(relative_path) = notebook_relative_path(&base, abs_path) else {
            return false;
        };
        let Some(memo) =
            self.find_memo_by_relative_path_for_notebook_id(notebook_id, &relative_path)
        else {
            return false;
        };
        let Ok(expected_abs) = notebook_path_from_relative(&base, &memo.relative_path) else {
            return false;
        };
        if normalize_for_compare(&expected_abs) != normalize_for_compare(abs_path) {
            // 对齐 Create 路径 (save_registered_memo) 的设计: filename 已在
            // notebook 内反查命中 = 唯一 memo, 此处 `normalize` 不一致多源自
            // macOS /var vs /private/var / 大小写 / trailing slash 等表示差异,
            // 不应阻断 watcher Remove -> emit Deleted (否则外部 rm / claude code
            // 删除不会更新 memo list, 与 Create 走 watcher 正常工作的不对称)。
            // `sync_index_on_delete` 按 memo.id 注销, 与 abs_path 表示无关,
            // 继续 unregister 不存在误删风险。
            tracing::debug!(
                "[watcher-delete] unregister_memo_by_path_for_notebook_id path mismatch (continuing): expected={} actual={}",
                expected_abs.display(),
                abs_path.display()
            );
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

        if !new_path.is_md() {
            return Err(format!("new path is not markdown: {}", new_path.display()));
        }

        let base = PathBuf::from(&location.notebook.path);
        let new_relative_path = notebook_relative_path(&base, new_path)?;
        let new_filename = filename_from_notebook_relative_path(&new_relative_path);
        let expected_new_abs = notebook_path_from_relative(&base, &new_relative_path)?;
        if normalize_for_compare(&expected_new_abs) != normalize_for_compare(new_path) {
            return Err(format!(
                "new path not under memo notebook base: {}",
                new_path.display()
            ));
        }

        let current_relative_path = location.memo.relative_path.clone();
        if current_relative_path != new_relative_path {
            let old_abs = notebook_path_from_relative(&base, &current_relative_path)?;
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
            .find(|entry| entry.relative_path == new_relative_path && entry.id != id)
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
        memo.relative_path = new_relative_path;
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

        if !new_path.is_md() {
            return Err(format!("new path is not markdown: {}", new_path.display()));
        }

        let base = self.memo_base_for_notebook_id_result(notebook_id)?;
        let new_relative_path = notebook_relative_path(&base, new_path)?;
        let new_filename = filename_from_notebook_relative_path(&new_relative_path);
        let expected_new_abs = notebook_path_from_relative(&base, &new_relative_path)?;
        if normalize_for_compare(&expected_new_abs) != normalize_for_compare(new_path) {
            return Err(format!(
                "new path not under memo notebook base: {}",
                new_path.display()
            ));
        }

        if existing.relative_path != new_relative_path {
            let old_abs = notebook_path_from_relative(&base, &existing.relative_path)?;
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
            .find(|entry| entry.relative_path == new_relative_path && entry.id != id)
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
        memo.relative_path = new_relative_path;
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

        let base = self.get_memo_base();
        let old_relative_path = notebook_relative_path(&base, old_path)?;
        let new_relative_path = notebook_relative_path(&base, new_path)?;

        // 1. 找旧 entry
        let mut memo = match self.find_memo_by_relative_path(&old_relative_path) {
            Some(m) => m.clone(),
            None => return Err(format!("old path not in memo index: {old_relative_path}")),
        };
        let id = memo.id.clone();

        // 2. 旧路径在不在当前 notebook base 下 (规范化检查)
        let expected_old_abs = notebook_path_from_relative(&base, &old_relative_path)?;
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
        if let Some(existing) = self.find_memo_by_relative_path(&new_relative_path) {
            if existing.id != id {
                return Err(format!(
                    "new filename already occupied by another memo (id={})",
                    existing.id
                ));
            }
        }

        // 5. 改 entry.filename + 重新派生 preview / tags / todos (frontmatter 跟着物理文件
        //    一起被 mv 搬过来了, 重新读)
        memo.filename = filename_from_notebook_relative_path(&new_relative_path);
        memo.relative_path = new_relative_path;
        let new_abs = notebook_path_from_relative(&base, &memo.relative_path)?;
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

    /// Move one indexed memo into an existing notebook directory while keeping
    /// its frontmatter key and memo id unchanged.
    pub fn move_memo_to_directory_for_notebook_id(
        &self,
        notebook_id: &str,
        memo_id: &str,
        parent_relative_path: &str,
    ) -> Result<(Memo, PathBuf, PathBuf), String> {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");
        let base = self.memo_base_for_notebook_id_result(notebook_id)?;
        let memo = self
            .read_memo_for_notebook_id(notebook_id, memo_id)
            .ok_or_else(|| format!("memo id not in notebook {notebook_id}: {memo_id}"))?;
        let old_path = notebook_path_from_relative(&base, &memo.relative_path)?;
        let parent = if parent_relative_path.trim().is_empty() {
            base.clone()
        } else {
            notebook_path_from_relative(&base, parent_relative_path)?
        };
        if !parent.is_dir() {
            return Err(format!("memo destination directory does not exist: {}", parent.display()));
        }
        let destination_relative = if parent_relative_path.trim().is_empty() {
            memo.filename.clone()
        } else {
            format!("{parent_relative_path}/{filename}", filename = memo.filename)
        };
        if !parent_relative_path.trim().is_empty()
            && is_internal_notebook_path(Path::new(parent_relative_path))
        {
            return Err("memo destination is an internal notebook directory".to_string());
        }
        let new_path = notebook_path_from_relative(&base, &destination_relative)?;
        if old_path == new_path {
            return Ok((memo, old_path, new_path));
        }
        if new_path.exists() {
            return Err(format!(
                "FILE_EXISTS: destination file already exists: {}",
                new_path.display()
            ));
        }

        fs::rename(&old_path, &new_path).map_err(|error| format!("move memo failed: {error}"))?;
        match self.rename_memo_file_for_notebook_id_locked(notebook_id, &old_path, &new_path) {
            Ok(moved) => Ok((moved, old_path, new_path)),
            Err(error) => {
                let _ = fs::rename(&new_path, &old_path);
                Err(error)
            }
        }
    }

    pub(super) fn rename_memo_file_for_notebook_id_locked(
        &self,
        notebook_id: &str,
        old_path: &Path,
        new_path: &Path,
    ) -> Result<Memo, String> {
        let base = self.memo_base_for_notebook_id_result(notebook_id)?;
        let old_relative_path = notebook_relative_path(&base, old_path)?;
        let new_relative_path = notebook_relative_path(&base, new_path)?;

        let mut memo = match self
            .find_memo_by_relative_path_for_notebook_id(notebook_id, &old_relative_path)
        {
            Some(m) => m,
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

        if let Some(existing) =
            self.find_memo_by_relative_path_for_notebook_id(notebook_id, &new_relative_path)
        {
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
        memo.updated_at = chrono::Utc::now().timestamp_millis();

        MemoFile::sync_index_on_write_for_notebook_id_locked(self, notebook_id, &memo)
            .map_err(|e| format!("sync memo index failed: {e}"))?;
        Ok(memo)
    }
}

fn is_internal_notebook_path(path: &Path) -> bool {
    is_ignored_notebook_relative_path(path)
}

fn collect_markdown_paths(
    base: &Path,
    directory: &Path,
    output: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let entries = fs::read_dir(directory).map_err(|e| format!("read_dir failed: {e}"))?;
    for entry in entries.filter_map(|entry| entry.ok()) {
        let path = entry.path();
        if is_internal_notebook_path(path.strip_prefix(base).unwrap_or(&path)) {
            continue;
        }
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            if let Err(error) = collect_markdown_paths(base, &path, output) {
                tracing::warn!(
                    path = %path.display(),
                    %error,
                    "skipping unreadable notebook subdirectory"
                );
            }
        } else if entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false)
            && path.is_md()
        {
            output.push(path);
        }
    }
    if directory == base {
        output.sort();
    }
    Ok(())
}
