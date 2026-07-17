//! Markdown reads, memo list queries, and filters.
//!
//! Current-notebook methods are used by watcher/reconcile flows. Global methods
//! resolve a memo id through `index.db` and should be used for user-facing
//! navigation and document operations.

use std::collections::HashSet;
use std::fs;

use super::time::{chrono_now, start_of_this_month, start_of_this_week};
use super::types::{Memo, MemoIndexEntry, MemoTag};
use super::MemoFile;

impl MemoFile {
    /// 派生 tags — 扫所有 memo 的 `tags` 字段, 合并去重, 按 name lowercase 排序。
    pub fn derived_tags(&self) -> Vec<MemoTag> {
        Self::derive_tags_from_memos(self.read_all_memos())
    }

    pub fn derived_tags_for_notebook_id(&self, notebook_id: Option<&str>) -> Vec<MemoTag> {
        Self::derive_tags_from_memos(self.read_all_memos_for_notebook_id(notebook_id))
    }

    fn derive_tags_from_memos(memos: Vec<Memo>) -> Vec<MemoTag> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut seen = HashSet::new();
        let mut tags = Vec::new();

        for memo in memos {
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

    /// 读 memo index 全表, 转 `Memo`, 按 `created_at` 倒序。
    pub fn read_all_memos(&self) -> Vec<Memo> {
        let list = match self.read_index() {
            Some(l) => l,
            None => return Vec::new(),
        };
        Self::memos_from_index(list)
    }

    pub fn read_all_memos_for_notebook_id(&self, notebook_id: Option<&str>) -> Vec<Memo> {
        let list = match self.read_index_for_notebook_id(notebook_id) {
            Ok(Some(list)) => list,
            _ => return Vec::new(),
        };
        Self::memos_from_index(list)
    }

    fn memos_from_index(list: super::types::MemoIndexFile) -> Vec<Memo> {
        let mut memos: Vec<Memo> = list
            .memos
            .into_iter()
            .filter(|entry| !entry.id.is_empty())
            .map(|entry| MemoFile::index_entry_to_memo(&entry))
            .collect();
        memos.sort_by_key(|b| std::cmp::Reverse(b.created_at));
        memos
    }

    /// 按 `filter` + `sort` + `tag_id` 过滤 read_all_memos 结果。
    pub fn read_all_memos_filtered(
        &self,
        filter: &str,
        sort: &str,
        tag_id: Option<&str>,
    ) -> Vec<Memo> {
        self.filter_memos(self.read_all_memos(), filter, sort, tag_id)
    }

    pub fn read_all_memos_filtered_for_notebook_id(
        &self,
        notebook_id: Option<&str>,
        filter: &str,
        sort: &str,
        tag_id: Option<&str>,
    ) -> Vec<Memo> {
        self.filter_memos(
            self.read_all_memos_for_notebook_id(notebook_id),
            filter,
            sort,
            tag_id,
        )
    }

    fn filter_memos(
        &self,
        all_memos: Vec<Memo>,
        filter: &str,
        sort: &str,
        tag_id: Option<&str>,
    ) -> Vec<Memo> {
        let now = chrono_now();
        let week_start = start_of_this_week(now);
        let month_start = start_of_this_month(now);

        let filtered: Vec<Memo> = match filter {
            "todos" => all_memos
                .into_iter()
                .filter(|m| !m.todos.is_empty())
                .collect(),
            "agents" => all_memos
                .into_iter()
                .filter(|m| !m.agents.is_empty())
                .collect(),
            "favorited" => all_memos.into_iter().filter(|m| m.favorited).collect(),
            "tagged" => {
                // Step 3+: 路径式 tag 选中某 segment (e.g. `中国`) 时, 过滤
                // 应包含所有前缀匹配的 memo (`中国`、`中国/湖南`、`中国/湖南/长沙` 都算)。
                // 走语义: `m.tags` 里任一元素 == tid 或以 `tid/` 开头 → 命中。
                // 精确匹配仍然能命中 (e.g. tag id = `中国/湖南/长沙`, 选中
                // 整条路径时仍能匹配它自身)。
                if let Some(tid) = tag_id {
                    let prefix = format!("{}/", tid);
                    all_memos
                        .into_iter()
                        .filter(|m| m.tags.iter().any(|t| t == tid || t.starts_with(&prefix)))
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
            "thisMonth" => all_memos
                .into_iter()
                .filter(|m| m.created_at >= month_start && m.created_at <= now)
                .collect(),
            _ => all_memos,
        };

        match sort {
            "updatedAt" => {
                let mut sorted = filtered;
                sorted.sort_by(|a, b| {
                    // 置顶优先于 sort 维度: pinned memo 始终靠前.
                    // filter == "favorited" 时所有可见 memo 都是 favorited, 此分支自然 no-op.
                    b.favorited
                        .cmp(&a.favorited)
                        .then_with(|| b.updated_at.cmp(&a.updated_at))
                });
                sorted
            }
            _ => {
                let mut sorted = filtered;
                sorted.sort_by(|a, b| {
                    b.favorited
                        .cmp(&a.favorited)
                        .then_with(|| b.created_at.cmp(&a.created_at))
                });
                sorted
            }
        }
    }

    /// Read one memo from the current notebook index. Body is not loaded.
    pub fn read_current_memo(&self, id: &str) -> Option<Memo> {
        let list = self.read_index()?;
        list.memos
            .iter()
            .find(|e| e.id == id)
            .map(|e| MemoFile::index_entry_to_memo(e))
    }

    pub fn read_memo(&self, id: &str) -> Option<Memo> {
        self.read_current_memo(id)
    }

    /// Resolve one memo by globally unique id across all notebooks.
    pub fn read_memo_global(&self, id: &str) -> Option<Memo> {
        self.resolve_memo_location(id)
            .ok()
            .flatten()
            .map(|location| MemoFile::index_entry_to_memo(&location.memo))
    }

    /// Read metadata and full markdown body for all memos in the current notebook.
    pub fn read_all_memos_with_body(&self) -> Vec<(MemoIndexEntry, String)> {
        let notebook_id = self.current_notebook_id_value();
        self.read_all_memos_with_body_for_notebook_id(notebook_id.as_deref())
    }

    /// Read metadata and bodies for one notebook without changing current notebook state.
    pub fn read_all_memos_with_body_for_notebook_id(
        &self,
        notebook_id: Option<&str>,
    ) -> Vec<(MemoIndexEntry, String)> {
        let list = match self.read_index_for_notebook_id(notebook_id) {
            Ok(Some(list)) => list,
            _ => return Vec::new(),
        };
        let base = notebook_id
            .and_then(|id| self.get_notebook_config_by_id(id))
            .map(|config| std::path::PathBuf::from(config.path))
            .unwrap_or_else(|| self.get_memo_base());
        list.memos
            .into_iter()
            .filter(|e| !e.id.is_empty())
            .map(|entry| {
                let path = base.join(&entry.filename);
                let body = fs::read_to_string(&path).unwrap_or_default();
                (entry, body)
            })
            .collect()
    }

    /// Read one memo and markdown body from the current notebook only.
    pub fn read_current_memo_with_body(&self, id: &str) -> Option<(MemoIndexEntry, String)> {
        let list = self.read_index()?;
        let entry = list.memos.iter().find(|e| e.id == id)?.clone();
        let path = self.get_memo_base().join(&entry.filename);
        let body = fs::read_to_string(&path).ok()?;
        Some((entry, body))
    }

    pub fn read_memo_with_body(&self, id: &str) -> Option<(MemoIndexEntry, String)> {
        self.read_current_memo_with_body(id)
    }

    /// Resolve one memo globally and read its markdown body from its owning notebook.
    pub fn read_memo_with_body_global(&self, id: &str) -> Option<(MemoIndexEntry, String)> {
        let location = self.resolve_memo_location(id).ok().flatten()?;
        let entry = location.memo;
        let path = std::path::PathBuf::from(location.notebook.path).join(&entry.filename);
        let body = fs::read_to_string(&path).ok()?;
        Some((entry, body))
    }
}
