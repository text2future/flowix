//! First-run onboarding documents for an empty notebook.

use std::fs;
use std::path::Path;

use super::MemoFile;

struct OnboardingDoc {
    title: &'static str,
    body: &'static str,
}

/// A plain file seeded next to the welcome notes. It is not a note: the note
/// index only projects Markdown, so this page never shows up in search, tag
/// filters or agent note lists — it is just a local HTML file the user may read,
/// edit or delete.
struct OnboardingPage {
    filename: &'static str,
    body: &'static str,
}

// Keep the editable Markdown files as the single source of truth. `include_str!`
// embeds them in flowix-core at compile time, so creating a notebook does not
// depend on resource lookup or the current working directory at runtime.
//
// The array order is the reverse of the final display order. The path index
// records creation time and the UI sorts createdAt descending.
// Expected display order (top to bottom):
//   1. Flowix 介绍.html (plain file, created last)
//   2. 欢迎文档
//   3. Welcome
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

/// Self-contained product introduction page (CSS inlined, no external assets) so
/// it renders offline inside the notebook's browser surface.
const ONBOARDING_INTRO_PAGE: OnboardingPage = OnboardingPage {
    filename: "Flowix 介绍.html",
    body: include_str!("../../resources/welcome/Flowix 介绍.html"),
};

impl MemoFile {
    /// Seed onboarding documents into a newly created notebook.
    ///
    /// Called every time `create_notebook` runs, so each fresh notebook gets its
    /// own guide documents.
    ///
    /// Safety guard: if the target folder already contains memos (for example,
    /// the user registered a folder full of notes), this is a no-op.
    pub fn seed_onboarding_docs(&self) -> std::io::Result<bool> {
        let notebook_id = self.current_notebook_id_for_index();
        if !self.note_index_is_ready(&notebook_id)? {
            self.reconcile_note_index_blocking(&notebook_id)?;
        }
        let empty = self.note_count(&notebook_id)? == 0;
        seed_onboarding_docs_if_empty(self, self.get_memo_base(), empty, None)
    }

    /// Seed onboarding documents into a notebook without changing the
    /// process-local current notebook. This is important for background
    /// imports: importing a newly registered notebook must not change the
    /// user's active notebook while they are browsing another one.
    pub fn seed_onboarding_docs_for_notebook_id(&self, notebook_id: &str) -> std::io::Result<bool> {
        if !self.note_index_is_ready(notebook_id)? {
            self.reconcile_note_index_blocking(notebook_id)?;
        }
        let empty = self.note_count(notebook_id)? == 0;
        let base = self
            .memo_base_for_notebook_id_result(notebook_id)
            .map_err(std::io::Error::other)?;
        seed_onboarding_docs_if_empty(self, base, empty, Some(notebook_id))
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

    let target_notebook = notebook_id.map(str::to_owned)
        .or_else(|| memo_file.current_notebook_id_value())
        .ok_or_else(|| std::io::Error::other("no notebook selected for onboarding"))?;
    for doc in ONBOARDING_DOCS {
        memo_file.create_note_by_path(&target_notebook, None, doc.title, doc.body)?;
    }
    // Created last so the newest file sorts to the top of the folder tree, right
    // above the welcome notes.
    seed_onboarding_intro_page(memo_file, &target_notebook, &base);

    Ok(true)
}

/// Write the introduction page as a regular notebook file.
///
/// The page is decorative: an existing file with the same name (user edits) or a
/// failed write must never roll back a notebook that was created successfully,
/// so both cases are swallowed instead of surfacing as an import failure.
fn seed_onboarding_intro_page(memo_file: &MemoFile, notebook_id: &str, base: &Path) {
    let path = base.join(ONBOARDING_INTRO_PAGE.filename);
    match memo_file.create_file_for_notebook(notebook_id, &path, ONBOARDING_INTRO_PAGE.body.as_bytes()) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => tracing::warn!(
            notebook_id,
            path = %path.display(),
            "onboarding intro page not seeded: {error}"
        ),
    }
}

