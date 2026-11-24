//! Remote configuration and runtime selection.
//!
//! Names and configuration are persisted by the desktop app. This module
//! models the selected backend for one SyncManager lifetime; credentials are
//! supplied by the backend-specific setup path and never persisted here.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{ObjectStoreCredentials, SyncError};

/// Backend identity after selecting a named Remote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteKind {
    /// Flowix account backed storage; the control plane issues short-lived S3 credentials.
    OfficialCloud,
    /// A user configured S3-compatible endpoint with locally stored keys.
    S3Compatible,
}

/// Credentials resolved by the selected backend. Both usable variants feed
/// the same S3 object operations; only their authentication source differs.
#[derive(Clone)]
pub(crate) enum RemoteBackend {
    OfficialCloud,
    S3Compatible(ObjectStoreCredentials),
    S3Unavailable,
}

impl Default for RemoteBackend {
    fn default() -> Self {
        Self::OfficialCloud
    }
}

impl RemoteBackend {
    pub(crate) fn kind(&self) -> RemoteKind {
        match self {
            Self::OfficialCloud => RemoteKind::OfficialCloud,
            Self::S3Compatible(_) | Self::S3Unavailable => RemoteKind::S3Compatible,
        }
    }

    pub(crate) fn is_configured(&self) -> bool {
        match self {
            Self::OfficialCloud => true,
            Self::S3Compatible(_) => true,
            Self::S3Unavailable => false,
        }
    }
}

/// Selection is frozen at the first object operation. A single typed backend
/// state prevents "missing custom credentials" from being mistaken for the
/// default official backend. Desktop creates a new manager to switch Remotes.
#[derive(Default)]
pub(crate) struct RemoteSelection {
    backend: RemoteBackend,
    profile_id: Option<String>,
    opened: bool,
}

impl RemoteSelection {
    pub(crate) fn ensure_not_opened(&self) -> Result<(), SyncError> {
        if self.opened {
            return Err(SyncError::InvalidState(
                "storage target is already in use; restart before changing it".into(),
            ));
        }
        Ok(())
    }

    pub(crate) fn select_s3(
        &mut self,
        credentials: ObjectStoreCredentials,
        profile_id: String,
    ) -> Result<(), SyncError> {
        self.ensure_not_opened()?;
        self.backend = RemoteBackend::S3Compatible(credentials);
        self.profile_id = Some(profile_id);
        Ok(())
    }

    pub(crate) fn select_unavailable_s3(
        &mut self,
        profile_id: Option<String>,
    ) -> Result<(), SyncError> {
        self.ensure_not_opened()?;
        self.backend = RemoteBackend::S3Unavailable;
        self.profile_id = profile_id;
        Ok(())
    }

    pub(crate) fn kind(&self) -> RemoteKind {
        self.backend.kind()
    }

    pub(crate) fn is_configured(&self) -> bool {
        self.backend.is_configured()
    }

    pub(crate) fn profile_id(&self) -> Option<&str> {
        self.profile_id.as_deref()
    }

    pub(crate) fn open(&mut self) -> RemoteBackend {
        self.opened = true;
        self.backend.clone()
    }
}

/// Non-secret connection settings for a path-style S3-compatible remote.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Remote {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    /// Dedicated object prefix, relative to the bucket.
    pub prefix: String,
}

