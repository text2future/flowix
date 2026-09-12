//! External-agent thread lifecycle application service (archive / delete).
//!
//! Mirrors `agent_history`: the service owns runtime dispatch and fallback
//! policy, runtime adapters own provider protocols, and Tauri commands only
//! forward the product request. A runtime without a registered adapter keeps
//! the Flowix-local semantics (delete the product thread only), so adding a
//! provider-side lifecycle later is a one-adapter change.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;

use crate::agent_external::codex::CodexAppServerManager;
use crate::agent_external::deepseek_harness::DeepSeekHarnessManager;
use crate::agent_external::hermes::HermesAcpManager;
use crate::agent_external::opencode::OpenCodeAcpManager;
pub use crate::agent_external::runtime_registry::ExternalRuntimeKind;
use crate::agent_session::ThreadManager;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LifecycleAction {
    /// Hide the provider-side thread while keeping its persisted transcript
    /// recoverable (Codex `thread/archive`).
    Archive,
    /// Permanently remove the provider-side thread and its descendants
    /// (Codex `thread/delete`).
    Delete,
}

/// Port implemented by runtimes that can archive or delete their own persisted
/// threads. `Ok(false)` means the runtime has no provider-side thread for the
/// conversation, so the caller keeps Flowix-local cleanup only.
#[async_trait]
pub trait ThreadLifecycleAdapter: Send + Sync {
    fn runtime(&self) -> ExternalRuntimeKind;
    async fn apply(&self, thread_id: &str, action: LifecycleAction) -> Result<bool, String>;
}

pub struct AgentLifecycleService {
    adapters: HashMap<ExternalRuntimeKind, Arc<dyn ThreadLifecycleAdapter>>,
}

impl AgentLifecycleService {
    pub fn new(
        threads: Arc<ThreadManager>,
        codex: Arc<CodexAppServerManager>,
        opencode: Arc<OpenCodeAcpManager>,
        hermes: Arc<HermesAcpManager>,
        deepseek_harness: Arc<DeepSeekHarnessManager>,
    ) -> Self {
        let dsh = deepseek_harness.clone();
        let adapters: [Arc<dyn ThreadLifecycleAdapter>; 4] = [
            Arc::new(CodexLifecycleAdapter {
                threads: threads.clone(),
                client: codex,
            }),
            Arc::new(AcpLifecycleAdapter {
                runtime: ExternalRuntimeKind::OpenCode,
                delete: Arc::new(move |thread_id: String| {
                    let client = opencode.clone();
                    Box::pin(async move { client.delete_thread(&thread_id).await })
                }),
            }),
            Arc::new(AcpLifecycleAdapter {
                runtime: ExternalRuntimeKind::Hermes,
                delete: Arc::new(move |thread_id: String| {
                    let client = hermes.clone();
                    Box::pin(async move { client.delete_thread(&thread_id).await })
                }),
            }),
            Arc::new(DeepSeekHarnessLifecycleAdapter { manager: dsh }),
        ];
        Self::try_from_adapters(adapters)
            .expect("built-in lifecycle adapters must have unique runtime keys")
    }

    fn try_from_adapters(
        adapters: impl IntoIterator<Item = Arc<dyn ThreadLifecycleAdapter>>,
    ) -> Result<Self, String> {
        let mut registry = HashMap::new();
        for adapter in adapters {
            let runtime = adapter.runtime();
            if registry.insert(runtime, adapter).is_some() {
                return Err(format!(
                    "lifecycle adapter is registered more than once for {}",
                    runtime.key()
                ));
            }
        }
        Ok(Self { adapters: registry })
    }

    /// Apply `action` to the provider thread behind `thread_id`. Returns
    /// whether a provider-side thread was affected. Unknown agent types and
    /// runtimes without an adapter resolve to `Ok(false)`, preserving the
    /// historical Flowix-local delete behavior.
    pub async fn apply(
        &self,
        agent_type: &str,
        thread_id: &str,
        action: LifecycleAction,
    ) -> Result<bool, String> {
        let Ok(runtime) = ExternalRuntimeKind::parse(agent_type) else {
            return Ok(false);
        };
        match self.adapters.get(&runtime) {
            Some(adapter) => adapter.apply(thread_id, action).await,
            None => Ok(false),
        }
    }
}

struct CodexLifecycleAdapter {
    threads: Arc<ThreadManager>,
    client: Arc<CodexAppServerManager>,
}

type DeleteProvider = Arc<
    dyn Fn(
            String,
        )
            -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<bool, String>> + Send>>
        + Send
        + Sync,
>;

struct AcpLifecycleAdapter {
    runtime: ExternalRuntimeKind,
    delete: DeleteProvider,
}

struct DeepSeekHarnessLifecycleAdapter {
    manager: Arc<DeepSeekHarnessManager>,
}

#[async_trait]
impl ThreadLifecycleAdapter for DeepSeekHarnessLifecycleAdapter {
    fn runtime(&self) -> ExternalRuntimeKind {
        ExternalRuntimeKind::DeepSeekHarness
    }

