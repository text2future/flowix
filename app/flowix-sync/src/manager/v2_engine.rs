use super::*;
use std::collections::HashMap;

mod inbound;
mod observe;
mod freeze;
mod push;
mod sync_pipeline;

fn verify_v2_blob(
    note_id: &str,
    expected_hash: &str,
    content: Vec<u8>,
) -> Result<Vec<u8>, SyncError> {
    let actual_hash = crate::v2::v2_content_hash(&content);
    if actual_hash != expected_hash {
        return Err(SyncError::InvalidState(format!(
            "cloud blob hash mismatch for note {note_id}: expected {expected_hash}, got {actual_hash}"
        )));
    }
    Ok(content)
}

fn v2_note_fingerprint(note: &crate::v2::V2LocalNote) -> Result<String, SyncError> {
    let mut attachments: Vec<_> = note
        .attachments
        .iter()
        .map(|item| item.metadata.clone())
        .collect();
    attachments.sort();
    let canonical = serde_json::to_vec(&(crate::v2::v2_content_hash(&note.content), attachments))
        .map_err(|error| {
        SyncError::InvalidState(format!("serialize attachment manifest: {error}"))
    })?;
    Ok(crate::v2::v2_content_hash(&canonical))
}

fn find_v2_relocated_note(
    notes: &[crate::v2::V2BootstrapNote],
    notebook_id: &str,
    source_note_id: &str,
) -> Option<crate::v2::V2BootstrapNote> {
    let mut predecessor = source_note_id.to_string();
    let mut visited = HashSet::from([predecessor.clone()]);
    for _ in 0..notes.len() {
        // Reused paths leave older tombstones pointing at the same predecessor.
        // Follow the newest edge and stop if malformed lineage forms a cycle.
        let next = notes.iter()
            .filter(|note| note.notebook_id == notebook_id
                && note.moved_from_note_id.as_deref() == Some(predecessor.as_str()))
            .max_by_key(|note| note.sync_seq)?;
        if !visited.insert(next.id.clone()) {
            return None;
        }
        if !next.deleted {
            return Some(next.clone());
        }
        predecessor.clone_from(&next.id);
    }
    None
}

impl SyncManager {
    pub fn record_v2_local_move(
        &self,
        notebook_id: &str,
        from_path: &str,
        to_path: &str,
    ) -> Result<bool, SyncError> {
        if !self.store.v2_notebooks(true)?.iter().any(|item| item.notebook_id == notebook_id) {
            return Ok(false);
        }
        self.store.enqueue_v2_move(notebook_id, from_path, to_path)
    }

    pub fn v2_pending_moves(&self) -> Result<Vec<crate::v2::V2PendingMove>, SyncError> {
        self.store.v2_pending_moves()
    }

    pub fn v2_pending_move(&self, operation_id: &str) -> Result<Option<crate::v2::V2PendingMove>, SyncError> {
        self.store.v2_pending_move(operation_id)
    }

    pub fn discard_v2_move_after_conflict(
        &self,
        movement: &crate::v2::V2PendingMove,
    ) -> Result<(), SyncError> {
        self.store.discard_v2_move_after_conflict(movement)
    }

    async fn push_v2_pending_moves(
        &self,
        access_token: &str,
        notebook_scope: Option<&str>,
        generation: u64,
    ) -> Result<HashSet<i64>, SyncError> {
        let mut self_sync_seqs = HashSet::new();
        for movement in self.store.v2_pending_moves()?
            .into_iter().filter(|item| notebook_scope.is_none_or(|scope| scope == item.notebook_id)) {
            drop(self.require_auth_generation(generation)?);
            let result = self.client.v2_push(access_token, &[V2PushOperation::NoteMove {
                operation_id: movement.operation_id.clone(),
                base_revision: Some(movement.base_revision.clone()),
                notebook_id: movement.notebook_id.clone(),
                from_note_id: movement.from_note_id.clone(),
                from_path: movement.from_path.clone(),
                to_note_id: movement.to_note_id.clone(),
                to_path: movement.to_path.clone(),
            }]).await?;
            let response = result.results.into_iter().next()
                .ok_or_else(|| SyncError::InvalidState("move result omitted".into()))?;
            if !response.ok {
                let error = response.error.ok_or_else(|| SyncError::InvalidState("move error omitted".into()))?;
                if (response.status == 409 && matches!(error.code.as_str(), "REVISION_CONFLICT" | "PATH_CONFLICT"))
                    || (response.status == 404 && error.code == "FILE_NOT_FOUND")
                {
                    return Err(SyncError::MoveConflict {
                        notebook_id: movement.notebook_id.clone(),
                        operation_id: movement.operation_id.clone(),
                        from_path: movement.from_path.clone(),
                        to_path: movement.to_path.clone(),
                    });
                }
                return Err(SyncError::Api {
                    status: response.status, code: error.code, message: error.message,
                    details: error.details,
                });
            }
            let data = response.data.ok_or_else(|| SyncError::InvalidState("move data omitted".into()))?;
            drop(self.require_auth_generation(generation)?);
            self.store.acknowledge_v2_move(&movement, &data)?;
            self_sync_seqs.insert(data.sync_seq);
            if let Some(source_seq) = data.source_sync_seq { self_sync_seqs.insert(source_seq); }
        }
        Ok(self_sync_seqs)
    }

