//! First-run onboarding documents for an empty notebook.

use std::fs;
use std::path::Path;

use super::MemoFile;

struct OnboardingDoc {
    title: &'static str,
    body: &'static str,
}

// Keep the editable Markdown files as the single source of truth. `include_str!`
// embeds them in flowix-core at compile time, so creating a notebook does not
// depend on resource lookup or the current working directory at runtime.
//
// The array order is the reverse of the final display order: create_memo gives
// each document an increasing createdAt and the UI sorts createdAt descending.
// Expected display order (top to bottom):
//   1. 欢迎文档
//   2. Welcome
const ONBOARDING_DOCS: &[OnboardingDoc] = &[
    OnboardingDoc {
        title: "Welcome",
        body: include_str!("../../resources/welcome/Welcome.md"),
    },
    OnboardingDoc {
        title: "欢迎文档",
        body: include_str!("../../resources/welcome/欢迎文档.md"),
    },
];

impl MemoFile {
    /// Seed onboarding documents into a newly created notebook.
    ///
    /// Called every time `create_notebook` runs, so each fresh notebook gets its
    /// own guide documents.
    ///
    /// Safety guard: if the target folder already contains memos (for example,
    /// the user registered a folder full of notes), this is a no-op.
    pub fn seed_onboarding_docs(&self) -> std::io::Result<bool> {
        let index = self.read_index_result()?.unwrap_or_default();
        seed_onboarding_docs_if_empty(self, self.get_memo_base(), index.memos.is_empty(), None)
    }

    /// Seed onboarding documents into a notebook without changing the
    /// process-local current notebook. This is important for background
    /// imports: importing a newly registered notebook must not change the
    /// user's active notebook while they are browsing another one.
    pub fn seed_onboarding_docs_for_notebook_id(&self, notebook_id: &str) -> std::io::Result<bool> {
        let index = self
            .read_index_for_notebook_id(Some(notebook_id))?
            .unwrap_or_default();
        let base = self
            .memo_base_for_notebook_id_result(notebook_id)
            .map_err(std::io::Error::other)?;
        seed_onboarding_docs_if_empty(self, base, index.memos.is_empty(), Some(notebook_id))
    }
}

fn seed_onboarding_docs_if_empty(
    memo_file: &MemoFile,
    base: std::path::PathBuf,
    index_is_empty: bool,
    notebook_id: Option<&str>,
) -> std::io::Result<bool> {
    // The index can be absent or stale when an existing folder is first
    // registered. Never create welcome files merely because the index has not
    // been built yet; inspect the actual Markdown files first.
    if !index_is_empty || contains_markdown_files(&base)? {
        return Ok(false);
    }

    for doc in ONBOARDING_DOCS {
        if let Some(notebook_id) = notebook_id {
            memo_file.create_memo_for_notebook_id(notebook_id, doc.title, doc.body, None)?;
        } else {
            memo_file.create_memo(doc.title, doc.body, None)?;
        }
    }

    Ok(true)
}

