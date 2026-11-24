//! Migration of notebook-local Flowix data into one `.flowix` directory.
//!
//! Copy missing targets file-by-file, keeping legacy sources for recovery.
//! Unfinished migrations check targets on retry; completed migrations never resurrect deletions.

use std::fs;
use std::io;
use std::path::{Component as PathComponent, Path, PathBuf};

use serde_json::Value;

use super::MemoFile;

pub const NOTEBOOK_INTERNAL_MIGRATION_KEY: &str = "notebook_internal_paths_v1";
const NOTEBOOK_INTERNAL_MIGRATION_VERSION: u32 = 1;

#[derive(Debug, Clone, Default)]
pub struct NotebookInternalMigrationReport {
    pub moved_files: usize,
    pub warnings: Vec<String>,
    pub completed: bool,
}

impl NotebookInternalMigrationReport {
    fn warning(&mut self, message: impl Into<String>) {
        self.warnings.push(message.into());
    }
}

impl MemoFile {
    /// Whether a registered notebook still has the old plugin artifact paths.
    /// New notebooks use `.flowix/plugin` from creation and do not need this
    /// migration.
    pub fn has_legacy_notebook_internal_data(&self, notebook_id: &str) -> io::Result<bool> {
        let base = self
            .get_notebook_config_by_id(notebook_id)
            .map(|config| PathBuf::from(config.path))
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("notebook not found: {notebook_id}"),
                )
            })?;
        if !base.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("notebook directory missing: {}", base.display()),
            ));
        }
        Ok(has_legacy_content(&base.join(".plugin-output"))?
            || has_legacy_content(&base.join(".flowix/artifacts"))?)
    }

    /// Copy missing legacy notebook-local data to `.flowix/`.
    /// Completion requires valid targets, not removal of retained sources.
    /// Unfinished retries check targets; completed migrations leave later deletions intact.
    pub fn migrate_notebook_internal_data(
        &self,
        notebook_id: &str,
    ) -> io::Result<NotebookInternalMigrationReport> {
        let base = self
            .get_notebook_config_by_id(notebook_id)
            .map(|config| PathBuf::from(config.path))
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("notebook not found: {notebook_id}"),
                )
            })?;
        if !base.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("notebook directory missing: {}", base.display()),
            ));
        }

        let _guard = self.current_index_io.lock().expect("index_io poisoned");
        let mut report = NotebookInternalMigrationReport::default();
        let flowix = base.join(".flowix");

        if is_symlink(&flowix) {
            report.warning(format!(
                "Flowix directory is a symbolic link: {}",
                flowix.display()
            ));
            return Ok(report);
        }

        // Once migration completed, a missing target may be an intentional
        // deletion. Retained sources are recovery inputs, not a live mirror.
        if self.local_migration_completed(
            &super::NotebookInitializationJob::ResetLegacyStorage.key(notebook_id),
        )? || self
            .notebook_data_migration_version(notebook_id, NOTEBOOK_INTERNAL_MIGRATION_KEY)?
            .unwrap_or_default()
            >= NOTEBOOK_INTERNAL_MIGRATION_VERSION
        {
            report.completed = true;
            return Ok(report);
        }

        migrate_tree(
            &base.join(".plugin-output"),
            &flowix.join("plugin"),
            &base,
            &mut report,
        );
        migrate_legacy_artifacts(
            &flowix.join("artifacts"),
            &flowix.join("plugin"),
            &base,
            &mut report,
        );

        // Completion means targets are ready; legacy sources remain for recovery.
        report.completed = report.warnings.is_empty();
        if report.completed {
            self.mark_notebook_data_migration(
                notebook_id,
                NOTEBOOK_INTERNAL_MIGRATION_KEY,
                NOTEBOOK_INTERNAL_MIGRATION_VERSION,
            )?;
        }
        Ok(report)
    }
}

fn has_legacy_content(path: &Path) -> io::Result<bool> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Ok(true);
    }
    Ok(fs::read_dir(path)?.next().is_some())
}

fn migrate_legacy_artifacts(
    source: &Path,
    plugin_root: &Path,
    base: &Path,
    report: &mut NotebookInternalMigrationReport,
) {
    let Ok(entries) = fs::read_dir(source) else {
        return;
    };
    for entry in entries {
        let Ok(entry) = entry else {
            report.warning(format!(
                "cannot read legacy artifact entry in {}",
                source.display()
            ));
            continue;
        };
        let artifact = entry.path();
        let Some(plugin_id) = legacy_artifact_plugin_id(&artifact) else {
            report.warning(format!(
                "unknown legacy artifact retained: {}",
                artifact.display()
            ));
            continue;
        };
        if !is_safe_component(&plugin_id) {
            report.warning(format!(
                "invalid legacy artifact plugin id retained: {plugin_id}"
            ));
            continue;
        }
        migrate_tree(&artifact, &plugin_root.join(plugin_id), base, report);
    }
}