    pub async fn v2_conflict_material(
        &self,
        notebook_id: &str,
        note_id: &str,
        operation_id: &str,
    ) -> Result<crate::v2::V2ConflictMaterial, SyncError> {
        let generation = self.auth_generation();
        let mut token = self.access_token(generation).await?;
        let baseline = self.store.v2_note_state(note_id)?;
        let mut page = self.client.v2_bootstrap_page(&token, None).await?;
        let snapshot_cursor = page.cursor;
        let mut remote = None;
        let mut lineage = Vec::new();
        let mut pages = 0;
        loop {
            for note in page.notes {
                if note.notebook_id != notebook_id { continue; }
                if note.id == note_id { remote = Some(note.clone()); }
                if note.moved_from_note_id.is_some() { lineage.push(note); }
            }
            let Some(page_token) = page.next_page_token else { break; };
            pages += 1;
            if pages > 10_000 {
                return Err(SyncError::InvalidState("bootstrap exceeded page limit".into()));
            }
            let first = self.client.v2_bootstrap_page(&token, Some(&page_token)).await;
            page = if first.as_ref().is_err_and(SyncError::is_unauthorized) {
                token = self.force_refresh_access_token(generation).await?;
                self.client.v2_bootstrap_page(&token, Some(&page_token)).await?
            } else { first? };
            if page.cursor != snapshot_cursor {
                return Err(SyncError::InvalidState("bootstrap snapshot cursor changed".into()));
            }
        }
        let remote = remote
            .ok_or_else(|| SyncError::InvalidState(format!("conflicting cloud file {note_id} disappeared")))?;
        let relocated = remote.deleted.then(|| {
            find_v2_relocated_note(&lineage, notebook_id, note_id)
        }).flatten();
        let base_content = match baseline.as_ref().and_then(|state| state.content_hash.as_deref()) {
            Some(hash) => match self.download_verified_v2_blob(&token, note_id, hash).await {
                Ok(content) => Some(content),
                // Retention may remove the ancestor. The desktop falls back to
                // archiving local bytes and applying the latest cloud head.
                Err(SyncError::Api { status: 404, .. }) => None,
                Err(error) => return Err(error),
            },
            None => None,
        };
        let remote_content = match relocated.as_ref().unwrap_or(&remote).content_hash.as_deref() {
            Some(hash) => Some(self.download_verified_v2_blob(&token, note_id, hash).await?),
            None => None,
        };
        drop(self.require_auth_generation(generation)?);
        Ok(crate::v2::V2ConflictMaterial {
            notebook_id: notebook_id.to_string(),
            note_id: note_id.to_string(),
            operation_id: operation_id.to_string(),
            remote,
            relocated,
            base_content,
            remote_content,
        })
    }

    pub fn v2_rebase_after_conflict(
        &self,
        remote: &crate::v2::V2BootstrapNote,
    ) -> Result<(), SyncError> {
        self.store.rebase_v2_note_after_conflict(remote)
    }

    pub fn v2_rebase_moved_conflict(
        &self,
        source: &crate::v2::V2BootstrapNote,
        target: &crate::v2::V2BootstrapNote,
    ) -> Result<(), SyncError> {
        self.store.rebase_v2_moved_conflict(source, target)
    }

    pub fn v2_notebook(
        &self,
        notebook_id: &str,
    ) -> Result<Option<crate::v2::V2SyncedNotebook>, SyncError> {
        Ok(self
            .store
            .v2_notebooks(false)?
            .into_iter()
            .find(|notebook| notebook.notebook_id == notebook_id))
    }

