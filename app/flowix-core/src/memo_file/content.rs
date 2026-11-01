//! Markdown reads, memo list queries, and filters.
//!
//! Current-notebook methods support watcher and path-based document flows.

use std::collections::HashSet;
use std::fs;

use super::time::{chrono_now, start_of_this_month, start_of_this_week};
use super::types::{Memo, MemoIndexEntry, MemoTag};
use super::{tag_path_matches_filter, MemoFile};

impl MemoFile {
    /// 派生 tags — 扫所有 memo 的 `tags` 字段, 合并去重, 按 name lowercase 排序。
    pub fn derived_tags(&self) -> Vec<MemoTag> {
        Self::derive_tags_from_memos(self.read_all_memos())
    }

    pub fn derived_tags_for_notebook_id(
        &self,
        notebook_id: Option<&str>,
    ) -> std::io::Result<Vec<MemoTag>> {
        let now = chrono::Utc::now().timestamp_millis();
        Ok(self.read_used_tag_ids_for_notebook_id(notebook_id)?
            .into_iter()
            .map(|name| MemoTag {
                id: name.clone(),
                name,
                created_at: now,
            })
            .collect())
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

        tags.sort_by_key(|tag| tag.name.to_lowercase());
        tags
    }

    /// 读 memo index 全表, 转 `Memo`, 按 `created_at` 倒序。
    pub fn read_all_memos(&self) -> Vec<Memo> {
        let notebook_id = self.current_notebook_id_for_index();
        let policy = self.file_management_policy(&notebook_id);
        let root = self.get_memo_base();
        let list = match self.read_index() {
            Some(l) => l,
            None => return Vec::new(),
        };
        Self::memos_from_index(list, &policy, &root)
    }

    pub fn read_all_memos_for_notebook_id(&self, notebook_id: Option<&str>) -> Vec<Memo> {
        let resolved_id = self.notebook_id_for_index(notebook_id);
        let policy = self.file_management_policy(&resolved_id);
        let root = self.get_notebook_config_by_id(&resolved_id)
            .map(|config| std::path::PathBuf::from(config.path))
            .unwrap_or_default();
        let list = match self.read_index_for_notebook_id(notebook_id) {
            Ok(Some(list)) => list,
            _ => return Vec::new(),
        };
        Self::memos_from_index(list, &policy, &root)
    }

    fn memos_from_index(list: super::types::MemoIndexFile, policy: &super::FileManagementPolicy, root: &std::path::Path) -> Vec<Memo> {
        let mut memos: Vec<Memo> = list
            .memos
            .iter()
            .filter(|entry| !entry.relative_path.is_empty())
            .filter(|entry| {
                let relative_path = if entry.relative_path.is_empty() {
                    &entry.filename
                } else {
                    &entry.relative_path
                };
                let relative = std::path::Path::new(relative_path);
                !policy.is_index_hidden_at(root, relative)
            })
            .map(MemoFile::index_entry_to_memo)
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
                    all_memos
                        .into_iter()
                        .filter(|m| m.tags.iter().any(|t| tag_path_matches_filter(t, tid)))
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
            "filenameAsc" | "filenameDesc" => {
                let descending = sort == "filenameDesc";
                let mut sorted = filtered;
                sorted.sort_by(|a, b| {
                    let filename_order = a
                        .filename
                        .to_lowercase()
                        .cmp(&b.filename.to_lowercase())
                        .then_with(|| a.filename.cmp(&b.filename))
                        .then_with(|| a.relative_path.cmp(&b.relative_path));
                    b.favorited.cmp(&a.favorited).then_with(|| {
                        if descending {
                            filename_order.reverse()
                        } else {
                            filename_order
                        }
                    })
                });
                sorted
            }
            "updatedAt" => {
                let mut sorted = filtered;
                sorted.sort_by(|a, b| {
                    // 置顶优先于 sort 维度: pinned memo 始终靠前.
                    // filter == "favorited" 时所有可见 memo 都是 favorited, 此分支自然 no-op.
                    b.favorited
                        .cmp(&a.favorited)
                        .then_with(|| b.updated_at.cmp(&a.updated_at))
                        // 同一毫秒创建/更新的 memo 也必须有确定顺序, 否则
                        // 分页时会出现重复或漏项。
                        .then_with(|| b.relative_path.cmp(&a.relative_path))
                });
                sorted
            }
            _ => {
                let mut sorted = filtered;
                sorted.sort_by(|a, b| {
                    b.favorited
                        .cmp(&a.favorited)
                        .then_with(|| b.created_at.cmp(&a.created_at))
                        .then_with(|| b.relative_path.cmp(&a.relative_path))
                });
                sorted
            }
        }
    }

    /// Read one memo from the current notebook index. Body is not loaded.
    pub fn read_current_memo(&self, relative_path: &str) -> Option<Memo> {
        let list = self.read_index()?;
        list.memos
            .iter()
            .find(|e| e.relative_path == relative_path)
            .map(MemoFile::index_entry_to_memo)
    }

    pub fn read_memo(&self, relative_path: &str) -> Option<Memo> {
        self.read_current_memo(relative_path)
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
        let policy = super::FileManagementPolicy::from_notebook_root(&base);
        list.memos
            .into_iter()
            .filter(|e| !e.relative_path.is_empty())
            .filter(|entry| !policy.is_index_hidden_at(&base, std::path::Path::new(&entry.relative_path)))
            .map(|entry| {
                let path = super::notebook_path_from_relative(&base, &entry.relative_path)
                    .unwrap_or_else(|_| base.join(&entry.filename));
                let body = fs::read_to_string(&path).unwrap_or_default();
                (entry, body)
            })
            .collect()
    }

    /// Read one memo and markdown body from the current notebook only.
    pub fn read_current_memo_with_body(&self, relative_path: &str) -> Option<(MemoIndexEntry, String)> {
        let list = self.read_index()?;
        let entry = list.memos.iter().find(|e| e.relative_path == relative_path)?.clone();
        let base = self.get_memo_base();
        let path = super::notebook_path_from_relative(&base, &entry.relative_path)
            .unwrap_or_else(|_| base.join(&entry.filename));
        let body = fs::read_to_string(&path).ok()?;
        Some((entry, body))
    }

    pub fn read_memo_with_body(&self, relative_path: &str) -> Option<(MemoIndexEntry, String)> {
        self.read_current_memo_with_body(relative_path)
    }
}
