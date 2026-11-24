//! One sync pass for the path-keyed engine: the thing that turns
//! "credentials + a local scan" into "the bucket and the notebook agree".
//!
//! The module is deliberately three layers, each testable on its own:
//!
//! * [`plan_pass`]  lists `s/`, gates the directories, lists `f/`, resolves
//!   `HEAD` probes and decides — no transfers, so a fake [`ObjectSource`] can
//!   drive every branch in a test;
//! * [`state_updates`]  pure: turns a plan plus its outcome into the rows to
//!   write, without touching SQLite;
//! * [`execute_pass`]  the thin glue: run the transfers, persist, bump the
//!   directory stamps.
//!
//! Cost shape (§4.1): the steady-state pass is **one** `list` of `s/` and
//! nothing else. Directory listings are paid only for directories whose stamp
//! moved, and bodies are fetched only for paths the decision actually needs.
//!
//! Two failure policies worth stating because they are load-bearing:
//!
//! * A directory listing that fails is *not* an empty directory: it is left out
//!   of `observed_dirs`, so absence inside it proves nothing and no file can be
//!   deleted because of a network error.
//! * A failed `HEAD` leaves the key `Unknown` even though its directory was
//!   enumerated (see [`RemoteListing::mark_unknown`]) and defers it a pass,
//!   because the alternative — reading it as "absent" — would delete the local
//!   copy on the strength of a 500.

mod execution;
mod planning;
mod state;

pub use execution::execute_pass;
use execution::execute_pass_with_progress;
pub use planning::plan_pass;
pub use state::state_updates;

use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::pin::Pin;

use chrono::{DateTime, Utc};
use futures_util::{stream, StreamExt};

use crate::error::SyncError;
use crate::object_store::{
    self, CredentialResolver, ListPage, ObjectStoreCredentials, StorageQuota,
};
use crate::reconcile::{DirScanRecord, ReconcilePlan, RemoteListing, RemoteObject};
use crate::store::SyncStore;
use crate::state::{ScannedLocalFile, LocalSnapshot, PathState};
use crate::apply::{
    object_key, ApplyFailure, ApplyOutcome, LocalStore, ProgressObserver, TransferObserver,
};

/// How long a freshly bound notebook refuses to delete anything (§13.2①).
/// This independent safeguard prevents an empty or newly selected bucket from
/// being mistaken for a notebook-wide deletion.
pub const BIND_GRACE_MS: i64 = 300_000;

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The bucket, as the pass needs it. Every method is one signed request.
///
/// A trait rather than free functions so the orchestrator can be tested without
/// a network: the interesting decisions are "which directories did I list" and
/// "what did the probe answer", not the wire format (covered by
/// `object_store`/`object_store_ops`).
///
/// Arguments are owned on purpose. A borrowed prefix would tie the returned
/// future to a caller-local `String`, and every caller builds one anyway.
pub trait ObjectSource: Send {
    /// One page of a prefix listing. `delimiter = Some("/")` restricts the
    /// result to direct children, which is what makes a directory listing mean
    /// one directory on a flat key space.
    fn list(
        &mut self,
        prefix: String,
        cursor: Option<String>,
        delimiter: Option<String>,
    ) -> BoxFuture<'_, Result<ListPage, SyncError>>;
    fn head(&mut self, key: String) -> BoxFuture<'_, Result<Option<RemoteObject>, SyncError>>;
    /// Return one result per key in input order. Backends may overlap requests;
    /// the default preserves compatibility with stateful test sources.
    fn head_many(
        &mut self,
        keys: Vec<String>,
    ) -> BoxFuture<'_, Vec<Result<Option<RemoteObject>, SyncError>>> {
        Box::pin(async move {
            let mut results = Vec::with_capacity(keys.len());
            for key in keys {
                results.push(self.head(key).await);
            }
            results
        })
    }
    /// Fully enumerate each directory, preserving partial results on failure.
    fn list_directories(
        &mut self,
        notebook_id: String,
        dirs: Vec<String>,
    ) -> BoxFuture<'_, Vec<(String, RemoteListing, Result<(), SyncError>)>> {
        Box::pin(async move {
            let mut results = Vec::with_capacity(dirs.len());
            for dir in dirs {
                let mut listing = RemoteListing::default();
                let result = collect(
                    self,
                    &file_prefix(&notebook_id, &dir),
                    Some("/"),
                    &notebook_id,
                    &mut listing,
                )
                .await;
                results.push((dir, listing, result));
            }
            results
        })
    }
    fn put(&mut self, key: String, body: Vec<u8>) -> BoxFuture<'_, Result<(), SyncError>>;
}