    /// 单条 note 的同步基线状态（content_hash 等）。desktop 适配层在 apply 远端变更前
    /// 用它做"本地是否已编辑"的即时判据：磁盘正文哈希偏离这个基线，说明本地自上次
    /// 同步后改过，远端覆盖会丢弃本地编辑。
    pub fn v2_note_state(
        &self,
        note_id: &str,
    ) -> Result<Option<crate::v2::V2NoteState>, SyncError> {
        self.store.v2_note_state(note_id)
    }

    pub async fn v2_history(&self, note_id: &str) -> Result<crate::v2::V2History, SyncError> {
        let generation = self.auth_generation();
        let token = self.access_token(generation).await?;
        let history = self.client.v2_history(&token, note_id).await?;
        let _guard = self.require_auth_generation(generation)?;
        Ok(history)
    }

    pub async fn v2_historical_bytes(&self, note_id: &str, revision: &str)
        -> Result<(crate::v2::V2History, Vec<u8>), SyncError> {
        let generation = self.auth_generation();
        let token = self.access_token(generation).await?;
        let history = self.client.v2_history(&token, note_id).await?;
        let entry = history.revisions.iter().find(|entry| entry.revision == revision && !entry.deleted)
            .ok_or_else(|| SyncError::InvalidState("history revision is unavailable".into()))?;
        let hash = entry.content_hash.as_deref()
            .ok_or_else(|| SyncError::InvalidState("history revision has no content".into()))?;
        let bytes = self.download_verified_v2_blob(&token, note_id, hash).await?;
        let _guard = self.require_auth_generation(generation)?;
        Ok((history, bytes))
    }

    pub fn v2_all_note_states(&self) -> Result<Vec<crate::v2::V2NoteState>, SyncError> {
        self.store.v2_all_note_states()
    }

    pub fn v2_enabled_notebooks(&self) -> Result<Vec<crate::v2::V2SyncedNotebook>, SyncError> {
        self.store.v2_notebooks(true)
    }

    pub fn v2_pending_file_operation_counts(&self) -> Result<HashMap<String, i64>, SyncError> {
        self.store.v2_pending_file_operation_counts()
    }

    /// Return note ids that have local changes waiting to be uploaded.
    ///
    /// The desktop adapter uses this set to build an incremental local
    /// snapshot. The dirty queue remains the source of truth for upload
    /// operations; this method only avoids rereading unchanged Markdown.
    pub fn v2_dirty_note_ids(&self) -> Result<HashSet<String>, SyncError> {
        Ok(self
            .store
            .v2_dirty_entities()?
            .into_iter()
            .filter(|dirty| dirty.entity_type == V2EntityType::Note)
            .map(|dirty| dirty.entity_id)
            .collect())
    }

    pub fn v2_retry_delay(&self, now: i64) -> Result<Option<i64>, SyncError> {
        Ok(self
            .store
            .v2_next_retry_at()?
            .map(|retry_at| retry_at.saturating_sub(now).max(1)))
    }

