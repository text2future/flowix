//! One-time cleanup and rebuilding of legacy user storage.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use flowix_core::memo_file::{MemoFile, NotebookConfig, NotebookInitializationJob};
use rusqlite::Connection;

use crate::device_registration::DeviceRegistry;

const NOTEBOOK_STORAGE_RESET_VERSION: u32 = 1;
// An interruption signal, not a completion record. Keep it until the single
// reset job completion has been persisted in local.db.
const NOTEBOOK_RESET_PENDING_FILE: &str = "storage-reset-pending";

pub const CONFIG_LOCAL_MIGRATIONS_JOB: &str = "config_local_migrations_v1";

#[derive(Clone, Copy)]
enum GlobalInitializationJob {
    AgentWorkspace,
    AgentLayout,
    LocalConfiguration,
    WatcherSettings,
    Templates,
}

impl GlobalInitializationJob {
    const ALL: [Self; 5] = [
        Self::AgentWorkspace,
        Self::AgentLayout,
        Self::LocalConfiguration,
        Self::WatcherSettings,
        Self::Templates,
    ];

    fn key(self) -> &'static str {
        match self {
            Self::AgentWorkspace => "agent_workspace_v1",
            Self::AgentLayout => "config_dsh_layout_v2",
            Self::LocalConfiguration => CONFIG_LOCAL_MIGRATIONS_JOB,
            Self::WatcherSettings => "config_watcher_exclusions_v1",
            Self::Templates => "templates_v1",
        }
    }

    fn run(
        self,
        memo_file: &MemoFile,
        user_config: &crate::config::UserConfigStore,
        user_config_dir: &Path,
    ) -> Result<(), String> {
        match self {
            Self::AgentWorkspace => memo_file
                .migrate_legacy_agent_workspace()
                .map(|imported| {
                    tracing::info!(imported, "legacy Agent workspace defaults imported");
                })
                .map_err(|error| format!("import legacy Agent workspace defaults failed: {error}")),
            Self::AgentLayout => user_config.initialize_legacy_dsh_layout(),
            Self::LocalConfiguration => user_config.initialize_legacy_config_migrations(),
            Self::WatcherSettings => user_config
                .clear_legacy_watcher_exclusions()
                .map_err(|error| format!("clear legacy watcher exclusions failed: {error}")),
            Self::Templates => crate::template_store::initialize(user_config_dir)
                .map_err(|error| format!("initialize templates failed: {error}")),
        }
    }
}

const RETIRED_INITIALIZATION_JOB_IDS: [&str; 6] = [
    "storage_reset_v1:plugin",
    "storage_reset_v1:notebook_settings",
    "storage_reset_v1:index",
    "storage_reset_v1:recovery",
    "storage_reset_v1:db_artifacts",
    "builtin_plugins_v1",
];

/// Copy missing global database targets before any store opens a connection.
pub fn prepare_database_paths(config_dir: &Path) -> io::Result<PathBuf> {
    let database_dir = config_dir.join("db");
    for name in ["local.db", "sync.db", "thread.db", "default.db"] {
        if let Err(error) = flowix_core::memo_file::prepare_database_directory(config_dir, &[name])
        {
            tracing::warn!(database = name, %error, "legacy database migration deferred; source retained");
        }
    }
    // Credentials in the secret store must remain private after VACUUM INTO
    // publishes the migrated snapshot.
    #[cfg(unix)]
    if database_dir.join("default.db").is_file() {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            database_dir.join("default.db"),
            fs::Permissions::from_mode(0o600),
        )?;
    }
    Ok(database_dir)
}

/// Run unfinished one-time initialization jobs and retry notebooks that were
/// offline when initialization first ran. Notebook content is never removed.
pub fn initialize_legacy_storage(
    device_registry: &DeviceRegistry,
    memo_file: &MemoFile,
    user_config: &crate::config::UserConfigStore,
    user_config_dir: &Path,
    app_data_dir: &Path,
) -> Result<(), String> {
    initialize_legacy_storage_with_progress(
        device_registry,
        memo_file,
        user_config,
        user_config_dir,
        app_data_dir,
        |_, _, _| {},
    )
    .map(|_| ())
}

