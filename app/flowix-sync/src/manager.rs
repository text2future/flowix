//! Notebook synchronization composed with an independently owned account service.
use crate::account::{AccountService, PendingLogout};
use crate::client::CloudClient;
use crate::error::SyncError;
use crate::models::*;
use crate::store::SyncStore;
use std::path::Path;
use std::sync::Arc;

#[derive(Clone)]
pub struct SyncManager {
    account: AccountService,
    client: CloudClient,
    store: SyncStore,
    /// Serialises path-keyed passes. See `engine` for why one at a time.
    pass_lock: Arc<tokio::sync::Mutex<()>>,
    credentials: Arc<tokio::sync::Mutex<engine::CredentialCache>>,
    credential_refresh: Arc<tokio::sync::Mutex<()>>,
    directory_cache: Arc<tokio::sync::Mutex<engine::DirectoryCache>>,
    remote: Arc<std::sync::Mutex<crate::remote::RemoteSelection>>,
    /// Object storage is not the control plane: a single object can be large
    /// and a slow uplink must not be cut off at the API client's 30 seconds.
    http: reqwest::Client,
}

impl SyncManager {
    pub fn account(&self) -> &AccountService {
        &self.account
    }

    fn from_account(account: AccountService) -> Self {
        Self {
            client: account.client().clone(),
            store: account.store().clone(),
            account,
            pass_lock: Arc::new(tokio::sync::Mutex::new(())),
            credentials: Arc::new(tokio::sync::Mutex::new(Default::default())),
            credential_refresh: Arc::new(tokio::sync::Mutex::new(())),
            directory_cache: Arc::new(tokio::sync::Mutex::new(Default::default())),
            remote: Arc::new(std::sync::Mutex::new(Default::default())),
            http: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                .read_timeout(std::time::Duration::from_secs(300))
                .build()
                .unwrap_or_default(),
        }
    }
}

mod account_api;
mod engine;

pub use engine::{PassInput, V4_CREDENTIAL_RENEWAL_MARGIN_MS};

