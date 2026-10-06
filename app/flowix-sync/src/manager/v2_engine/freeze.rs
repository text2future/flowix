use super::*;

impl SyncManager {
    pub(super) async fn freeze_new_v2_operations(
        &self,
        access_token: &str,
        notebooks: &[V2LocalNotebook],
        notes: &[V2LocalNote],
        notebook_scope: Option<&str>,
        generation: u64,
    ) -> Result<(), SyncError> {
        let notebooks_by_id: HashMap<&str, &V2LocalNotebook> = notebooks
            .iter()
            .map(|item| (item.id.as_str(), item))
            .collect();
        let notes_by_id: HashMap<&str, &V2LocalNote> =
            notes.iter().map(|item| (item.id.as_str(), item)).collect();
        for dirty in self.store.v2_dirty_entities()? {
            drop(self.require_auth_generation(generation)?);
            if let Some(scope) = notebook_scope {
                let belongs_to_scope = match dirty.entity_type {
                    V2EntityType::Notebook => dirty.entity_id == scope,
                    V2EntityType::Note => dirty.notebook_id.as_deref() == Some(scope),
                };
                if !belongs_to_scope {
                    continue;
                }
            }
            if self
                .store
                .v2_inflight_for_generation(dirty.entity_type, &dirty.entity_id, dirty.generation)?
                .is_some()
            {
                continue;
            }
            let operation_id = crate::v2::new_v2_operation_id();
            let base_revision = match dirty.entity_type {
                V2EntityType::Notebook => self
                    .store
                    .v2_notebook_state(&dirty.entity_id)?
                    .map(|state| state.revision),
                V2EntityType::Note => self
                    .store
                    .v2_note_state(&dirty.entity_id)?
                    .map(|state| state.revision),
            };
            let operation = match (dirty.entity_type, dirty.operation_kind) {
                (V2EntityType::Notebook, V2OperationKind::Put) => {
                    let Some(notebook) = notebooks_by_id.get(dirty.entity_id.as_str()) else {
                        continue;
                    };
                    V2PushOperation::NotebookPut {
                        operation_id: operation_id.clone(),
                        base_revision: base_revision.clone(),
                        notebook: crate::v2::V2NotebookPut {
                            id: notebook.id.clone(),
                            name: notebook.name.clone(),
                            icon: notebook.icon.clone(),
                            sort_order: notebook.sort_order,
                        },
                    }
                }
                (V2EntityType::Notebook, V2OperationKind::Delete) => {
                    V2PushOperation::NotebookDelete {
                        operation_id: operation_id.clone(),
                        base_revision: base_revision.clone(),
                        notebook_id: dirty.entity_id.clone(),
                        base_tree_seq: self
                            .store
                            .v2_notebook_cursor(&dirty.entity_id)?
                            .max(self.store.v2_cursor()?),
                    }
                }
                (V2EntityType::Note, V2OperationKind::Put) => {
                    let Some(note) = notes_by_id.get(dirty.entity_id.as_str()) else {
                        continue;
                    };
                    let content_hash = crate::v2::v2_content_hash(&note.content);
                    let reservation = self
                        .client
                        .v2_reserve_blob(
                            access_token,
                            &content_hash,
                            i64::try_from(note.content.len()).map_err(|_| {
                                SyncError::InvalidState("memo content length exceeds i64".into())
                            })?,
                            if note.filename.starts_with("attachments/") {
                                "attachment"
                            } else {
                                "note"
                            },
                            if note.filename.starts_with("attachments/") {
                                "application/octet-stream"
                            } else {
                                "text/markdown; charset=utf-8"
                            },
                        )
                        .await?;
                    drop(self.require_auth_generation(generation)?);
                    self.client
                        .v2_upload_blob(
                            access_token,
                            &reservation.upload,
                            if note.filename.starts_with("attachments/") {
                                "application/octet-stream"
                            } else {
                                "text/markdown; charset=utf-8"
                            },
                            note.content.clone(),
                        )
                        .await?;
                    for attachment in &note.attachments {
                        drop(self.require_auth_generation(generation)?);
                        let reservation = self
                            .client
                            .v2_reserve_blob(
                                access_token,
                                &attachment.metadata.content_hash,
                                attachment.metadata.size_bytes,
                                "attachment",
                                &attachment.metadata.mime_type,
                            )
                            .await?;
                        drop(self.require_auth_generation(generation)?);
                        self.client
                            .v2_upload_blob(
                                access_token,
                                &reservation.upload,
                                &attachment.metadata.mime_type,
                                attachment.content.clone(),
                            )
                            .await?;
                    }
                    V2PushOperation::NotePut {
                        operation_id: operation_id.clone(),
                        base_revision: base_revision.clone(),
                        note: crate::v2::V2NotePut {
                            id: note.id.clone(),
                            notebook_id: note.notebook_id.clone(),
                            filename: note.filename.clone(),
                            file_kind: if note.filename.starts_with("attachments/") {
                                "attachment".into()
                            } else {
                                "markdown".into()
                            },
                            content_hash,
                            size_bytes: i64::try_from(note.content.len()).map_err(|_| {
                                SyncError::InvalidState("memo content length exceeds i64".into())
                            })?,
                            attachments: note
                                .attachments
                                .iter()
                                .map(|item| item.metadata.clone())
                                .collect(),
                        },
                    }
                }
                (V2EntityType::Note, V2OperationKind::Delete) => V2PushOperation::NoteDelete {
                    operation_id: operation_id.clone(),
                    base_revision: base_revision.clone(),
                    note_id: dirty.entity_id.clone(),
                },
            };
            let payload = serde_json::to_string(&operation).map_err(|error| {
                SyncError::InvalidState(format!("serialize v2 operation: {error}"))
            })?;
            let _generation = self.require_auth_generation(generation)?;
            match self.store.freeze_v2_operation(V2FreezeOperation {
                operation_id: &operation_id,
                entity_type: dirty.entity_type,
                entity_id: &dirty.entity_id,
                generation: dirty.generation,
                operation_kind: dirty.operation_kind,
                base_revision: base_revision.as_deref(),
                payload_json: &payload,
            }) {
                Ok(_) => {}
                Err(SyncError::InvalidState(message))
                    if message.starts_with("dirty generation changed before operation freeze") => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
}