/// Returns false when migration work remains pending. The shell can start, but
/// must keep the version incomplete so the next launch retries unfinished jobs.
pub fn initialize_legacy_storage_with_progress(
    device_registry: &DeviceRegistry,
    memo_file: &MemoFile,
    user_config: &crate::config::UserConfigStore,
    user_config_dir: &Path,
    _app_data_dir: &Path,
    mut report: impl FnMut(usize, usize, &str),
) -> Result<bool, String> {
    let notebooks = memo_file.read_notebook_configs().unwrap_or_else(|error| {
        tracing::warn!(%error, "notebook migration source unavailable; skipping notebook jobs");
        Vec::new()
    });
    // Global jobs, retired markers, and the per-notebook jobs.
    // Offline notebook jobs resolve as deferred units instead of stalling progress.
    let total = GlobalInitializationJob::ALL.len()
        + RETIRED_INITIALIZATION_JOB_IDS.len()
        + notebooks.len() * NotebookInitializationJob::ALL.len();
    let mut completed = 0usize;
    let mut all_completed = true;
    for job in GlobalInitializationJob::ALL {
        let result = run_job_with_progress(
            memo_file,
            job.key(),
            || job.run(memo_file, user_config, user_config_dir),
            &mut report,
            &mut completed,
            total,
        );
        if let Err(error) = result {
            all_completed = false;
            tracing::warn!(job_id = job.key(), %error, "initialization job skipped");
        }
    }
    let reset_version = device_registry.notebook_storage_reset_version();
    // Missing completion records are not permission to delete surviving data.
    // Retire old cleanup job markers without deleting their legacy inputs.
    for key in RETIRED_INITIALIZATION_JOB_IDS {
        report(completed, total, key);
        if let Err(error) = memo_file.mark_local_migration_completed(key) {
            tracing::warn!(%error, %key, "retired migration marker skipped");
            all_completed = false;
        }
        completed += 1;
        report(completed, total, key);
    }

    all_completed &= reset_pending_notebooks_with_progress(
        memo_file,
        &notebooks,
        &mut report,
        &mut completed,
        total,
    )
    .unwrap_or_else(|error| {
        tracing::warn!(%error, "notebook migration skipped");
        false
    });
    if all_completed && reset_version < NOTEBOOK_STORAGE_RESET_VERSION {
        if let Err(error) =
            device_registry.complete_notebook_storage_reset_version(NOTEBOOK_STORAGE_RESET_VERSION)
        {
            tracing::warn!(%error, "notebook migration completion marker skipped");
            all_completed = false;
        }
    }
    tracing::info!(
        all_completed,
        "legacy notebook storage initialization attempted"
    );
    Ok(all_completed)
}

fn run_job_with_progress(
    memo_file: &MemoFile,
    key: &str,
    operation: impl FnOnce() -> Result<(), String>,
    report: &mut impl FnMut(usize, usize, &str),
    completed: &mut usize,
    total: usize,
) -> Result<(), String> {
    report(*completed, total, key);
    let result = run_job(memo_file, key, operation);
    *completed += 1;
    report(*completed, total, key);
    result
}

fn run_job(
    memo_file: &MemoFile,
    key: &str,
    operation: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if memo_file
        .local_migration_completed(key)
        .map_err(|error| format!("read initialization job {key} progress failed: {error}"))?
    {
        tracing::debug!(job_id = key, "initialization job already completed");
        return Ok(());
    }
    let started = std::time::Instant::now();
    tracing::info!(job_id = key, "initialization job started");
    if let Err(error) = operation() {
        crate::runtime_log::record_event(
            "error",
            "startup.job_failed",
            serde_json::json!({
                "jobId": key, "error": error, "elapsedMs": started.elapsed().as_millis()
            })
            .to_string(),
        );
        return Err(format!("initialization job {key} failed: {error}"));
    }
    memo_file
        .mark_local_migration_completed(key)
        .map_err(|error| format!("record initialization job {key} completion failed: {error}"))?;
    tracing::info!(job_id = key, "initialization job completed");
    Ok(())
}

