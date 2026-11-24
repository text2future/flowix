use super::*;

impl AccountService {
    pub async fn create_folder_share_link(
        &self,
        notebook_id: &str,
        relative_path: &str,
    ) -> Result<crate::models::CloudNoteShareLink, SyncError> {
        let generation = self.auth_generation();
        let token = self.access_token(generation).await?;
        let first = self
            .client
            .create_folder_share_link(&token, notebook_id, relative_path)
            .await;
        let link = if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token(generation).await?;
            self.client
                .create_folder_share_link(&refreshed, notebook_id, relative_path)
                .await?
        } else {
            first?
        };
        let _generation = self.require_auth_generation(generation)?;
        Ok(link)
    }
    pub async fn create_note_share_link(
        &self,
        notebook_id: &str,
        relative_path: &str,
        content_hash: &str,
    ) -> Result<crate::models::CloudNoteShareLink, SyncError> {
        let generation = self.auth_generation();
        let token = self.access_token(generation).await?;
        let first = self
            .client
            .create_note_share_link(&token, notebook_id, relative_path, content_hash)
            .await;
        let link = if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token(generation).await?;
            self.client
                .create_note_share_link(&refreshed, notebook_id, relative_path, content_hash)
                .await?
        } else {
            first?
        };
        let _generation = self.require_auth_generation(generation)?;
        Ok(link)
    }
}