/// Production [`ObjectSource`]: direct SigV4 against the bucket, no Worker in
/// the data path (§8).
pub struct DirectSource<'a> {
    pub http: &'a reqwest::Client,
    pub credentials: &'a ObjectStoreCredentials,
    pub credential_resolver: &'a dyn CredentialResolver,
}

impl ObjectSource for DirectSource<'_> {
    fn list(
        &mut self,
        prefix: String,
        cursor: Option<String>,
        delimiter: Option<String>,
    ) -> BoxFuture<'_, Result<ListPage, SyncError>> {
        Box::pin(async move {
            let page = object_store::list_prefix(
                self.http,
                self.credential_resolver,
                &prefix,
                cursor.as_deref(),
                delimiter.as_deref(),
            )
            .await?;
            unscoped_page(page, &self.credentials.prefix)
        })
    }

    fn head(&mut self, key: String) -> BoxFuture<'_, Result<Option<RemoteObject>, SyncError>> {
        Box::pin(async move {
            crate::object_store_ops::head(self.http, self.credential_resolver, &key).await
        })
    }

    fn head_many(
        &mut self,
        keys: Vec<String>,
    ) -> BoxFuture<'_, Vec<Result<Option<RemoteObject>, SyncError>>> {
        let http = self.http;
        let resolver = self.credential_resolver;
        Box::pin(async move {
            stream::iter(keys)
                .map(|key| async move { crate::object_store_ops::head(http, resolver, &key).await })
                .buffered(4)
                .collect()
                .await
        })
    }

    fn list_directories(
        &mut self,
        notebook_id: String,
        dirs: Vec<String>,
    ) -> BoxFuture<'_, Vec<(String, RemoteListing, Result<(), SyncError>)>> {
        let http = self.http;
        let credentials = self.credentials;
        let resolver = self.credential_resolver;
        Box::pin(async move {
            stream::iter(dirs)
                .map(|dir| {
                    let notebook_id = &notebook_id;
                    async move {
                        let mut source = DirectSource {
                            http,
                            credentials,
                            credential_resolver: resolver,
                        };
                        let mut listing = RemoteListing::default();
                        let result = collect(
                            &mut source,
                            &file_prefix(notebook_id, &dir),
                            Some("/"),
                            notebook_id,
                            &mut listing,
                        )
                        .await;
                        (dir, listing, result)
                    }
                })
                .buffered(4)
                .collect()
                .await
        })
    }

    fn put(&mut self, key: String, body: Vec<u8>) -> BoxFuture<'_, Result<(), SyncError>> {
        Box::pin(async move {
            crate::object_store_ops::put_object(
                self.http,
                self.credential_resolver,
                &key,
                body.into(),
                "application/json",
                &[],
            )
            .await
        })
    }
}

/// The storage API returns full bucket keys. Reconciliation uses keys relative
/// to the authenticated user's prefix, as do `head` and `put`.
fn unscoped_page(mut page: ListPage, scope: &str) -> Result<ListPage, SyncError> {
    for key in page
        .objects
        .iter_mut()
        .map(|object| &mut object.key)
        .chain(page.common_prefixes.iter_mut())
    {
        *key = key
            .strip_prefix(scope)
            .ok_or_else(|| {
                SyncError::InvalidState(
                    "object listing returned a key outside the credential prefix".into(),
                )
            })?
            .to_owned();
    }
    Ok(page)
}

/// Prefix that lists every object of a notebook, recursively.
pub fn notebook_prefix(notebook_id: &str) -> String {
    format!("nb/{notebook_id}/f/")
}

/// Prefix that lists exactly the direct children of `dir`.
pub fn file_prefix(notebook_id: &str, dir: &str) -> String {
    if dir.is_empty() {
        notebook_prefix(notebook_id)
    } else {
        format!("nb/{notebook_id}/f/{dir}/")
    }
}

