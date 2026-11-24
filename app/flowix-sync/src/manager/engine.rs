//! The production caller of [`crate::pass::run_pass`].
//!
//! Everything below the pass is deliberately environment-free (a pure decision
//! function, an executor over a `LocalStore` trait, a signed-request layer), so
//! this module is the only place that knows about *this* process: who is logged
//! in, which bucket the control plane just handed out, and the fact that two
//! passes must never overlap.
//!
//! Two invariants live here, and both are invisible from the pass itself:
//!
//! * **One pass at a time, process-wide.** `execute_pass` ends by *replacing*
//!   the notebook's pending-deletion table with the set its own plan computed
//!   (`set_pending_deletions` is a whole-table swap). Two concurrent passes
//!   over the same notebook could erase retry state needed to revisit a failed
//!   remote check or tombstone write. A pass is also bandwidth-bound, so
//!   serialising costs nothing a single user notices.
//! * **Resolve credentials at request boundaries.** A pass can run longer than
//!   the 15-minute grant. Every object request renews the official grant with a
//!   five-minute margin and signs with a fresh timestamp; custom S3 credentials
//!   remain static. The pass keeps its initial bucket, scope and quota policy.

use chrono::Utc;
use futures_util::{stream, StreamExt};
use std::collections::HashMap;

use super::*;
use crate::models::CloudNotebook;
use crate::object_store::{self, CredentialResolver, ObjectStoreCredentials, StorageQuota};
use crate::object_store_ops;
use crate::state::{CloudDirectoryMarker, CloudNotebookManifest, ScannedLocalFile, DirectoryState};
use crate::state::{
    PathNotebookLink, PathNotebookMetadata, PendingNotebookAction, PendingNotebookChange,
};
use crate::apply::{LocalStore, ProgressObserver, TransferObserver};
use crate::pass::{run_pass_with_progress, DirectSource, PassEnv, PassReport, PassRequest};

/// Renew this long before expiry (`§8`: TTL 15 min, renew 5 min early).
pub const V4_CREDENTIAL_RENEWAL_MARGIN_MS: i64 = 5 * 60 * 1_000;

/// The TTL asked of the control plane. Matches the server's default; sent
/// explicitly so the client never depends on it.
const V4_CREDENTIAL_TTL_SECONDS: u32 = 900;

/// What one pass needs from its caller.
pub struct PassInput<'a> {
    pub notebook_id: &'a str,
    /// Human-facing label used in stamp bodies and conflict-copy names.
    pub device_id: &'a str,
    /// `stat`-only view of the notebook (`§4.1`: hashing is the upload path's
    /// job, so the scan never reads file contents).
    pub scanned: &'a [ScannedLocalFile],
    pub local: &'a dyn LocalStore,
    /// Called when a pass has file transfers or deletions to execute.
    pub on_transfer: Option<&'a TransferObserver<'a>>,
    pub on_progress: Option<&'a ProgressObserver<'a>>,
    /// The hourly sweep: list `f/` recursively instead of trusting the stamps.
    pub force: bool,
    /// The user confirmed a bulk delete, so this pass may apply it.
    pub allow_mass_deletion: bool,
}

/// A credential plus the quota it was issued under, remembered across passes.
#[derive(Default)]
pub(super) struct CredentialCache {
    /// The session generation the credential belongs to. A logout or account
    /// switch invalidates it even if it has not expired: the token is scoped to
    /// the previous user's prefix.
    generation: u64,
    credentials: Option<ObjectStoreCredentials>,
    quota: Option<StorageQuota>,
}

impl CredentialCache {
    fn invalidate_for_generation(&mut self, generation: u64) {
        if self.generation == generation {
            *self = Self::default();
        }
    }

    fn usable(
        &self,
        generation: u64,
        now_millis: i64,
        required_mode: Option<&str>,
    ) -> Option<(ObjectStoreCredentials, Option<StorageQuota>)> {
        if self.generation != generation {
            return None;
        }
        let credentials = self.credentials.as_ref()?;
        if required_mode.is_some_and(|mode| credentials.mode != mode) {
            return None;
        }
        if !credentials.is_fresh_within(now_millis, V4_CREDENTIAL_RENEWAL_MARGIN_MS) {
            return None;
        }
        Some((credentials.clone(), self.quota.clone()))
    }
}

type ResolvedCredentials = (ObjectStoreCredentials, Option<StorageQuota>);

