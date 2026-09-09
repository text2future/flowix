use std::io;
use std::path::Path;

use super::MemoFile;

/// Consolidate notebook-owned Flowix files under `.flowix/` and ensure every
/// registered notebook has its portable identity manifest.
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
        MemoFile::ensure_notebook_manifest(&notebook)?;
        let report = memo_file.migrate_notebook_internal_data(&notebook.id)?;
        if !report.completed {
            return Err(io::Error::other(format!(
                "notebook {} migration incomplete: {}",
                notebook.id,
                report.warnings.join("; ")
            )));
        }
    }
    Ok(())
}
