//! Single registration point for every external CLI runtime.
//!
//! Runtime-specific managers keep their protocol implementations. This layer
//! only normalizes application-wide lifecycle operations so chat dispatch,
//! stop, watchdog reaping, shutdown, and running-thread aggregation cannot
//! drift into separate hard-coded runtime lists.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures::{future::join_all, FutureExt};
use sha2::{Digest, Sha256};
use tokio::sync::{watch, Mutex};

use super::claude::{ClaudeCliManager, AGENT_TYPE as CLAUDE_AGENT_TYPE};
use super::codex::{CodexAppServerManager, AGENT_TYPE as CODEX_AGENT_TYPE};
use super::deepseek_harness::{DeepSeekHarnessManager, AGENT_TYPE as DSH_AGENT_TYPE};
use super::hermes::HermesAcpManager;
use super::opencode::{OpenCodeAcpManager, AGENT_TYPE as OPENCODE_AGENT_TYPE};
use super::pi::{PiRpcManager, AGENT_TYPE as PI_AGENT_TYPE};
use crate::agent_wire::{AgentUserMessage, RunInfo};
use tauri::Listener;

const HERMES_AGENT_TYPE: &str = "hermes";

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ExternalRuntimeKind {
    Codex,
    Claude,
    Hermes,
    OpenCode,
    Pi,
    DeepSeekHarness,
}

impl ExternalRuntimeKind {
    pub const ALL: [Self; 6] = [
        Self::Codex,
        Self::Claude,
        Self::Hermes,
        Self::OpenCode,
        Self::Pi,
        Self::DeepSeekHarness,
    ];

    pub const fn key(self) -> &'static str {
        match self {
            Self::Codex => CODEX_AGENT_TYPE,
            Self::Claude => CLAUDE_AGENT_TYPE,
            Self::Hermes => HERMES_AGENT_TYPE,
            Self::OpenCode => OPENCODE_AGENT_TYPE,
            Self::Pi => PI_AGENT_TYPE,
            Self::DeepSeekHarness => DSH_AGENT_TYPE,
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "codex" => Ok(Self::Codex),
            "claude" => Ok(Self::Claude),
            "hermes" => Ok(Self::Hermes),
            "opencode" => Ok(Self::OpenCode),
            "pi" => Ok(Self::Pi),
            "deepseek-harness" | "deepseek_harness" | "dsh" => Ok(Self::DeepSeekHarness),
            other => Err(format!("unsupported agent type: {other}")),
        }
    }
}

#[async_trait]
pub trait ExternalCliRuntime: Send + Sync {
    fn kind(&self) -> ExternalRuntimeKind;

    fn key(&self) -> &'static str {
        self.kind().key()
    }

    async fn chat_stream(
        &self,
        thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<String, String>;

    async fn steer_chat(
        &self,
        _thread_id: &str,
        _message: AgentUserMessage,
        _client_user_message_id: String,
        _app_handle: &tauri::AppHandle,
    ) -> Result<(), String> {
        Err("this agent does not support steering an active turn".to_string())
    }

    async fn stop_chat(
        &self,
        thread_id: &str,
        run_id: Option<&str>,
        app_handle: &tauri::AppHandle,
    ) -> bool;

    async fn running_threads(&self) -> HashMap<String, RunInfo>;
    async fn stop_all(&self) -> usize;

    async fn reap_inactive_runs(
        &self,
        app_handle: &tauri::AppHandle,
        idle_timeout_ms: i64,
    ) -> usize;
}

