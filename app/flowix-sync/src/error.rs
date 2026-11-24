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
    /// A local file operation failed. The path is part of the error because the
    /// pass turns it into an [`ApplyFailure`](crate::v4_apply::ApplyFailure) and
    /// then carries on: without the path the user sees "permission denied" and
    /// no way to tell which of 300 files it was.
    #[error("local file error for {path}: {message}")]
    Local { path: String, message: String },
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
