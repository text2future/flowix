use super::*;

impl MemoFile {
    /// 移动 subtag: 把 `old_path` 整棵子树重命名 (含 prefix 替换),
    /// 批量改写所有受影响 memo 的 frontmatter `tags` + 同步 memo index。
    ///
    /// **语义**:
    /// - `old_path` 自身: 重命名为 `new_path`。
    /// - `old_path/<...>` 子树 (任意深度): 全部重命名, 把 `old_path/`
    ///   前缀替换为 `new_path/`, 子段保持不变。
    /// - 其它 YAML tag 与正文（包括正文中的 `#tag` 引用）保持不变。
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
    pub fn ensure_tag_union_index_for_notebook_id(
        &self,
        notebook_id: &str,
    ) -> std::io::Result<usize> {
        const MIGRATION_KEY: &str = "yaml-body-tag-union-index";
        const MIGRATION_VERSION: u32 = 1;

        let _guard = self
            .current_index_io
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self
            .notebook_data_migration_version(notebook_id, MIGRATION_KEY)?
            .unwrap_or_default()
            >= MIGRATION_VERSION
        {
            return Ok(0);
        }

        let base = self
            .memo_base_for_notebook_id_result(notebook_id)
            .map_err(std::io::Error::other)?;
        let entries = self
            .read_index_for_notebook_id(Some(notebook_id))?
            .unwrap_or_default()
            .memos;
        let mut updated = 0usize;
        for entry in entries {
            let path = super::super::notebook_path_from_relative(&base, &entry.relative_path)
                .map_err(std::io::Error::other)
                .unwrap_or_else(|_| base.join(&entry.filename));
            let content = match std::fs::read_to_string(&path) {
                Ok(content) => content,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    tracing::debug!(
                        notebook = %notebook_id,
                        path = %path.display(),
                        "skip tag migration for missing memo file"
                    );
                    continue;
                }
                Err(error) => return Err(error),
            };
            let before = entry.tags.clone();
            let mut memo = MemoFile::index_entry_to_memo(&entry);
            apply_derived_memo_fields(&mut memo, &content);
            if memo.tags != before {
                MemoFile::sync_index_on_write_for_notebook_id_locked(self, notebook_id, &memo)?;
                updated += 1;
            }
        }