#[derive(Clone, Debug)]
pub struct RuntimeRunSnapshot {
    pub runtime: ExternalRuntimeKind,
    pub thread_id: String,
    pub info: RunInfo,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RuntimeOperationCount {
    pub runtime: ExternalRuntimeKind,
    pub affected: usize,
}

macro_rules! impl_external_runtime {
    ($manager:ty, $kind:expr) => {
        #[async_trait]
        impl ExternalCliRuntime for Arc<$manager> {
            fn kind(&self) -> ExternalRuntimeKind {
                $kind
            }

            async fn chat_stream(
                &self,
                thread_id: &str,
                message: AgentUserMessage,
                app_handle: &tauri::AppHandle,
            ) -> Result<String, String> {
                <$manager>::chat_stream(self, thread_id, message, app_handle).await
            }

            async fn stop_chat(
                &self,
                thread_id: &str,
                run_id: Option<&str>,
                app_handle: &tauri::AppHandle,
            ) -> bool {
                <$manager>::stop_chat(self.as_ref(), thread_id, run_id, app_handle).await
            }

            async fn running_threads(&self) -> HashMap<String, RunInfo> {
                <$manager>::running_threads(self.as_ref()).await
            }

            async fn stop_all(&self) -> usize {
                <$manager>::stop_all(self.as_ref()).await
            }

            async fn reap_inactive_runs(
                &self,
                app_handle: &tauri::AppHandle,
                idle_timeout_ms: i64,
            ) -> usize {
                <$manager>::reap_inactive_runs(self.as_ref(), app_handle, idle_timeout_ms).await
            }
        }
    };
}

impl_external_runtime!(CodexAppServerManager, ExternalRuntimeKind::Codex);
impl_external_runtime!(ClaudeCliManager, ExternalRuntimeKind::Claude);
impl_external_runtime!(DeepSeekHarnessManager, ExternalRuntimeKind::DeepSeekHarness);
impl_external_runtime!(HermesAcpManager, ExternalRuntimeKind::Hermes);
impl_external_runtime!(OpenCodeAcpManager, ExternalRuntimeKind::OpenCode);
impl_external_runtime!(PiRpcManager, ExternalRuntimeKind::Pi);

pub struct ExternalRuntimeRegistry {
    runtimes: HashMap<ExternalRuntimeKind, Box<dyn ExternalCliRuntime>>,
    codex: Option<Arc<CodexAppServerManager>>,
    deepseek_harness: Option<Arc<DeepSeekHarnessManager>>,
    admissions: Mutex<AdmissionState>,
}

const ACCEPTED_REQUEST_LIMIT: usize = 4096;
const ACCEPTED_REQUEST_TTL: Duration = Duration::from_secs(30 * 60);
const TERMINAL_CONFIRMATION_GRACE: Duration = Duration::from_secs(1);

#[derive(Default)]
struct AdmissionState {
    requests: HashMap<(String, String), AcceptedRequest>,
    occupied: HashMap<String, OccupiedThread>,
    protected: HashSet<String>,
}

struct AcceptedRequest {
    runtime: ExternalRuntimeKind,
    fingerprint: [u8; 32],
    result: watch::Sender<Option<Result<String, String>>>,
    terminal_at: Option<Instant>,
}

#[derive(Clone)]
struct OccupiedThread {
    run_id: String,
    runtime: ExternalRuntimeKind,
    dispatching: bool,
}

pub struct ThreadProtection {
    registry: Arc<ExternalRuntimeRegistry>,
    thread_id: String,
}

impl Drop for ThreadProtection {
    fn drop(&mut self) {
        let registry = self.registry.clone();
        let thread_id = self.thread_id.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                registry.unprotect_thread(&thread_id).await;
            });
        }
    }
}