/// Prefix of the directory stamps.
pub fn stamp_prefix(notebook_id: &str) -> String {
    format!("nb/{notebook_id}/s/")
}

/// Key of the stamp object for `dir`; the notebook root is `s/.json`.
///
/// A dot file is fine here — unlike on disk, nothing filters keys, and it keeps
/// the mapping `stamp_key` ↔ [`stamp_dir`] total: every directory, including
/// the root, has exactly one key.
pub fn stamp_key(notebook_id: &str, dir: &str) -> String {
    format!("{}{dir}.json", stamp_prefix(notebook_id))
}

/// Inverse of [`stamp_key`]; `None` for anything under `s/` that is not a stamp.
pub fn stamp_dir(notebook_id: &str, key: &str) -> Option<String> {
    key.strip_prefix(&stamp_prefix(notebook_id))?
        .strip_suffix(".json")
        .map(str::to_string)
}

/// Strips `nb/{id}/f/`; `None` for a key outside this notebook's content tree.
pub fn relative_path(notebook_id: &str, key: &str) -> Option<String> {
    key.strip_prefix(&notebook_prefix(notebook_id))
        .map(str::to_string)
}

/// Body of a stamp object. Deliberately minimal.
///
/// `lastChangeAt` is informational: the gate reads the object's own
/// `LastModified`, because a `list` never returns bodies (§4.1). Index
/// configuration and folder appearance are local-only and never belong in this
/// hot stamp.
pub fn stamp_body(dir: &str, last_change_at_millis: i64, device_id: &str) -> Vec<u8> {
    serde_json::json!({
        "schema": 1,
        "path": dir,
        "lastChangeAt": last_change_at_millis,
        "deviceId": device_id,
    })
    .to_string()
    .into_bytes()
}

/// True when the control plane said the account is at or past its capacity.
///
/// This closes the window a credential alone cannot: the token is signed once and
/// stays valid for fifteen minutes, so an account that fills its storage keeps
/// attempting uploads until renewal, paying a round trip per object to learn what
/// the issued quota already said.
///
/// `limit_bytes` of zero or less means *no capacity is configured* for this grant,
/// not that it is full — reading it the other way would stop every account from
/// publishing. A missing number on either side means "unknown", which must never
/// suppress a write: the server still has the final say at renewal time.
fn quota_exhausted(quota: Option<&StorageQuota>) -> bool {
    let Some(quota) = quota else { return false };
    match (quota.used_bytes, quota.limit_bytes) {
        (Some(used), Some(limit)) => limit > 0 && used >= limit,
        _ => false,
    }
}

/// Everything one pass needs from the caller.
pub struct PassRequest<'a> {
    pub notebook_id: &'a str,
    pub device_id: &'a str,
    /// What `stat` says about the notebook right now. Stat only — hashing is
    /// the upload path's job (§4.1).
    pub scanned: &'a [ScannedLocalFile],
    /// The periodic sweep: list `f/` recursively instead of trusting the
    /// stamps. Cheap enough hourly and it is the safety net for a stamp write
    /// that failed (§9).
    pub force: bool,
    /// The quota the credential was issued under, when the control plane sent
    /// one. Used to stop publishing *before* the credential expires: an account
    /// that filled its storage would otherwise keep attempting uploads for the
    /// rest of the token's lifetime and collect a 403 per object.
    pub quota: Option<&'a StorageQuota>,
}

/// The decision half of a pass: everything except transfers and persistence.
pub struct PassPlan {
    /// Server clock from the `Date` header of the `s/` listing.
    pub server_now_millis: i64,
    /// False when the backend omitted `Date`; the pass then falls back to the
    /// device clock and suppresses deletions, because an untrusted clock must
    /// never authorise one.
    pub clock_trusted: bool,
    pub snapshot: LocalSnapshot,
    /// Directory → stamp `LastModified` as the `s/` listing reported it.
    pub stamps: BTreeMap<String, i64>,
    pub listing: RemoteListing,
    pub plan: ReconcilePlan,
    /// Directories fully enumerated this pass (only these can prove absence).
    pub listed_dirs: Vec<String>,
    pub list_failures: Vec<ApplyFailure>,
    /// The credential points at a different bucket than the stored baselines.
    pub rebound: bool,
    pub allows_deletes: bool,
    /// False when the credential in hand has read scope only; every publish in
    /// `plan` was turned into `defer:read-only`.
    pub writable: bool,
}

