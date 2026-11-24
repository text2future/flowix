use thiserror::Error;

/// Why one path failed, in a form the retry loop and the UI can branch on.
///
/// `ApplyFailure` used to carry only a `String`, which collapsed "quota is
/// full", "the credential is read-only" and "the network hiccuped" into the same
/// value: a caller could only tell them apart by matching human-readable text,
/// and the next reworded message silently broke the distinction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FailureKind {
    /// Unclassified; treated as retryable so nothing is dropped silently.
    #[default]
    Unknown,
    /// The same request can succeed later: transport, 5xx, 429, or a race with
    /// another device that the next plan will resolve.
    Transient,
    /// Retrying cannot help until the user re-authenticates or the credential's
    /// scope is widened.
    Permission,
    /// The storage quota is exhausted; the next pass would fail the same way.
    Quota,
    /// A local file operation failed.
    Local,
    /// The path cannot cross the cloud boundary: excluded by notebook policy, or
    /// a key the object store cannot represent.
    Unsupported,
    /// Progress could not be persisted, so the pass stopped to avoid acting on
    /// state it could not record.
    Storage,
}

impl FailureKind {
    /// Whether an identical retry has a chance of succeeding. `false` means the
    /// user must change something first, and a status UI should say so instead of
    /// showing a generic "sync failed".
    pub fn is_retryable(self) -> bool {
        !matches!(self, Self::Permission | Self::Quota | Self::Unsupported)
    }

    /// Stable identifier for logs and the status payload.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Transient => "transient",
            Self::Permission => "permission",
            Self::Quota => "quota",
            Self::Local => "local",
            Self::Unsupported => "unsupported",
            Self::Storage => "storage",
        }
    }
}

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
    /// pass turns it into an [`ApplyFailure`](crate::apply::ApplyFailure) and
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

    /// The classification an [`ApplyFailure`](crate::apply::ApplyFailure)
    /// records, so a per-path failure keeps its meaning after the message is
    /// formatted for a human.
    pub fn failure_kind(&self) -> FailureKind {
        match self {
            Self::Http(_) => FailureKind::Transient,
            Self::Database(_) => FailureKind::Storage,
            Self::Api { status, code, .. } => {
                if code.to_ascii_uppercase().contains("QUOTA") {
                    return FailureKind::Quota;
                }
                match *status {
                    401 | 403 => FailureKind::Permission,
                    402 => FailureKind::Quota,
                    404 | 409 | 412 => FailureKind::Transient,
                    // The object store rejects the body size; the same bytes
                    // will be rejected again until a chunked upload exists.
                    413 => FailureKind::Unsupported,
                    _ => FailureKind::Transient,
                }
            }
            Self::NotAuthenticated | Self::NotebookDisabled => FailureKind::Permission,
            // A decision raced with a change on either side; the next plan sees
            // the new state.
            Self::InvalidState(_) => FailureKind::Transient,
            Self::Local { .. } => FailureKind::Local,
        }
    }
}


#[cfg(test)]
mod failure_kind_tests {
    use super::*;

    fn api(status: u16, code: &str) -> SyncError {
        SyncError::Api {
            status,
            code: code.to_string(),
            message: String::new(),
            details: None,
        }
    }

    #[test]
    fn status_codes_decide_whether_a_retry_can_help() {
        assert_eq!(api(401, "").failure_kind(), FailureKind::Permission);
        assert_eq!(api(403, "").failure_kind(), FailureKind::Permission);
        // A quota refusal often arrives as 403 with a code, not as 402.
        assert_eq!(
            api(403, "STORAGE_QUOTA_EXCEEDED").failure_kind(),
            FailureKind::Quota
        );
        assert_eq!(api(402, "").failure_kind(), FailureKind::Quota);
        assert_eq!(api(412, "").failure_kind(), FailureKind::Transient);
        assert_eq!(api(503, "").failure_kind(), FailureKind::Transient);
        // Too large for one PUT: the same bytes fail again next pass.
        assert_eq!(api(413, "").failure_kind(), FailureKind::Unsupported);
        assert!(!api(403, "").failure_kind().is_retryable());
        assert!(api(503, "").failure_kind().is_retryable());
    }

    #[test]
    fn local_and_state_errors_keep_their_meaning() {
        assert_eq!(
            SyncError::Local {
                path: "a.md".into(),
                message: "denied".into()
            }
            .failure_kind(),
            FailureKind::Local
        );
        assert_eq!(
            SyncError::InvalidState("changed mid-transfer".into()).failure_kind(),
            FailureKind::Transient
        );
        assert_eq!(
            SyncError::NotebookDisabled.failure_kind(),
            FailureKind::Permission
        );
    }
}