fn contains_markdown_files(base: &Path) -> std::io::Result<bool> {
    if !base.exists() {
        return Ok(false);
    }

    fn visit(base: &Path, directory: &Path) -> std::io::Result<bool> {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            let relative = path.strip_prefix(base).unwrap_or(&path);
            if super::ops::is_ignored_notebook_relative_path(relative) {
                continue;
            }
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                if visit(base, &path)? {
                    return Ok(true);
                }
            } else if file_type.is_file()
                && path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .map(|extension| {
                        matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown")
                    })
                    .unwrap_or(false)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    visit(base, base)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::memo_file::{MemoFile, MemoIndexFile, NotebookConfig};

    fn test_memo_file() -> (tempfile::TempDir, MemoFile) {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("data");
        let config_dir = dir.path().join("config");
        fs::create_dir_all(&app_data).unwrap();
        fs::create_dir_all(&config_dir).unwrap();

        let notebook_path = dir.path().join("Default Notebook");
        fs::create_dir_all(&notebook_path).unwrap();
        let mut mf = MemoFile::new(config_dir);
        let config = NotebookConfig {
            id: "nb_default".to_string(),
            name: "Default Notebook".to_string(),
            icon: None,
            path: format!("{}/", notebook_path.to_string_lossy()),
            is_default: true,
            sort: 0,
            created_at: 1,
            updated_at: 1,
        };
        mf.write_notebook_configs(&[config]).unwrap();
        mf.set_current_notebook(Some("nb_default".to_string()));
        (dir, mf)
    }

    #[test]
    fn seeds_welcome_docs_into_empty_notebook() {
        let (_dir, mf) = test_memo_file();

        assert!(mf.seed_onboarding_docs().unwrap());
        let index = mf.read_index().unwrap();
        let filenames: Vec<&str> = index
            .memos
            .iter()
            .map(|memo| memo.filename.as_str())
            .collect();

        assert_eq!(filenames, ["Welcome.md", "欢迎文档.md"]);
        assert_eq!(index.memos.len(), ONBOARDING_DOCS.len());
        assert!(!filenames.iter().any(|filename| {
            matches!(
                *filename,
                "Flowix Memo 产品介绍.md" | "如何快速上手.md" | "配置使用 AI Agent.md"
            )
        }));

        let english = fs::read_to_string(mf.get_memo_base().join("Welcome.md")).unwrap();
        let chinese = fs::read_to_string(mf.get_memo_base().join("欢迎文档.md")).unwrap();
        assert!(english.contains("# Welcome"));
        assert!(english.contains("## Quick Start"));
        assert!(english.contains("https://flowix-memo.com/docs/"));
        assert!(chinese.contains("# 欢迎文档"));
        assert!(chinese.contains("## 快速上手"));
        assert!(chinese.contains("https://flowix-memo.com/docs/"));

        // The last-created document has the greatest createdAt and is displayed
        // first by the UI's descending sort.
        assert_eq!(filenames.last(), Some(&"欢迎文档.md"));

        // A second call for the same non-empty notebook is a no-op.
        assert!(!mf.seed_onboarding_docs().unwrap());
        assert_eq!(mf.read_index().unwrap().memos.len(), ONBOARDING_DOCS.len());
    }

    #[test]
    fn does_not_seed_when_notebook_already_has_notes() {
        let (_dir, mf) = test_memo_file();

        mf.create_memo("Existing Note", "# Existing Note\n", None)
            .unwrap();
        assert!(!mf.seed_onboarding_docs().unwrap());
        assert_eq!(mf.read_index().unwrap().memos.len(), 1);
    }

    #[test]
    fn does_not_seed_when_disk_contains_unindexed_markdown() {
        let (_dir, mf) = test_memo_file();
        let existing = mf.get_memo_base().join("Existing from disk.md");
        fs::write(&existing, "# Existing from disk\n").unwrap();

        assert!(!mf.seed_onboarding_docs().unwrap());
        assert!(existing.exists());
        assert!(mf.read_index().unwrap_or_default().memos.is_empty());
        assert!(!mf.get_memo_base().join("Welcome.md").exists());
        assert!(!mf.get_memo_base().join("欢迎文档.md").exists());
    }

    #[test]
    fn import_reconciliation_preserves_existing_markdown_content() {
        let (_dir, mf) = test_memo_file();
        let existing = mf.get_memo_base().join("Existing from disk.md");
        let original = "# Existing from disk\n\nNo Flowix metadata yet.\n";
        fs::write(&existing, original).unwrap();

        let report = mf
            .reconcile_notebook_with_disk_bidirectional_for_import("nb_default")
            .unwrap();

        assert_eq!(report.added, 1);
        assert_eq!(fs::read_to_string(&existing).unwrap(), original);
        assert!(mf
            .read_index_for_notebook_id(Some("nb_default"))
            .unwrap()
            .unwrap()
            .memos
            .iter()
            .any(|memo| memo.filename == "Existing from disk.md"));
    }

    #[test]
    fn seeds_for_notebook_id_without_changing_current_notebook() {
        let (_dir, mf) = test_memo_file();
        let other_path = mf.get_memo_base().join("../Other Notebook");
        fs::create_dir_all(&other_path).unwrap();
        let mut configs = mf.read_notebook_configs().unwrap();
        configs.push(NotebookConfig {
            id: "nb_other".to_string(),
            name: "Other Notebook".to_string(),
            icon: None,
            path: format!("{}/", other_path.to_string_lossy()),
            is_default: false,
            sort: 10,
            created_at: 2,
            updated_at: 2,
        });
        mf.write_notebook_configs(&configs).unwrap();

        assert!(mf.seed_onboarding_docs_for_notebook_id("nb_other").unwrap());
        assert_eq!(
            mf.current_notebook_id_value().as_deref(),
            Some("nb_default")
        );
        assert!(other_path.join("Welcome.md").exists());
        assert_eq!(mf.read_index().unwrap_or_default().memos.len(), 0);
        assert_eq!(
            mf.read_index_for_notebook_id(Some("nb_other"))
                .unwrap()
                .unwrap()
                .memos
                .len(),
            ONBOARDING_DOCS.len()
        );
    }

    #[test]
    fn reseeds_after_clearing_index_for_a_fresh_notebook() {
        let (_dir, mf) = test_memo_file();

        assert!(mf.seed_onboarding_docs().unwrap());
        assert_eq!(mf.read_index().unwrap().memos.len(), ONBOARDING_DOCS.len());

        // Simulate another new, empty notebook by clearing the memo index.
        mf.write_index(&MemoIndexFile::default()).unwrap();
        fs::remove_file(mf.get_memo_base().join("Welcome.md")).unwrap();
        fs::remove_file(mf.get_memo_base().join("欢迎文档.md")).unwrap();

        assert!(mf.seed_onboarding_docs().unwrap());
        assert_eq!(mf.read_index().unwrap().memos.len(), ONBOARDING_DOCS.len());
    }
}