fn reset_pending_notebooks(memo_file: &MemoFile) -> Result<(), String> {
    let notebooks = memo_file
        .read_notebook_configs()
        .map_err(|error| format!("read notebooks for storage reset retry failed: {error}"))?;
    let total = notebooks.len() * NotebookInitializationJob::ALL.len();
    let mut completed = 0;
    reset_pending_notebooks_with_progress(
        memo_file,
        &notebooks,
        &mut |_, _, _| {},
        &mut completed,
        total,
    )
    .map(|_| ())
}

fn reset_pending_notebooks_with_progress(
    memo_file: &MemoFile,
    notebooks: &[NotebookConfig],
    report: &mut impl FnMut(usize, usize, &str),
    completed: &mut usize,
    total: usize,
) -> Result<bool, String> {
    let mut all_completed = true;
    for notebook in notebooks {
        for (job_index, job) in NotebookInitializationJob::ALL.into_iter().enumerate() {
            let key = job.key(&notebook.id);
            if memo_file
                .local_migration_completed(&key)
                .map_err(|error| error.to_string())?
            {
                // This job is recorded once, but notebook schemas evolve over
                // time. Re-run the idempotent schema initializers on every
                // startup so existing notebooks receive newer columns and
                // data migrations after the one-time job has completed.
                if matches!(job, NotebookInitializationJob::InitializeSchema) {
                    if !Path::new(&notebook.path).is_dir() {
                        tracing::warn!(job_id = %key, notebook = %notebook.id,
                            "notebook schema refresh deferred until the notebook is available");
                        break;
                    }
                    if let Err(error) = memo_file
                        .initialize_note_index_schema(&notebook.id)
                        .and_then(|_| memo_file.initialize_resource_catalog_schema(&notebook.id))
                    {
                        all_completed = false;
                        tracing::warn!(notebook_id = %notebook.id, %error, "notebook schema refresh deferred");
                        for deferred_job in NotebookInitializationJob::ALL.iter().skip(job_index) {
                            *completed += 1;
                            report(
                                *completed,
                                total,
                                &format!("deferred:{}", deferred_job.key(&notebook.id)),
                            );
                        }
                        break;
                    }
                }
                report(*completed, total, &key);
                *completed += 1;
                report(*completed, total, &key);
                if matches!(job, NotebookInitializationJob::ResetLegacyStorage) {
                    clear_notebook_reset_signal_best_effort(notebook);
                }
                continue;
            }
            if !Path::new(&notebook.path).is_dir() {
                tracing::warn!(job_id = %key, notebook = %notebook.id,
                    "notebook initialization deferred until the notebook is available");
                for deferred_job in NotebookInitializationJob::ALL.iter().skip(job_index) {
                    let deferred_key = deferred_job.key(&notebook.id);
                    *completed += 1;
                    report(*completed, total, &format!("deferred:{deferred_key}"));
                }
                break;
            }
            let result = run_job_with_progress(
                memo_file,
                &key,
                || match job {
                    NotebookInitializationJob::ResetLegacyStorage => {
                        if notebook_requires_reset(memo_file, notebook)? {
                            reset_notebook(memo_file, notebook)?;
                        }
                        Ok(())
                    }
                    NotebookInitializationJob::InitializeSchema => {
                        // Retrying schema preparation must preserve a database
                        // already rebuilt by a successful reset job.
                        memo_file
                            .initialize_note_index_schema(&notebook.id)
                            .and_then(|_| {
                                memo_file.initialize_resource_catalog_schema(&notebook.id)
                            })
                            .map_err(|error| {
                                format!(
                                    "initialize notebook {} database schema failed: {error}",
                                    notebook.id
                                )
                            })
                    }
                    NotebookInitializationJob::MigrateMediaResourceIdentity => memo_file
                        .migrate_media_resource_identities(&notebook.id)
                        .map(|count| {
                            tracing::info!(notebook_id = %notebook.id, changed = count,
                                "media resource identity migration completed");
                        })
                        .map_err(|error| {
                            format!(
                                "migrate notebook {} media identities failed: {error}",
                                notebook.id
                            )
                        }),
                    NotebookInitializationJob::MigrateResourceCatalog => {
                        let migrated = memo_file
                            .migrate_legacy_media_resources_to_catalog(&notebook.id)
                            .map_err(|error| {
                                format!(
                                    "migrate notebook {} resource catalog failed: {error}",
                                    notebook.id
                                )
                            })?;
                        let indexed =
                            memo_file
                                .reconcile_resources(&notebook.id)
                                .map_err(|error| {
                                    format!(
                                        "rebuild notebook {} resource catalog failed: {error}",
                                        notebook.id
                                    )
                                })?;
                        tracing::info!(notebook_id = %notebook.id, migrated, indexed,
                            "shared resource catalog initialized");
                        Ok(())
                    }
                    NotebookInitializationJob::IndexWorkDocuments => memo_file
                        .initialize_resource_catalog_schema(&notebook.id)
                        .and_then(|_| memo_file.reconcile_resources(&notebook.id))
                        .map(|indexed| {
                            tracing::info!(notebook_id = %notebook.id, indexed,
                                    "work document resource index initialized");
                        })
                        .map_err(|error| {
                            format!(
                                "initialize notebook {} work document index failed: {error}",
                                notebook.id
                            )
                        }),
                },
                report,
                completed,
                total,
            );
            if let Err(error) = result {
                // The registry remains critical: a broken journal is not a
                // safe basis for deciding whether a migration may replay.
                memo_file
                    .local_migration_completed(&key)
                    .map_err(|error| error.to_string())?;
                all_completed = false;
                tracing::warn!(job_id = %key, notebook_id = %notebook.id, %error,
                    "notebook migration deferred; continuing with other notebooks");
                for deferred_job in NotebookInitializationJob::ALL.iter().skip(job_index + 1) {
                    *completed += 1;
                    report(
                        *completed,
                        total,
                        &format!("deferred:{}", deferred_job.key(&notebook.id)),
                    );
                }
                break;
            }
            if matches!(job, NotebookInitializationJob::ResetLegacyStorage) {
                clear_notebook_reset_signal_best_effort(notebook);
            }
        }
    }
    Ok(all_completed)
}

