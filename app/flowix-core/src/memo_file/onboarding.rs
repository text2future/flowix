//! First-run onboarding documents for an empty notebook.

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
        if self
            .read_index()
            .map(|index| !index.memos.is_empty())
            .unwrap_or(false)
        {
            return Ok(false);
        }

        for doc in ONBOARDING_DOCS {
            self.create_memo(doc.title, doc.body, None)?;
        }

        Ok(true)
    }
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
