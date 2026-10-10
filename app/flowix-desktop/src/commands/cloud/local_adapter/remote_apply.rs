use super::*;

pub(crate) fn safe_cloud_file_path(
    base: &Path,
    filename: &str,
    attachment: bool,
) -> Result<PathBuf, String> {
    let candidate = Path::new(filename);
    if (!attachment && !candidate.is_md())
        || (attachment && !filename.starts_with("attachments/"))
        || filename.contains('\\')
        || filename.starts_with('/')
        || candidate
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
        || candidate
            .components()
            .any(|component| component.as_os_str().to_string_lossy().starts_with('.'))
    {
        return Err("INVALID_CLOUD_FILENAME".to_string());
    }
    let mut path = base.to_path_buf();
    for component in candidate.components() {
        path.push(component.as_os_str());
        if let Ok(metadata) = std::fs::symlink_metadata(&path) {
            if metadata.file_type().is_symlink() {
                return Err("CLOUD_PATH_SYMLINK".to_string());
            }
        }
    }
    Ok(path)
}

pub(crate) fn safe_cloud_note_path(base: &Path, filename: &str) -> Result<PathBuf, String> {
    safe_cloud_file_path(base, filename, false)
}

pub(super) fn write_cloud_attachments(
    base: &Path,
    attachments: &[flowix_sync::V2RemoteAttachment],
) -> Result<(), String> {
    for attachment in attachments {
        let filename = &attachment.metadata.filename;
        let relative = Path::new(filename);
        if relative.is_absolute()
            || relative
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
            || relative.components().next() == Some(std::path::Component::CurDir)
            || attachment.metadata.size_bytes
                != i64::try_from(attachment.content.len()).map_err(|_| "ATTACHMENT_TOO_LARGE")?
            || v2_content_hash(&attachment.content) != attachment.metadata.content_hash
        {
            return Err(format!("CLOUD_ATTACHMENT_INVALID: {filename}"));
        }
        let relative_name = match relative.strip_prefix("attachments") {
            Ok(path) => format!("attachments/{}", path.display()),
            Err(_) => format!("attachments/{filename}"),
        };
        let path = safe_cloud_file_path(base, &relative_name, true)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(sync_error)?;
        }
        match flowix_core::memo_file::atomic_create_bytes(&path, &attachment.content) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if std::fs::read(&path).map_err(sync_error)? != attachment.content {
                    return Err(format!("CLOUD_ATTACHMENT_EDIT_CONFLICT: {filename}"));
                }
            }
            Err(error) => return Err(sync_error(error)),
        }
    }
    Ok(())
}