fn clear_notebook_reset_signal_best_effort(notebook: &NotebookConfig) {
    let dir = Path::new(&notebook.path).join(".flowix");
    match fs::symlink_metadata(&dir) {
        // Never follow a replaced .flowix symlink to delete a signal elsewhere.
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            if let Err(error) = remove_path(&dir.join(NOTEBOOK_RESET_PENDING_FILE)) {
                tracing::warn!(notebook_id = %notebook.id, %error,
                    "remove completed notebook reset signal failed");
            }
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => tracing::warn!(notebook_id = %notebook.id, %error,
            "inspect completed notebook reset directory failed"),
    }
}

fn notebook_requires_reset(
    memo_file: &MemoFile,
    notebook: &NotebookConfig,
) -> Result<bool, String> {
    let root = Path::new(&notebook.path);
    let flowix = root.join(".flowix");
    if memo_file
        .has_legacy_notebook_internal_data(&notebook.id)
        .map_err(|error| format!("inspect notebook artifacts failed: {error}"))?
        || [
            flowix.join("agent.json"),
            flowix.join(NOTEBOOK_RESET_PENDING_FILE),
        ]
        .iter()
        .any(|path| path.exists())
    {
        return Ok(true);
    }
    // Read old checkpoints only to resume resets interrupted before this
    // simplified implementation. New resets never write stage completions.
    for stage in [
        "plugin-artifacts",
        "derived-reset",
        "note-index",
        "media-index",
    ] {
        let key = format!("storage_reset_v1:notebook:{}:{stage}", notebook.id);
        if memo_file
            .local_migration_completed(&key)
            .map_err(|error| error.to_string())?
        {
            return Ok(true);
        }
    }
    legacy_notebook_database(&flowix.join("notebook.db"))
        .map_err(|error| format!("inspect notebook database failed: {error}"))
}

