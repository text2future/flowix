//! Resolve an [`OpenTarget`] into a concrete memo location.
//!
//! Deep links use the globally unique memo id and resolve through `index.db`
//! (`memos` joined with `notebooks`). Physical paths are matched against the
//! notebook implied by the path and then checked against that notebook index.

use std::path::Path;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::commands::AppState;
use crate::lock_utils::read_lock;
use crate::watcher::path::normalize_for_compare;
use flowix_core::memo_file::NotebookConfig;

use super::parser::OpenTarget;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedOpenTarget {
    pub memo_id: String,
    pub notebook_id: String,
    pub notebook_name: String,
    pub notebook_path: String,
    /// 绝对物理路径 (从 memo index entry.filename 拼)
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

    // 1. 物理路径模式: 按 filename 反查 memo index (v3 后 filename 即磁盘
    //    文件名, memo index 是真源)。memo_id 不知道时也走这条 (parser 端
    //    把 PhysicalPath.memo_id 设成 None, 物理 filename 已不再带 `#<id>`
    //    后缀, 解析不出来)。
    if let Some(abs_path) = target_physical_path(&target) {
        if let Some(filename) = Path::new(&abs_path).file_name().and_then(|n| n.to_str()) {
            if let Some((cfg, memo)) =
                find_memo_by_path_in_notebooks(state, &configs, &abs_path, filename)
            {
                return Ok(build_resolved(memo, &cfg, abs_path));
            }
        }
        // 物理 filename 找不到 memo index entry (可能不是 memo 文件 / 路径拼错)
        return Err(ResolveError::NotFound(abs_path));
    }

    // 2. Deep link: resolve the globally unique memo id through index.db.
    let memo_id = extract_memo_id(&target).ok_or(ResolveError::NoMemoId)?;
    let location = state
        .memo_file
        .read()
        .unwrap()
        .resolve_memo_location(&memo_id)
        .map_err(|_| ResolveError::NotFound(memo_id.clone()))?
        .ok_or_else(|| ResolveError::NotFound(memo_id.clone()))?;
    let abs = build_abs_path(&location.notebook, &location.memo.filename);
    Ok(build_resolved(
        flowix_core::memo_file::MemoFile::index_entry_to_memo(&location.memo),
        &location.notebook,
        abs,
    ))
}

/// Build the response using the notebook resolved from the target.
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

fn find_memo_by_path_in_notebooks(
    state: &AppState,
    configs: &[NotebookConfig],
    abs_path: &str,
    filename: &str,
) -> Option<(NotebookConfig, flowix_core::memo_file::Memo)> {
    let target = Path::new(abs_path);
    let target_norm = normalize_for_compare(target);
    let memo_file = read_lock(&state.memo_file, "memo_file");
    for cfg in configs {
        let base_norm = normalize_for_compare(Path::new(&cfg.path));
        if !target_norm.starts_with(&base_norm) {
            continue;
        }
        let Some(list) = memo_file
            .read_index_for_notebook_id(Some(&cfg.id))
            .ok()
            .flatten()
        else {
            continue;
        };
        if let Some(entry) = list
            .memos
            .into_iter()
            .find(|entry| entry.filename == filename)
        {
            return Some((
                cfg.clone(),
                flowix_core::memo_file::MemoFile::index_entry_to_memo(&entry),
            ));
        }
    }
    None
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
