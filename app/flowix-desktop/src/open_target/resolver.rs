//! `resolve_open_target` — 把 [`OpenTarget`] 解析成 [`ResolvedOpenTarget`]。
//!
//! v3 改造:
//! - 物理路径走 index.json `find_memo_by_filename` (按磁盘文件名精确比对)。
//!   v3 后物理 filename 不再带 `#<id>` 后缀, parser 端无法从路径抽 id,
//!   走 index.json 反查是唯一权威路径。
//! - 深链 `flowix://memo/<id>` 走 index.json `read_memo` 找 entry, 拼
//!   `cfg.path + entry.filename` 得到绝对路径。
//! - index.json per-notebook 隔离, 我们只搜 current_notebook ── 跨 notebook
//!   解析由调用方 (openNoteByTarget 前端) 切完 notebook 后再调, 本函数
//!   负责"在当前 notebook 里找"。

use std::path::Path;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::commands::AppState;
use crate::lock_utils::read_lock;
use flowix_core::memo_file::NotebookConfig;

use super::parser::OpenTarget;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedOpenTarget {
    pub memo_id: String,
    pub notebook_id: String,
    pub notebook_name: String,
    pub notebook_path: String,
    /// 绝对物理路径 (从 index.json entry.filename 拼)
    pub absolute_path: String,
    /// memo filename (用于 stale check / 前端显示)
    pub memo_title: String,
}

#[derive(Debug, Error, Serialize)]
pub enum ResolveError {
    #[error("memo not found: {0}")]
    NotFound(String),
    #[error("notebook not found for memo: {0}")]
    NotebookNotFound(String),
    #[error("no memo id resolvable from target")]
    NoMemoId,
}

pub fn resolve_open_target(
    target: OpenTarget,
    state: &AppState,
) -> Result<ResolvedOpenTarget, ResolveError> {
    let configs = {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        memo_file.read_notebook_configs().unwrap_or_default()
    };

    if configs.is_empty() {
        return Err(ResolveError::NotebookNotFound("<no notebook>".into()));
    }

    // 1. 物理路径模式: 按 filename 反查 index.json (v3 后 filename 即磁盘
    //    文件名, index.json 是真源)。memo_id 不知道时也走这条 (parser 端
    //    把 PhysicalPath.memo_id 设成 None, 物理 filename 已不再带 `#<id>`
    //    后缀, 解析不出来)。
    if let Some(abs_path) = target_physical_path(&target) {
        if let Some(filename) = Path::new(&abs_path).file_name().and_then(|n| n.to_str()) {
            if let Some((cfg, memo)) = find_memo_by_filename_in_notebooks(state, &configs, filename)
            {
                return Ok(build_resolved(memo, &cfg, abs_path));
            }
        }
        // 物理 filename 找不到 index.json entry (可能不是 memo 文件 / 路径拼错)
        return Err(ResolveError::NotFound(abs_path));
    }

    // 2. 深链 (flowix://memo/<id>): 走 index.json 找 entry。
    let memo_id = extract_memo_id(&target).ok_or(ResolveError::NoMemoId)?;
    let memo = state
        .memo_file
        .read()
        .unwrap()
        .read_memo(&memo_id)
        .ok_or_else(|| ResolveError::NotFound(memo_id.clone()))?;
    let chosen = pick_notebook_for_current(&state, &configs)
        .ok_or_else(|| ResolveError::NotebookNotFound(memo_id.clone()))?;
    let abs = build_abs_path(chosen, &memo.filename);
    Ok(build_resolved(memo, chosen, abs))
}

/// 选当前 notebook 的 config (current_notebook_id 对应项), 兜底用第一个。
fn pick_notebook_for_current<'a>(
    state: &AppState,
    configs: &'a [NotebookConfig],
) -> Option<&'a NotebookConfig> {
    let cur = read_lock(&state.memo_file, "memo_file").current_notebook_id_value();
    if let Some(ref id) = cur {
        if let Some(c) = configs.iter().find(|c| &c.id == id) {
            return Some(c);
        }
    }
    configs.first()
}

fn build_resolved(
    memo: flowix_core::memo_file::Memo,
    cfg: &NotebookConfig,
    abs_path: String,
) -> ResolvedOpenTarget {
    ResolvedOpenTarget {
        memo_id: memo.id,
        notebook_id: cfg.id.clone(),
        notebook_name: cfg.name.clone(),
        notebook_path: cfg.path.clone(),
        absolute_path: abs_path,
        memo_title: memo.filename,
    }
}

fn build_abs_path(cfg: &NotebookConfig, filename: &str) -> String {
    format!("{}/{}", cfg.path.trim_end_matches(['/', '\\']), filename)
}

fn find_memo_by_filename_in_notebooks(
    state: &AppState,
    configs: &[NotebookConfig],
    filename: &str,
) -> Option<(NotebookConfig, flowix_core::memo_file::Memo)> {
    // v3: 走 index.json 反查 (filename 即磁盘文件名, index.json 是真源)。
    // index.json per-notebook 隔离, 当前 MemoFile 实例只持 current_notebook
    // 一份 ── 跨 notebook 解析由调用方 (openNoteByTarget 前端逻辑) 切完
    // notebook 后再调 resolve_open_target, 本函数只搜当前 notebook。
    let memo = state
        .memo_file
        .read()
        .unwrap()
        .find_memo_by_filename(filename)?;
    let cfg = pick_notebook_for_current(state, configs)?.clone();
    Some((cfg, memo))
}

fn extract_memo_id(target: &OpenTarget) -> Option<String> {
    match target {
        OpenTarget::DeepLink { memo_id, .. } => memo_id.clone(),
        OpenTarget::PhysicalPath { memo_id, .. } => memo_id.clone(),
    }
}

fn target_physical_path(target: &OpenTarget) -> Option<String> {
    match target {
        OpenTarget::PhysicalPath { path, .. } => Some(path.clone()),
        OpenTarget::DeepLink { physical_path, .. } => physical_path.clone(),
    }
}