impl S3Remote {
    /// Builds an in-memory session from secrets supplied by the local secret store.
    pub fn open(
        &self,
        access_key_id: &str,
        secret_access_key: &str,
    ) -> Result<ObjectStoreCredentials, SyncError> {
        let endpoint = reqwest::Url::parse(self.endpoint.trim())
            .map_err(|_| SyncError::InvalidState("invalid S3 endpoint".into()))?;
        if !matches!(endpoint.scheme(), "https" | "http")
            || endpoint.host_str().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.path() != "/"
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            return Err(SyncError::InvalidState(
                "S3 endpoint must be an HTTP(S) origin without credentials or a path".into(),
            ));
        }
        let bucket = self.bucket.trim();
        let region = self.region.trim();
        if bucket.is_empty()
            || bucket.contains('/')
            || region.is_empty()
            || access_key_id.trim().is_empty()
            || secret_access_key.is_empty()
        {
            return Err(SyncError::InvalidState(
                "S3 bucket, region and credentials are required".into(),
            ));
        }
        let prefix = self.prefix.trim_matches('/');
        if prefix.is_empty()
            || prefix
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(SyncError::InvalidState(
                "a dedicated S3 prefix without empty or dot segments is required".into(),
            ));
        }
        let endpoint = endpoint.as_str().trim_end_matches('/').to_owned();
        // The existing v4 baseline fingerprint includes backend_id, bucket and
        // prefix. Include the endpoint here so identical bucket names on two
        // different services cannot share a baseline.
        let digest = Sha256::digest(endpoint.as_bytes());
        let backend_id = format!("custom-s3-{digest:x}");
        Ok(ObjectStoreCredentials {
            backend_id,
            scheme: "s3-v4".into(),
            endpoint,
            bucket: bucket.into(),
            region: region.into(),
            access_key_id: access_key_id.into(),
            secret_access_key: secret_access_key.into(),
            session_token: None,
            token_header: "x-amz-security-token".into(),
            meta_prefix: "x-amz-meta-".into(),
            prefix: format!("{prefix}/"),
            mode: "read-write".into(),
            expires_at: i64::MAX,
        })
    }

    /// Checks that the supplied credentials can list the configured prefix.
    ///
    /// A successful listing establishes read access only. It does not certify
    /// write permissions or the consistency guarantees required for syncing.
    pub async fn check_read_access(
        &self,
        http: &reqwest::Client,
        access_key_id: &str,
        secret_access_key: &str,
    ) -> Result<(), SyncError> {
        let session = self.open(access_key_id, secret_access_key)?;
        crate::object_store::list_prefix(http, &session, "", None, Some("/")).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v4::credential_fingerprint;

    fn remote(endpoint: &str) -> S3Remote {
        S3Remote {
            endpoint: endpoint.into(),
            region: "auto".into(),
            bucket: "notes".into(),
            prefix: "flowix/user".into(),
        }
    }

    #[test]
    fn credentials_are_scoped_and_omitted_from_debug() {
        let session = remote("https://example.com/")
            .open("access", "secret-value")
            .unwrap();
        assert_eq!(session.endpoint, "https://example.com");
        assert_eq!(session.prefix, "flowix/user/");
        assert_eq!(session.scoped_key("nb/one"), "flowix/user/nb/one");
        assert!(!format!("{session:?}").contains("secret-value"));
    }

    #[test]
    fn target_fingerprint_distinguishes_endpoints_but_not_key_rotation() {
        let one = remote("https://one.example").open("key", "secret").unwrap();
        let rotated = remote("https://one.example/")
            .open("new-key", "new-secret")
            .unwrap();
        let two = remote("https://two.example").open("key", "secret").unwrap();
        let fingerprint = |session: &ObjectStoreCredentials| {
            credential_fingerprint(&session.backend_id, &session.bucket, &session.prefix)
        };
        assert_eq!(fingerprint(&one), fingerprint(&rotated));
        assert_ne!(fingerprint(&one), fingerprint(&two));
    }

    #[test]
    fn rejects_ambiguous_endpoints_and_unscoped_prefixes() {
        for endpoint in [
            "https://user:pass@example.com",
            "https://example.com/path",
            "https://example.com/?token=x",
            "file:///tmp",
        ] {
            assert!(remote(endpoint).open("key", "secret").is_err());
        }
        for prefix in ["", "/", "../escape", "a//b", "a/./b"] {
            let mut value = remote("https://example.com");
            value.prefix = prefix.into();
            assert!(value.open("key", "secret").is_err());
        }
    }

    #[test]
    fn remote_selection_is_fixed_after_first_use() {
        let first = remote("https://one.example").open("key", "secret").unwrap();
        let second = remote("https://two.example").open("key", "secret").unwrap();
        let mut selection = RemoteSelection::default();
        selection.select_s3(first.clone(), "one".into()).unwrap();
        let RemoteBackend::S3Compatible(opened) = selection.open() else {
            panic!("expected selected S3 backend");
        };
        assert_eq!(opened.endpoint, first.endpoint);
        assert!(selection.select_s3(second, "two".into()).is_err());
        let RemoteBackend::S3Compatible(opened) = selection.open() else {
            panic!("expected selected S3 backend");
        };
        assert_eq!(opened.endpoint, first.endpoint);
        let mut official = RemoteSelection::default();
        assert!(matches!(official.open(), RemoteBackend::OfficialCloud));
        assert!(official.select_s3(first, "one".into()).is_err());
    }
}
