//! The credential shape, its freshness rules, and the request-boundary
//! resolver that renews it.
//!
//! Official storage hands out a short-lived, prefix-scoped grant; a custom S3
//! Remote carries a static keypair. Everything that differs between the two
//! lives behind [`CredentialResolver`], so the protocol layer never branches on
//! the backend's name.

use serde::{Deserialize, Serialize};

use crate::error::SyncError;

/// The `data` object of `POST /v2/storage/credentials`.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectStoreCredentials {
    pub backend_id: String,
    #[serde(default = "default_scheme")]
    pub scheme: String,
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    #[serde(default)]
    pub session_token: Option<String>,
    #[serde(default = "default_token_header")]
    pub token_header: String,
    /// Prefix for object metadata headers (`x-amz-meta-`, `x-cos-meta-`).
    /// A capability the server declares, so the client never branches on the
    /// backend's name.
    #[serde(default = "default_meta_prefix")]
    pub meta_prefix: String,
    pub prefix: String,
    #[serde(default = "default_mode")]
    pub mode: String,
    /// Unix epoch milliseconds, as issued by the server.
    pub expires_at: i64,
}

fn default_scheme() -> String {
    "s3-v4".to_string()
}

fn default_token_header() -> String {
    "x-amz-security-token".to_string()
}

fn default_meta_prefix() -> String {
    "x-amz-meta-".to_string()
}

fn default_mode() -> String {
    "read".to_string()
}

impl std::fmt::Debug for ObjectStoreCredentials {
    /// Redacted on purpose.
    ///
    /// The derived version prints `secretAccessKey` and `sessionToken`, and a
    /// credential is exactly the value that ends up in a `tracing::debug!` line,
    /// a panic message or a support log — the three places a temporary secret
    /// must never reach. Nothing is lost for debugging: the identity of the
    /// credential (bucket, prefix, mode, expiry) is all a human needs.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ObjectStoreCredentials")
            .field("backend_id", &self.backend_id)
            .field("scheme", &self.scheme)
            .field("endpoint", &self.endpoint)
            .field("bucket", &self.bucket)
            .field("region", &self.region)
            .field("access_key_id", &self.access_key_id)
            .field("secret_access_key", &"<redacted>")
            .field(
                "session_token",
                &self.session_token.as_ref().map(|_| "<redacted>"),
            )
            .field("meta_prefix", &self.meta_prefix)
            .field("prefix", &self.prefix)
            .field("mode", &self.mode)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

impl ObjectStoreCredentials {
    /// Renew a little before expiry so a request cannot be signed with a
    /// credential that dies in flight.
    pub fn is_fresh(&self, now_millis: i64) -> bool {
        self.is_fresh_within(now_millis, 60_000)
    }

    /// The same question with a caller-chosen margin.
    ///
    /// A pass can outlive one short-lived grant. The request layer checks this
    /// margin before every S3 request, so a later page or transfer renews the
    /// grant before it gets close to expiry (§8: renew five minutes early).
    pub fn is_fresh_within(&self, now_millis: i64, margin_millis: i64) -> bool {
        self.expires_at - now_millis > margin_millis
    }

    pub fn remaining_millis(&self, now_millis: i64) -> i64 {
        self.expires_at.saturating_sub(now_millis)
    }

    pub fn can_write(&self) -> bool {
        self.mode == "read-write"
    }

    /// Keys are always resolved against the issued prefix; a caller-supplied
    /// path can never escape it.
    pub fn scoped_key(&self, relative: &str) -> String {
        format!("{}{}", self.prefix, relative.trim_start_matches('/'))
    }

    /// Wire header for one metadata field, e.g. `contenthash`.
    pub fn meta_header(&self, name: &str) -> String {
        format!("{}{}", self.meta_prefix, name)
    }

    pub(crate) fn same_signing_material(&self, other: &Self) -> bool {
        self.access_key_id == other.access_key_id
            && self.secret_access_key == other.secret_access_key
            && self.session_token == other.session_token
    }
}

/// Resolves the credentials used for one object-store request.
///
/// Official storage renews its short-lived grant when it approaches expiry;
/// a custom S3 Remote simply returns the locally configured keypair. Keeping
/// this boundary at the request layer lets a long pass renew between pages or
/// objects without changing the shared S3 protocol implementation.
#[async_trait::async_trait]
pub trait CredentialResolver: Send + Sync {
    async fn resolve(&self, now_millis: i64) -> Result<ObjectStoreCredentials, SyncError>;

    /// The clock a request should be signed and judged against.
    ///
    /// Defaults to the device clock. A resolver that has seen a `Date` header
    /// overrides it with a corrected clock, because a grant is judged against
    /// its own expiry: a device clock running minutes ahead renews every
    /// request, and one running behind signs requests with a grant the store
    /// already retired.
    fn now(&self) -> chrono::DateTime<chrono::Utc> {
        chrono::Utc::now()
    }

