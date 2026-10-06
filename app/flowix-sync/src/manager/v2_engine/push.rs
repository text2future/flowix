use super::*;

impl SyncManager {
    pub(super) async fn push_v2_inflight(
        &self,
        access_token: &str,
        due: &[crate::v2::V2InflightOperation],
        generation: u64,
    ) -> Result<(usize, usize, HashSet<i64>), SyncError> {
        let mut uploaded = 0;
        let mut deleted = 0;
        // P0-1: 记录本批次 push 在服务端拿到的 sync_seq，回传给 pull 阶段，用于过滤
        // 本端自己的回声（单端 push 后 pull 用旧 cursor 又拉回自己刚推上去的内容）。
        let mut self_sync_seqs: HashSet<i64> = HashSet::new();
        for batch in due.chunks(100) {
            drop(self.require_auth_generation(generation)?);
            let operations = batch
                .iter()
                .map(|item| {
                    serde_json::from_str::<V2PushOperation>(&item.payload_json).map_err(|error| {
                        SyncError::InvalidState(format!("invalid frozen v2 operation: {error}"))
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            let result = match self.client.v2_push(access_token, &operations).await {
                Ok(result) => result,
                Err(error) => {
                    let _generation = self.require_auth_generation(generation)?;
                    for item in batch {
                        self.store.defer_v2_operation(
                            &item.operation_id,
                            Utc::now().timestamp_millis(),
                            &error.to_string(),
                        )?;
                    }
                    return Err(error);
                }
            };
            let _generation = self.require_auth_generation(generation)?;
            let by_id: HashMap<&str, &crate::v2::V2OperationResult> = result
                .results
                .iter()
                .map(|item| (item.operation_id.as_str(), item))
                .collect();
            let operations_by_id: HashMap<&str, &V2PushOperation> = operations
                .iter()
                .map(|operation| {
                    let operation_id = match operation {
                        V2PushOperation::NotebookPut { operation_id, .. }
                        | V2PushOperation::NotebookDelete { operation_id, .. }
                        | V2PushOperation::NotePut { operation_id, .. }
                        | V2PushOperation::NoteDelete { operation_id, .. }
                        | V2PushOperation::NoteMove { operation_id, .. } => operation_id,
                    };
                    (operation_id.as_str(), operation)
                })
                .collect();
            for item in batch {
                let response = by_id.get(item.operation_id.as_str()).ok_or_else(|| {
                    SyncError::InvalidState(format!(
                        "cloud omitted operation result {}",
                        item.operation_id
                    ))
                })?;
                if response.ok {
                    let data = response.data.as_ref().ok_or_else(|| {
                        SyncError::InvalidState(format!(
                            "cloud omitted successful operation data {}",
                            item.operation_id
                        ))
                    })?;
                    let operation = operations_by_id
                        .get(item.operation_id.as_str())
                        .ok_or_else(|| {
                            SyncError::InvalidState(format!(
                                "local push batch omitted operation {}",
                                item.operation_id
                            ))
                        })?;
                    self_sync_seqs.insert(data.sync_seq);
                    self.store.acknowledge_v2_operation(
                        &item.operation_id,
                        item.entity_type,
                        &item.entity_id,
                        item.generation,
                        operation,
                        data,
                    )?;
                    match item.operation_kind {
                        V2OperationKind::Put => uploaded += 1,
                        V2OperationKind::Delete => deleted += 1,
                    }
                } else {
                    if response.status == 409
                        && response
                            .error
                            .as_ref()
                            .is_some_and(|error| error.code == "REVISION_CONFLICT")
                    {
                        // Never pull and acknowledge the newer cloud head while
                        // this frozen local edit still targets an older base.
                        // Doing so would cause the next scan to upload the local
                        // bytes as a fresh edit and silently replace the peer.
                        return Err(SyncError::RevisionConflict {
                            notebook_id: operations_by_id
                                .get(item.operation_id.as_str())
                                .and_then(|operation| match operation {
                                    V2PushOperation::NotePut { note, .. } => {
                                        Some(note.notebook_id.clone())
                                    }
                                    _ => None,
                                })
                                .unwrap_or_default(),
                            note_id: item.entity_id.clone(),
                            operation_id: item.operation_id.clone(),
                            operation_kind: item.operation_kind.as_str().to_string(),
                            current_revision: response
                                .error
                                .as_ref()
                                .and_then(|error| error.details.as_ref())
                                .and_then(|details| details.get("currentRevision"))
                                .and_then(|value| value.as_str())
                                .unwrap_or_default()
                                .to_string(),
                        });
                    }
                    let message = response
                        .error
                        .as_ref()
                        .map(|error| format!("{}: {}", error.code, error.message))
                        .unwrap_or_else(|| {
                            format!("operation failed with status {}", response.status)
                        });
                    self.store.defer_v2_operation(
                        &item.operation_id,
                        Utc::now().timestamp_millis(),
                        &message,
                    )?;
                }
            }
        }
        Ok((uploaded, deleted, self_sync_seqs))
    }
}
