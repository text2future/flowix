//! Single registration point for every external CLI runtime.
//!
//! Runtime-specific managers keep their protocol implementations. This layer
//! only normalizes application-wide lifecycle operations so chat dispatch,
//! stop, watchdog reaping, shutdown, and running-thread aggregation cannot
//! drift into separate hard-coded runtime lists.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use futures::future::join_all;

use super::claude::{ClaudeCliManager, AGENT_TYPE as CLAUDE_AGENT_TYPE};
use super::codex::{CodexAppServerManager, AGENT_TYPE as CODEX_AGENT_TYPE};
use super::deepseek_harness::{DeepSeekHarnessManager, AGENT_TYPE as DSH_AGENT_TYPE};
use super::hermes::HermesAcpManager;
use super::opencode::{OpenCodeAcpManager, AGENT_TYPE as OPENCODE_AGENT_TYPE};
use super::pi::{PiRpcManager, AGENT_TYPE as PI_AGENT_TYPE};
use crate::agent_wire::{AgentUserMessage, RunInfo};

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
}

impl ExternalRuntimeRegistry {
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
        })
    }

    pub async fn steer_codex(
        &self,
        thread_id: &str,
        message: AgentUserMessage,
        client_user_message_id: String,
        app_handle: &tauri::AppHandle,
    ) -> Result<(), String> {
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

    pub async fn running_threads(&self) -> HashMap<String, RunInfo> {
        let mut all = HashMap::new();
        for snapshot in self.running_snapshots().await {
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
}