    /// Records the store's own time from a response header.
    ///
    /// Static credentials have nothing to correct; the official resolver feeds
    /// this into its skew so `now` stops depending on the device clock.
    fn observe_server_time(&self, _server_millis: i64) {}

    fn supports_deletion_proxy(&self) -> bool {
        false
    }

    async fn proxy_tombstone(
        &self,
        _notebook: &str,
        _path: &str,
        _etag: &str,
    ) -> Result<(), SyncError> {
        Err(SyncError::InvalidState(
            "remote deletion proxy unavailable".into(),
        ))
    }
    async fn proxy_deletion_stamp(&self, _notebook: &str, _path: &str) -> Result<(), SyncError> {
        Err(SyncError::InvalidState(
            "remote deletion proxy unavailable".into(),
        ))
    }

    /// Requests a fresh grant after the object store explicitly rejected the
    /// previous one as expired. Static providers fall back to `resolve`; the
    /// caller retries only if the signing material actually changed.
    async fn refresh_after_rejection(
        &self,
        now_millis: i64,
        _rejected: &ObjectStoreCredentials,
    ) -> Result<ObjectStoreCredentials, SyncError> {
        self.resolve(now_millis).await
    }
}

/// Device clock plus the last offset the object store implied.
///
/// Only absolute times go through it. A grant is judged against its own expiry
/// and signed with the current time, so an offset learned from one response
/// keeps both in step with the store instead of with whatever the local clock
/// says — a device running minutes ahead otherwise renews on every request,
/// and one running behind signs with a grant the store already retired.
#[derive(Default)]
pub struct ClockSkew {
    offset_millis: std::sync::atomic::AtomicI64,
}

impl ClockSkew {
    /// A day of skew is already a broken clock; beyond that a header is more
    /// likely stale or garbled than the device being wrong that far.
    const MAX_PLAUSIBLE_SKEW_MILLIS: i64 = 24 * 60 * 60 * 1_000;

    pub fn observe(&self, server_millis: i64) {
        let offset = server_millis.saturating_sub(chrono::Utc::now().timestamp_millis());
        if offset.abs() > Self::MAX_PLAUSIBLE_SKEW_MILLIS {
            return;
        }
        self.offset_millis
            .store(offset, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn now(&self) -> chrono::DateTime<chrono::Utc> {
        chrono::Utc::now()
            + chrono::Duration::milliseconds(
                self.offset_millis
                    .load(std::sync::atomic::Ordering::Relaxed),
            )
    }

    pub fn offset_millis(&self) -> i64 {
        self.offset_millis
            .load(std::sync::atomic::Ordering::Relaxed)
    }
}

/// Static local credentials are already resolved. This implementation keeps
/// connection checks and protocol utilities on the same request interface as
/// the official, renewable credential source.
#[async_trait::async_trait]
impl CredentialResolver for ObjectStoreCredentials {
    async fn resolve(&self, _now_millis: i64) -> Result<ObjectStoreCredentials, SyncError> {
        Ok(self.clone())
    }
}

/// `POST /v2/storage/credentials` — one credential plus the quota it was
/// issued under. The client can defer writes when the reported usage is already
/// at the limit; it does not reserve capacity for an upcoming batch.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageCredentialEnvelope {
    pub data: ObjectStoreCredentials,
    #[serde(default)]
    pub quota: Option<StorageQuota>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageQuota {
    pub mode: String,
    /// Whether the object-store measurement is complete and current.
    #[serde(default)]
    pub read_status: Option<String>,
    /// Bytes already stored, as the server last measured them.
    ///
    /// The only figure a direct-transfer client can act on: the Worker no
    /// longer sees writes, so the client can only use this as a snapshot.
    /// `None` for read scope, where nothing will be published anyway.
    #[serde(default)]
    pub used_bytes: Option<i64>,
    #[serde(default)]
    pub limit_bytes: Option<i64>,
    #[serde(default)]
    pub expires_at: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_server_time_moves_the_clock_away_from_the_device() {
        let clock = ClockSkew::default();
        let server = chrono::Utc::now().timestamp_millis() + 120_000;
        clock.observe(server);
        // The offset is applied, not the absolute time: reading the clock a
        // moment later still lands within a second of the server's figure.
        let drift = (clock.now().timestamp_millis() - server).abs();
        assert!(drift < 1_000, "clock drifted {drift} ms from the server");
    }

    #[test]
    fn an_implausible_header_is_ignored() {
        let clock = ClockSkew::default();
        clock.observe(chrono::Utc::now().timestamp_millis() + 60_000);
        let kept = clock.offset_millis();
        // A stale proxy cache or a garbled header must not move every later
        // signature by two days.
        clock.observe(chrono::Utc::now().timestamp_millis() + 48 * 60 * 60 * 1_000);
        assert_eq!(clock.offset_millis(), kept);
    }
}
