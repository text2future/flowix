use super::*;

/// Archive a rejected local move, then restore the current cloud tree.
pub(crate) fn resolve_v2_move_conflict(
    state: &AppState,
    app: &AppHandle,
    movement: &flowix_sync::V2PendingMove,
) -> Result<(), String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let _guard = memo_file
        .acquire_cross_process_write_lock()
        .map_err(sync_error)?;
    let notebook = memo_file
        .get_notebook_config_by_id(&movement.notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let root = Path::new(&notebook.path);
    let attachment = movement.to_path.starts_with("attachments/");
    let target = safe_cloud_file_path(root, &movement.to_path, attachment)?;
    let conflict_path = cloud_conflict_copy_path(&target, &movement.operation_id);
    if recover_and_register_conflict_stage(
        &memo_file,
        &movement.notebook_id,
        root,
        &target,
        &movement.operation_id,
        &conflict_path,
        attachment,
    )? {
        return Err("CLOUD_CONFLICT_LOCAL_CHANGED: recovered a staged move version".into());
    }
    let local = match std::fs::read(&target) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(sync_error(error)),
    };
    if let Some(bytes) = local.as_deref() {
        record_rejected_cloud_version(&memo_file, &movement.notebook_id, root, &target, bytes)?;
    }
    if let Some(local) = &local {
        match safely_remove_conflict_file(&target, local, &movement.operation_id, &conflict_path)? {
            ConflictFileOutcome::Applied { preserved } => {
                if let Some(preserved) = preserved {
                    register_preserved_conflict_copy(
                        &memo_file,
                        &movement.notebook_id,
                        root,
                        &preserved,
                        attachment,
                    )?;
                }
            }
            ConflictFileOutcome::Interrupted { preserved } => {
                if let Some(preserved) = preserved {
                    register_preserved_conflict_copy(
                        &memo_file,
                        &movement.notebook_id,
                        root,
                        &preserved,
                        attachment,
                    )?;
                }
                return Err(
                    "CLOUD_CONFLICT_LOCAL_CHANGED: move target changed during recovery".into(),
                );
            }
        }
        crate::watcher::runtime::mark_self_write_missing_for(app, &target);
        if attachment {
            memo_file
                .refresh_media_resource_path(&movement.notebook_id, &movement.to_path)
                .map_err(sync_error)?;
        } else if let Some(memo) = memo_file
            .find_memo_by_relative_path_for_notebook_id(&movement.notebook_id, &movement.to_path)
        {
            let _ = memo_file
                .prune_deleted_memo_for_notebook_id(
                    &movement.notebook_id,
                    &movement.to_path,
                    &memo.id,
                )
                .map_err(sync_error)?;
        }
    }
    state
        .cloud_sync
        .discard_v2_move_after_conflict(movement)
        .map_err(sync_error)
}

/// A local delete cannot overwrite a concurrent cloud edit. Keep the prior
/// local revision as a named copy (or a notice if its blob has expired), then
/// rebase to the cloud head so the normal pull restores the edited file.
pub(crate) fn resolve_v2_delete_conflict(
    state: &AppState,
    app: &AppHandle,
    material: &flowix_sync::V2ConflictMaterial,
) -> Result<(), String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let _guard = memo_file
        .acquire_cross_process_write_lock()
        .map_err(sync_error)?;
    let notebook = memo_file
        .get_notebook_config_by_id(&material.notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;

    // A rejected delete has no new bytes. The earlier accepted revision
    // remains in cloud history, and the newer cloud head stays visible.
    let _ = (app, memo_file, notebook);

    if let Some(target) = &material.relocated {
        state
            .cloud_sync
            .v2_rebase_moved_conflict(&material.remote, target)
            .map_err(sync_error)
    } else {
        state
            .cloud_sync
            .v2_rebase_after_conflict(&material.remote)
            .map_err(sync_error)
    }
}