impl ExternalRuntimeRegistry {
    /// Accept one ordinary run before calling a provider. The watch sender is
    /// owned by a supervisor task, so losing the IPC waiter cannot start the
    /// same native operation twice on retry.
    pub async fn dispatch_chat(
        self: &Arc<Self>,
        thread_id: &str,
        runtime: ExternalRuntimeKind,
        mut message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<String, String> {
        let run_id = super::shared::resolve_run_id(thread_id, message.run_id.as_deref());
        message.run_id = Some(run_id.clone());
        let encoded = serde_json::to_vec(&message).map_err(|error| error.to_string())?;
        let fingerprint: [u8; 32] = Sha256::digest(encoded).into();
        let thread_key = thread_id.to_string();
        let request_key = (thread_key.clone(), run_id.clone());
        let mut refreshed_capacity = false;

        // Include runs started before this registry took ownership (for
        // example, a native session recovered after a window reload).
        let existing = self.refresh_admissions().await;
        if existing.iter().any(|snapshot| {
            (snapshot.thread_id == thread_id
                || snapshot.info.pending_thread_id.as_deref() == Some(thread_id))
                && snapshot.info.run_id.is_none()
        }) {
            return Err(
                "AlreadyRunning: an existing runtime has an unscoped active execution".to_string(),
            );
        }

        loop {
            let mut admissions = self.admissions.lock().await;
            if admissions.protected.contains(&thread_key) {
                return Err("ThreadProtected: this thread is being archived or deleted".to_string());
            }
            let now = Instant::now();
            admissions.requests.retain(|_, request| {
                request
                    .terminal_at
                    .is_none_or(|finished| now.duration_since(finished) < ACCEPTED_REQUEST_TTL)
            });

            if let Some(request) = admissions.requests.get(&request_key) {
                if request.runtime != runtime || request.fingerprint != fingerprint {
                    return Err(
                        "IdempotencyConflict: run ID was accepted with different input".to_string(),
                    );
                }
                let receiver = request.result.subscribe();
                drop(admissions);
                return wait_for_accepted_result(receiver).await;
            }

            if let Some(occupied) = admissions.occupied.get(&thread_key).cloned() {
                if occupied.dispatching {
                    return Err("AlreadyRunning: this thread is accepting another run".to_string());
                }
                let request = admissions
                    .requests
                    .get(&(thread_key.clone(), occupied.run_id.clone()))
                    .map(|request| request.terminal_at);
                if request == Some(None) {
                    drop(admissions);
                    let snapshots = self.running_snapshots().await;
                    let still_active = snapshots.iter().any(|snapshot| {
                        snapshot.info.run_id.as_deref() == Some(occupied.run_id.as_str())
                            && (snapshot.thread_id == thread_key
                                || snapshot.info.pending_thread_id.as_deref()
                                    == Some(thread_key.as_str()))
                    });
                    if still_active {
                        return Err("AlreadyRunning: this thread has an active run".to_string());
                    }
                    if self
                        .wait_for_terminal_confirmation(&thread_key, &occupied.run_id)
                        .await
                    {
                        self.refresh_admissions().await;
                        continue;
                    }
                    return Err(
                        "AlreadyRunning: accepted run has not yet reached a confirmed terminal state"
                            .to_string(),
                    );
                }
                let terminal_confirmed = request.is_some_and(|terminal_at| terminal_at.is_some());
                // For runs accepted in this process, the terminal event is
                // the completion proof. The activity snapshot confirms the
                // runtime has also dropped its active entry. Older runs that
                // predate this registry have no accepted request record, so
                // their runtime snapshot remains the only available signal.
                drop(admissions);
                let running = self
                    .get(occupied.runtime)
                    .expect("occupied runtime must be registered")
                    .running_threads()
                    .await;
                let still_active = running
                    .values()
                    .any(|info| info.run_id.as_deref() == Some(occupied.run_id.as_str()));
                if still_active
                    && terminal_confirmed
                    && self
                        .wait_for_runtime_inactive(occupied.runtime, &occupied.run_id)
                        .await
                {
                    self.refresh_admissions().await;
                    continue;
                }
                let mut admissions = self.admissions.lock().await;
                if admissions.occupied.get(&thread_key).is_some_and(|current| {
                    current.run_id == occupied.run_id && current.runtime == occupied.runtime
                }) {
                    if still_active {
                        return Err("AlreadyRunning: this thread has an active run".to_string());
                    }
                    admissions.occupied.remove(&thread_key);
                    if let Some(request) = admissions
                        .requests
                        .get_mut(&(thread_key.clone(), occupied.run_id))
                    {
                        request.terminal_at.get_or_insert_with(Instant::now);
                    }
                }
                continue;
            }

            if admissions.requests.len() >= ACCEPTED_REQUEST_LIMIT {
                if !refreshed_capacity {
                    refreshed_capacity = true;
                    drop(admissions);
                    self.refresh_admissions().await;
                    continue;
                }
                return Err("CapacityExceeded: accepted request registry is full".to_string());
            }
            let (sender, receiver) = watch::channel(None);
            admissions.requests.insert(
                request_key.clone(),
                AcceptedRequest {
                    runtime,
                    fingerprint,
                    result: sender,
                    terminal_at: None,
                },
            );
            admissions.occupied.insert(
                thread_key.clone(),
                OccupiedThread {
                    run_id: run_id.clone(),
                    runtime,
                    dispatching: true,
                },
            );
            drop(admissions);

            let registry = self.clone();
            let app = app_handle.clone();
            tokio::spawn(async move {
                let dispatch_registry = registry.clone();
                let dispatch_thread_key = thread_key.clone();
                let dispatch_app = app.clone();
                let start = std::panic::AssertUnwindSafe(async move {
                    let Some(runtime) = dispatch_registry.get(runtime) else {
                        return Err("accepted runtime is not registered".to_string());
                    };
                    runtime
                        .chat_stream(&dispatch_thread_key, message, &dispatch_app)
                        .await
                })
                .catch_unwind()
                .await;
                let (result, confirmed_start_failure) = match start {
                    Ok(result) => (result, true),
                    Err(_) => (
                        Err("accepted runtime panicked; terminal state is unknown".to_string()),
                        false,
                    ),
                };
                let mut admissions = registry.admissions.lock().await;
                let mut release_failed_start = false;
                if let Some(occupied) = admissions.occupied.get_mut(&thread_key) {
                    if occupied.run_id == run_id {
                        occupied.dispatching = false;
                        release_failed_start = result.is_err() && confirmed_start_failure;
                    }
                }
                if release_failed_start {
                    admissions.occupied.remove(&thread_key);
                    if let Some(request) = admissions.requests.get_mut(&request_key) {
                        request.terminal_at = Some(Instant::now());
                    }
                }
                if let Some(request) = admissions.requests.get(&request_key) {
                    request.result.send_replace(Some(result));
                }
            });
            return wait_for_accepted_result(receiver).await;
        }
    }

    pub async fn protect_thread(
        self: &Arc<Self>,
        thread_id: &str,
    ) -> Result<ThreadProtection, String> {
        let mut admissions = self.admissions.lock().await;
        if !admissions.protected.insert(thread_id.to_string()) {
            return Err(
                "ThreadProtected: a lifecycle operation is already in progress".to_string(),
            );
        }
        Ok(ThreadProtection {
            registry: self.clone(),
            thread_id: thread_id.to_string(),
        })
    }

    pub async fn unprotect_thread(&self, thread_id: &str) {
        self.admissions.lock().await.protected.remove(thread_id);
    }

    pub async fn ensure_thread_writable(&self, thread_id: &str) -> Result<(), String> {
        if self.admissions.lock().await.protected.contains(thread_id) {
            Err("ThreadProtected: this thread is being archived or deleted".to_string())
        } else {
            Ok(())
        }
    }

    pub async fn thread_has_active_run(&self, thread_id: &str) -> bool {
        let snapshots = self.refresh_admissions().await;
        if self
            .admissions
            .lock()
            .await
            .occupied
            .contains_key(thread_id)
        {
            return true;
        }
        snapshots.iter().any(|snapshot| {
            snapshot.thread_id == thread_id
                || snapshot.info.pending_thread_id.as_deref() == Some(thread_id)
        })
    }

    /// Listen for terminal events as positive completion proof. Runtime
    /// activity snapshots confirm that the active entry has been removed and
    /// recover runs that predate this registry.
    pub fn listen_for_terminal_events(self: &Arc<Self>, app_handle: &tauri::AppHandle) {
        let registry = Arc::downgrade(self);
        app_handle.listen("agent-run-terminal", move |event| {
            let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
                return;
            };
            let (Some(thread_id), Some(run_id), Some(agent_type)) = (
                payload.get("thread_id").and_then(serde_json::Value::as_str),
                payload.get("run_id").and_then(serde_json::Value::as_str),
                payload
                    .get("agent_type")
                    .and_then(serde_json::Value::as_str),
            ) else {
                return;
            };
            let Ok(runtime) = ExternalRuntimeKind::parse(agent_type) else {
                return;
            };
            let (thread_id, run_id) = (thread_id.to_string(), run_id.to_string());
            let Some(registry) = registry.upgrade() else {
                return;
            };
            tauri::async_runtime::spawn(async move {
                registry
                    .reconcile_terminal_event(runtime, &thread_id, &run_id)
                    .await;
            });
        });
    }

