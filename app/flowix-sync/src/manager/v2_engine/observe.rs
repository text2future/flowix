use super::*;

impl SyncManager {
    pub(super) fn reconcile_v2_snapshot(
        &self,
        enabled_ids: &HashSet<&str>,
        notebooks: &[V2LocalNotebook],
        notes: &[V2LocalNote],
    ) -> Result<(), SyncError> {
        let now = Utc::now().timestamp_millis();
        for notebook in notebooks
            .iter()
            .filter(|notebook| enabled_ids.contains(notebook.id.as_str()))
        {
            let fingerprint = crate::v2::v2_notebook_metadata_hash(
                &notebook.name,
                notebook.icon.as_deref(),
                notebook.sort_order,
            );
            let current = self.store.v2_notebook_state(&notebook.id)?;
            if current
                .as_ref()
                .is_none_or(|state| state.deleted || state.metadata_hash != fingerprint)
            {
                self.store.mark_v2_dirty(
                    V2EntityType::Notebook,
                    &notebook.id,
                    Some(&notebook.id),
                    V2OperationKind::Put,
                    &fingerprint,
                    now,
                )?;
            }
        }
        for note in notes
            .iter()
            .filter(|note| enabled_ids.contains(note.notebook_id.as_str()))
        {
            let fingerprint = v2_note_fingerprint(note)?;
            let content_hash = crate::v2::v2_content_hash(&note.content);
            let current = self.store.v2_note_state(&note.id)?;
            if current.as_ref().is_none_or(|state| {
                state.deleted
                    || state.notebook_id != note.notebook_id
                    || state.filename != note.filename
                    || state.content_hash.as_deref() != Some(content_hash.as_str())
                    || state.attachments
                        != note
                            .attachments
                            .iter()
                            .map(|item| item.metadata.clone())
                            .collect::<Vec<_>>()
            }) {
                self.store.mark_v2_dirty(
                    V2EntityType::Note,
                    &note.id,
                    Some(&note.notebook_id),
                    V2OperationKind::Put,
                    &fingerprint,
                    now,
                )?;
            }
        }
        Ok(())
    }
}