fn contains_markdown_files(base: &Path) -> std::io::Result<bool> {
    if !base.exists() {
        return Ok(false);
    }

    let policy = super::FileManagementPolicy::from_notebook_root(base);
    fn visit(base: &Path, directory: &Path, policy: &super::FileManagementPolicy) -> std::io::Result<bool> {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            let relative = path.strip_prefix(base).unwrap_or(&path);
            if policy.is_index_ignored_at(base, relative) {
                continue;
            }
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                if visit(base, &path, policy)? {
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

    visit(base, base, &policy)
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
        let filenames = mf.list_note_paths_from_disk("nb_default").unwrap();

        assert!(filenames.contains(&"Welcome.md".to_string()));
        assert!(filenames.contains(&"欢迎文档.md".to_string()));
        assert_eq!(filenames.len(), ONBOARDING_DOCS.len());
        assert!(!filenames.iter().any(|filename| {
            matches!(
                filename.as_str(),
                "Flowix Memo 产品介绍.md" | "如何快速上手.md" | "配置使用 AI Agent.md"
            )
        }));

        let english = fs::read_to_string(mf.get_memo_base().join("Welcome.md")).unwrap();
        let chinese = fs::read_to_string(mf.get_memo_base().join("欢迎文档.md")).unwrap();
        // 正文不再带 H1（标题由文件名派生），开头的 YAML 属性块直接进入正文。
        assert!(english.contains("flowix_icon: pizza"));
        assert!(english.contains("status: 进行中"));
        assert!(english.contains("a documentation workspace for AI agents"));
        assert!(english.contains("## Quick Start"));
        assert!(english.contains("https://flowix-memo.com/docs/"));
        assert!(chinese.contains("flowix_icon: carrot"));
        assert!(chinese.contains("status: 完成"));
        assert!(chinese.contains("AI Agents 的文档空间"));
        assert!(chinese.contains("## 快速上手"));
        assert!(chinese.contains("https://flowix-memo.com/docs/"));

        // The introduction page is seeded as a plain file, not as a note: the
        // Markdown-only index must not project it.
        let intro = mf.get_memo_base().join(ONBOARDING_INTRO_PAGE.filename);
        assert!(intro.exists());
        assert!(intro.is_file());
        let intro_html = fs::read_to_string(&intro).unwrap();
        assert!(intro_html.contains("<!DOCTYPE html>"));
        // 封面主张：把知识库放回自己的文件夹。
        assert!(intro_html.contains("把知识库"));
        assert!(intro_html.contains("你的文件夹"));
        assert!(intro_html.contains("安全优势"));
        assert!(intro_html.contains("管理优势"));
        assert!(intro_html.contains("价格优势"));
        // 内容分区：笔记 / 资料的关系，以及两种记录方式。
        assert!(intro_html.contains("理解笔记"));
        assert!(intro_html.contains("理解资料"));
        assert!(intro_html.contains("静态资料"));
        assert!(intro_html.contains("完整的 AI 知识库"));
        assert!(intro_html.contains("简洁记录"));
        assert!(intro_html.contains("文件树管理"));
        // 页面是纵向排列的 HTML 幻灯片：内联样式与脚本，不依赖任何外部资源。
        assert!(intro_html.contains("<style>"));
        assert!(intro_html.contains("<script>"));
        assert!(intro_html.contains("scroll-snap-type"));
        assert!(intro_html.contains("16 / 9"));
        // 五页：封面 / 结构 + 公式 / 内容模型 / 三个理由 / 三步开始。
        // 首屏阅读本该短——加页前先问是不是在重复同一件事。
        assert_eq!(intro_html.matches("<section class=\"slide").count(), 5);
        assert!(!intro_html.contains("<link"));
        assert!(!intro_html.contains("rel=\"stylesheet\""));
        assert!(!filenames.contains(&ONBOARDING_INTRO_PAGE.filename.to_string()));

        // 新笔记本根目录就只有三样：两份欢迎笔记 + 一个介绍网页。
        // 介绍页必须落在根目录（不是子文件夹），否则文件树里看不到它。
        let mut root_entries: Vec<String> = fs::read_dir(mf.get_memo_base())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name != ".flowix")
            .collect();
        root_entries.sort();
        assert_eq!(
            root_entries,
            vec![
                ONBOARDING_INTRO_PAGE.filename.to_string(),
                "Welcome.md".to_string(),
                "欢迎文档.md".to_string(),
            ]
        );

        // The last-created document has the greatest createdAt and is displayed
        // first by the UI's descending sort.
        assert!(filenames.contains(&"欢迎文档.md".to_string()));

        // A second call for the same non-empty notebook is a no-op.
        assert!(!mf.seed_onboarding_docs().unwrap());
        assert_eq!(mf.list_note_paths_from_disk("nb_default").unwrap().len(), ONBOARDING_DOCS.len());
    }

    #[test]
    fn does_not_seed_when_notebook_already_has_notes() {
        let (_dir, mf) = test_memo_file();

        mf.create_memo("Existing Note", "# Existing Note\n", None)
            .unwrap();
        assert!(!mf.seed_onboarding_docs().unwrap());
        assert_eq!(mf.read_index().unwrap().memos.len(), 1);
        assert!(!mf.get_memo_base().join(ONBOARDING_INTRO_PAGE.filename).exists());
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
        assert!(!mf.get_memo_base().join(ONBOARDING_INTRO_PAGE.filename).exists());
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
        let _imported = mf
            .read_index_for_notebook_id(Some("nb_default"))
            .unwrap()
            .unwrap()
            .memos
            .into_iter()
            .find(|memo| memo.filename == "Existing from disk.md")
            .expect("imported memo should be indexed");
        let content = fs::read_to_string(&existing).unwrap();
        assert!(
            content.contains(original),
            "original Markdown body must survive"
        );
        assert!(!content.contains("flowix_key:"));
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
        assert!(other_path.join(ONBOARDING_INTRO_PAGE.filename).exists());
        assert_eq!(mf.read_index().unwrap_or_default().memos.len(), 0);
        assert_eq!(mf.list_note_paths_from_disk("nb_other").unwrap().len(), ONBOARDING_DOCS.len());
        // The active notebook must stay untouched, intro page included.
        assert!(!mf.get_memo_base().join(ONBOARDING_INTRO_PAGE.filename).exists());
    }

    #[test]
    fn reseeds_after_clearing_index_for_a_fresh_notebook() {
        let (_dir, mf) = test_memo_file();

        assert!(mf.seed_onboarding_docs().unwrap());
        assert_eq!(mf.list_note_paths_from_disk("nb_default").unwrap().len(), ONBOARDING_DOCS.len());

        // Simulate another new, empty notebook by clearing the memo index.
        mf.write_index(&MemoIndexFile::default()).unwrap();
        fs::remove_file(mf.get_memo_base().join("Welcome.md")).unwrap();
        fs::remove_file(mf.get_memo_base().join("欢迎文档.md")).unwrap();
        // The path projection is authoritative for emptiness. Reconcile the
        // externally removed files before asking onboarding to seed again.
        mf.reconcile_note_index_blocking("nb_default").unwrap();

        assert!(mf.seed_onboarding_docs().unwrap());
        assert_eq!(mf.list_note_paths_from_disk("nb_default").unwrap().len(), ONBOARDING_DOCS.len());
    }

    #[test]
    fn keeps_user_edits_to_the_intro_page() {
        let (_dir, mf) = test_memo_file();
        assert!(mf.seed_onboarding_docs().unwrap());
        let intro = mf.get_memo_base().join(ONBOARDING_INTRO_PAGE.filename);
        fs::write(&intro, "<!DOCTYPE html><p>edited by user</p>").unwrap();

        // Clear the notes so the same folder seeds again; the existing page must
        // survive because the seed never clobbers a file it did not create.
        mf.write_index(&MemoIndexFile::default()).unwrap();
        fs::remove_file(mf.get_memo_base().join("Welcome.md")).unwrap();
        fs::remove_file(mf.get_memo_base().join("欢迎文档.md")).unwrap();
        mf.reconcile_note_index_blocking("nb_default").unwrap();

        assert!(mf.seed_onboarding_docs().unwrap());
        assert_eq!(
            fs::read_to_string(&intro).unwrap(),
            "<!DOCTYPE html><p>edited by user</p>"
        );
    }
}