    async fn reconcile_terminal_event(
        &self,
        runtime: ExternalRuntimeKind,
        thread_id: &str,
        run_id: &str,
    ) {
        {
            let mut admissions = self.admissions.lock().await;
            if let Some(request) = admissions
                .requests
                .get_mut(&(thread_id.to_string(), run_id.to_string()))
                .filter(|request| request.runtime == runtime)
            {
                request.terminal_at.get_or_insert_with(Instant::now);
            }
        }

        // Some runtimes emit StreamEnd immediately before dropping their
        // active-run entry. Wait briefly for that authoritative cleanup; if
        // it does not arrive, normal reconciliation will retry on the next
        // snapshot or lifecycle operation.
        for _ in 0..50 {
            let Some(occupied) = self
                .admissions
                .lock()
                .await
                .occupied
                .get(thread_id)
                .cloned()
            else {
                return;
            };
            if occupied.runtime != runtime || occupied.run_id != run_id {
                return;
            }
            if occupied.dispatching {
                tokio::time::sleep(Duration::from_millis(20)).await;
                continue;
            }

            let snapshots = self.refresh_admissions().await;
            let still_active = snapshots.iter().any(|snapshot| {
                snapshot.runtime == runtime
                    && snapshot.info.run_id.as_deref() == Some(run_id)
                    && (snapshot.thread_id == thread_id
                        || snapshot.info.pending_thread_id.as_deref() == Some(thread_id))
            });
            let current = self
                .admissions
                .lock()
                .await
                .occupied
                .get(thread_id)
                .cloned();
            if current
                .as_ref()
                .is_none_or(|current| current.runtime != runtime || current.run_id != run_id)
            {
                return;
            }
            if !still_active && !current.is_some_and(|current| current.dispatching) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn refresh_admissions(&self) -> Vec<RuntimeRunSnapshot> {
        let snapshots = self.running_snapshots().await;
        let mut admissions = self.admissions.lock().await;
        reconcile_admissions(&mut admissions, &snapshots);
        snapshots
    }

    async fn wait_for_terminal_confirmation(&self, thread_id: &str, run_id: &str) -> bool {
        let deadline = tokio::time::Instant::now() + TERMINAL_CONFIRMATION_GRACE;
        loop {
            let confirmed = self
                .admissions
                .lock()
                .await
                .requests
                .get(&(thread_id.to_string(), run_id.to_string()))
                .is_some_and(|request| request.terminal_at.is_some());
            if confirmed {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn wait_for_runtime_inactive(&self, runtime: ExternalRuntimeKind, run_id: &str) -> bool {
        let deadline = tokio::time::Instant::now() + TERMINAL_CONFIRMATION_GRACE;
        loop {
            let Some(runtime) = self.get(runtime) else {
                return false;
            };
            if !runtime
                .running_threads()
                .await
                .values()
                .any(|info| info.run_id.as_deref() == Some(run_id))
            {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    pub fn new(
        codex: Arc<CodexAppServerManager>,
        claude: Arc<ClaudeCliManager>,
        hermes: Arc<HermesAcpManager>,
        opencode: Arc<OpenCodeAcpManager>,
        pi: Arc<PiRpcManager>,
        deepseek_harness: Arc<DeepSeekHarnessManager>,
    ) -> Self {
        let codex_for_registry = codex.clone();
        let deepseek_harness_for_registry = deepseek_harness.clone();
        Self::try_from_runtimes(vec![
            Box::new(codex),
            Box::new(claude),
            Box::new(hermes),
            Box::new(opencode),
            Box::new(pi),
            Box::new(deepseek_harness),
        ])
        .expect("built-in external runtimes must have unique kinds")
        .with_codex(codex_for_registry)
        .with_deepseek_harness(deepseek_harness_for_registry)
    }

    fn with_codex(mut self, codex: Arc<CodexAppServerManager>) -> Self {
        self.codex = Some(codex);
        self
    }

    fn with_deepseek_harness(mut self, manager: Arc<DeepSeekHarnessManager>) -> Self {
        self.deepseek_harness = Some(manager);
        self
    }

    fn try_from_runtimes(runtimes: Vec<Box<dyn ExternalCliRuntime>>) -> Result<Self, String> {
        let mut registry = HashMap::new();
        for runtime in runtimes {
            let kind = runtime.kind();
            if registry.insert(kind, runtime).is_some() {
                return Err(format!(
                    "external runtime is registered more than once for {}",
                    kind.key()
                ));
            }
        }
        // Test-only construction does not need direct Codex steering access.
        // `new` installs the concrete manager immediately afterwards.
        Ok(Self {
            runtimes: registry,
            codex: None,
            deepseek_harness: None,
            admissions: Mutex::new(AdmissionState::default()),
        })
    }

    pub async fn steer_codex(
        &self,
        thread_id: &str,
        message: AgentUserMessage,
        client_user_message_id: String,
        app_handle: &tauri::AppHandle,
    ) -> Result<(), String> {
        self.ensure_thread_writable(thread_id).await?;
        // The registry stores the concrete manager separately because steering
        // is currently Codex-only.  Call the inherent method explicitly here:
        // method syntax on `Arc<CodexAppServerManager>` can otherwise resolve
        // to `ExternalCliRuntime::steer_chat`, whose default implementation
        // intentionally rejects steering for runtimes that do not support it.
        let codex = self
            .codex
            .as_ref()
            .ok_or_else(|| "Codex runtime is unavailable".to_string())?;
        CodexAppServerManager::steer_chat(
            codex.as_ref(),
            thread_id,
            message,
            client_user_message_id,
            app_handle,
        )
        .await
    }

    pub async fn steer_deepseek_harness(
        &self,
        thread_id: &str,
        message: AgentUserMessage,
        client_user_message_id: String,
        app_handle: &tauri::AppHandle,
    ) -> Result<(), String> {
        self.ensure_thread_writable(thread_id).await?;
        let manager = self
            .deepseek_harness
            .as_ref()
            .ok_or_else(|| "DeepSeek Harness runtime is unavailable".to_string())?;
        DeepSeekHarnessManager::steer_chat(
            manager.as_ref(),
            thread_id,
            message,
            client_user_message_id,
            app_handle,
        )
        .await
    }

    pub fn get(&self, kind: ExternalRuntimeKind) -> Option<&dyn ExternalCliRuntime> {
        self.runtimes.get(&kind).map(Box::as_ref)
    }

    pub fn iter(&self) -> impl Iterator<Item = &dyn ExternalCliRuntime> {
        ExternalRuntimeKind::ALL
            .into_iter()
            .filter_map(|kind| self.get(kind))
    }

    pub async fn stop_chat_all(&self, thread_id: &str, app_handle: &tauri::AppHandle) -> bool {
        join_all(
            self.iter()
                .map(|runtime| runtime.stop_chat(thread_id, None, app_handle)),
        )
        .await
        .into_iter()
        .any(|stopped| stopped)
    }

    pub async fn cancel_pending_work_for_lifecycle(&self, thread_id: &str) -> Result<(), String> {
        if let Some(dsh) = &self.deepseek_harness {
            dsh.cancel_pending_goal(thread_id).await?;
        }
        Ok(())
    }

    pub async fn running_threads(&self) -> HashMap<String, RunInfo> {
        let mut all = HashMap::new();
        for snapshot in self.refresh_admissions().await {
            merge_run_snapshot(&mut all, snapshot);
        }
        all
    }

    /// Lossless runtime-qualified view. The existing frontend IPC map is
    /// derived from this collection for backward compatibility.
    pub async fn running_snapshots(&self) -> Vec<RuntimeRunSnapshot> {
        let runtimes = self.iter().collect::<Vec<_>>();
        let snapshots = join_all(runtimes.iter().map(|runtime| runtime.running_threads())).await;
        let mut all = Vec::new();
        for (runtime, threads) in runtimes.into_iter().zip(snapshots) {
            all.extend(
                threads
                    .into_iter()
                    .map(|(thread_id, info)| RuntimeRunSnapshot {
                        runtime: runtime.kind(),
                        thread_id,
                        info,
                    }),
            );
        }
        all
    }

    pub async fn reap_inactive_runs(
        &self,
        app_handle: &tauri::AppHandle,
        idle_timeout_ms: i64,
    ) -> Vec<RuntimeOperationCount> {
        let runtimes = self.iter().collect::<Vec<_>>();
        let counts = join_all(
            runtimes
                .iter()
                .map(|runtime| runtime.reap_inactive_runs(app_handle, idle_timeout_ms)),
        )
        .await;
        runtimes
            .into_iter()
            .map(ExternalCliRuntime::kind)
            .zip(counts)
            .map(|(runtime, affected)| RuntimeOperationCount { runtime, affected })
            .collect()
    }

    pub async fn stop_all(&self) -> Vec<RuntimeOperationCount> {
        let runtimes = self.iter().collect::<Vec<_>>();
        let counts = join_all(runtimes.iter().map(|runtime| runtime.stop_all())).await;
        runtimes
            .into_iter()
            .map(ExternalCliRuntime::kind)
            .zip(counts)
            .map(|(runtime, affected)| RuntimeOperationCount { runtime, affected })
            .collect()
    }
}

async fn wait_for_accepted_result(
    mut receiver: watch::Receiver<Option<Result<String, String>>>,
) -> Result<String, String> {
    loop {
        if let Some(result) = receiver.borrow_and_update().clone() {
            return result;
        }
        receiver
            .changed()
            .await
            .map_err(|_| "accepted run supervisor ended unexpectedly".to_string())?;
    }
}

fn reconcile_admissions(admissions: &mut AdmissionState, snapshots: &[RuntimeRunSnapshot]) {
    let mut active = HashSet::new();
    for snapshot in snapshots {
        let Some(run_id) = snapshot.info.run_id.as_ref() else {
            continue;
        };
        let thread_id = snapshot
            .info
            .pending_thread_id
            .as_deref()
            .unwrap_or(&snapshot.thread_id)
            .to_string();
        active.insert((thread_id, snapshot.runtime, run_id.clone()));
    }

    for snapshot in snapshots {
        let Some(run_id) = snapshot.info.run_id.as_ref() else {
            continue;
        };
        let thread_id = snapshot
            .info
            .pending_thread_id
            .as_deref()
            .unwrap_or(&snapshot.thread_id)
            .to_string();
        let replacement = OccupiedThread {
            run_id: run_id.clone(),
            runtime: snapshot.runtime,
            dispatching: false,
        };
        match admissions.occupied.get(&thread_id).cloned() {
            None => {
                admissions.occupied.insert(thread_id, replacement);
            }
            Some(current)
                if current.runtime == snapshot.runtime
                    && current.run_id.as_str() == run_id.as_str() => {}
            Some(current) if current.dispatching => {}
            Some(current)
                if active.contains(&(
                    thread_id.clone(),
                    current.runtime,
                    current.run_id.clone(),
                )) => {}
            Some(current)
                if admissions
                    .requests
                    .get(&(thread_id.clone(), current.run_id.clone()))
                    .is_some_and(|request| request.terminal_at.is_none()) => {}
            Some(_) => {
                let previous = admissions.occupied.insert(thread_id.clone(), replacement);
                if let Some(previous) = previous {
                    mark_request_terminal(admissions, &thread_id, &previous.run_id);
                }
            }
        }
    }

    let finished = admissions
        .occupied
        .iter()
        .filter(|(thread_id, slot)| {
            !slot.dispatching
                && !active.contains(&(thread_id.to_string(), slot.runtime, slot.run_id.clone()))
                && !admissions
                    .requests
                    .get(&(thread_id.to_string(), slot.run_id.clone()))
                    .is_some_and(|request| request.terminal_at.is_none())
        })
        .map(|(thread_id, slot)| (thread_id.clone(), slot.run_id.clone()))
        .collect::<Vec<_>>();
    for (thread_id, run_id) in finished {
        admissions.occupied.remove(&thread_id);
        mark_request_terminal(admissions, &thread_id, &run_id);
    }
}

fn mark_request_terminal(admissions: &mut AdmissionState, thread_id: &str, run_id: &str) {
    if let Some(request) = admissions
        .requests
        .get_mut(&(thread_id.to_string(), run_id.to_string()))
    {
        request.terminal_at.get_or_insert_with(Instant::now);
    }
}

fn merge_run_snapshot(target: &mut HashMap<String, RunInfo>, snapshot: RuntimeRunSnapshot) {
    use std::collections::hash_map::Entry;

    match target.entry(snapshot.thread_id.clone()) {
        Entry::Vacant(entry) => {
            entry.insert(snapshot.info);
        }
        Entry::Occupied(mut entry) => {
            let existing = entry.get();
            // The compatibility IPC map cannot represent two runtimes on one
            // thread. Keep the newest deterministically and log the conflict.
            if snapshot.info.started_at > existing.started_at {
                tracing::warn!(
                    thread_id = %snapshot.thread_id,
                    kept_runtime = snapshot.runtime.key(),
                    dropped_runtime = existing.agent_type.as_deref().unwrap_or("unknown"),
                    "multiple runtimes reported the same running thread; keeping the newest run"
                );
                entry.insert(snapshot.info);
            } else {
                tracing::warn!(
                    thread_id = %snapshot.thread_id,
                    kept_runtime = existing.agent_type.as_deref().unwrap_or("unknown"),
                    dropped_runtime = snapshot.runtime.key(),
                    "multiple runtimes reported the same running thread; keeping the newest run"
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_session::ThreadManager;
    use crate::config::UserConfigStore;

    #[test]
    fn runtime_kind_normalizes_wire_aliases() {
        assert_eq!(
            ExternalRuntimeKind::parse(" CODEX ").unwrap(),
            ExternalRuntimeKind::Codex
        );
        assert_eq!(
            ExternalRuntimeKind::parse("dsh").unwrap(),
            ExternalRuntimeKind::DeepSeekHarness
        );
        assert_eq!(
            ExternalRuntimeKind::parse("deepseek_harness").unwrap(),
            ExternalRuntimeKind::DeepSeekHarness
        );
        assert!(ExternalRuntimeKind::parse("flowix").is_err());
    }

    fn run_info(started_at: i64, agent_type: &str) -> RunInfo {
        RunInfo::active(
            started_at,
            None,
            Some(agent_type),
            Some(format!("run-{started_at}")),
            None,
            None,
        )
    }

    #[test]
    fn compatibility_snapshot_keeps_newest_cross_runtime_run() {
        let mut running = HashMap::new();
        merge_run_snapshot(
            &mut running,
            RuntimeRunSnapshot {
                runtime: ExternalRuntimeKind::Claude,
                thread_id: "shared-thread".to_string(),
                info: run_info(10, "claude"),
            },
        );
        merge_run_snapshot(
            &mut running,
            RuntimeRunSnapshot {
                runtime: ExternalRuntimeKind::Codex,
                thread_id: "shared-thread".to_string(),
                info: run_info(20, "codex"),
            },
        );
        merge_run_snapshot(
            &mut running,
            RuntimeRunSnapshot {
                runtime: ExternalRuntimeKind::Hermes,
                thread_id: "shared-thread".to_string(),
                info: run_info(5, "hermes"),
            },
        );

        let retained = running.get("shared-thread").unwrap();
        assert_eq!(retained.started_at, 20);
        assert_eq!(retained.agent_type.as_deref(), Some("codex"));
    }

    #[test]
    fn registry_contains_every_external_runtime_once() {
        let threads = ThreadManager::for_tests();
        let temp = tempfile::tempdir().unwrap();
        let user_config = Arc::new(UserConfigStore::new(temp.path().to_path_buf()));
        let dsh_sessions = user_config.dsh_sessions_dir();
        let registry = ExternalRuntimeRegistry::new(
            Arc::new(CodexAppServerManager::new(threads.clone())),
            Arc::new(ClaudeCliManager::new(threads.clone())),
            Arc::new(HermesAcpManager::new(threads.clone())),
            Arc::new(OpenCodeAcpManager::new(threads.clone())),
            Arc::new(PiRpcManager::new(threads.clone())),
            Arc::new(DeepSeekHarnessManager::new(
                threads,
                user_config,
                dsh_sessions,
            )),
        );

        let keys = registry
            .iter()
            .map(ExternalCliRuntime::key)
            .collect::<Vec<_>>();
        assert_eq!(
            keys,
            [
                "codex",
                "claude",
                "hermes",
                "opencode",
                "pi",
                "deepseek-harness"
            ]
        );
        for kind in ExternalRuntimeKind::ALL {
            assert_eq!(registry.get(kind).map(ExternalCliRuntime::kind), Some(kind));
        }
    }

    #[tokio::test]
    async fn lifecycle_protection_rejects_parallel_mutation_and_releases_on_failure() {
        let registry = Arc::new(ExternalRuntimeRegistry::try_from_runtimes(vec![]).unwrap());
        let guard = registry.protect_thread("thread-1").await.unwrap();
        assert!(registry.protect_thread("thread-1").await.is_err());
        assert!(registry.ensure_thread_writable("thread-1").await.is_err());
        drop(guard);
        tokio::time::timeout(Duration::from_secs(1), async {
            while registry.ensure_thread_writable("thread-1").await.is_err() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(registry.ensure_thread_writable("thread-1").await.is_ok());
    }

    fn accepted_request(runtime: ExternalRuntimeKind) -> AcceptedRequest {
        let (result, _receiver) = watch::channel(Some(Ok(String::new())));
        AcceptedRequest {
            runtime,
            fingerprint: [0; 32],
            result,
            terminal_at: None,
        }
    }

    #[test]
    fn reconciliation_keeps_an_accepted_run_until_terminal_confirmation() {
        let mut admissions = AdmissionState::default();
        admissions.requests.insert(
            ("thread-1".into(), "run-1".into()),
            accepted_request(ExternalRuntimeKind::Codex),
        );
        admissions.occupied.insert(
            "thread-1".into(),
            OccupiedThread {
                run_id: "run-1".into(),
                runtime: ExternalRuntimeKind::Codex,
                dispatching: false,
            },
        );

        reconcile_admissions(&mut admissions, &[]);

        assert!(admissions.occupied.contains_key("thread-1"));
        assert!(
            admissions.requests[&(String::from("thread-1"), String::from("run-1"))]
                .terminal_at
                .is_none()
        );

        admissions
            .requests
            .get_mut(&(String::from("thread-1"), String::from("run-1")))
            .unwrap()
            .terminal_at = Some(Instant::now());
        reconcile_admissions(&mut admissions, &[]);

        assert!(!admissions.occupied.contains_key("thread-1"));
        assert!(
            admissions.requests[&(String::from("thread-1"), String::from("run-1"))]
                .terminal_at
                .is_some()
        );
    }

    #[test]
    fn reconciliation_keeps_a_run_reported_active_by_its_runtime() {
        let mut admissions = AdmissionState::default();
        admissions.requests.insert(
            ("thread-1".into(), "run-1".into()),
            accepted_request(ExternalRuntimeKind::Codex),
        );
        admissions.occupied.insert(
            "thread-1".into(),
            OccupiedThread {
                run_id: "run-1".into(),
                runtime: ExternalRuntimeKind::Codex,
                dispatching: false,
            },
        );
        let snapshots = [RuntimeRunSnapshot {
            runtime: ExternalRuntimeKind::Codex,
            thread_id: "thread-1".into(),
            info: RunInfo::active(
                1,
                None,
                Some("codex"),
                Some("run-1".into()),
                Some("thread-1".into()),
                None,
            ),
        }];

        reconcile_admissions(&mut admissions, &snapshots);

        assert_eq!(admissions.occupied["thread-1"].run_id, "run-1");
        assert!(
            admissions.requests[&(String::from("thread-1"), String::from("run-1"))]
                .terminal_at
                .is_none()
        );
    }

    #[test]
    fn reconciliation_replaces_a_stale_slot_with_a_different_active_run() {
        let mut admissions = AdmissionState::default();
        let mut old_request = accepted_request(ExternalRuntimeKind::Codex);
        // A confirmed terminal state makes the old slot eligible for reuse.
        old_request.terminal_at = Some(Instant::now());
        admissions
            .requests
            .insert(("thread-1".into(), "run-old".into()), old_request);
        admissions.occupied.insert(
            "thread-1".into(),
            OccupiedThread {
                run_id: "run-old".into(),
                runtime: ExternalRuntimeKind::Codex,
                dispatching: false,
            },
        );
        let snapshots = [RuntimeRunSnapshot {
            runtime: ExternalRuntimeKind::Codex,
            thread_id: "thread-1".into(),
            info: RunInfo::active(
                2,
                None,
                Some("codex"),
                Some("run-new".into()),
                Some("thread-1".into()),
                None,
            ),
        }];

        reconcile_admissions(&mut admissions, &snapshots);

        assert_eq!(admissions.occupied["thread-1"].run_id, "run-new");
        assert!(
            admissions.requests[&(String::from("thread-1"), String::from("run-old"))]
                .terminal_at
                .is_some()
        );
    }
}