        self.mark_notebook_data_migration(notebook_id, MIGRATION_KEY, MIGRATION_VERSION)?;
        Ok(updated)
    }

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
        let old_path = match super::super::derivation::normalize_tag_path(old_path) {
            Some(p) => p,
            None => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("invalid old path: {old_path}"),
                ));
            }
        };
        let new_path = match super::super::derivation::normalize_tag_path(new_path) {
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
        if new_path.starts_with(&(old_path.clone() + "/")) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "cannot move a tag inside its own subtree",
            ));
        }

        // 3. 解析目标 notebook
        let notebook_id_owned = notebook_id
            .map(str::to_string)
            .unwrap_or_else(|| self.current_notebook_id_for_index());

        // 4. 冲突检查: new_path 在该 notebook 是否已存在
        let conn = self.open_memo_index_db()?;
        let prefix = format!("{old_path}/");
        let mut catalog_stmt = conn
            .prepare(
                "SELECT path FROM notebook_tags
                 WHERE notebook_id = ?1
                   AND (path = ?2 OR path LIKE ?3 ESCAPE '\\')
                 ORDER BY length(path) ASC, path ASC",
            )
            .map_err(sqlite_to_io)?;
        let catalog_paths: Vec<String> = catalog_stmt
            .query_map(
                rusqlite::params![&notebook_id_owned, &old_path, format!("{prefix}%")],
                |row| row.get(0),
            )
            .map_err(sqlite_to_io)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_to_io)?;
        drop(catalog_stmt);
        if catalog_paths.is_empty() {
            return Ok(MoveTagReport::default());
        }
        let renamed_catalog_paths: Vec<(String, String)> = catalog_paths
            .iter()
            .map(|path| {
                let suffix = path.strip_prefix(&old_path).unwrap_or_default();
                (path.clone(), format!("{new_path}{suffix}"))
            })
            .collect();
        let moving_paths: std::collections::HashSet<&str> =
            catalog_paths.iter().map(String::as_str).collect();
        for (_, target) in &renamed_catalog_paths {
            let collision: Option<String> = conn
                .query_row(
                    "SELECT path FROM notebook_tags
                     WHERE notebook_id = ?1 AND path = ?2 LIMIT 1",
                    rusqlite::params![&notebook_id_owned, target],
                    |row| row.get(0),
                )
                .optional()
                .map_err(sqlite_to_io)?;
            if collision
                .as_deref()
                .is_some_and(|path| !moving_paths.contains(path))
            {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!("target tag already exists in notebook: {target}"),
                ));
            }
        }

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

        // 6. 逐 memo 改写 YAML 与正文中的真实标签来源，再同步并集索引。
        let mut report = MoveTagReport {
            renamed_tags: renamed_catalog_paths.clone(),
            ..Default::default()
        };
        let mut renamed_seen: std::collections::HashSet<(String, String)> =
            report.renamed_tags.iter().cloned().collect();
        for memo_id in &affected_ids {
            let location = self.resolve_memo_location(memo_id)?.ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("memo {memo_id} not found"),
                )
            })?;
            let path = super::super::notebook_path_from_relative(
                &std::path::PathBuf::from(&location.notebook.path),
                &location.memo.relative_path,
            )
            .unwrap_or_else(|_| {
                std::path::PathBuf::from(&location.notebook.path).join(&location.memo.filename)
            });
            let content = std::fs::read_to_string(&path)?;
            let metadata = extract_document_metadata(&content).map_err(|error| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string())
            })?;
            let mut yaml_changed = false;
            let next_tags: Vec<String> = metadata
                .tags
                .iter()
                .map(|tag| {
                    let next = if tag == &old_path {
                        new_path.clone()
                    } else if let Some(suffix) = tag.strip_prefix(&prefix) {
                        format!("{new_path}/{suffix}")
                    } else {
                        tag.clone()
                    };
                    yaml_changed |= next != *tag;
                    next
                })
                .collect();
            let content_with_body = super::super::derivation::rewrite_body_tag_path(
                &content,
                &old_path,
                Some(&new_path),
            );
            let body_changed = content_with_body != content;
            if !yaml_changed && !body_changed {
                continue;
            }
            let content_with_tags = if yaml_changed {
                replace_frontmatter_tags(&content_with_body, &next_tags).map_err(|error| {
                    std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string())
                })?
            } else {
                content_with_body
            };

            // 改写前的 memo 快照: on_after_write 把它交回调用方, 用于 emit
            // memo-event 时算 derived_changed (before -> after)。
            let before_memo = MemoFile::index_entry_to_memo(&location.memo);

            // 收集实际改写涉及的 (old, new) 路径对, 用于报告
            for old_tag in &location.memo.tags {
                let new_tag = if old_tag == &old_path {
                    Some(new_path.clone())
                } else {
                    old_tag
                        .strip_prefix(&prefix)
                        .map(|suffix| format!("{new_path}/{suffix}"))
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
            let merged = merge_frontmatter(&content_with_tags, &overrides);

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

        let mut catalog_conn = self.open_memo_index_db()?;
        let catalog_tx = catalog_conn.transaction().map_err(sqlite_to_io)?;
        for old in &catalog_paths {
            catalog_tx
                .execute(
                    "DELETE FROM notebook_tags WHERE notebook_id = ?1 AND path = ?2",
                    rusqlite::params![&notebook_id_owned, old],
                )
                .map_err(sqlite_to_io)?;
        }
        let now = chrono::Utc::now().timestamp_millis();
        for (_, new) in &renamed_catalog_paths {
            catalog_tx
                .execute(
                    "INSERT OR REPLACE INTO notebook_tags
                        (notebook_id, path, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?3)",
                    rusqlite::params![&notebook_id_owned, new, now],
                )
                .map_err(sqlite_to_io)?;
        }
        catalog_tx.commit().map_err(sqlite_to_io)?;

        Ok(report)
    }

    /// Delete tag: remove `tag_path` itself + all subtree tags (any depth
    /// under `tag_path/`) from YAML, body tokens, and the memo index.
    ///
    /// Semantics:
    /// - `tag_path` itself: removed from `memo_tags`, YAML, and body tokens.
    /// - `tag_path/<...>` subtree (any depth): all of them are removed in
    ///   one shot from both sources and the derived index.
    /// - Other tags and non-tag body text are untouched.
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
    pub fn delete_memo_tag_locked_with_hooks<F, G>(
        &self,
        notebook_id: Option<&str>,
        tag_path: &str,
        on_before_write: F,
        mut on_after_write: G,
    ) -> std::io::Result<DeleteTagReport>
    where
        F: Fn(&Path),
        G: FnMut(&str, &Memo),
    {
        let _index_io_guard = self.current_index_io.lock().expect("index_io poisoned");

        // 1. validate + normalise
        let tag_path = match super::super::derivation::normalize_tag_path(tag_path) {
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
                "SELECT path FROM notebook_tags
                 WHERE notebook_id = ?1
                   AND (path = ?2 OR path LIKE ?3 ESCAPE '\\')
                 ORDER BY length(path) DESC, path ASC",
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

        // 5. Per-memo YAML/body tag rewrite + union index sync.
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
            let path = super::super::notebook_path_from_relative(
                &std::path::PathBuf::from(&location.notebook.path),
                &location.memo.relative_path,
            )
            .unwrap_or_else(|_| {
                std::path::PathBuf::from(&location.notebook.path).join(&location.memo.filename)
            });
            let before_memo = MemoFile::index_entry_to_memo(&location.memo);
            let content = std::fs::read_to_string(&path)?;
            let metadata = extract_document_metadata_preserving_invalid_tag_paths(&content)
                .map_err(|error| {
                    std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string())
                })?;
            let next_tags: Vec<String> = metadata
                .tags
                .iter()
                .filter(|tag| *tag != &tag_path && !tag.starts_with(&prefix))
                .cloned()
                .collect();
            let yaml_changed = next_tags != metadata.tags;
            let content_with_body =
                super::super::derivation::rewrite_body_tag_path(&content, &tag_path, None);
            let body_changed = content_with_body != content;
            if !yaml_changed && !body_changed {
                // A stale index row is repaired without changing the document.
                let mut memo = MemoFile::index_entry_to_memo(&location.memo);
                apply_derived_memo_fields(&mut memo, &content);
                MemoFile::sync_index_on_write_for_notebook_id_locked(
                    self,
                    &location.notebook.id,
                    &memo,
                )?;
                continue;
            }
            let content_with_tags = if yaml_changed {
                replace_frontmatter_tags_preserving_invalid_paths(&content_with_body, &next_tags)
                    .map_err(|error| {
                        std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string())
                    })?
            } else {
                content_with_body
            };

            let overrides: MergeOverrides =
                [("key".to_string(), memo_id.clone())].into_iter().collect();
            let merged = merge_frontmatter(&content_with_tags, &overrides);

            // notify caller to mark_self_write -- otherwise the watcher
            // would mistake this for an external edit and emit a wave of
            // reload events.
            on_before_write(&path);

            atomic_write_bytes(&path, merged.as_bytes())?;

            // Re-derive the YAML/body union and prune deleted index rows.
            let mut memo = before_memo.clone();
            apply_derived_memo_fields(&mut memo, &merged);
            memo.updated_at = chrono::Utc::now().timestamp_millis();
            MemoFile::sync_index_on_write_for_notebook_id_locked(
                self,
                &location.notebook.id,
                &memo,
            )?;

            on_after_write(memo_id, &before_memo);
            report.affected_memos += 1;
        }

        let mut catalog_conn = self.open_memo_index_db()?;
        let catalog_tx = catalog_conn.transaction().map_err(sqlite_to_io)?;
        for deleted in &report.deleted_tags {
            catalog_tx
                .execute(
                    "DELETE FROM notebook_tags WHERE notebook_id = ?1 AND path = ?2",
                    rusqlite::params![&notebook_id_owned, deleted],
                )
                .map_err(sqlite_to_io)?;
        }
        catalog_tx.commit().map_err(sqlite_to_io)?;

        Ok(report)
    }
}
