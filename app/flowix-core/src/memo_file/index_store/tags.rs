use super::*;

type TagUsageSummary = (Vec<String>, Vec<(String, usize)>, usize, usize, usize);

impl MemoFile {
    pub fn read_used_tag_ids(&self) -> std::io::Result<Vec<String>> {
        Ok(self
            .read_tag_usage_summary_for_notebook_id(Some(
                &self.current_notebook_id_for_index(),
            ))?
            .1
            .into_iter()
            .map(|(tag, _)| tag)
            .collect())
    }

    pub fn read_notebook_tag_paths(
        &self,
        notebook_id: Option<&str>,
    ) -> std::io::Result<Vec<String>> {
        let notebook_id = self.notebook_id_for_index(notebook_id);
        let conn = self.open_memo_index_db_for_notebook_id(&notebook_id)?;
        let mut stmt = conn
            .prepare(
                "SELECT path
                 FROM notebook_tags
                 WHERE notebook_id = ?1
                 ORDER BY path COLLATE NOCASE ASC, path ASC",
            )
            .map_err(sqlite_to_io)?;
        let rows = stmt
            .query_map(params![notebook_id], |row| row.get::<_, String>(0))
            .map_err(sqlite_to_io)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_to_io)
    }

    pub fn create_notebook_tag(&self, notebook_id: &str, path: &str) -> std::io::Result<String> {
        let path = super::super::derivation::normalize_tag_path(path).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("invalid tag path: {path}"),
            )
        })?;
        if self.get_notebook_config_by_id(notebook_id).is_none() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("notebook not found: {notebook_id}"),
            ));
        }
        let mut conn = self.open_memo_index_db_for_notebook_id(notebook_id)?;
        let now = chrono::Utc::now().timestamp_millis();
        let exists = conn
            .query_row(
                "SELECT 1 FROM notebook_tags
                 WHERE notebook_id = ?1 AND path = ?2
                 LIMIT 1",
                params![notebook_id, path],
                |_| Ok(true),
            )
            .optional()
            .map_err(sqlite_to_io)?
            .unwrap_or(false);
        if exists {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                format!("tag already exists in notebook: {path}"),
            ));
        }
        let tx = conn.transaction().map_err(sqlite_to_io)?;
        for prefix in tag_path_prefixes(&path) {
            tx.execute(
                "INSERT OR IGNORE INTO notebook_tags
                    (notebook_id, path, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?3)",
                params![notebook_id, prefix, now],
            )
            .map_err(sqlite_to_io)?;
        }
        tx.commit().map_err(sqlite_to_io)?;
        Ok(path)
    }

    pub fn read_used_tag_ids_for_notebook_id(
        &self,
        notebook_id: Option<&str>,
    ) -> std::io::Result<Vec<String>> {
        Ok(self
            .read_tag_usage_summary_for_notebook_id(notebook_id)?
            .1
            .into_iter()
            .map(|(tag, _)| tag)
            .collect())
    }

    pub fn read_tag_usage_summary_for_notebook_id(
        &self,
        notebook_id: Option<&str>,
    ) -> std::io::Result<TagUsageSummary> {
        let notebook_id = self.notebook_id_for_index(notebook_id);
        if !self.note_index_is_ready(&notebook_id)? {
            // Cold start: rebuild the rebuildable projection instead of
            // reading the legacy ID-keyed cache. The summary is an active
            // request, so wait for the maintenance lock rather than skipping.
            let _ = self.reconcile_note_index_blocking(&notebook_id);
        }
        self.note_tag_usage_summary(&notebook_id)
    }


    /// 路径式 tag 的 prefix → 去重 memo 数。每个真实 tag `T` 拆出
    /// 所有前缀 (`T` 自身 + `T` 的每级祖先 fullPath), 然后每个 prefix
    /// 收集所有"挂载了 T 的 memo id", 取 set 长度 (即有任意 tag
    /// 落在 prefix 之下的 distinct memo 数)。
    ///
    /// **为什么需要**: 之前侧栏 tree 用 `tagCounts` 累加, 一个 memo
    /// 既有 `#中国/湖南` 又有 `#中国/广东` 会被 `中国` 节点算两次。
    /// 现在用 distinct memo_id, 1 个 memo 即使挂了多个子 tag, 父节点
    /// 也只算 1。
    ///
    /// O(N×L) where N = (tag, memo) pairs, L = 平均路径深度。典型
    /// 库 (10K memos × 3 tags × depth 2) ~ 60K HashMap insert, 远低于
    /// 1ms, 不需要 SQL 聚合优化。
    pub fn read_tag_prefix_counts_for_notebook_id(
        &self,
        notebook_id: Option<&str>,
    ) -> std::io::Result<std::collections::HashMap<String, usize>> {
        use std::collections::{HashMap, HashSet};

        let notebook_id = self.notebook_id_for_index(notebook_id);
        let pairs: Vec<(String, String)> = if self.note_index_is_ready(&notebook_id)? {
            self.note_tag_path_pairs(&notebook_id)?
        } else {
            let conn = self.open_memo_index_db_for_notebook_id(&notebook_id)?;
            let mut stmt = conn
                .prepare(
                    "SELECT mt.tag, mt.memo_id
                 FROM memo_tags mt
                 JOIN memos m ON m.id = mt.memo_id
                 WHERE m.notebook_id = ?1",
                )
                .map_err(sqlite_to_io)?;
            let collected = stmt
                .query_map(rusqlite::params![&notebook_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(sqlite_to_io)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_to_io)?;
            collected
        };

        let mut prefix_to_memos: HashMap<String, HashSet<String>> = HashMap::new();
        for (tag, note_key) in &pairs {
            let segments: Vec<&str> = tag.split('/').collect();
            for i in 1..=segments.len() {
                let prefix = segments[..i].join("/");
                prefix_to_memos
                    .entry(prefix)
                    .or_default()
                    .insert(note_key.clone());
            }
        }

        Ok(prefix_to_memos
            .into_iter()
            .map(|(k, v)| (k, v.len()))
            .collect())
    }
}
