use std::io;
use std::path::Path;

use super::MemoFile;

/// Backfill the memo index with tags derived from both YAML and Markdown.
///
/// Notebook-local markers make this migration safe for notebooks added after
/// the application-level migration version has already advanced.
pub(super) fn run(memo_file: &MemoFile) -> io::Result<()> {
    for notebook in memo_file.read_notebook_configs()? {
        if !Path::new(&notebook.path).is_dir() {
            tracing::debug!(
                notebook = %notebook.id,
                path = %notebook.path,
                "skip notebook migration for unavailable notebook"
            );
            continue;
        }
        memo_file.ensure_tag_union_index_for_notebook_id(&notebook.id)?;
    }
    Ok(())
}