/// Rows to persist after a pass, computed without touching the database.
#[derive(Debug, Default)]
pub struct StateUpdates {
    pub states: Vec<PathState>,
    /// Paths whose row must go (file gone locally, or both sides gone).
    pub removed: Vec<String>,
    pub dir_scans: BTreeMap<String, DirScanRecord>,
    /// Directories whose stamp must be rewritten because something under them
    /// changed.
    pub stamp_dirs: Vec<String>,
}

pub struct PassReport {
    pub server_now_millis: i64,
    pub listed_dirs: Vec<String>,
    pub plan: ReconcilePlan,
    pub applied: ApplyOutcome,
    pub stamped_dirs: Vec<String>,
    pub list_failures: Vec<ApplyFailure>,
    pub stamp_failures: Vec<ApplyFailure>,
    pub rebound: bool,
    /// False when deletes were suppressed (grace window, empty bucket after a
    /// rebind, or an untrusted clock). Worth surfacing: a user wondering why a
    /// deletion has not propagated is looking at this flag.
    pub allows_deletes: bool,
    /// False when the credential in hand has read scope only, so every publish
    /// was turned into `defer:read-only`. Downloads still happened.
    pub writable: bool,
}

impl PassReport {
    /// True when this pass moved bytes or wrote a tombstone.
    pub fn did_work(&self) -> bool {
        let stats = &self.plan.stats;
        stats.uploads + stats.downloads + stats.deletes + stats.tombstones > 0
    }
}

/// Everything the pass writes to, bundled so the entry point stays readable.
pub struct PassEnv<'a> {
    pub source: &'a mut dyn ObjectSource,
    pub http: &'a reqwest::Client,
    pub credentials: &'a ObjectStoreCredentials,
    pub credential_resolver: &'a dyn CredentialResolver,
    pub store: &'a SyncStore,
    pub local: &'a dyn LocalStore,
}

/// One complete pass.
pub async fn run_pass(
    env: &mut PassEnv<'_>,
    request: &PassRequest<'_>,
    now: DateTime<Utc>,
) -> Result<PassReport, SyncError> {
    run_pass_with_progress(env, request, now, None, None).await
}

pub(crate) async fn run_pass_with_progress(
    env: &mut PassEnv<'_>,
    request: &PassRequest<'_>,
    now: DateTime<Utc>,
    on_transfer: Option<&TransferObserver<'_>>,
    on_progress: Option<&ProgressObserver<'_>>,
) -> Result<PassReport, SyncError> {
    let started = std::time::Instant::now();
    let prepared = planning::plan_pass_with_proxy(
        &mut *env.source,
        env.credentials,
        env.store,
        request,
        env.credential_resolver.supports_deletion_proxy(),
    )
    .await?;
    tracing::info!(
        notebook_id = request.notebook_id,
        elapsed_ms = started.elapsed().as_millis() as u64,
        listed_dirs = prepared.listed_dirs.len(),
        actions = prepared.plan.actions.len(),
        failures = prepared.list_failures.len(),
        "cloud sync planning completed"
    );
    let started = std::time::Instant::now();
    let result =
        execute_pass_with_progress(env, request, &prepared, now, on_transfer, on_progress).await;
    tracing::info!(
        notebook_id = request.notebook_id,
        elapsed_ms = started.elapsed().as_millis() as u64,
        success = result.is_ok(),
        "cloud sync execution completed"
    );
    result
}

struct StampListing {
    dirs: BTreeMap<String, i64>,
    server_date_millis: Option<i64>,
}