fn legacy_notebook_database(path: &Path) -> io::Result<bool> {
    if !path.is_file() {
        return Ok(false);
    }
    let conn = Connection::open(path).map_err(sqlite_to_io)?;
    let names = {
        let mut statement = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            )
            .map_err(sqlite_to_io)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(sqlite_to_io)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_to_io)?
    };
    let has_old_memos = names.iter().any(|name| name == "memos");
    let has_old_v2_projection = names.iter().any(|name| name.starts_with("v2_"));
    // Memo tables are migrated in place by the schema job so their
    // non-derivable properties can be preserved before they are retired.
    Ok(has_old_v2_projection && !has_old_memos)
}

fn path_entry_exists(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

// Retry the complete reset safely. Only the enclosing run_job records success.
fn reset_notebook(memo_file: &MemoFile, notebook: &NotebookConfig) -> Result<(), String> {
    let root = Path::new(&notebook.path);
    let flowix_dir = root.join(".flowix");
    if fs::symlink_metadata(&flowix_dir).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(format!(
            "notebook .flowix directory is a symbolic link: {}",
            flowix_dir.display()
        ));
    }
    fs::create_dir_all(&flowix_dir)
        .map_err(|error| format!("create notebook Flowix directory failed: {error}"))?;
    // Persist interruption state before preparing any migration targets.
    flowix_core::memo_file::atomic_write_bytes(&flowix_dir.join(NOTEBOOK_RESET_PENDING_FILE), b"1")
        .map_err(|error| format!("persist notebook reset interruption signal failed: {error}"))?;

    MemoFile::ensure_notebook_manifest(notebook)
        .map_err(|error| format!("restore notebook identity manifest failed: {error}"))?;
    let migration = memo_file
        .migrate_notebook_internal_data(&notebook.id)
        .map_err(|error| format!("preserve notebook plugin artifacts failed: {error}"))?;
    if !migration.completed {
        return Err(format!(
            "notebook {} plugin artifact migration is incomplete: {:?}",
            notebook.id, migration.warnings
        ));
    }

    // Prepare the target projection without deleting legacy Memo-ID tables.
    memo_file
        .initialize_note_index_schema(&notebook.id)
        .map_err(|error| format!("migrate notebook note index failed: {error}"))?;
    memo_file
        .initialize_resource_catalog_schema(&notebook.id)
        .map_err(|error| format!("initialize notebook resource catalog schema failed: {error}"))?;
    memo_file.invalidate_caches();
    // Existing target preferences are authoritative, even with missing reset markers.
    if !path_entry_exists(&flowix_dir.join("view-preferences.json"))
        .map_err(|error| format!("inspect notebook preferences failed: {error}"))?
    {
        crate::commands::file::write_default_notebook_view_preferences(root)?;
    }
    memo_file
        .reconcile_note_index_blocking(&notebook.id)
        .map_err(|error| format!("rebuild notebook note index failed: {error}"))?;

    // Keep legacy configuration and source artifacts available for recovery.
    Ok(())
}

