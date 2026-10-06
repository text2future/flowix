use super::*;

struct DownloadedNotePayload {
    content: Option<Vec<u8>>,
    attachments: Vec<crate::v2::V2RemoteAttachment>,
}

impl SyncManager {
    async fn download_note_payload(
        &self,
        access_token: &str,
        note_id: &str,
        content_hash: Option<&str>,
        deleted: bool,
        attachment_manifest: &[crate::v2::V2Attachment],
    ) -> Result<DownloadedNotePayload, SyncError> {
        let content = if deleted {
            None
        } else if let Some(hash) = content_hash {
            Some(
                self.download_verified_v2_blob(access_token, note_id, hash)
                    .await?,
            )
        } else {
            None
        };

        let mut attachments = Vec::new();
        if !deleted {
            attachments.reserve(attachment_manifest.len());
            for metadata in attachment_manifest {
                attachments.push(crate::v2::V2RemoteAttachment {
                    content: self
                        .download_verified_v2_blob(access_token, note_id, &metadata.content_hash)
                        .await?,
                    metadata: metadata.clone(),
                });
            }
        }

        Ok(DownloadedNotePayload {
            content,
            attachments,
        })
    }

    pub(super) async fn pull_v2_changes(
        &self,
        access_token: &str,
        cursor: i64,
        enabled: &HashSet<&str>,
        notebook_scope: Option<&str>,
        self_sync_seqs: &HashSet<i64>,
    ) -> Result<(Vec<V2RemoteApply>, i64, i64), SyncError> {
        let page = self.client.v2_changes(access_token, cursor, 100).await?;
        let next_cursor = page.cursor;
        let head_cursor = page.head_cursor;
        if next_cursor < cursor || (page.has_more && next_cursor == cursor) {
            return Err(SyncError::InvalidState(
                "cloud v2 changes cursor did not advance".into(),
            ));
        }
        let mut latest = HashMap::<(String, String), V2Change>::new();
        for change in page.changes {
            latest.insert(
                (change.entity_type.clone(), change.entity_id.clone()),
                change,
            );
        }
        let mut changes: Vec<_> = latest.into_values().collect();
        changes.sort_by_key(|change| change.sync_seq);
        let mut remote = Vec::new();
        for change in changes {
            // P0-1: 跳过本端刚 push 产生的 change，避免把自己的上传当成远端更新拉回
            // 覆盖本地（单端 echo）。其他设备的 change 不在 self_sync_seqs 中，正常 apply。
            if self_sync_seqs.contains(&change.sync_seq) {
                continue;
            }
            if change.entity_type == "notebook" {
                if notebook_scope.is_some_and(|scope| scope != change.entity_id) {
                    continue;
                }
                if !enabled.contains(change.entity_id.as_str()) {
                    continue;
                }
                remote.push(V2RemoteApply::Notebook {
                    notebook_id: change.entity_id,
                    name: change.name,
                    icon: change.icon,
                    sort_order: change.sort_order,
                    revision: change.revision,
                    sync_seq: change.sync_seq,
                    deleted: change.deleted,
                });
            } else if change.entity_type == "note" {
                let Some(notebook_id) = change.notebook_id else {
                    return Err(SyncError::InvalidState(
                        "cloud note change has no notebook".into(),
                    ));
                };
                if notebook_scope.is_some_and(|scope| scope != notebook_id) {
                    continue;
                }
                if !enabled.contains(notebook_id.as_str()) {
                    continue;
                }
                let filename = change.filename.ok_or_else(|| {
                    SyncError::InvalidState("cloud note change has no filename".into())
                })?;
                let payload = self
                    .download_note_payload(
                        access_token,
                        &change.entity_id,
                        change.content_hash.as_deref(),
                        change.deleted,
                        &change.attachments,
                    )
                    .await?;
                remote.push(V2RemoteApply::Note {
                    note_id: change.entity_id,
                    notebook_id,
                    filename,
                    content_hash: change.content_hash,
                    content: payload.content,
                    revision: change.revision,
                    sync_seq: change.sync_seq,
                    deleted: change.deleted,
                    attachments: payload.attachments,
                });
            } else {
                return Err(SyncError::InvalidState(format!(
                    "unknown cloud v2 entity type {}",
                    change.entity_type
                )));
            }
        }
        Ok((remote, next_cursor, head_cursor))
    }

    pub(super) async fn remote_from_bootstrap(
        &self,
        access_token: &str,
        enabled: &HashSet<&str>,
        bootstrap: &V2Bootstrap,
    ) -> Result<Vec<V2RemoteApply>, SyncError> {
        let mut remote = Vec::new();
        for notebook in &bootstrap.notebooks {
            if enabled.contains(notebook.id.as_str()) {
                remote.push(V2RemoteApply::Notebook {
                    notebook_id: notebook.id.clone(),
                    name: Some(notebook.name.clone()),
                    icon: notebook.icon.clone(),
                    sort_order: Some(notebook.sort_order),
                    revision: notebook.revision.clone(),
                    sync_seq: notebook.sync_seq,
                    deleted: notebook.deleted,
                });
            }
        }
        for note in &bootstrap.notes {
            if !enabled.contains(note.notebook_id.as_str()) {
                continue;
            }
            let payload = self
                .download_note_payload(
                    access_token,
                    &note.id,
                    note.content_hash.as_deref(),
                    note.deleted,
                    &note.attachments,
                )
                .await?;
            remote.push(V2RemoteApply::Note {
                note_id: note.id.clone(),
                notebook_id: note.notebook_id.clone(),
                filename: note.filename.clone(),
                content_hash: note.content_hash.clone(),
                content: payload.content,
                revision: note.revision.clone(),
                sync_seq: note.sync_seq,
                deleted: note.deleted,
                attachments: payload.attachments,
            });
        }
        remote.sort_by_key(|change| match change {
            V2RemoteApply::Notebook { sync_seq, .. } | V2RemoteApply::Note { sync_seq, .. } => {
                *sync_seq
            }
        });
        Ok(remote)
    }

    pub(super) async fn download_verified_v2_blob(
        &self,
        access_token: &str,
        note_id: &str,
        expected_hash: &str,
    ) -> Result<Vec<u8>, SyncError> {
        let content = self
            .client
            .v2_download_blob(access_token, expected_hash)
            .await?;
        verify_v2_blob(note_id, expected_hash, content)
    }
}