fn apply_v2_note_changes(
    state: &AppState,
    app: &AppHandle,
    notebook_id: &str,
    changes: &[&V2RemoteApply],
) -> Result<(), String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let _write_guard = memo_file.operation_locks()
        .notebook_change(&[notebook_id], "apply_cloud_note_changes")
        .map_err(sync_error)?;
    let notebook = memo_file
        .get_notebook_config_by_id(notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let base = PathBuf::from(&notebook.path);
    for change in changes {
        let V2RemoteApply::Note {
            note_id,
            filename,
            content_hash,
            content,
            deleted,
            attachments,
            ..
        } = change
        else {
            continue;
        };
        if filename.starts_with("attachments/") {
            let path = safe_cloud_file_path(&base, filename, true)?;
            let local_bytes = match std::fs::read(&path) {
                Ok(bytes) => Some(bytes),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(format!("CLOUD_ATTACHMENT_READ_FAILED: {error}")),
            };
            let local_hash = local_bytes.as_ref().map(|bytes| v2_content_hash(bytes));
            let baseline_hash = state
                .cloud_sync
                .v2_note_state(note_id)
                .map_err(sync_error)?
                .and_then(|value| value.content_hash);
            let pending = state
                .cloud_sync
                .has_pending_v2_note_change(note_id)
                .map_err(sync_error)?;
            if *deleted {
                if v2_local_content_diverged(
                    local_hash.as_deref(),
                    baseline_hash.as_deref(),
                    pending,
                ) {
                    return Err(format!("CLOUD_ATTACHMENT_DELETE_CONFLICT: {filename}"));
                }
                if let Some(expected) = local_bytes.as_deref() {
                    crate::watcher::runtime::mark_self_write_for(app, &path);
                    let copy = cloud_conflict_copy_path(&path, note_id);
                    match safely_remove_conflict_file(&path, expected, note_id, &copy)? {
                        ConflictFileOutcome::Applied { preserved: None } => {}
                        outcome => {
                            let preserved = match outcome {
                                ConflictFileOutcome::Applied { preserved }
                                | ConflictFileOutcome::Interrupted { preserved } => preserved,
                            };
                            if let Some(preserved) = preserved {
                                register_preserved_conflict_copy(
                                    &memo_file,
                                    notebook_id,
                                    &base,
                                    &preserved,
                                    true,
                                )?;
                            }
                            return Err(format!("CLOUD_ATTACHMENT_DELETE_CONFLICT: {filename}"));
                        }
                    }
                }
                continue;
            }
            let bytes = content
                .as_ref()
                .ok_or_else(|| format!("CLOUD_ATTACHMENT_CONTENT_MISSING: {filename}"))?;
            let expected_hash = content_hash
                .as_deref()
                .ok_or_else(|| format!("CLOUD_ATTACHMENT_HASH_MISSING: {filename}"))?;
            if v2_content_hash(bytes) != expected_hash {
                return Err(format!("CLOUD_ATTACHMENT_HASH_MISMATCH: {filename}"));
            }
            if local_hash.as_deref() == Some(expected_hash) {
                continue;
            }
            if v2_local_content_diverged(local_hash.as_deref(), baseline_hash.as_deref(), pending) {
                return Err(format!("CLOUD_ATTACHMENT_EDIT_CONFLICT: {filename}"));
            }
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(sync_error)?;
            }
            crate::watcher::runtime::mark_self_write_for(app, &path);
            let copy = cloud_conflict_copy_path(&path, note_id);
            match safely_replace_cloud_file(&path, local_bytes.as_deref(), bytes, note_id, &copy)? {
                ConflictFileOutcome::Applied { preserved: None } => {}
                outcome => {
                    let preserved = match outcome {
                        ConflictFileOutcome::Applied { preserved }
                        | ConflictFileOutcome::Interrupted { preserved } => preserved,
                    };
                    if let Some(preserved) = preserved {
                        register_preserved_conflict_copy(
                            &memo_file,
                            notebook_id,
                            &base,
                            &preserved,
                            true,
                        )?;
                    }
                    return Err(format!("CLOUD_ATTACHMENT_EDIT_CONFLICT: {filename}"));
                }
            }
            continue;
        }
        if *deleted {
            if let Some(memo) = deletion::delete_cloud_note_locked(
                &memo_file,
                &state.cloud_sync,
                notebook_id,
                note_id,
                filename,
                |path| crate::watcher::runtime::mark_self_write_for(app, path),
            )? {
                let path = notebook_path_from_relative(&base, &memo.relative_path)
                    .unwrap_or_else(|_| base.join(&memo.filename));
                let derived_changed = MemoDerivedChanged::from_deleted(&memo);
                memo_events::emit(
                    app,
                    MemoEvent::Deleted {
                        id: memo.id.clone(),
                        path: path.to_string_lossy().into_owned(),
                        relative_path: memo.relative_path.clone(),
                        notebook_id: notebook_id.to_string(),
                        derived_changed,
                        source: MemoChangeSource::CloudSync,
                    },
                );
            }
        } else {
            let bytes = content
                .as_ref()
                .ok_or_else(|| format!("CLOUD_NOTE_CONTENT_MISSING: {note_id}"))?;
            let expected_hash = content_hash
                .as_deref()
                .ok_or_else(|| format!("CLOUD_NOTE_HASH_MISSING: {note_id}"))?;
            let actual_hash = v2_content_hash(bytes);
            if actual_hash != expected_hash {
                return Err(format!(
                        "CLOUD_NOTE_HASH_MISMATCH: note {note_id} expected {expected_hash} got {actual_hash}"
                    ));
            }
            let markdown = std::str::from_utf8(bytes)
                .map_err(|_| format!("CLOUD_NOTE_NOT_UTF8: {note_id}"))?;
            write_cloud_attachments(&base, attachments)?;
            let current_memo =
                memo_file.find_memo_by_relative_path_for_notebook_id(notebook_id, filename);
            let old_path = current_memo.as_ref().map(|memo| {
                notebook_path_from_relative(&base, &memo.relative_path)
                    .unwrap_or_else(|_| base.join(&memo.filename))
            });
            let desired_path = safe_cloud_note_path(&base, filename)?;
            if desired_path.exists() && old_path.as_ref() != Some(&desired_path) {
                memo_file
                    .register_existing_file_for_notebook_id(notebook_id, &desired_path)
                    .map_err(sync_error)?;
                if std::fs::read(&desired_path).map_err(sync_error)? != *bytes {
                    return Err(format!(
                        "CLOUD_PATH_COLLISION: local file preserved at {filename}"
                    ));
                }
                continue;
            }
            // P0-2: 单端同步回声抑制。本端 push 后紧接的 pull 会用旧 cursor 把刚推上去
            // 的内容再拉回来（协议暂无 device 维度去重）。若此时本地磁盘正文与远端
            // content_hash 一致，说明是回声而非真实远端更新，跳过覆盖写与 Updated 事件
            // ——否则文件监听器会把这次“内容未变”的写盘误判为外部编辑，弹“文档已被外部
            // 修改”。附件已由上方 write_cloud_attachments 幂等落盘，filename/位置未变时
            // 无需重写正文。
            // 本地磁盘当前正文哈希：P0-2 回声判据与 P1-3 本地编辑判据共用。
            let disk_bytes = match std::fs::read(&desired_path) {
                Ok(bytes) => Some(bytes),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(sync_error(error)),
            };
            let disk_hash = disk_bytes.as_ref().map(|bytes| v2_content_hash(bytes));

            // P0-2: 回声 / 内容已一致 → 跳过写盘与事件（避免监听器把“内容未变”的
            // 写盘误判为外部编辑）。
            if matches!(&old_path, Some(path) if path == &desired_path)
                && disk_hash.as_deref() == Some(expected_hash)
            {
                let memo = memo_file
                    .register_existing_file_for_notebook_id(notebook_id, &desired_path)
                    .map_err(sync_error)?;
                let _ = memo;
                continue;
            }

            // P1-3: 本地有未同步编辑时不接受远端覆盖（本地会在下次 push 以最新远端
            // revision 为 base 补推上去）。两条判据取或：
            //   ① has_pending_v2_note_change —— sync dirty 队列，但由 watcher 处理编辑器
            //     保存事件后才打标记，有 ~400ms settle 延迟；
            //   ② 磁盘正文偏离同步基线 note_state.content_hash —— 即时读盘+读同步状态，
            //     堵住 ① 的延迟窗口：快速编辑时编辑器刚保存、watcher 还没 mark dirty，
            //     但磁盘已领先于同步基线，据此判定本地已编辑、不覆盖。
            let baseline_hash = state
                .cloud_sync
                .v2_note_state(note_id)
                .ok()
                .flatten()
                .and_then(|stored| stored.content_hash);
            let has_pending_change = state
                .cloud_sync
                .has_pending_v2_note_change(note_id)
                .unwrap_or(false);
            let locally_edited = v2_local_content_diverged(
                disk_hash.as_deref(),
                baseline_hash.as_deref(),
                has_pending_change,
            );
            if locally_edited {
                return Err(format!(
                    "CLOUD_LOCAL_EDIT_CONFLICT: local file preserved at {filename}"
                ));
            }
            if let Some(path) = &old_path {
                crate::watcher::runtime::mark_self_write_for(app, path);
            }
            if let Some(parent) = desired_path.parent() {
                std::fs::create_dir_all(parent).map_err(sync_error)?;
            }
            let copy = cloud_conflict_copy_path(&desired_path, note_id);
            match safely_replace_cloud_file(
                &desired_path,
                disk_bytes.as_deref(),
                markdown.as_bytes(),
                note_id,
                &copy,
            )? {
                ConflictFileOutcome::Applied { preserved: None } => {}
                outcome => {
                    let preserved = match outcome {
                        ConflictFileOutcome::Applied { preserved }
                        | ConflictFileOutcome::Interrupted { preserved } => preserved,
                    };
                    if let Some(preserved) = preserved {
                        register_preserved_conflict_copy(
                            &memo_file,
                            notebook_id,
                            &base,
                            &preserved,
                            false,
                        )?;
                    }
                    return Err(format!(
                        "CLOUD_LOCAL_EDIT_CONFLICT: local file preserved at {filename}"
                    ));
                }
            }
            let memo = memo_file
                .register_existing_file_for_notebook_id(notebook_id, &desired_path)
                .map_err(sync_error)?;
            if let Some(path) = old_path.filter(|path| path != &desired_path) {
                if path.exists() {
                    std::fs::remove_file(&path).map_err(sync_error)?;
                }
            }
            memo_events::emit(
                app,
                MemoEvent::Updated {
                    id: memo.id.clone(),
                    path: desired_path.to_string_lossy().into_owned(),
                    notebook_id: notebook_id.to_string(),
                    derived_changed: MemoDerivedChanged {
                        tags: true,
                        todos: true,
                        agents: true,
                    },
                    memo,
                    source: MemoChangeSource::CloudSync,
                },
            );
        }
    }
    Ok(())
}