async fn list_stamps(
    source: &mut dyn ObjectSource,
    notebook_id: &str,
) -> Result<StampListing, SyncError> {
    let prefix = stamp_prefix(notebook_id);
    let mut dirs = BTreeMap::new();
    let mut server_date_millis = None;
    let mut cursor: Option<String> = None;
    let mut seen_cursors = BTreeSet::new();
    loop {
        let page = source.list(prefix.clone(), cursor.clone(), None).await?;
        server_date_millis = server_date_millis.or(page.server_date_millis);
        for object in &page.objects {
            let Some(dir) = stamp_dir(notebook_id, &object.key) else {
                // A folder marker (`s/x/`) or something another writer put
                // there: not a stamp, so it carries no gate information.
                tracing::debug!(key = object.key, "ignoring a non-stamp key under s/");
                continue;
            };
            dirs.insert(
                dir,
                object_store::parse_http_date(&object.last_modified).unwrap_or(0),
            );
        }
        match next_cursor(cursor.as_deref(), page.next_cursor)? {
            Some(next) if seen_cursors.insert(next.clone()) => cursor = Some(next),
            Some(_) => {
                return Err(SyncError::InvalidState(
                    "object store repeated a continuation token".into(),
                ));
            }
            None => break,
        }
    }
    Ok(StampListing {
        dirs,
        server_date_millis,
    })
}

/// Collects every object under `prefix` into `listing`.
///
/// `Ok(())` means the listing was consumed to its last page, which is what
/// entitles the caller to mark the directory as enumerated. An `Err` leaves
/// whatever was already collected in place but must not be read as "empty".
async fn collect<T: ObjectSource + ?Sized>(
    source: &mut T,
    prefix: &str,
    delimiter: Option<&str>,
    notebook_id: &str,
    listing: &mut RemoteListing,
) -> Result<(), SyncError> {
    let mut cursor: Option<String> = None;
    let mut seen_cursors = BTreeSet::new();
    loop {
        let page = source
            .list(
                prefix.to_string(),
                cursor.clone(),
                delimiter.map(str::to_string),
            )
            .await?;
        for object in page.objects {
            if let Some(path) = relative_path(notebook_id, &object.key) {
                if path.is_empty() {
                    // The `f/` folder marker itself, not a file.
                    continue;
                }
                listing.observe(RemoteObject {
                    path,
                    mtime_millis: object_store::parse_http_date(&object.last_modified).unwrap_or(0),
                    size: object.size,
                    content_hash: None,
                    etag: Some(object.etag),
                    tombstone: false,
                });
            }
        }
        match next_cursor(cursor.as_deref(), page.next_cursor)? {
            Some(next) if seen_cursors.insert(next.clone()) => cursor = Some(next),
            Some(_) => {
                return Err(SyncError::InvalidState(
                    "object store repeated a continuation token".into(),
                ));
            }
            None => return Ok(()),
        }
    }
}

/// Guards pagination against a backend that echoes the cursor it was given;
/// without this the pass would spin forever instead of failing visibly.
fn next_cursor(previous: Option<&str>, next: Option<String>) -> Result<Option<String>, SyncError> {
    match next {
        Some(next) if previous != Some(next.as_str()) => Ok(Some(next)),
        Some(_) => Err(SyncError::InvalidState(
            "object store repeated a continuation token".into(),
        )),
        None => Ok(None),
    }
}

/// Turns "zero bytes" into "empty note" or "deleted".
async fn resolve_tombstones(
    source: &mut dyn ObjectSource,
    notebook_id: &str,
    listing: &mut RemoteListing,
    failures: &mut Vec<ApplyFailure>,
) {
    let ambiguous: Vec<String> = listing
        .observed
        .values()
        .filter(|object| object.size == 0 && !object.tombstone)
        .map(|object| object.path.clone())
        .collect();
    let keys = ambiguous
        .iter()
        .map(|path| object_key(notebook_id, path))
        .collect();
    let mut results = source.head_many(keys).await.into_iter();
    for path in ambiguous {
        let result = results
            .next()
            .unwrap_or_else(|| Err(SyncError::InvalidState("missing HEAD result".into())));
        match result {
            Ok(Some(mut object)) => {
                object.path = path;
                listing.observe(object);
            }
            Ok(None) => listing.mark_missing(&path),
            Err(error) => {
                listing.mark_unknown(&path);
                failures.push(ApplyFailure::from_error(path, &error));
            }
        }
    }
}

#[cfg(test)]
#[path = "pass_tests.rs"]
mod tests;