    async fn apply(&self, thread_id: &str, action: LifecycleAction) -> Result<bool, String> {
        match action {
            LifecycleAction::Archive => self.manager.archive_thread(thread_id).await,
            // DSH deliberately has no hard-delete session API. Flowix's
            // delete therefore uses the same provider archive operation so
            // the session disappears from DSH navigation before its Flowix
            // record is removed.
            LifecycleAction::Delete => self.manager.archive_thread(thread_id).await,
        }
    }
}

#[async_trait]
impl ThreadLifecycleAdapter for AcpLifecycleAdapter {
    fn runtime(&self) -> ExternalRuntimeKind {
        self.runtime
    }

    async fn apply(&self, thread_id: &str, action: LifecycleAction) -> Result<bool, String> {
        if action == LifecycleAction::Archive {
            return Ok(false);
        }
        (self.delete)(thread_id.to_string()).await
    }
}

#[async_trait]
impl ThreadLifecycleAdapter for CodexLifecycleAdapter {
    fn runtime(&self) -> ExternalRuntimeKind {
        ExternalRuntimeKind::Codex
    }

    async fn apply(&self, thread_id: &str, action: LifecycleAction) -> Result<bool, String> {
        if action == LifecycleAction::Archive {
            return Ok(false);
        }
        // Resolution order:
        //   1. the stored flowix→codex session binding (live-started thread)
        //   2. the thread id itself when it already is a Codex thread id
        //      (conversation opened from provider history)
        //   3. otherwise the conversation never reached the provider
        let codex_thread_id = match self
            .threads
            .get_external_session(thread_id, self.runtime().key())
            .await
            .map_err(|error| error.to_string())?
        {
            Some(session_id) => session_id,
            None if is_codex_thread_id(thread_id) => thread_id.to_string(),
            None => return Ok(false),
        };
        self.client.delete_thread(&codex_thread_id).await?;
        Ok(true)
    }
}

/// Codex thread ids are UUIDs; Flowix-local placeholder ids
/// (`codex-local-...`) never are. This keeps never-started conversations on
/// the Flowix-local path instead of sending a bogus id to the app-server.
fn is_codex_thread_id(thread_id: &str) -> bool {
    uuid::Uuid::parse_str(thread_id.trim()).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_codex_thread_ids_but_not_local_placeholders() {
        assert!(is_codex_thread_id("01984de2-8f74-7c91-a3b2-5c5e937cf318"));
        assert!(is_codex_thread_id(" 01984de2-8f74-7c91-a3b2-5c5e937cf318 "));
        assert!(!is_codex_thread_id("codex-local-agent-inst-123"));
        assert!(!is_codex_thread_id(""));
    }

    #[test]
    fn duplicate_runtime_registration_is_rejected() {
        let threads = ThreadManager::for_tests();
        let adapter = Arc::new(CodexLifecycleAdapter {
            threads: threads.clone(),
            client: Arc::new(CodexAppServerManager::new(threads)),
        }) as Arc<dyn ThreadLifecycleAdapter>;
        let error = match AgentLifecycleService::try_from_adapters([adapter.clone(), adapter]) {
            Ok(_) => panic!("duplicate lifecycle registration should fail"),
            Err(error) => error,
        };
        assert!(error.contains("more than once"));
    }

    #[tokio::test]
    async fn unknown_agent_types_and_unmapped_threads_stay_local_only() {
        let threads = ThreadManager::for_tests();
        let service = AgentLifecycleService::new(
            threads.clone(),
            Arc::new(CodexAppServerManager::new(threads.clone())),
            Arc::new(OpenCodeAcpManager::new(threads.clone())),
            Arc::new(HermesAcpManager::new(threads)),
            Arc::new(DeepSeekHarnessManager::new(
                ThreadManager::for_tests(),
                Arc::new(crate::config::UserConfigStore::new(
                    tempfile::tempdir().unwrap().path().to_path_buf(),
                )),
                tempfile::tempdir().unwrap().path().to_path_buf(),
            )),
        );

        // A type without a lifecycle adapter must not fail the delete.
        assert!(!service
            .apply("claude", "thread-1", LifecycleAction::Delete)
            .await
            .unwrap());
        // Unparseable types (local agents) keep local-only semantics too.
        assert!(!service
            .apply("gemini", "thread-1", LifecycleAction::Delete)
            .await
            .unwrap());
        // A never-started Codex conversation has no provider thread, so no
        // app-server connection is attempted and the caller stays local-only.
        assert!(!service
            .apply(
                "codex",
                "codex-local-agent-inst-abc",
                LifecycleAction::Archive
            )
            .await
            .unwrap());
        assert!(!service
            .apply(
                "codex",
                "codex-local-agent-inst-abc",
                LifecycleAction::Delete
            )
            .await
            .unwrap());
    }
}