pub(crate) fn apply_v2_report(
    state: &AppState,
    app: &AppHandle,
    report: &V2AccountSyncReport,
) -> Result<(), String> {
    let mut note_changes = HashMap::<String, Vec<&V2RemoteApply>>::new();
    let mut notebook_metadata =
        HashMap::<String, (Option<String>, Option<String>, Option<i64>, bool)>::new();
    for change in &report.remote {
        match change {
            V2RemoteApply::Notebook {
                notebook_id,
                name,
                icon,
                sort_order,
                deleted,
                ..
            } => {
                notebook_metadata.insert(
                    notebook_id.clone(),
                    (name.clone(), icon.clone(), *sort_order, *deleted),
                );
            }
            V2RemoteApply::Note { notebook_id, .. } => {
                note_changes
                    .entry(notebook_id.clone())
                    .or_default()
                    .push(change);
            }
        }
    }

    for (notebook_id, changes) in note_changes {
        apply_v2_note_changes(state, app, &notebook_id, &changes)?;
    }

    if !notebook_metadata.is_empty() {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let mut configs = memo_file.read_notebook_configs().map_err(sync_error)?;
        let mut changed = false;
        configs.retain(|config| {
            let deleted = notebook_metadata
                .get(&config.id)
                .is_some_and(|(_, _, _, deleted)| *deleted);
            if deleted {
                changed = true;
                if state.agent_access.remove_notebook(&config.id) {
                    crate::events::emit_to(
                        app,
                        crate::commands::agent_access::AGENT_ACCESS_CHANGED_EVENT,
                        (),
                    );
                }
            }
            !deleted
        });
        for config in &mut configs {
            let Some((name, icon, sort_order, deleted)) = notebook_metadata.get(&config.id) else {
                continue;
            };
            if *deleted {
                continue;
            }
            if let Some(name) = name {
                if config.name != *name {
                    config.name.clone_from(name);
                    changed = true;
                }
            }
            if config.icon != *icon {
                config.icon.clone_from(icon);
                changed = true;
            }
            if let Some(sort_order) = sort_order {
                if config.sort != *sort_order {
                    config.sort = *sort_order;
                    changed = true;
                }
            }
        }
        if changed {
            memo_file
                .write_notebook_configs(&configs)
                .map_err(sync_error)?;
            drop(memo_file);
            crate::events::emit_to(app, crate::commands::notebook::NOTEBOOKS_CHANGED_EVENT, ());
            crate::commands::helpers::refresh_watcher_roots(state, app);
        }
    }
    Ok(())
}