/// Disposable cache of validated marker bodies for the last notebook listed.
/// It is never used as evidence that a remote key is absent.
#[derive(Default)]
pub(super) struct DirectoryCache {
    scope: Option<(u64, String, String, String, String, String)>,
    entries: HashMap<String, CachedDirectory>,
}

#[derive(Clone)]
struct CachedDirectory {
    etag: String,
    modified: i64,
    marker: CloudDirectoryMarker,
}

fn normalized_etag(etag: &str) -> &str {
    etag.trim().trim_matches('"')
}

/// Dependencies a credential provider needs, without giving it access to the
/// rest of the sync manager or the object transfer pipeline.
struct CredentialContext<'a> {
    account: &'a crate::account::AccountService,
    client: &'a crate::client::CloudClient,
    store: &'a crate::store::SyncStore,
    cache: &'a tokio::sync::Mutex<CredentialCache>,
    refresh: &'a tokio::sync::Mutex<()>,
}

/// The selected Remote chooses how credentials are obtained. Object listing,
/// reading, writing and deletion continue through the shared S3 protocol code.
#[async_trait::async_trait]
trait RemoteCredentialProvider: Send + Sync {
    async fn resolve(
        &self,
        context: &CredentialContext<'_>,
        now_millis: i64,
        required_mode: Option<&str>,
    ) -> Result<ResolvedCredentials, SyncError>;
}

struct OfficialCloudCredentialProvider;

#[async_trait::async_trait]
impl RemoteCredentialProvider for OfficialCloudCredentialProvider {
    async fn resolve(
        &self,
        context: &CredentialContext<'_>,
        now_millis: i64,
        required_mode: Option<&str>,
    ) -> Result<ResolvedCredentials, SyncError> {
        context.store.require_official_remote()?;
        let generation = context.account.session_generation();
        if let Some(hit) = {
            let cache = context.cache.lock().await;
            cache.usable(generation, now_millis, required_mode)
        } {
            if context.account.session_generation() != generation {
                return Err(SyncError::NotAuthenticated);
            }
            return Ok(hit);
        }
        // Concurrent object requests share one refresh and its quota scan.
        let _refresh = context.refresh.lock().await;
        if context.account.session_generation() != generation {
            return Err(SyncError::NotAuthenticated);
        }
        if let Some(hit) = {
            let cache = context.cache.lock().await;
            cache.usable(generation, Utc::now().timestamp_millis(), required_mode)
        } {
            return Ok(hit);
        }
        let started = std::time::Instant::now();
        let token = context.account.access_token(generation).await?;
        let envelope = if let Some(mode) = required_mode {
            // A running pass keeps the scope it planned with. A renewal must
            // not silently turn an upload into a read-only failure halfway
            // through applying the plan.
            crate::telemetry::credential_request(context.client.storage_credentials(
                &token,
                mode,
                Some(V4_CREDENTIAL_TTL_SECONDS),
            ))
            .await?
        } else {
            match crate::telemetry::credential_request(context.client.storage_credentials(
                &token,
                "read-write",
                Some(V4_CREDENTIAL_TTL_SECONDS),
            ))
            .await
            {
                Ok(envelope) => envelope,
                // Only an explicit write refusal (for example, expired
                // membership) is worth a second round trip. A 5xx, 429, or
                // authentication failure must remain an error; treating it as
                // read-only would hide a transient control-plane problem.
                Err(error @ SyncError::Api { status: 402, .. }) => {
                    tracing::info!(
                        %error,
                        "storage write scope refused; retrying with read scope (publishes will defer)"
                    );
                    crate::telemetry::credential_request(context.client.storage_credentials(
                        &token,
                        "read",
                        Some(V4_CREDENTIAL_TTL_SECONDS),
                    ))
                    .await?
                }
                Err(error) => return Err(error),
            }
        };
        if required_mode.is_some_and(|mode| envelope.data.mode != mode) {
            return Err(SyncError::InvalidState(
                "storage credential scope changed during sync".into(),
            ));
        }
        tracing::info!(elapsed_ms = started.elapsed().as_millis() as u64, mode = %envelope.data.mode, "cloud storage credentials refreshed");
        {
            let mut cache = context.cache.lock().await;
            // The account can change while the request is in flight; never
            // cache the previous user's credential under the new generation.
            if context.account.session_generation() == generation {
                *cache = CredentialCache {
                    generation,
                    credentials: Some(envelope.data.clone()),
                    quota: envelope.quota.clone(),
                };
            }
        }
        // A credential issued for the old account must not be used merely
        // because the account changed after the cache check. Fail this pass;
        // the next one can resolve credentials for the newly selected account.
        if context.account.session_generation() != generation {
            return Err(SyncError::NotAuthenticated);
        }
        Ok((envelope.data, envelope.quota))
    }
}

