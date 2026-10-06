use super::*;

/// Resolve a rejected file put before its old server head is acknowledged.
/// This handles both Markdown notes and binary attachments. The caller reruns
/// a full snapshot after disk state and the local revision base are updated.
pub(crate) fn resolve_v2_file_put_conflict(
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
    if material.remote.filename.starts_with("attachments/") {
        let notebook_root = Path::new(&notebook.path);
        let path = safe_cloud_file_path(notebook_root, &material.remote.filename, true)?;
        let stem: String = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("attachment")
            .chars()
            .take(80)
            .collect();
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let filename = if extension.is_empty() {
            format!("{stem} (Flowix conflict {})", material.operation_id)
        } else {
            format!(
                "{stem} (Flowix conflict {}).{extension}",
                material.operation_id
            )
        };
        let copy_path = path.with_file_name(filename);
        if recover_and_register_conflict_stage(
            &memo_file,
            &material.notebook_id,
            notebook_root,
            &path,
            &material.operation_id,
            &copy_path,
            true,
        )? {
            return Err(
                "CLOUD_CONFLICT_LOCAL_CHANGED: recovered a staged attachment version".into(),
            );
        }
        let local = std::fs::read(&path).map_err(sync_error)?;
        record_rejected_cloud_version(
            &memo_file,
            &material.notebook_id,
            notebook_root,
            &path,
            &local,
        )?;
        if std::fs::read(&path).map_err(sync_error)? != local {
            return Err("CLOUD_CONFLICT_LOCAL_CHANGED: local changes preserved".to_string());
        }
        if material.remote.deleted && material.relocated.is_none() {
            crate::watcher::runtime::mark_self_write_for(app, &path);
            match safely_remove_conflict_file(&path, &local, &material.operation_id, &copy_path)? {
                ConflictFileOutcome::Applied { preserved } => {
                    if let Some(preserved) = preserved {
                        register_preserved_conflict_copy(
                            &memo_file,
                            &material.notebook_id,
                            notebook_root,
                            &preserved,
                            true,
                        )?;
                    }
                }
                ConflictFileOutcome::Interrupted { preserved } => {
                    if let Some(preserved) = preserved {
                        register_preserved_conflict_copy(
                            &memo_file,
                            &material.notebook_id,
                            notebook_root,
                            &preserved,
                            true,
                        )?;
                    }
                    return Err(
                        "CLOUD_CONFLICT_LOCAL_CHANGED: attachment changed during recovery".into(),
                    );
                }
            }
            crate::watcher::runtime::mark_self_write_missing_for(app, &path);
            if flowix_core::memo_file::media_kind_for_path(&path).is_some() {
                memo_file
                    .refresh_media_resource_path(&material.notebook_id, &material.remote.filename)
                    .map_err(sync_error)?;
            }
            let _ = app.emit(
                "media-properties-changed",
                serde_json::json!({ "notebookId": material.notebook_id }),
            );
            return state
                .cloud_sync
                .v2_rebase_after_conflict(&material.remote)
                .map_err(sync_error);
        }
        let remote = material
            .remote_content
            .as_deref()
            .ok_or_else(|| "CLOUD_CONFLICT_REMOTE_UNAVAILABLE".to_string())?;
        let destination = if let Some(target) = &material.relocated {
            let destination =
                safe_cloud_file_path(Path::new(&notebook.path), &target.filename, true)?;
            if destination.exists() {
                return Err("CLOUD_MOVE_TARGET_COLLISION: local changes preserved".to_string());
            }
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent).map_err(sync_error)?;
            }
            crate::watcher::runtime::mark_self_write_for(app, &path);
            crate::watcher::runtime::mark_self_write_for(app, &destination);
            flowix_core::memo_file::rename_file_noclobber(&path, &destination)
                .map_err(sync_error)?;
            if flowix_core::memo_file::media_kind_for_path(&destination).is_some() {
                if let Err(error) = memo_file.move_media_resource_path(
                    &material.notebook_id,
                    &material.remote.filename,
                    &target.filename,
                ) {
                    let _ = flowix_core::memo_file::rename_file_noclobber(&destination, &path);
                    return Err(sync_error(error));
                }
            }
            destination
        } else {
            crate::watcher::runtime::mark_self_write_for(app, &path);
            path.clone()
        };
        crate::watcher::runtime::mark_self_write_for(app, &destination);
        match safely_replace_conflict_file(
            &destination,
            &local,
            remote,
            &material.operation_id,
            &copy_path,
        )? {
            ConflictFileOutcome::Applied { preserved } => {
                if let Some(preserved) = preserved {
                    register_preserved_conflict_copy(
                        &memo_file,
                        &material.notebook_id,
                        notebook_root,
                        &preserved,
                        true,
                    )?;
                }
            }
            ConflictFileOutcome::Interrupted { preserved } => {
                if let Some(preserved) = preserved {
                    register_preserved_conflict_copy(
                        &memo_file,
                        &material.notebook_id,
                        notebook_root,
                        &preserved,
                        true,
                    )?;
                }
                if material.relocated.is_some()
                    && !path.exists()
                    && destination.exists()
                    && flowix_core::memo_file::rename_file_noclobber(&destination, &path).is_ok()
                {
                    let _ = memo_file.move_media_resource_path(
                        &material.notebook_id,
                        material
                            .relocated
                            .as_ref()
                            .map_or(material.remote.filename.as_str(), |item| {
                                item.filename.as_str()
                            }),
                        &material.remote.filename,
                    );
                }
                return Err(
                    "CLOUD_CONFLICT_LOCAL_CHANGED: attachment changed during recovery".into(),
                );
            }
        }
        crate::watcher::runtime::mark_self_write_content_for(app, &destination, remote);
        if flowix_core::memo_file::media_kind_for_path(&destination).is_some() {
            memo_file
                .refresh_media_resource_path(
                    &material.notebook_id,
                    material
                        .relocated
                        .as_ref()
                        .map_or(material.remote.filename.as_str(), |target| {
                            target.filename.as_str()
                        }),
                )
                .map_err(sync_error)?;
        }
        let _ = app.emit(
            "media-properties-changed",
            serde_json::json!({ "notebookId": material.notebook_id }),
        );
        return if let Some(target) = &material.relocated {
            state
                .cloud_sync
                .v2_rebase_moved_conflict(&material.remote, target)
                .map_err(sync_error)
        } else {
            state
                .cloud_sync
                .v2_rebase_after_conflict(&material.remote)
                .map_err(sync_error)
        };
    }
    let memo = memo_file
        .find_memo_by_relative_path_for_notebook_id(
            &material.notebook_id,
            &material.remote.filename,
        )
        .ok_or_else(|| "CLOUD_CONFLICT_LOCAL_NOTE_NOT_FOUND".to_string())?;
    if material.remote.filename != memo.relative_path {
        return Err("CLOUD_PATH_OR_DELETE_CONFLICT: local changes preserved".to_string());
    }
    let path = notebook_path_from_relative(Path::new(&notebook.path), &memo.relative_path)?;
    let conflict_copy = path.with_file_name(format!(
        "{} (Flowix conflict {}).md",
        path.file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("Note"),
        material.operation_id,
    ));
    if recover_and_register_conflict_stage(
        &memo_file,
        &material.notebook_id,
        Path::new(&notebook.path),
        &path,
        &material.operation_id,
        &conflict_copy,
        false,
    )? {
        return Err("CLOUD_CONFLICT_LOCAL_CHANGED: recovered a staged note version".into());
    }
    let local = std::fs::read(&path).map_err(sync_error)?;
    if material.remote.deleted && material.relocated.is_none() {
        record_rejected_cloud_version(
            &memo_file,
            &material.notebook_id,
            Path::new(&notebook.path),
            &path,
            &local,
        )?;
        let copy_path = conflict_copy.clone();
        if std::fs::read(&path).map_err(sync_error)? != local {
            return Err("CLOUD_CONFLICT_LOCAL_CHANGED: local changes preserved".into());
        }
        match safely_remove_conflict_file(&path, &local, &material.operation_id, &copy_path)? {
            ConflictFileOutcome::Applied { preserved } => {
                if let Some(preserved) = preserved {
                    register_preserved_conflict_copy(
                        &memo_file,
                        &material.notebook_id,
                        Path::new(&notebook.path),
                        &preserved,
                        false,
                    )?;
                }
            }
            ConflictFileOutcome::Interrupted { preserved } => {
                if let Some(preserved) = preserved {
                    register_preserved_conflict_copy(
                        &memo_file,
                        &material.notebook_id,
                        Path::new(&notebook.path),
                        &preserved,
                        false,
                    )?;
                }
                return Err(
                    "CLOUD_CONFLICT_LOCAL_CHANGED: local note changed during recovery".into(),
                );
            }
        }
        crate::watcher::runtime::mark_self_write_for(app, &path);
        if !memo_file
            .prune_deleted_memo_for_notebook_id(
                &material.notebook_id,
                &material.remote.filename,
                &memo.id,
            )
            .map_err(sync_error)?
        {
            return Err(
                "CLOUD_CONFLICT_LOCAL_CHANGED: local note reappeared during recovery".into(),
            );
        }
        crate::watcher::runtime::mark_self_write_missing_for(app, &path);
        return state
            .cloud_sync
            .v2_rebase_after_conflict(&material.remote)
            .map_err(sync_error);
    }
    let remote = material
        .remote_content
        .as_deref()
        .ok_or_else(|| "CLOUD_CONFLICT_REMOTE_UNAVAILABLE".to_string())?;
    let (next, archive_local) =
        choose_markdown_conflict_content(material.base_content.as_deref(), &local, remote);
    if archive_local {
        record_rejected_cloud_version(
            &memo_file,
            &material.notebook_id,
            Path::new(&notebook.path),
            &path,
            &local,
        )?;
    }
    if std::fs::read(&path).map_err(sync_error)? != local {
        return Err("CLOUD_CONFLICT_LOCAL_CHANGED: local changes preserved".to_string());
    }
    let destination = if let Some(target) = &material.relocated {
        let destination = safe_cloud_note_path(Path::new(&notebook.path), &target.filename)?;
        if destination.exists() {
            return Err("CLOUD_MOVE_TARGET_COLLISION: local changes preserved".to_string());
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(sync_error)?;
        }
        crate::watcher::runtime::mark_self_write_for(app, &path);
        crate::watcher::runtime::mark_self_write_for(app, &destination);
        flowix_core::memo_file::rename_file_noclobber(&path, &destination).map_err(sync_error)?;
        if let Err(error) =
            memo_file.rename_memo_file_for_notebook_id(&material.notebook_id, &path, &destination)
        {
            let _ = flowix_core::memo_file::rename_file_noclobber(&destination, &path);
            return Err(error);
        }
        destination
    } else {
        crate::watcher::runtime::mark_self_write_for(app, &path);
        path.clone()
    };
    match safely_replace_conflict_file(
        &destination,
        &local,
        &next,
        &material.operation_id,
        &conflict_copy,
    )? {
        ConflictFileOutcome::Applied { preserved } => {
            if let Some(preserved) = preserved {
                register_preserved_conflict_copy(
                    &memo_file,
                    &material.notebook_id,
                    Path::new(&notebook.path),
                    &preserved,
                    false,
                )?;
            }
        }
        ConflictFileOutcome::Interrupted { preserved } => {
            if let Some(preserved) = preserved {
                register_preserved_conflict_copy(
                    &memo_file,
                    &material.notebook_id,
                    Path::new(&notebook.path),
                    &preserved,
                    false,
                )?;
            }
            if material.relocated.is_some()
                && !path.exists()
                && destination.exists()
                && flowix_core::memo_file::rename_file_noclobber(&destination, &path).is_ok()
            {
                let _ = memo_file.rename_memo_file_for_notebook_id(
                    &material.notebook_id,
                    &destination,
                    &path,
                );
            }
            return Err("CLOUD_CONFLICT_LOCAL_CHANGED: local note changed during recovery".into());
        }
    }
    crate::watcher::runtime::mark_self_write_content_for(app, &destination, &next);
    let updated = memo_file
        .register_existing_file_for_notebook_id(&material.notebook_id, &destination)
        .map_err(sync_error)?;
    memo_events::emit(
        app,
        MemoEvent::Updated {
            id: updated.id.clone(),
            path: destination.to_string_lossy().into_owned(),
            notebook_id: material.notebook_id.clone(),
            derived_changed: MemoDerivedChanged {
                tags: true,
                todos: true,
                agents: true,
            },
            memo: updated,
            source: MemoChangeSource::CloudSync,
        },
    );
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