fn legacy_artifact_plugin_id(path: &Path) -> Option<String> {
    let manifest = fs::read_to_string(path.join("manifest.json")).ok()?;
    let value: Value = serde_json::from_str(&manifest).ok()?;
    value
        .get("pluginId")
        .or_else(|| value.get("plugin_id"))
        .or_else(|| value.get("plugin"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn migrate_tree(
    source: &Path,
    destination: &Path,
    base: &Path,
    report: &mut NotebookInternalMigrationReport,
) {
    let Ok(metadata) = fs::symlink_metadata(source) else {
        return;
    };
    if metadata.file_type().is_symlink() {
        report.warning(format!(
            "symbolic link retained during migration: {}",
            source.display()
        ));
        return;
    }
    if has_symlink_below_base(base, destination) {
        report.warning(format!(
            "symbolic link in migration destination path retained: {}",
            destination.display()
        ));
        return;
    }
    if metadata.is_file() {
        migrate_file(source, destination, report);
        return;
    }
    if !metadata.is_dir() {
        report.warning(format!(
            "unsupported legacy entry retained: {}",
            source.display()
        ));
        return;
    }

    if let Err(error) = fs::create_dir_all(destination) {
        report.warning(format!(
            "create migration directory {}: {error}",
            destination.display()
        ));
        return;
    }
    let entries = match fs::read_dir(source) {
        Ok(entries) => entries,
        Err(error) => {
            report.warning(format!(
                "read legacy directory {}: {error}",
                source.display()
            ));
            return;
        }
    };
    for entry in entries {
        match entry {
            Ok(entry) => migrate_tree(
                &entry.path(),
                &destination.join(entry.file_name()),
                base,
                report,
            ),
            Err(error) => report.warning(format!(
                "read legacy directory entry {}: {error}",
                source.display()
            )),
        }
    }
}

fn migrate_file(source: &Path, destination: &Path, report: &mut NotebookInternalMigrationReport) {
    if let Ok(destination_metadata) = fs::symlink_metadata(destination) {
        if destination_metadata.file_type().is_symlink() || !destination_metadata.is_file() {
            report.warning(format!(
                "migration conflict retained: {}",
                destination.display()
            ));
            return;
        }
        match (fs::read(source), fs::read(destination)) {
            (Ok(left), Ok(right)) if left == right => {}
            (Ok(_), Ok(_)) => {
                tracing::warn!(source = %source.display(), target = %destination.display(),
                "different-content legacy artifact retained; existing target is authoritative")
            }
            (Err(error), _) => {
                report.warning(format!("read legacy file {}: {error}", source.display()))
            }
            (_, Err(error)) => report.warning(format!(
                "read destination file {}: {error}",
                destination.display()
            )),
        }
        return;
    }

    let Some(parent) = destination.parent() else {
        report.warning(format!(
            "destination has no parent: {}",
            destination.display()
        ));
        return;
    };
    if let Err(error) = fs::create_dir_all(parent) {
        report.warning(format!(
            "create migration parent {}: {error}",
            parent.display()
        ));
        return;
    }
    // Stage and publish without overwriting a concurrently created destination.
    let copied = (|| -> io::Result<bool> {
        let mut input = fs::File::open(source)?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        io::copy(&mut input, temporary.as_file_mut())?;
        temporary.as_file().sync_all()?;
        match temporary.persist_noclobber(destination) {
            Ok(_) => Ok(true),
            Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
                if fs::read(source)? == fs::read(destination)? {
                    Ok(false)
                } else {
                    Err(io::Error::other(
                        "different-content migration conflict retained",
                    ))
                }
            }
            Err(error) => Err(error.error),
        }
    })();
    match copied {
        Ok(true) => report.moved_files += 1,
        Ok(false) => {}
        Err(error) => report.warning(format!(
            "copy legacy file {} -> {}: {error}",
            source.display(),
            destination.display()
        )),
    }
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
}

fn has_symlink_below_base(base: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(base) else {
        return true;
    };
    let mut current = base.to_path_buf();
    for component in relative.components() {
        let PathComponent::Normal(name) = component else {
            continue;
        };
        current.push(name);
        if is_symlink(&current) {
            return true;
        }
    }
    false
}

fn is_safe_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.chars().enumerate().all(|(index, ch)| {
            (ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' || ch == '_')
                && (index > 0 || ch.is_ascii_lowercase())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memo_file::{MemoFile, NotebookConfig};

    fn fixture() -> (MemoFile, tempfile::TempDir) {
        let temp = tempfile::tempdir().expect("tempdir");
        let config = temp.path().join("config");
        let notebook = temp.path().join("notebook");
        fs::create_dir_all(&config).expect("config");
        fs::create_dir_all(&notebook).expect("notebook");
        let mf = MemoFile::new(config);
        mf.write_notebook_configs(&[NotebookConfig {
            id: "nb_test".into(),
            name: "Test".into(),
            icon: None,
            path: notebook.to_string_lossy().into_owned(),
            is_default: true,
            sort: 0,
            created_at: 0,
            updated_at: 0,
        }])
        .expect("notebook config");
        (mf, temp)
    }

    #[test]
    fn migrates_plugin_outputs_and_records_marker() {
        let (mf, temp) = fixture();
        let notebook = temp.path().join("notebook");
        let old_plugin = notebook.join(".plugin-output/mindmap/map.md");
        fs::create_dir_all(old_plugin.parent().unwrap()).unwrap();
        fs::write(&old_plugin, "plugin bytes").unwrap();

        let report = mf.migrate_notebook_internal_data("nb_test").unwrap();
        assert_eq!(report.moved_files, 1);
        assert!(report.completed);
        assert_eq!(
            fs::read(notebook.join(".flowix/plugin/mindmap/map.md")).unwrap(),
            b"plugin bytes"
        );
        assert_eq!(fs::read(&old_plugin).unwrap(), b"plugin bytes");
        assert_eq!(
            mf.notebook_data_migration_version("nb_test", NOTEBOOK_INTERNAL_MIGRATION_KEY)
                .unwrap(),
            Some(1)
        );

        let second = mf.migrate_notebook_internal_data("nb_test").unwrap();
        assert_eq!(second.moved_files, 0);
        assert!(second.warnings.is_empty());
        assert!(second.completed);
        let target = notebook.join(".flowix/plugin/mindmap/map.md");
        fs::remove_file(&target).unwrap();
        let repaired = mf.migrate_notebook_internal_data("nb_test").unwrap();
        assert!(repaired.completed);
        assert_eq!(repaired.moved_files, 0);
        assert!(
            !target.exists(),
            "a completed migration must not resurrect deleted targets"
        );
        assert_eq!(fs::read(old_plugin).unwrap(), b"plugin bytes");
        mf.mark_local_migration_completed(
            &super::super::NotebookInitializationJob::ResetLegacyStorage.key("nb_test"),
        )
        .unwrap();
        let conn = rusqlite::Connection::open(notebook.join(".flowix/notebook.db")).unwrap();
        conn.execute("DROP TABLE notebook_data_migrations", [])
            .unwrap();
        assert!(
            mf.migrate_notebook_internal_data("nb_test")
                .unwrap()
                .completed
        );
        assert!(!notebook.join(".flowix/plugin/mindmap/map.md").exists());
    }

    #[test]
    fn conflicting_files_are_kept_and_reported() {
        let (mf, temp) = fixture();
        let notebook = temp.path().join("notebook");
        let old = notebook.join(".plugin-output/webpage/index.html");
        let new = notebook.join(".flowix/plugin/webpage/index.html");
        fs::create_dir_all(old.parent().unwrap()).unwrap();
        fs::create_dir_all(new.parent().unwrap()).unwrap();
        fs::write(&old, "old").unwrap();
        fs::write(&new, "new").unwrap();

        let report = mf.migrate_notebook_internal_data("nb_test").unwrap();
        assert!(report.completed);
        assert_eq!(report.moved_files, 0);
        assert_eq!(fs::read_to_string(&old).unwrap(), "old");
        assert_eq!(fs::read_to_string(&new).unwrap(), "new");
    }

    #[test]
    fn known_legacy_artifact_manifest_is_migrated() {
        let (mf, temp) = fixture();
        let notebook = temp.path().join("notebook");
        let artifact = notebook.join(".flowix/artifacts/abc");
        fs::create_dir_all(&artifact).unwrap();
        fs::write(artifact.join("manifest.json"), r#"{"pluginId":"mindmap"}"#).unwrap();
        fs::write(artifact.join("output.md"), "# Root").unwrap();

        let report = mf.migrate_notebook_internal_data("nb_test").unwrap();
        assert_eq!(report.moved_files, 2);
        assert!(report.completed);
        assert!(notebook.join(".flowix/plugin/mindmap/output.md").is_file());
        assert!(notebook
            .join(".flowix/plugin/mindmap/manifest.json")
            .is_file());
    }
}
