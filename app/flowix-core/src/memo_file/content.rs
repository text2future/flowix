//! .md 文件读取 + 列表查询 / 过滤 — v3 (filename 即磁盘文件名, 无 #id 后缀)。
//!
//! 写路径全部走 [`super::ops`] 模块; 本文件只保留只读 API:
//! - `read_memo` / `read_all_memos` / `read_all_memos_filtered` /
//!   `read_memo_with_body` / `read_all_memos_with_body` /
//!   `find_memo_file_path` / `derived_tags`

use std::collections::HashSet;
use std::fs;

use super::time::{chrono_now, start_of_this_month, start_of_this_week};
use super::types::{Memo, MemoIndexEntry, MemoTag};
use super::MemoFile;

impl MemoFile {
    /// 派生 tags — 扫所有 memo 的 `tags` 字段, 合并去重, 按 name lowercase 排序。
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

    /// 读 index.json 全表, 转 `Memo`, 按 `created_at` 倒序。
    pub fn read_all_memos(&self) -> Vec<Memo> {
        let _ = self.ensure_dirs();

        let list = match self.read_index() {
            Some(l) => l,
            None => return Vec::new(),
        };
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
        let all_memos = self.read_all_memos();

        let now = chrono_now();
        let week_start = start_of_this_week(now);
        let month_start = start_of_this_month(now);

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

    /// 按 id 读 index.json 里的单条 memo。文件 body 不读, 只 metadata。
    pub fn read_memo(&self, id: &str) -> Option<Memo> {
        let list = self.read_index()?;
        list.memos
            .iter()
            .find(|e| e.id == id)
            .map(|e| MemoFile::index_entry_to_memo(e))
    }

    /// 读出当前 notebook 全部 memos 的 metadata + 完整 .md 原始内容。
    /// 用于 `search.rs` 全量 rebuild。
    pub fn read_all_memos_with_body(&self) -> Vec<(MemoIndexEntry, String)> {
        let list = match self.read_index() {
            Some(l) => l,
            None => return Vec::new(),
        };
        let base = self.get_memo_base();
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

    /// 读单条 memo 的 metadata + 完整 .md 原始内容。
    pub fn read_memo_with_body(&self, id: &str) -> Option<(MemoIndexEntry, String)> {
        let list = self.read_index()?;
        let entry = list.memos.iter().find(|e| e.id == id)?.clone();
        let path = self.get_memo_base().join(&entry.filename);
        let body = fs::read_to_string(&path).ok()?;
        Some((entry, body))
    }
}