struct S3CredentialProvider {
    credentials: ObjectStoreCredentials,
}

#[async_trait::async_trait]
impl RemoteCredentialProvider for S3CredentialProvider {
    async fn resolve(
        &self,
        _context: &CredentialContext<'_>,
        _now_millis: i64,
        required_mode: Option<&str>,
    ) -> Result<ResolvedCredentials, SyncError> {
        if required_mode.is_some_and(|mode| self.credentials.mode != mode) {
            return Err(SyncError::InvalidState(
                "custom S3 credential scope changed during sync".into(),
            ));
        }
        Ok((self.credentials.clone(), None))
    }
}

/// One request boundary's credential plus the resolver that renews it.
///
/// Every entry point that talks to the object store needs the same three
/// things: the current signing material, the quota snapshot issued with it, and
/// a resolver pinned to the scope the call planned with. Building them together
/// keeps that invariant in one place instead of repeating a three-line dance
/// that is easy to get subtly wrong (forgetting the clone, forgetting the
/// mode).
struct PassCredentials<'a> {
    credentials: ObjectStoreCredentials,
    quota: Option<StorageQuota>,
    resolver: PassCredentialResolver<'a>,
}

/// The storage identity and write scope are fixed for one pass, while the
/// short-lived signing material can rotate between requests.
struct PassCredentialResolver<'a> {
    manager: &'a SyncManager,
    initial: ObjectStoreCredentials,
}

fn supports_official_deletion_proxy(kind: crate::remote::RemoteKind, scheme: &str) -> bool {
    kind == crate::remote::RemoteKind::OfficialCloud && scheme == "s3-v4"
}

impl PassCredentialResolver<'_> {
    async fn invalidate_cached_credentials(&self, generation: u64) {
        let mut cache = self.manager.credentials.lock().await;
        if self.manager.account.session_generation() == generation {
            cache.invalidate_for_generation(generation);
        }
    }
}

#[async_trait::async_trait]
impl CredentialResolver for PassCredentialResolver<'_> {
    fn supports_deletion_proxy(&self) -> bool {
        let kind = self
            .manager
            .remote
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .kind();
        supports_official_deletion_proxy(kind, &self.initial.scheme)
    }

    async fn proxy_tombstone(
        &self,
        notebook: &str,
        path: &str,
        etag: &str,
    ) -> Result<(), SyncError> {
        let generation = self.manager.account.session_generation();
        self.resolve(Utc::now().timestamp_millis()).await?;
        if self.manager.account.session_generation() != generation {
            return Err(SyncError::NotAuthenticated);
        }
        let token = self.manager.account.access_token(generation).await?;
        let result = self
            .manager
            .client
            .storage_tombstone(&token, notebook, path, etag)
            .await;
        // A timeout or a failed stamp can still follow a successful tombstone.
        self.invalidate_cached_credentials(generation).await;
        result?;
        if self.manager.account.session_generation() != generation {
            return Err(SyncError::NotAuthenticated);
        }
        Ok(())
    }

    async fn proxy_deletion_stamp(&self, notebook: &str, path: &str) -> Result<(), SyncError> {
        let generation = self.manager.account.session_generation();
        self.resolve(Utc::now().timestamp_millis()).await?;
        if self.manager.account.session_generation() != generation {
            return Err(SyncError::NotAuthenticated);
        }
        let token = self.manager.account.access_token(generation).await?;
        self.manager
            .client
            .storage_deletion_stamp(&token, notebook, path)
            .await?;
        if self.manager.account.session_generation() != generation {
            return Err(SyncError::NotAuthenticated);
        }
        self.invalidate_cached_credentials(generation).await;
        Ok(())
    }

    async fn resolve(&self, now_millis: i64) -> Result<ObjectStoreCredentials, SyncError> {
        let (credentials, _) = self
            .manager
            .credentials_for_mode(now_millis, Some(&self.initial.mode))
            .await?;
        let same_binding = credentials.backend_id == self.initial.backend_id
            && credentials.scheme == self.initial.scheme
            && credentials.endpoint == self.initial.endpoint
            && credentials.bucket == self.initial.bucket
            && credentials.region == self.initial.region
            && credentials.prefix == self.initial.prefix
            && credentials.token_header == self.initial.token_header
            && credentials.meta_prefix == self.initial.meta_prefix
            && credentials.mode == self.initial.mode;
        if !same_binding {
            return Err(SyncError::InvalidState(
                "storage binding or access scope changed during sync".into(),
            ));
        }
        Ok(credentials)
    }

    async fn refresh_after_rejection(
        &self,
        now_millis: i64,
        rejected: &ObjectStoreCredentials,
    ) -> Result<ObjectStoreCredentials, SyncError> {
        let credentials = self
            .manager
            .refresh_credentials_after_rejection(now_millis, rejected)
            .await?;
        let same_binding = credentials.backend_id == self.initial.backend_id
            && credentials.scheme == self.initial.scheme
            && credentials.endpoint == self.initial.endpoint
            && credentials.bucket == self.initial.bucket
            && credentials.region == self.initial.region
            && credentials.prefix == self.initial.prefix
            && credentials.token_header == self.initial.token_header
            && credentials.meta_prefix == self.initial.meta_prefix
            && credentials.mode == self.initial.mode;
        if !same_binding {
            return Err(SyncError::InvalidState(
                "storage binding or access scope changed during sync".into(),
            ));
        }
        Ok(credentials)
    }
}

