//! Resolve an [`OpenTarget`] into a concrete memo location.
//!
//! Deep links use the globally unique memo id and resolve through `index.db`
//! (`memos` joined with `notebooks`). Physical paths are matched against the
//! notebook implied by the path and then checked against that notebook index.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::lock_utils::read_lock;
use crate::watcher::path::normalize_for_compare;
use flowix_core::memo_file::{MemoFile, NotebookConfig};

use super::parser::OpenTarget;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedOpenTarget {
    pub memo_id: String,
    pub notebook_id: String,
    pub notebook_name: String,
    pub notebook_path: String,
    /// 缁濆鐗╃悊璺緞 (浠?memo index entry.filename 鎷?
    pub absolute_path: String,
    /// memo filename (鐢ㄤ簬 stale check / 鍓嶇鏄剧ず)
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
    memo_file: &RwLock<MemoFile>,
) -> Result<ResolvedOpenTarget, ResolveError> {
    let configs = {
        let memo_file = read_lock(memo_file, "memo_file");
        memo_file.read_notebook_configs().unwrap_or_default()
    };

    if configs.is_empty() {
        return Err(ResolveError::NotebookNotFound("<no notebook>".into()));
    }

    // 1. 鐗╃悊璺緞妯″紡: 鎸?filename 鍙嶆煡 memo index 鍚? 蹇呴』纭浼犲叆璺緞
    //    涓?notebook 鏍圭洰褰?+ entry.filename 鐨勫畬鏁磋鑼冨寲璺緞涓€鑷淬€傝繖鏍?    //    `/notebook/subdir/Note.md` 涓嶄細璇懡涓牴鐩綍鐨?`Note.md`銆?
    if let Some(abs_path) = target_physical_path(&target) {
        if let Some(filename) = Path::new(&abs_path).file_name().and_then(|n| n.to_str()) {
            if let Some((cfg, memo)) =
                find_memo_by_path_in_notebooks(memo_file, &configs, &abs_path, filename)
            {
                let canonical_abs = build_abs_path(&cfg, &memo.filename);
                return Ok(build_resolved(memo, &cfg, canonical_abs));
            }
        }
        // 鐗╃悊 filename 鎵句笉鍒?memo index entry (鍙兘涓嶆槸 memo 鏂囦欢 / 璺緞鎷奸敊)
        return Err(ResolveError::NotFound(abs_path));
    }

    // 2. Deep link: resolve the globally unique memo id through index.db.
    let memo_id = extract_memo_id(&target).ok_or(ResolveError::NoMemoId)?;
    let location = read_lock(memo_file, "memo_file")
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
    PathBuf::from(&cfg.path)
        .join(filename)
        .display()
        .to_string()
}

fn find_memo_by_path_in_notebooks(
    memo_file: &RwLock<MemoFile>,
    configs: &[NotebookConfig],
    abs_path: &str,
    filename: &str,
) -> Option<(NotebookConfig, flowix_core::memo_file::Memo)> {
    let target = Path::new(abs_path);
    let target_norm = normalize_for_compare(target);
    let memo_file = read_lock(memo_file, "memo_file");
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
        if let Some(entry) = list.memos.into_iter().find(|entry| {
            if entry.filename != filename {
                return false;
            }
            let expected = PathBuf::from(&cfg.path).join(&entry.filename);
            normalize_for_compare(&expected) == target_norm
        }) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use flowix_core::memo_file::{MemoFile, NotebookConfig};
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn fresh_memo_file() -> (RwLock<MemoFile>, PathBuf, PathBuf) {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let tmp = std::env::temp_dir().join(format!(
            "flowix-open-target-resolver-test-{}-{}-{}",
            std::process::id(),
            n,
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let nb_one = tmp.join("notebook-one");
        let nb_two = tmp.join("notebook-two");
        fs::create_dir_all(&nb_one).unwrap();
        fs::create_dir_all(&nb_two).unwrap();

        let config_dir = tmp.join("config");
        fs::create_dir_all(&config_dir).unwrap();
        let mut mf = MemoFile::new(config_dir);
        let configs = vec![
            NotebookConfig {
                id: "nb_one".to_string(),
                name: "One".to_string(),
                icon: None,
                path: nb_one.display().to_string(),
                is_default: true,
                sort: 0,
                created_at: 0,
                updated_at: 0,
            },
            NotebookConfig {
                id: "nb_two".to_string(),
                name: "Two".to_string(),
                icon: None,
                path: nb_two.display().to_string(),
                is_default: false,
                sort: 0,
                created_at: 0,
                updated_at: 0,
            },
        ];
        mf.write_notebook_configs(&configs).unwrap();
        mf.set_current_notebook(Some("nb_one".to_string()));
        (RwLock::new(mf), nb_one, nb_two)
    }

    fn seed_memo(
        memo_file: &RwLock<MemoFile>,
        notebook_id: &str,
        base: &Path,
        title: &str,
    ) -> (String, PathBuf) {
        let path = base.join(format!("{title}.md"));
        fs::write(&path, format!("---\ntitle: {title}\n---\n# {title}\n")).unwrap();
        let memo = read_lock(memo_file, "memo_file")
            .register_existing_file_for_notebook_id(notebook_id, &path)
            .unwrap();
        (memo.id, path)
    }

    #[test]
    fn resolves_deep_link_by_global_memo_id() {
        let (memo_file, nb_one, nb_two) = fresh_memo_file();
        let (_id_one, _path_one) = seed_memo(&memo_file, "nb_one", &nb_one, "First");
        let (id_two, path_two) = seed_memo(&memo_file, "nb_two", &nb_two, "Second");

        let resolved = resolve_open_target(
            OpenTarget::DeepLink {
                url: format!("flowix://memo/{id_two}"),
                memo_id: Some(id_two.clone()),
                physical_path: None,
            },
            &memo_file,
        )
        .unwrap();

        assert_eq!(resolved.memo_id, id_two);
        assert_eq!(resolved.notebook_id, "nb_two");
        assert_eq!(
            normalize_for_compare(Path::new(&resolved.absolute_path)),
            normalize_for_compare(&path_two)
        );
    }

    #[test]
    fn resolves_physical_path_by_exact_notebook_entry_path() {
        let (memo_file, nb_one, _nb_two) = fresh_memo_file();
        let (id, path) = seed_memo(&memo_file, "nb_one", &nb_one, "Exact");

        let resolved = resolve_open_target(
            OpenTarget::PhysicalPath {
                path: path.display().to_string(),
                memo_id: None,
            },
            &memo_file,
        )
        .unwrap();

        assert_eq!(resolved.memo_id, id);
        assert_eq!(resolved.notebook_id, "nb_one");
        assert_eq!(
            normalize_for_compare(Path::new(&resolved.absolute_path)),
            normalize_for_compare(&path)
        );
    }

    #[test]
    fn physical_path_in_subdir_with_same_filename_does_not_match_root_memo() {
        let (memo_file, nb_one, _nb_two) = fresh_memo_file();
        let (_id, _root_path) = seed_memo(&memo_file, "nb_one", &nb_one, "SameName");

        let subdir = nb_one.join("subdir");
        fs::create_dir_all(&subdir).unwrap();
        let nested_path = subdir.join("SameName.md");
        fs::write(&nested_path, "# SameName in subdir\n").unwrap();

        let err = resolve_open_target(
            OpenTarget::PhysicalPath {
                path: nested_path.display().to_string(),
                memo_id: None,
            },
            &memo_file,
        )
        .unwrap_err();

        assert!(matches!(err, ResolveError::NotFound(_)));
    }
}
