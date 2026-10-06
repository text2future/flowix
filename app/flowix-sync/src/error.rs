use thiserror::Error;

#[derive(Debug, Error)]
pub enum SyncError {
    #[error("cloud request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("sync database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("cloud API error {status} {code}: {message}")]
    Api {
        status: u16,
        code: String,
        message: String,
        details: Option<serde_json::Value>,
    },
    #[error("not authenticated")]
    NotAuthenticated,
    #[error("notebook is not enabled for cloud sync")]
    NotebookDisabled,
    #[error("invalid cloud state: {0}")]
    InvalidState(String),
    #[error("cloud revision conflict for {notebook_id}/{note_id}")]
    RevisionConflict {
        notebook_id: String,
        note_id: String,
        operation_id: String,
        operation_kind: String,
        current_revision: String,
    },
    #[error("cloud move conflict for {notebook_id}: {from_path} -> {to_path}")]
    MoveConflict {
        notebook_id: String,
        operation_id: String,
        from_path: String,
        to_path: String,
    },
}

impl SyncError {
    pub fn api_code(&self) -> Option<&str> {
        match self {
            Self::Api { code, .. } => Some(code),
            _ => None,
        }
    }

    pub(crate) fn is_unauthorized(&self) -> bool {
        matches!(self, Self::Api { status: 401, .. })
    }

    /// Only this response proves that the persisted refresh credential is no
    /// longer usable. Transport failures and other server errors must keep the
    /// local credential so startup can retry without logging the user out.
    pub fn is_invalid_refresh_token(&self) -> bool {
        matches!(
            self,
            Self::Api {
                status: 401,
                code,
                ..
            } if code == "INVALID_REFRESH_TOKEN"
        )
    }
}