impl SyncManager {
    pub fn path_notebook(&self, notebook_id: &str) -> Result<Option<PathNotebookLink>, SyncError> {
        self.store.path_notebook(notebook_id)
    }

    pub fn path_enabled_notebooks(&self) -> Result<Vec<PathNotebookLink>, SyncError> {
        self.store.path_enabled_notebooks()
    }

    pub fn set_path_notebook_enabled(
        &self,
        notebook: &PathNotebookMetadata,
        enabled: bool,
    ) -> Result<PathNotebookLink, SyncError> {
        self.store.set_path_notebook(notebook, enabled)
    }

    pub fn record_path_notebook_change(
        &self,
        notebook: &PathNotebookMetadata,
    ) -> Result<bool, SyncError> {
        self.store.record_path_notebook_change(notebook)
    }

    pub fn record_path_notebook_delete(&self, notebook_id: &str) -> Result<(), SyncError> {
        self.store.record_path_notebook_delete(notebook_id)
    }

    /// Lists active notebook manifests without consulting the indexed sync API.
    /// The delimiter keeps discovery proportional to notebook count instead of
    /// enumerating every note object under the account prefix.
    pub async fn remote_notebooks(&self) -> Result<Vec<CloudNotebook>, SyncError> {
        let now = Utc::now();
        let PassCredentials {
            credentials,
            quota: _,
            resolver,
        } = self.pass_credentials(now.timestamp_millis()).await?;
        let enabled: std::collections::HashSet<String> = self
            .path_enabled_notebooks()?
            .into_iter()
            .map(|notebook| notebook.notebook_id)
            .collect();
        let mut cursor = None;
        let mut notebooks = Vec::new();
        let mut page_count = 0usize;
        loop {
            let page = object_store::list_prefix(
                &self.http,
                &resolver,
                "nb/",
                cursor.as_deref(),
                Some("/"),
            )
            .await?;
            for prefix in page.common_prefixes {
                let Some(id) = prefix
                    .strip_prefix(&credentials.prefix)
                    .and_then(|value| value.strip_prefix("nb/"))
                    .and_then(|value| value.strip_suffix('/'))
                else {
                    continue;
                };
                if !valid_notebook_id(id) {
                    tracing::warn!(notebook_id = %id, "ignoring invalid notebook manifest prefix");
                    continue;
                }
                let Some((manifest, modified_at)) = self
                    .get_notebook_manifest_with_resolver(&resolver, id)
                    .await?
                else {
                    continue;
                };
                if manifest.deleted {
                    continue;
                }
                notebooks.push(CloudNotebook {
                    id: id.to_string(),
                    name: manifest.name,
                    icon: manifest.icon,
                    sort_order: manifest.sort_order,
                    created_at: manifest.created_at,
                    updated_at: modified_at,
                    synced: enabled.contains(id),
                    // Per-notebook bytes are not part of the path manifest.
                    // The account-level storage UI reports the authoritative
                    // measured total separately.
                    used_bytes: 0,
                });
            }
            page_count += 1;
            if page_count > 10_000 {
                return Err(SyncError::InvalidState(
                    "notebook manifest listing exceeded the page limit".into(),
                ));
            }
            let Some(next) = page.next_cursor else { break };
            if cursor.as_deref() == Some(next.as_str()) {
                return Err(SyncError::InvalidState(
                    "notebook manifest listing cursor stalled".into(),
                ));
            }
            cursor = Some(next);
        }
        notebooks.sort_by(|left, right| {
            left.sort_order
                .cmp(&right.sort_order)
                .then_with(|| left.name.cmp(&right.name))
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(notebooks)
    }

    pub async fn get_notebook_manifest(
        &self,
        notebook_id: &str,
    ) -> Result<Option<(CloudNotebookManifest, i64)>, SyncError> {
        validate_notebook_id(notebook_id)?;
        let now = Utc::now();
        let PassCredentials { resolver, .. } =
            self.pass_credentials(now.timestamp_millis()).await?;
        self.get_notebook_manifest_with_resolver(&resolver, notebook_id)
            .await
    }

    pub async fn put_notebook_manifest(
        &self,
        notebook_id: &str,
        manifest: &CloudNotebookManifest,
    ) -> Result<bool, SyncError> {
        validate_notebook_id(notebook_id)?;
        manifest.validate()?;
        let now = Utc::now();
        let PassCredentials {
            credentials,
            quota: _,
            resolver,
        } = self.pass_credentials(now.timestamp_millis()).await?;
        if !credentials.can_write() {
            return Ok(false);
        }
        let body = serde_json::to_vec(manifest)
            .map_err(|error| SyncError::InvalidState(error.to_string()))?;
        object_store_ops::put_object(
            &self.http,
            &resolver,
            &notebook_manifest_key(notebook_id),
            body.into(),
            "application/json",
            &[],
        )
        .await?;
        Ok(true)
    }

    /// Reads durable directory records for one notebook. Listing keys first
    /// keeps the protocol flat; only marker bodies are fetched, never note data.
    pub async fn remote_directories(
        &self,
        notebook_id: &str,
    ) -> Result<(Vec<(CloudDirectoryMarker, i64)>, Option<i64>), SyncError> {
        validate_notebook_id(notebook_id)?;
        let now = Utc::now();
        let generation = self.account.session_generation();
        let PassCredentials {
            credentials,
            quota: _,
            resolver,
        } = self.pass_credentials(now.timestamp_millis()).await?;
        let relative_prefix = format!("nb/{notebook_id}/d/");
        let scoped_prefix = credentials.scoped_key(&relative_prefix);
        let scope = (
            generation,
            credentials.backend_id.clone(),
            credentials.endpoint.clone(),
            credentials.bucket.clone(),
            credentials.prefix.clone(),
            notebook_id.to_string(),
        );
        let cached = {
            let cache = self.directory_cache.lock().await;
            if cache.scope.as_ref() == Some(&scope) {
                cache.entries.clone()
            } else {
                HashMap::new()
            }
        };
        let started = std::time::Instant::now();
        let mut cursor = None;
        let mut objects = Vec::new();
        let mut page_count = 0usize;
        let mut server_now = None;
        let mut server_clock_complete = true;
        loop {
            let page = object_store::list_prefix(
                &self.http,
                &resolver,
                &relative_prefix,
                cursor.as_deref(),
                None,
            )
            .await?;
            if let Some(page_date) = page.server_date_millis {
                server_now =
                    Some(server_now.map_or(page_date, |previous: i64| previous.max(page_date)));
            } else {
                server_clock_complete = false;
            }
            objects.extend(page.objects);
            page_count += 1;
            if page_count > 10_000 {
                return Err(SyncError::InvalidState(
                    "directory marker listing exceeded the page limit".into(),
                ));
            }
            let Some(next) = page.next_cursor else { break };
            if cursor.as_deref() == Some(next.as_str()) {
                return Err(SyncError::InvalidState(
                    "directory marker listing cursor stalled".into(),
                ));
            }
            cursor = Some(next);
        }
        let total = objects.len();
        let mut cache_hits = 0usize;
        let mut result = Vec::with_capacity(total);
        let mut next_cache = HashMap::new();
        let mut pending = Vec::new();
        for object in objects {
            let Some(path) = object
                .key
                .strip_prefix(&scoped_prefix)
                .and_then(|path| path.strip_suffix(".json"))
            else {
                continue;
            };
            let etag = normalized_etag(&object.etag);
            let modified = object_store::parse_http_date(&object.last_modified);
            if let Some(entry) = cached.get(&object.key).filter(|entry| {
                !etag.is_empty() && entry.etag == etag && Some(entry.modified) == modified
            }) {
                cache_hits += 1;
                result.push((entry.marker.clone(), entry.modified));
                next_cache.insert(object.key, entry.clone());
            } else {
                pending.push((
                    object.key.clone(),
                    path.to_string(),
                    etag.to_string(),
                    modified,
                ));
            }
        }
        crate::telemetry::directory_cache(total, cache_hits);
        let fetched = stream::iter(pending.into_iter().map(|(key, path, etag, modified)| {
            let resolver = &resolver;
            let credentials = &credentials;
            async move {
                let relative_key = key.strip_prefix(&credentials.prefix).ok_or_else(|| {
                    SyncError::InvalidState("directory marker outside storage scope".into())
                })?;
                let downloaded = object_store_ops::download(&self.http, resolver, relative_key)
                    .await?
                    .ok_or_else(|| {
                        SyncError::InvalidState(format!(
                            "directory marker {relative_key} disappeared during listing"
                        ))
                    })?;
                let marker: CloudDirectoryMarker = serde_json::from_slice(&downloaded.bytes)
                    .map_err(|error| {
                        SyncError::InvalidState(format!("invalid directory marker: {error}"))
                    })?;
                marker.validate()?;
                if marker.path != path {
                    return Err(SyncError::InvalidState(
                        "directory marker key and body path disagree".into(),
                    ));
                }
                let remote = downloaded.remote;
                let cacheable = !etag.is_empty()
                    && remote
                        .etag
                        .as_deref()
                        .is_some_and(|value| normalized_etag(value) == etag)
                    && modified == Some(remote.mtime_millis);
                Ok((key, marker, remote.mtime_millis, cacheable.then_some(etag)))
            }
        }))
        .buffer_unordered(8)
        .collect::<Vec<Result<_, SyncError>>>()
        .await;
        for fetched in fetched {
            let (key, marker, modified, etag) = fetched?;
            if let Some(etag) = etag {
                next_cache.insert(
                    key,
                    CachedDirectory {
                        etag,
                        modified,
                        marker: marker.clone(),
                    },
                );
            }
            result.push((marker, modified));
        }
        if self.account.session_generation() != generation {
            return Err(SyncError::NotAuthenticated);
        }
        {
            let mut cache = self.directory_cache.lock().await;
            cache.scope = Some(scope);
            cache.entries = next_cache;
        }
        result.sort_by(|left, right| left.0.path.cmp(&right.0.path));
        tracing::info!(%notebook_id, markers = total, cache_hits, pages = page_count,
            elapsed_ms = started.elapsed().as_millis() as u64, "cloud directory markers read");
        Ok((
            result,
            server_clock_complete.then_some(server_now).flatten(),
        ))
    }

    /// Writes a directory presence/deletion record, returning the bucket's
    /// authoritative modification time. `None` means this credential is
    /// deliberately read-only and the caller should leave the change pending.
    pub async fn put_directory_marker(
        &self,
        notebook_id: &str,
        marker: &CloudDirectoryMarker,
    ) -> Result<Option<i64>, SyncError> {
        validate_notebook_id(notebook_id)?;
        marker.validate()?;
        let now = Utc::now();
        let PassCredentials {
            credentials,
            quota: _,
            resolver,
        } = self.pass_credentials(now.timestamp_millis()).await?;
        if !credentials.can_write() {
            return Ok(None);
        }
        let key = directory_marker_key(notebook_id, &marker.path);
        let body = serde_json::to_vec(marker)
            .map_err(|error| SyncError::InvalidState(error.to_string()))?;
        object_store_ops::put_object(
            &self.http,
            &resolver,
            &key,
            body.into(),
            "application/json",
            &[],
        )
        .await?;
        let remote = object_store_ops::head(&self.http, &resolver, &key)
            .await?
            .ok_or_else(|| {
                SyncError::InvalidState(format!("directory marker {key} vanished after PUT"))
            })?;
        Ok(Some(remote.mtime_millis))
    }

    pub fn pending_notebook_changes(&self) -> Result<Vec<PendingNotebookChange>, SyncError> {
        self.store.pending_path_notebook_changes()
    }

    pub fn ack_notebook_change(
        &self,
        notebook_id: &str,
        generation: i64,
        action: PendingNotebookAction,
    ) -> Result<(), SyncError> {
        self.store
            .ack_path_notebook_change(notebook_id, generation, action)
    }

    pub fn directory_states(
        &self,
        notebook_id: &str,
    ) -> Result<Vec<DirectoryState>, SyncError> {
        self.store.directory_states(notebook_id)
    }

    pub fn save_directory_states(
        &self,
        notebook_id: &str,
        states: &[DirectoryState],
    ) -> Result<(), SyncError> {
        self.store.save_directory_states(notebook_id, states)
    }

    async fn get_notebook_manifest_with_resolver(
        &self,
        credential_resolver: &dyn CredentialResolver,
        notebook_id: &str,
    ) -> Result<Option<(CloudNotebookManifest, i64)>, SyncError> {
        let key = notebook_manifest_key(notebook_id);
        let Some(downloaded) =
            object_store_ops::download(&self.http, credential_resolver, &key).await?
        else {
            return Ok(None);
        };
        let manifest: CloudNotebookManifest =
            serde_json::from_slice(&downloaded.bytes).map_err(|error| {
                SyncError::InvalidState(format!("invalid notebook manifest: {error}"))
            })?;
        manifest.validate()?;
        Ok(Some((manifest, downloaded.remote.mtime_millis)))
    }

    /// Runs one path-keyed pass for one notebook.
    ///
    /// Returns the report instead of swallowing it: the caller decides whether a
    /// notebook that allowed no deletions or accepted no writes is worth
    /// surfacing, and that answer changes with the UI.
    pub async fn pass(&self, input: PassInput<'_>) -> Result<PassReport, SyncError> {
        let _single = self.pass_lock.clone().lock_owned().await;
        let now = Utc::now();
        let PassCredentials {
            credentials,
            quota,
            resolver,
        } = self.pass_credentials(now.timestamp_millis()).await?;
        let mut source = DirectSource {
            http: &self.http,
            credentials: &credentials,
            credential_resolver: &resolver,
        };
        let request = PassRequest {
            notebook_id: input.notebook_id,
            device_id: input.device_id,
            scanned: input.scanned,
            force: input.force,
            quota: quota.as_ref(),
            allow_mass_deletion: input.allow_mass_deletion,
        };
        let mut env = PassEnv {
            source: &mut source,
            http: &self.http,
            credentials: &credentials,
            credential_resolver: &resolver,
            store: &self.store,
            local: input.local,
        };
        run_pass_with_progress(
            &mut env,
            &request,
            now,
            input.on_transfer,
            input.on_progress,
        )
        .await
    }

    /// Resolves the initial pass credentials, or refreshes a cached grant for
    /// the same access mode when the request layer reaches its renewal window.
    ///
    /// Write scope is requested first because publishing is the common case. A
    /// refusal (over quota, membership lapsed) is not an error here: the design
    /// makes read scope always available precisely so that a lapsed account can
    /// still *receive* its data (§4.3), and the pass turns every publish into
    /// `defer:read-only` on its own.
    async fn credentials_for_pass(
        &self,
        now_millis: i64,
    ) -> Result<ResolvedCredentials, SyncError> {
        self.credentials_for_mode(now_millis, None).await
    }

    /// Credentials, quota and renewal resolver for one object-store entry
    /// point.
    ///
    /// Callers that only read still go through here: the resolver is what lets
    /// a long listing survive its grant expiring mid-page, so it is not an
    /// optional extra.
    async fn pass_credentials(&self, now_millis: i64) -> Result<PassCredentials<'_>, SyncError> {
        let (credentials, quota) = self.credentials_for_pass(now_millis).await?;
        let resolver = PassCredentialResolver {
            manager: self,
            initial: credentials.clone(),
        };
        Ok(PassCredentials {
            credentials,
            quota,
            resolver,
        })
    }

    async fn credentials_for_mode(
        &self,
        now_millis: i64,
        required_mode: Option<&str>,
    ) -> Result<ResolvedCredentials, SyncError> {
        let backend = self.remote.lock().unwrap_or_else(|e| e.into_inner()).open();
        let provider: Box<dyn RemoteCredentialProvider> = match backend {
            crate::remote::RemoteBackend::OfficialCloud => {
                Box::new(OfficialCloudCredentialProvider)
            }
            crate::remote::RemoteBackend::S3Compatible(credentials) => {
                Box::new(S3CredentialProvider { credentials })
            }
            crate::remote::RemoteBackend::S3Unavailable => {
                return Err(SyncError::InvalidState(
                    "S3 remote credentials are unavailable".into(),
                ));
            }
        };
        let context = CredentialContext {
            account: &self.account,
            client: &self.client,
            store: &self.store,
            cache: &self.credentials,
            refresh: &self.credential_refresh,
        };
        provider.resolve(&context, now_millis, required_mode).await
    }

    async fn refresh_credentials_after_rejection(
        &self,
        now_millis: i64,
        rejected: &ObjectStoreCredentials,
    ) -> Result<ObjectStoreCredentials, SyncError> {
        {
            let mut cache = self.credentials.lock().await;
            if cache
                .credentials
                .as_ref()
                .is_some_and(|cached| cached.same_signing_material(rejected))
            {
                // Invalidate only the rejected grant. If another request has
                // already installed a newer one, keep it and share that grant.
                cache.credentials = None;
                cache.quota = None;
            }
        }
        self.credentials_for_mode(now_millis, Some(&rejected.mode))
            .await
            .map(|(credentials, _)| credentials)
    }

    /// Drops the cached credential (logout, bucket rebind, quota change).
    pub async fn forget_credentials(&self) {
        let mut cache = self.credentials.lock().await;
        *cache = CredentialCache::default();
    }
}

fn notebook_manifest_key(notebook_id: &str) -> String {
    format!("nb/{notebook_id}/m/manifest.json")
}

fn directory_marker_key(notebook_id: &str, path: &str) -> String {
    format!("nb/{notebook_id}/d/{path}.json")
}

fn valid_notebook_id(notebook_id: &str) -> bool {
    !notebook_id.is_empty()
        && notebook_id.len() <= 80
        && notebook_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn validate_notebook_id(notebook_id: &str) -> Result<(), SyncError> {
    if valid_notebook_id(notebook_id) {
        Ok(())
    } else {
        Err(SyncError::InvalidState(
            "notebook ID cannot be represented as an object key".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deletion_proxy_is_limited_to_official_r2() {
        use crate::remote::RemoteKind;
        assert!(supports_official_deletion_proxy(
            RemoteKind::OfficialCloud,
            "s3-v4"
        ));
        assert!(!supports_official_deletion_proxy(
            RemoteKind::OfficialCloud,
            "cos-v5"
        ));
        assert!(!supports_official_deletion_proxy(
            RemoteKind::S3Compatible,
            "s3-v4"
        ));
    }

    #[test]
    fn deletion_recovery_invalidates_only_the_matching_session_cache() {
        let now = 1_700_000_000_000;
        let mut current = cache(7, now + 600_000);
        current.invalidate_for_generation(6);
        assert!(current.usable(7, now, None).is_some());
        current.invalidate_for_generation(7);
        assert!(current.usable(7, now, None).is_none());
    }

    fn credentials(expires_at: i64) -> ObjectStoreCredentials {
        ObjectStoreCredentials {
            backend_id: "r2-primary".to_string(),
            scheme: "s3-v4".to_string(),
            endpoint: "https://example.r2.cloudflarestorage.com".to_string(),
            bucket: "flowix-blobs".to_string(),
            region: "auto".to_string(),
            access_key_id: "ak".to_string(),
            secret_access_key: "sk".to_string(),
            session_token: None,
            token_header: "x-amz-security-token".to_string(),
            meta_prefix: "x-amz-meta-".to_string(),
            prefix: "u/usr_1/".to_string(),
            mode: "read-write".to_string(),
            expires_at,
        }
    }

    fn cache(generation: u64, expires_at: i64) -> CredentialCache {
        CredentialCache {
            generation,
            credentials: Some(credentials(expires_at)),
            quota: None,
        }
    }

    /// A pass signs every transfer itself, so the margin has to cover the pass,
    /// not one request: ten minutes of validity is plenty, four is not.
    #[test]
    fn renews_five_minutes_before_expiry() {
        let now = 1_700_000_000_000;
        assert!(cache(1, now + 10 * 60_000).usable(1, now, None).is_some());
        assert!(cache(1, now + 4 * 60_000).usable(1, now, None).is_none());
        // Still valid for a single request — the two margins are separate on
        // purpose, and conflating them is exactly the bug this locks out.
        assert!(credentials(now + 2 * 60_000).is_fresh(now));
    }

    /// The token is scoped to one user's prefix; reusing it after a logout would
    /// sign the next account's writes into the previous one.
    #[test]
    fn a_new_session_never_reuses_the_old_credential() {
        let now = 1_700_000_000_000;
        let mut cached = cache(7, now + 10 * 60_000);
        assert!(cached.usable(8, now, None).is_none());
        // And an empty cache is never "usable", even at generation zero.
        cached = CredentialCache::default();
        assert!(cached.usable(0, now, None).is_none());
    }
}

