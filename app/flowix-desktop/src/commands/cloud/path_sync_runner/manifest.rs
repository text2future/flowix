//! Synchronizes notebook identity and explicit notebook deletions.

use flowix_core::memo_file::{MemoFile, NotebookConfig};
use flowix_sync::v4::{
    CloudNotebookManifest, PathNotebookMetadata, PendingNotebookAction, PendingNotebookChange,
};
use tauri::{AppHandle, Emitter};

use crate::app::state::AppState;

/// Propagate only explicit deletions of notebooks no longer registered locally.
/// This never scans or transfers the contents of a non-current notebook.
pub(in crate::commands::cloud) async fn flush_deleted_notebook_manifests(
    state: &AppState,
    app: &AppHandle,
) -> Result<(), String> {
    let configs = MemoFile::new(state.user_config.config_dir().clone())
        .read_notebook_configs()
        .map_err(|error| format!("CLOUD_NOTEBOOK_CONFIG_READ_FAILED: {error}"))?;
    let pending = state
        .cloud_sync
        .v4_pending_notebook_changes()
        .map_err(|error| format!("CLOUD_NOTEBOOK_METADATA_READ_FAILED: {error}"))?;
    for change in pending
        .iter()
        .filter(|change| change.action == PendingNotebookAction::Delete)
    {
        if configs.iter().any(|config| config.id == change.notebook_id) {
            continue;
        }
        sync_notebook_manifest(
            state,
            app,
            &change.notebook_id,
            None,
            Some(change),
            &configs,
        )
        .await?;
    }
    Ok(())
}

pub(super) async fn sync_notebook_manifest(
    state: &AppState,
    app: &AppHandle,
    notebook_id: &str,
    config: Option<&NotebookConfig>,
    pending: Option<&PendingNotebookChange>,
    current_configs: &[NotebookConfig],
) -> Result<bool, String> {
    let remote = state
        .cloud_sync
        .v4_get_notebook_manifest(notebook_id)
        .await
        .map_err(|error| format!("CLOUD_NOTEBOOK_MANIFEST_READ_FAILED: {notebook_id}: {error}"))?;

    if pending.is_some_and(|change| change.action == PendingNotebookAction::Delete) {
        let deleted = CloudNotebookManifest {
            schema: 1,
            name: config
                .map(|config| config.name.clone())
                .or_else(|| remote.as_ref().map(|(manifest, _)| manifest.name.clone()))
                .unwrap_or_default(),
            icon: config.and_then(|config| config.icon.clone()).or_else(|| {
                remote
                    .as_ref()
                    .and_then(|(manifest, _)| manifest.icon.clone())
            }),
            sort_order: config
                .map(|config| config.sort)
                .or_else(|| remote.as_ref().map(|(manifest, _)| manifest.sort_order))
                .unwrap_or_default(),
            deleted: true,
            created_at: config
                .map(|config| config.created_at)
                .or_else(|| remote.as_ref().map(|(manifest, _)| manifest.created_at))
                .unwrap_or_default(),
        };
        if remote
            .as_ref()
            .is_some_and(|(manifest, _)| manifest == &deleted)
        {
            state
                .cloud_sync
                .v4_ack_notebook_change(
                    notebook_id,
                    pending.unwrap().generation,
                    PendingNotebookAction::Delete,
                )
                .map_err(|error| format!("CLOUD_NOTEBOOK_MANIFEST_ACK_FAILED: {error}"))?;
        } else if state
            .cloud_sync
            .v4_put_notebook_manifest(notebook_id, &deleted)
            .await
            .map_err(|error| {
                format!("CLOUD_NOTEBOOK_MANIFEST_WRITE_FAILED: {notebook_id}: {error}")
            })?
        {
            state
                .cloud_sync
                .v4_ack_notebook_change(
                    notebook_id,
                    pending.unwrap().generation,
                    PendingNotebookAction::Delete,
                )
                .map_err(|error| format!("CLOUD_NOTEBOOK_MANIFEST_ACK_FAILED: {error}"))?;
        }
        return Ok(false);
    }

    let Some(config) = config else {
        return Ok(false);
    };
    let local_manifest = CloudNotebookManifest {
        schema: 1,
        name: config.name.clone(),
        icon: config.icon.clone(),
        sort_order: config.sort,
        deleted: false,
        created_at: config.created_at,
    };

    if pending.is_some_and(|change| change.action == PendingNotebookAction::Put) {
        if remote
            .as_ref()
            .is_some_and(|(manifest, _)| manifest == &local_manifest)
        {
            state
                .cloud_sync
                .v4_ack_notebook_change(
                    notebook_id,
                    pending.unwrap().generation,
                    PendingNotebookAction::Put,
                )
                .map_err(|error| format!("CLOUD_NOTEBOOK_MANIFEST_ACK_FAILED: {error}"))?;
        } else if state
            .cloud_sync
            .v4_put_notebook_manifest(notebook_id, &local_manifest)
            .await
            .map_err(|error| {
                format!("CLOUD_NOTEBOOK_MANIFEST_WRITE_FAILED: {notebook_id}: {error}")
            })?
        {
            state
                .cloud_sync
                .v4_ack_notebook_change(
                    notebook_id,
                    pending.unwrap().generation,
                    PendingNotebookAction::Put,
                )
                .map_err(|error| format!("CLOUD_NOTEBOOK_MANIFEST_ACK_FAILED: {error}"))?;
        }
        return Ok(true);
    }

    let Some((remote_manifest, _)) = remote else {
        state
            .cloud_sync
            .v4_put_notebook_manifest(notebook_id, &local_manifest)
            .await
            .map_err(|error| {
                format!("CLOUD_NOTEBOOK_MANIFEST_WRITE_FAILED: {notebook_id}: {error}")
            })?;
        return Ok(true);
    };
    if remote_manifest.deleted {
        state
            .cloud_sync
            .set_path_notebook_enabled(
                &PathNotebookMetadata {
                    id: config.id.clone(),
                    name: config.name.clone(),
                    icon: config.icon.clone(),
                    sort_order: config.sort,
                },
                false,
            )
            .map_err(|error| format!("CLOUD_NOTEBOOK_UNLINK_FAILED: {notebook_id}: {error}"))?;
        let _ = app.emit("notebooks-changed", ());
        return Ok(false);
    }

    if remote_manifest.name != config.name
        || remote_manifest.icon != config.icon
        || remote_manifest.sort_order != config.sort
    {
        let mut next_configs = current_configs.to_vec();
        if let Some(local) = next_configs
            .iter_mut()
            .find(|local| local.id == notebook_id)
        {
            local.name = remote_manifest.name;
            local.icon = remote_manifest.icon;
            local.sort = remote_manifest.sort_order;
        }
        MemoFile::new(state.user_config.config_dir().clone())
            .write_notebook_configs(&next_configs)
            .map_err(|error| {
                format!("CLOUD_NOTEBOOK_MANIFEST_APPLY_FAILED: {notebook_id}: {error}")
            })?;
        let _ = app.emit("notebooks-changed", ());
    }
    Ok(true)
}