fn remove_path(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || metadata.is_file() => {
            fs::remove_file(path)
        }
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unsupported path type: {}", path.display()),
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn sqlite_to_io(error: rusqlite::Error) -> io::Error {
    io::Error::other(error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, MemoFile, NotebookConfig) {
        let temp = tempfile::tempdir().unwrap();
        let memo = MemoFile::new(temp.path().join("config"));
        memo.initialize_registry_storage().unwrap();
        let root = temp.path().join("notebook");
        fs::create_dir_all(&root).unwrap();
        let notebook = NotebookConfig {
            id: "test".into(),
            name: "notebook".into(),
            icon: None,
            path: root.to_string_lossy().into_owned(),
            is_default: true,
            sort: 0,
            created_at: 0,
            updated_at: 0,
        };
        memo.write_notebook_configs(&[notebook.clone()]).unwrap();
        (temp, memo, notebook)
    }

    #[test]
    fn storage_rebuild_missing_markers_preserves_plugins_and_drafts() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().to_path_buf();
        let config = home.join(crate::USER_CONFIG_DIR_NAME);
        let app_data = home.join("app-data");
        fs::create_dir_all(config.join("plugin/custom")).unwrap();
        fs::write(config.join("plugin/custom/kept.txt"), b"custom plugin").unwrap();
        fs::create_dir_all(app_data.join("recovery-drafts")).unwrap();
        fs::write(app_data.join("recovery-drafts/kept.md"), b"draft").unwrap();
        let user = crate::config::UserConfigStore::new(home);
        let device = DeviceRegistry::load(&config, "test");
        let memo = MemoFile::new(config.clone());
        memo.initialize_registry_storage().unwrap();
        initialize_legacy_storage(&device, &memo, &user, &config, &app_data).unwrap();
        assert_eq!(
            fs::read(config.join("plugin/custom/kept.txt")).unwrap(),
            b"custom plugin"
        );
        assert_eq!(
            fs::read(app_data.join("recovery-drafts/kept.md")).unwrap(),
            b"draft"
        );
    }

    #[test]
    fn registry_initialization_prepares_workspace_tables() {
        let temp = tempfile::tempdir().unwrap();
        let memo = MemoFile::new(temp.path().join("config"));
        memo.initialize_registry_storage().unwrap();
        let conn = Connection::open(memo.registry_db_path()).unwrap();
        for table in ["notebook_add_dirs", "notebook_workspace_state"] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 0);
        }
    }

    #[test]
    fn startup_imports_legacy_agent_workspace_defaults_once() {
        let (temp, memo, notebook) = fixture();
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        fs::write(
            temp.path().join("config/agent-access.json"),
            serde_json::json!({"defaults":{"files":{"_global":{"folders":[repo]}}}}).to_string(),
        )
        .unwrap();
        let config = temp.path().join("config");
        let app_data = temp.path().join("app-data");
        let user = crate::config::UserConfigStore::new(temp.path().to_path_buf());
        let device = DeviceRegistry::load(&config, "test");

        initialize_legacy_storage(&device, &memo, &user, &config, &app_data).unwrap();
        assert!(memo
            .local_migration_completed("agent_workspace_v1")
            .unwrap());
        assert_eq!(
            memo.read_notebook_workspace().unwrap().notebook_configs["test"]
                .add_dirs
                .len(),
            1
        );

        let mut new_notebook = notebook;
        new_notebook.id = "later".into();
        new_notebook.name = "later".into();
        new_notebook.path = temp.path().join("later").to_string_lossy().into();
        fs::create_dir_all(&new_notebook.path).unwrap();
        memo.write_notebook_configs(&[
            memo.read_notebook_configs().unwrap()[0].clone(),
            new_notebook,
        ])
        .unwrap();

        initialize_legacy_storage(&device, &memo, &user, &config, &app_data).unwrap();
        assert!(
            memo.read_notebook_workspace().unwrap().notebook_configs["later"]
                .add_dirs
                .is_empty()
        );
    }

    #[test]
    fn initialization_preserves_legacy_tables_sources_and_target_preferences() {
        let (_temp, memo, notebook) = fixture();
        let root = Path::new(&notebook.path);
        let flowix = root.join(".flowix");
        fs::create_dir_all(&flowix).unwrap();
        fs::write(flowix.join("agent.json"), b"legacy agent").unwrap();
        fs::write(flowix.join("system.json"), b"legacy settings").unwrap();
        fs::write(flowix.join("custom-initialization-marker.json"), b"{}").unwrap();
        let preferences = b"{\"default_create_folder\":\"custom\"}";
        fs::write(flowix.join("view-preferences.json"), preferences).unwrap();
        Connection::open(flowix.join("notebook.db")).unwrap().execute_batch(
            "CREATE TABLE memos (id TEXT); INSERT INTO memos VALUES ('keep');
             CREATE TABLE memo_content_revisions (value TEXT); INSERT INTO memo_content_revisions VALUES ('history');"
        ).unwrap();
        for _ in 0..2 {
            reset_pending_notebooks(&memo).unwrap();
            assert_eq!(
                fs::read(flowix.join("view-preferences.json")).unwrap(),
                preferences
            );
            assert_eq!(
                fs::read(flowix.join("agent.json")).unwrap(),
                b"legacy agent"
            );
            assert_eq!(
                fs::read(flowix.join("system.json")).unwrap(),
                b"legacy settings"
            );
            assert!(flowix.join("custom-initialization-marker.json").exists());
            let conn = Connection::open(flowix.join("notebook.db")).unwrap();
            assert_eq!(
                conn.query_row("SELECT id FROM memos", [], |row| row.get::<_, String>(0))
                    .unwrap(),
                "keep"
            );
            assert_eq!(
                conn.query_row("SELECT value FROM memo_content_revisions", [], |row| row
                    .get::<_, String>(
                    0
                ))
                .unwrap(),
                "history"
            );
            assert_eq!(memo.read_notebook_configs().unwrap()[0].id, notebook.id);
        }
    }

    #[test]
    fn startup_copies_legacy_media_before_scanning_and_does_not_resurrect_deleted_artifacts() {
        let (_temp, memo, notebook) = fixture();
        let root = Path::new(&notebook.path);
        let flowix = root.join(".flowix");
        fs::create_dir_all(&flowix).unwrap();
        fs::write(flowix.join("agent.json"), b"legacy").unwrap();
        fs::write(root.join("photo.png"), b"image").unwrap();
        let source = root.join(".plugin-output/mindmap/map.md");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, b"legacy artifact").unwrap();
        let conn = Connection::open(flowix.join("notebook.db")).unwrap();
        conn.execute_batch("CREATE TABLE media_resources (id TEXT, notebook_id TEXT, relative_path TEXT, kind TEXT,
            size_bytes INTEGER, modified_ms INTEGER, fingerprint TEXT, properties TEXT, properties_revision INTEGER,
            missing_since INTEGER, deleted_at INTEGER, created_at INTEGER, updated_at INTEGER);
            INSERT INTO media_resources VALUES ('old-id','test','photo.png','image',5,1,NULL,
                '{\"caption\":\"legacy metadata\"}',3,NULL,NULL,1,1);").unwrap();
        reset_pending_notebooks(&memo).unwrap();
        let resource = memo
            .read_media_resource("test", "photo.png")
            .unwrap()
            .unwrap();
        assert_eq!(resource.properties["caption"], "legacy metadata");
        let target = flowix.join("plugin/mindmap/map.md");
        assert!(target.exists());
        fs::remove_file(&target).unwrap();
        fs::remove_file(root.join("photo.png")).unwrap();
        conn.execute("DELETE FROM resource_catalog", []).unwrap();
        reset_pending_notebooks(&memo).unwrap();
        memo.migrate_notebook_internal_data("test").unwrap();
        memo.reconcile_resources("test").unwrap();
        assert!(!target.exists());
        assert!(memo
            .read_media_resource("test", "photo.png")
            .unwrap()
            .is_none());
        assert!(source.exists());
        assert_eq!(memo.read_notebook_configs().unwrap()[0].id, notebook.id);
    }

    #[test]
    fn current_view_preferences_do_not_require_reset() {
        let (_temp, memo, notebook) = fixture();
        crate::commands::file::write_default_notebook_view_preferences(Path::new(&notebook.path))
            .unwrap();
        assert!(!notebook_requires_reset(&memo, &notebook).unwrap());
    }

    #[test]
    fn schema_retry_preserves_database_after_completed_reset() {
        let (_temp, memo, notebook) = fixture();
        crate::commands::file::write_default_notebook_view_preferences(Path::new(&notebook.path))
            .unwrap();
        let path = Path::new(&notebook.path).join(".flowix/notebook.db");
        Connection::open(&path).unwrap().execute_batch("CREATE TABLE retained_probe (value TEXT); INSERT INTO retained_probe VALUES ('keep');").unwrap();
        memo.mark_local_migration_completed(
            &NotebookInitializationJob::ResetLegacyStorage.key(&notebook.id),
        )
        .unwrap();
        reset_pending_notebooks(&memo).unwrap();
        let value: String = Connection::open(path)
            .unwrap()
            .query_row("SELECT value FROM retained_probe", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "keep");
        assert!(!memo.has_pending_notebook_storage_initialization().unwrap());
    }

    #[test]
    fn current_status_markers_do_not_reset_preferences() {
        let (_temp, memo, notebook) = fixture();
        let flowix = Path::new(&notebook.path).join(".flowix");
        fs::create_dir_all(&flowix).unwrap();
        fs::write(
            flowix.join("view-preferences.json"),
            b"{\"default_create_folder\":\"custom\"}",
        )
        .unwrap();
        fs::write(flowix.join("file-management-refresh-pending"), b"refresh").unwrap();
        fs::write(flowix.join("custom-initialization-marker.json"), b"{}").unwrap();
        assert!(!notebook_requires_reset(&memo, &notebook).unwrap());
        reset_pending_notebooks(&memo).unwrap();
        assert_eq!(
            fs::read(flowix.join("view-preferences.json")).unwrap(),
            b"{\"default_create_folder\":\"custom\"}"
        );
        assert!(flowix.join("file-management-refresh-pending").exists());
        assert!(flowix.join("custom-initialization-marker.json").exists());
    }

    fn assert_reset_rebuilds_note(memo: &MemoFile, notebook: &NotebookConfig) {
        let root = Path::new(&notebook.path);
        fs::write(root.join("retained.md"), "# Retained note\nbody").unwrap();
        reset_pending_notebooks(memo).unwrap();
        let conn = Connection::open(root.join(".flowix/notebook.db")).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE relative_path = 'retained.md'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(
            fs::read_to_string(root.join("retained.md")).unwrap(),
            "# Retained note\nbody"
        );
        assert!(!root
            .join(".flowix")
            .join(NOTEBOOK_RESET_PENDING_FILE)
            .exists());
        assert!(memo
            .local_migration_completed(
                &NotebookInitializationJob::ResetLegacyStorage.key(&notebook.id)
            )
            .unwrap());
    }

    #[test]
    fn interrupted_reset_rebuilds_indexes_and_records_only_overall_completion() {
        let (_temp, memo, notebook) = fixture();
        let flowix = Path::new(&notebook.path).join(".flowix");
        fs::create_dir_all(&flowix).unwrap();
        // Simulate interruption after legacy sources and derived DB disappeared.
        fs::write(flowix.join(NOTEBOOK_RESET_PENDING_FILE), b"1").unwrap();
        assert_reset_rebuilds_note(&memo, &notebook);
        let conn = Connection::open(memo.registry_db_path()).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM local_migrations WHERE migration_key LIKE 'storage_reset_v1:notebook:test:%'", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0, "new resets must not write stage completions");
    }

    #[test]
    fn legacy_partial_reset_is_retried_without_original_sources() {
        let (_temp, memo, notebook) = fixture();
        memo.mark_local_migration_completed("storage_reset_v1:notebook:test:derived-reset")
            .unwrap();
        assert_reset_rebuilds_note(&memo, &notebook);
    }

    #[test]
    fn failed_job_retries_and_completed_job_skips() {
        let (_temp, memo, _) = fixture();
        assert!(run_job(&memo, "test_retry", || Err("interrupted".into())).is_err());
        assert!(!memo.local_migration_completed("test_retry").unwrap());
        run_job(&memo, "test_retry", || Ok(())).unwrap();
        run_job(&memo, "test_retry", || panic!("completed job ran again")).unwrap();
    }
}