    pub async fn v2_remote_notebooks(
        &self,
    ) -> Result<Vec<crate::models::CloudNotebook>, SyncError> {
        let generation = self.auth_generation();
        let mut token = self.access_token(generation).await?;
        let first = self.client.v2_bootstrap_page(&token, None).await;
        let mut bootstrap = if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            token = self.force_refresh_access_token(generation).await?;
            self.client.v2_bootstrap_page(&token, None).await?
        } else {
            first?
        };
        let mut used_bytes_by_notebook = HashMap::new();
        let notebooks = std::mem::take(&mut bootstrap.notebooks);
        let snapshot_cursor = bootstrap.cursor;
        let mut pages = 0;
        loop {
            for note in bootstrap.notes.iter().filter(|note| !note.deleted) {
                let attachment_bytes = note.attachments.iter().fold(0_i64, |total, attachment| {
                    total.saturating_add(attachment.size_bytes.max(0))
                });
                let note_bytes = note.size_bytes.max(0).saturating_add(attachment_bytes);
                let total = used_bytes_by_notebook
                    .entry(note.notebook_id.clone())
                    .or_insert(0_i64);
                *total = total.saturating_add(note_bytes);
            }
            let Some(page_token) = bootstrap.next_page_token.take() else { break; };
            pages += 1;
            if pages > 10_000 {
                return Err(SyncError::InvalidState("bootstrap exceeded page limit".into()));
            }
            let first = self.client.v2_bootstrap_page(&token, Some(&page_token)).await;
            bootstrap = if first.as_ref().is_err_and(SyncError::is_unauthorized) {
                token = self.force_refresh_access_token(generation).await?;
                self.client.v2_bootstrap_page(&token, Some(&page_token)).await?
            } else { first? };
            if bootstrap.cursor != snapshot_cursor {
                return Err(SyncError::InvalidState("bootstrap snapshot cursor changed".into()));
            }
        }
        let _generation = self.require_auth_generation(generation)?;
        let enabled: HashSet<String> = self
            .store
            .v2_notebooks(true)?
            .into_iter()
            .map(|notebook| notebook.notebook_id)
            .collect();
        Ok(notebooks
            .into_iter()
            .filter(|notebook| !notebook.deleted)
            .map(|notebook| {
                let used_bytes = used_bytes_by_notebook
                    .get(&notebook.id)
                    .copied()
                    .unwrap_or(0);
                crate::models::CloudNotebook {
                    synced: enabled.contains(&notebook.id),
                    id: notebook.id,
                    name: notebook.name,
                    icon: notebook.icon,
                    sort_order: notebook.sort_order,
                    created_at: notebook.created_at,
                    updated_at: notebook.updated_at,
                    used_bytes,
                }
            })
            .collect())
    }
    pub fn record_v2_local_change(
        &self,
        notebook_id: &str,
        note_id: &str,
        operation: LocalChangeKind,
        fingerprint: &str,
    ) -> Result<bool, SyncError> {
        if !self
            .store
            .v2_notebooks(true)?
            .iter()
            .any(|notebook| notebook.notebook_id == notebook_id)
        {
            return Ok(false);
        }
        if matches!(operation, LocalChangeKind::Delete)
            && self.store.v2_note_state(note_id)?.is_none_or(|state| state.deleted)
        {
            self.store.discard_v2_unsynced_note(note_id)?;
            return Ok(false);
        }
        let (_dirty, changed) = self.store.mark_v2_dirty_with_change(
            V2EntityType::Note,
            note_id,
            Some(notebook_id),
            match operation {
                LocalChangeKind::Put => V2OperationKind::Put,
                LocalChangeKind::Delete => V2OperationKind::Delete,
            },
            fingerprint,
            Utc::now().timestamp_millis(),
        )?;
        Ok(changed)
    }

    pub fn has_pending_v2_note_change(&self, note_id: &str) -> Result<bool, SyncError> {
        Ok(self
            .store
            .v2_dirty_entities()?
            .into_iter()
            .any(|dirty| dirty.entity_type == V2EntityType::Note && dirty.entity_id == note_id))
    }

    /// Recover a missing local Markdown file from Flowix Cloud on the next
    /// account sync. This discards only the stale local operation for the
    /// missing file and requests a full bootstrap of its notebook; it never
    /// creates a cloud delete.
    pub fn recover_missing_v2_note(
        &self,
        notebook_id: &str,
        note_id: &str,
    ) -> Result<(), SyncError> {
        self.store.recover_missing_v2_note(notebook_id, note_id)
    }

    pub fn set_v2_notebook_enabled(
        &self,
        notebook: &V2LocalNotebook,
        enabled: bool,
    ) -> Result<crate::v2::V2SyncedNotebook, SyncError> {
        let state = self.store.set_v2_notebook(&notebook.id, enabled)?;
        if enabled {
            self.store.mark_v2_dirty(
                V2EntityType::Notebook,
                &notebook.id,
                Some(&notebook.id),
                V2OperationKind::Put,
                &crate::v2::v2_notebook_metadata_hash(
                    &notebook.name,
                    notebook.icon.as_deref(),
                    notebook.sort_order,
                ),
                Utc::now().timestamp_millis(),
            )?;
        }
        Ok(state)
    }

    pub fn record_v2_notebook_delete(&self, notebook_id: &str) -> Result<(), SyncError> {
        let Some(notebook) = self.v2_notebook(notebook_id)? else {
            return Ok(());
        };
        if !notebook.enabled {
            return Ok(());
        }
        self.store
            .discard_v2_note_operations_for_notebook(notebook_id)?;
        self.store.mark_v2_dirty(
            V2EntityType::Notebook,
            notebook_id,
            Some(notebook_id),
            V2OperationKind::Delete,
            "deleted",
            Utc::now().timestamp_millis(),
        )?;
        Ok(())
    }

    pub fn record_v2_notebook_change(&self, notebook: &V2LocalNotebook) -> Result<bool, SyncError> {
        let Some(state) = self.v2_notebook(&notebook.id)? else {
            return Ok(false);
        };
        if !state.enabled {
            return Ok(false);
        }
        self.store.mark_v2_dirty(
            V2EntityType::Notebook,
            &notebook.id,
            Some(&notebook.id),
            V2OperationKind::Put,
            &crate::v2::v2_notebook_metadata_hash(
                &notebook.name,
                notebook.icon.as_deref(),
                notebook.sort_order,
            ),
            Utc::now().timestamp_millis(),
        )?;
        Ok(true)
    }

    pub async fn sync_v2_account(
        &self,
        notebooks: Vec<V2LocalNotebook>,
        notes: Vec<V2LocalNote>,
    ) -> Result<V2AccountSyncReport, SyncError> {
        self.sync_v2_snapshot_at_generation(None, notebooks, notes, self.auth_generation())
            .await
    }

    /// Synchronize only one enabled notebook.
    ///
    /// The cloud changes endpoint is account-wide, so this uses a cursor per
    /// notebook and advances it over the complete account stream while only
    /// materializing changes belonging to this notebook.
    pub async fn sync_v2_notebook(
        &self,
        notebook_id: &str,
        notebooks: Vec<V2LocalNotebook>,
        notes: Vec<V2LocalNote>,
    ) -> Result<V2AccountSyncReport, SyncError> {
        self.sync_v2_snapshot_at_generation(
            Some(notebook_id),
            notebooks,
            notes,
            self.auth_generation(),
        )
        .await
    }

    pub async fn sync_v2_snapshot_at_generation(
        &self,
        notebook_scope: Option<&str>,
        notebooks: Vec<V2LocalNotebook>,
        notes: Vec<V2LocalNote>,
        generation: u64,
    ) -> Result<V2AccountSyncReport, SyncError> {
        let _guard = self.account_sync_lock.lock().await;
        self.store
            .v2_account()?
            .ok_or(SyncError::NotAuthenticated)?;
        let first_token = self.access_token(generation).await?;
        let first = self
            .sync_v2_account_once(&first_token, &notebooks, &notes, notebook_scope, generation)
            .await;
        let result = if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token(generation).await?;
            self.sync_v2_account_once(&refreshed, &notebooks, &notes, notebook_scope, generation)
                .await
        } else {
            first
        };
        let _generation = self.require_auth_generation(generation)?;
        result
    }

    pub fn complete_v2_account_sync(&self, report: &V2AccountSyncReport) -> Result<(), SyncError> {
        self.complete_v2_sync_with_apply(report, None, || Ok(()))
    }

    pub fn complete_v2_notebook_sync(
        &self,
        notebook_id: &str,
        report: &V2AccountSyncReport,
    ) -> Result<(), SyncError> {
        self.complete_v2_sync_with_apply(report, Some(notebook_id), || Ok(()))
    }

    pub fn complete_v2_sync_with_apply(
        &self,
        report: &V2AccountSyncReport,
        notebook_id: Option<&str>,
        apply: impl FnOnce() -> Result<(), SyncError>,
    ) -> Result<(), SyncError> {
        let _generation = self
            .require_auth_generation(report.auth_generation.ok_or(SyncError::NotAuthenticated)?)?;
        apply()?;
        match notebook_id {
            Some(notebook_id) => self.store.commit_v2_notebook_sync_report(
                notebook_id,
                &report.remote,
                report.cursor,
                &report.bootstrapped_notebooks,
                Utc::now().timestamp_millis(),
            ),
            None => self.store.commit_v2_sync_report(
                &report.remote,
                report.cursor,
                &report.bootstrapped_notebooks,
                Utc::now().timestamp_millis(),
            ),
        }
    }

    pub async fn v2_continue_bootstrap(
        &self,
        previous: &V2AccountSyncReport,
        notebook_scope: Option<&str>,
    ) -> Result<V2AccountSyncReport, SyncError> {
        let token = previous.bootstrap_next_page_token.as_deref()
            .ok_or_else(|| SyncError::InvalidState("bootstrap has no next page".into()))?;
        let generation = previous.auth_generation.ok_or(SyncError::NotAuthenticated)?;
        let mut access_token = self.access_token(generation).await?;
        let first = self.client.v2_bootstrap_page(&access_token, Some(token)).await;
        let page = if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            access_token = self.force_refresh_access_token(generation).await?;
            self.client.v2_bootstrap_page(&access_token, Some(token)).await?
        } else {
            first?
        };
        if page.cursor != previous.head_cursor {
            return Err(SyncError::InvalidState("bootstrap snapshot cursor changed".into()));
        }
        let enabled_notebooks: Vec<_> = self.store.v2_notebooks(true)?.into_iter()
            .filter(|notebook| notebook_scope.is_none_or(|scope| scope == notebook.notebook_id))
            .collect();
        let enabled_ids: HashSet<_> = enabled_notebooks.iter()
            .map(|notebook| notebook.notebook_id.as_str()).collect();
        let remote = self.remote_from_bootstrap(&access_token, &enabled_ids, &page).await?;
        let complete = page.next_page_token.is_none();
        let _generation = self.require_auth_generation(generation)?;
        Ok(V2AccountSyncReport {
            auth_generation: Some(generation),
            started_at: previous.started_at,
            cursor: if complete { page.cursor } else { previous.cursor },
            head_cursor: previous.head_cursor,
            uploaded: 0,
            deleted: 0,
            remote,
            bootstrapped_notebooks: if complete { enabled_notebooks.into_iter()
                .map(|notebook| notebook.notebook_id).collect() } else { Vec::new() },
            bootstrap_next_page_token: page.next_page_token,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_local_observation_only_requests_sync_for_a_new_generation() {
        let temp = tempfile::tempdir().unwrap();
        let manager =
            SyncManager::new("https://cloud.example.test", temp.path().join("sync.db")).unwrap();
        let notebook = V2LocalNotebook {
            id: "nb_1".into(),
            name: "Notes".into(),
            icon: None,
            sort_order: 0,
        };
        manager.set_v2_notebook_enabled(&notebook, true).unwrap();

        assert!(manager
            .record_v2_local_change(&notebook.id, "memo_1", LocalChangeKind::Put, "hash-a",)
            .unwrap());
        assert!(!manager
            .record_v2_local_change(&notebook.id, "memo_1", LocalChangeKind::Put, "hash-a",)
            .unwrap());
        assert!(manager
            .record_v2_local_change(&notebook.id, "memo_1", LocalChangeKind::Put, "hash-b",)
            .unwrap());
    }

    #[test]
    fn snapshot_reconciliation_only_advances_generation_for_real_changes() {
        let temp = tempfile::tempdir().unwrap();
        let manager =
            SyncManager::new("https://cloud.example.test", temp.path().join("sync.db")).unwrap();
        let notebook = V2LocalNotebook {
            id: "nb_0198f1aa-7b22-7def-8123-0123456789ab".into(),
            name: "Notes".into(),
            icon: None,
            sort_order: 0,
        };
        manager.set_v2_notebook_enabled(&notebook, true).unwrap();
        let note = V2LocalNote {
            id: "abc12345".into(),
            notebook_id: notebook.id.clone(),
            filename: "abc12345.md".into(),
            content: b"first".to_vec(),
            attachments: Vec::new(),
        };
        let enabled = HashSet::from([notebook.id.as_str()]);
        manager
            .reconcile_v2_snapshot(
                &enabled,
                std::slice::from_ref(&notebook),
                std::slice::from_ref(&note),
            )
            .unwrap();
        let first = manager.store.v2_dirty_entities().unwrap();
        assert_eq!(
            manager.v2_dirty_note_ids().unwrap(),
            HashSet::from(["abc12345".to_string()])
        );
        manager
            .reconcile_v2_snapshot(
                &enabled,
                std::slice::from_ref(&notebook),
                std::slice::from_ref(&note),
            )
            .unwrap();
        assert_eq!(manager.store.v2_dirty_entities().unwrap(), first);

        let changed = V2LocalNote {
            content: b"second".to_vec(),
            ..note
        };
        manager
            .reconcile_v2_snapshot(
                &enabled,
                std::slice::from_ref(&notebook),
                std::slice::from_ref(&changed),
            )
            .unwrap();
        let note_dirty = manager
            .store
            .v2_dirty_entities()
            .unwrap()
            .into_iter()
            .find(|dirty| dirty.entity_type == V2EntityType::Note)
            .unwrap();
        assert_eq!(note_dirty.generation, 2);
    }

    #[test]
    fn missing_local_file_discards_stale_upload_and_requires_cloud_recovery() {
        let temp = tempfile::tempdir().unwrap();
        let manager =
            SyncManager::new("https://cloud.example.test", temp.path().join("sync.db")).unwrap();
        let notebook = V2LocalNotebook {
            id: "nb_0198f1aa-7b22-7def-8123-0123456789ab".into(),
            name: "Notes".into(),
            icon: None,
            sort_order: 0,
        };
        manager.set_v2_notebook_enabled(&notebook, true).unwrap();
        manager
            .store
            .complete_v2_notebook_bootstrap(&notebook.id)
            .unwrap();
        manager
            .store
            .save_v2_note_state(&crate::v2::V2NoteState {
                note_id: "abc12345".into(),
                notebook_id: notebook.id.clone(),
                revision: "rev_2".into(),
                content_hash: Some(crate::v2::v2_content_hash(b"remote")),
                filename: "abc12345.md".into(),
                deleted: false,
                last_seq: 2,
                attachments: Vec::new(),
            })
            .unwrap();
        let enabled = HashSet::from([notebook.id.as_str()]);

        manager
            .reconcile_v2_snapshot(&enabled, std::slice::from_ref(&notebook), &[])
            .unwrap();

        manager
            .record_v2_local_change(
                &notebook.id,
                "abc12345",
                LocalChangeKind::Put,
                "stale-local-content",
            )
            .unwrap();
        let dirty = manager
            .store
            .v2_dirty_entities()
            .unwrap()
            .into_iter()
            .find(|dirty| dirty.entity_type == V2EntityType::Note)
            .unwrap();
        manager
            .store
            .freeze_v2_operation(V2FreezeOperation {
                operation_id: "op_stale_local_note",
                entity_type: dirty.entity_type,
                entity_id: &dirty.entity_id,
                generation: dirty.generation,
                operation_kind: dirty.operation_kind,
                base_revision: Some("rev_2"),
                payload_json: "{}",
            })
            .unwrap();

        manager
            .recover_missing_v2_note(&notebook.id, "abc12345")
            .unwrap();

        assert!(manager
            .store
            .v2_dirty_entities()
            .unwrap()
            .iter()
            .all(|dirty| dirty.entity_type != V2EntityType::Note));
        assert!(
            !manager
                .store
                .v2_note_state("abc12345")
                .unwrap()
                .unwrap()
                .deleted
        );
        assert!(manager.store.v2_inflight_due(i64::MAX).unwrap().is_empty());
        assert!(
            manager
                .v2_notebook(&notebook.id)
                .unwrap()
                .unwrap()
                .bootstrap_required
        );
    }

    #[test]
    fn account_reconciliation_tracks_multiple_notebooks() {
        let temp = tempfile::tempdir().unwrap();
        let manager =
            SyncManager::new("https://cloud.example.test", temp.path().join("sync.db")).unwrap();
        let notebooks = [
            V2LocalNotebook {
                id: "nb_a".into(),
                name: "A".into(),
                icon: None,
                sort_order: 0,
            },
            V2LocalNotebook {
                id: "nb_b".into(),
                name: "B".into(),
                icon: None,
                sort_order: 10,
            },
        ];
        for notebook in &notebooks {
            manager.set_v2_notebook_enabled(notebook, true).unwrap();
        }
        let notes = [
            V2LocalNote {
                id: "memo_a".into(),
                notebook_id: "nb_a".into(),
                filename: "a.md".into(),
                content: b"a".to_vec(),
                attachments: Vec::new(),
            },
            V2LocalNote {
                id: "memo_b".into(),
                notebook_id: "nb_b".into(),
                filename: "b.md".into(),
                content: b"b".to_vec(),
                attachments: Vec::new(),
            },
        ];
        let enabled = HashSet::from(["nb_a", "nb_b"]);

        manager
            .reconcile_v2_snapshot(&enabled, &notebooks, &notes)
            .unwrap();

        let dirty = manager.store.v2_dirty_entities().unwrap();
        assert_eq!(
            dirty
                .iter()
                .filter(|item| item.entity_type == V2EntityType::Notebook)
                .count(),
            2
        );
        assert_eq!(
            dirty
                .iter()
                .filter(|item| item.entity_type == V2EntityType::Note)
                .count(),
            2
        );
    }

    #[test]
    fn notebook_delete_can_freeze_after_local_registry_removal() {
        let temp = tempfile::tempdir().unwrap();
        let manager =
            SyncManager::new("https://cloud.example.test", temp.path().join("sync.db")).unwrap();
        let notebook = V2LocalNotebook {
            id: "nb_deleted".into(),
            name: "Deleted".into(),
            icon: None,
            sort_order: 0,
        };
        manager.set_v2_notebook_enabled(&notebook, true).unwrap();
        manager
            .record_v2_local_change(
                &notebook.id,
                "memo_in_deleted_notebook",
                LocalChangeKind::Put,
                "content",
            )
            .unwrap();
        manager.record_v2_notebook_delete(&notebook.id).unwrap();

        assert!(manager
            .store
            .v2_dirty_entities()
            .unwrap()
            .iter()
            .all(|item| item.entity_type != V2EntityType::Note));

        let dirty = manager
            .store
            .v2_dirty_entities()
            .unwrap()
            .into_iter()
            .find(|item| {
                item.entity_type == V2EntityType::Notebook
                    && item.entity_id == notebook.id
                    && item.operation_kind == V2OperationKind::Delete
            })
            .unwrap();
        let operation_id = crate::v2::new_v2_operation_id();
        let payload = serde_json::to_string(&V2PushOperation::NotebookDelete {
            operation_id: operation_id.clone(),
            base_revision: None,
            notebook_id: notebook.id.clone(),
            base_tree_seq: 0,
        })
        .unwrap();
        manager
            .store
            .freeze_v2_operation(V2FreezeOperation {
                operation_id: &operation_id,
                entity_type: dirty.entity_type,
                entity_id: &dirty.entity_id,
                generation: dirty.generation,
                operation_kind: dirty.operation_kind,
                base_revision: None,
                payload_json: &payload,
            })
            .unwrap();

        let operations = manager.store.v2_inflight_due(0).unwrap();
        assert!(operations.iter().any(|operation| {
            operation.entity_type == V2EntityType::Notebook
                && operation.entity_id == notebook.id
                && operation.operation_kind == V2OperationKind::Delete
        }));
    }

    #[test]
    fn downloaded_blob_hash_is_verified() {
        let content = b"verified".to_vec();
        let hash = crate::v2::v2_content_hash(&content);
        assert_eq!(
            verify_v2_blob("memo", &hash, content.clone()).unwrap(),
            content
        );
        assert!(verify_v2_blob("memo", &hash, b"tampered".to_vec()).is_err());
    }

    #[test]
    fn relocated_note_follows_newest_edge_after_path_reuse() {
        let notebook_id = "nb_moves";
        let note = |id: &str, moved_from: Option<&str>, deleted: bool, sync_seq: i64| {
            crate::v2::V2BootstrapNote {
                id: id.into(), notebook_id: notebook_id.into(), filename: format!("{id}.md"),
                moved_from_note_id: moved_from.map(str::to_owned), revision: format!("rev_{sync_seq}"),
                content_hash: (!deleted).then(|| format!("hash_{id}")), size_bytes: 1, deleted,
                sync_seq, created_at: sync_seq, updated_at: sync_seq, attachments: Vec::new(),
            }
        };
        // A -> B -> A -> C. The stale B tombstone appears before current C.
        let notes = vec![
            note("B", Some("A"), true, 3),
            note("A", Some("B"), true, 5),
            note("C", Some("A"), false, 6),
        ];
        assert_eq!(find_v2_relocated_note(&notes, notebook_id, "A").unwrap().id, "C");
    }

    #[test]
    fn relocated_note_stops_on_cyclic_move_lineage() {
        let notebook_id = "nb_moves";
        let notes = vec![
            crate::v2::V2BootstrapNote {
                id: "B".into(), notebook_id: notebook_id.into(), filename: "B.md".into(),
                moved_from_note_id: Some("A".into()), revision: "r1".into(), content_hash: None,
                size_bytes: 0, deleted: true, sync_seq: 1, created_at: 1, updated_at: 1,
                attachments: Vec::new(),
            },
            crate::v2::V2BootstrapNote {
                id: "A".into(), notebook_id: notebook_id.into(), filename: "A.md".into(),
                moved_from_note_id: Some("B".into()), revision: "r2".into(), content_hash: None,
                size_bytes: 0, deleted: true, sync_seq: 2, created_at: 2, updated_at: 2,
                attachments: Vec::new(),
            },
        ];
        assert!(find_v2_relocated_note(&notes, notebook_id, "A").is_none());
    }
}
