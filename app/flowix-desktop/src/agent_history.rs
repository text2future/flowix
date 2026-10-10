//! External-agent history application service.
//!
//! The service owns pagination and source-selection policy. Runtime adapters
//! own provider protocols and legacy transcript details. Tauri commands only
//! select a runtime and forward the product request.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;

mod adapters;

pub use crate::agent_external::runtime_registry::ExternalRuntimeKind;
use crate::agent_external::{
    codex::CodexAppServerManager, deepseek_harness::DeepSeekHarnessManager,
    opencode::OpenCodeAcpManager,
};
use crate::agent_session::{ChatMessage, ThreadInfo, ThreadManager, ThreadMessagesPage};

use self::adapters::builtin_adapters;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HistoryAuthority {
    Provider,
    Journal,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HistoryPolicy {
    pub authority: HistoryAuthority,
    pub legacy_fallback: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct HistoryPageRequest<'a> {
    pub thread_id: &'a str,
    pub before_sequence: Option<i64>,
    pub snapshot_sequence: Option<i64>,
    pub limit: i64,
}

/// Port implemented by each runtime. Adding another agent no longer requires
/// changing `AgentHistoryService` or the thread commands.
#[async_trait]
pub trait HistoryAdapter: Send + Sync {
    fn runtime(&self) -> ExternalRuntimeKind;
    fn policy(&self) -> HistoryPolicy;
    async fn list_threads(&self) -> Result<Vec<ThreadInfo>, String>;
    async fn read_page(
        &self,
        request: HistoryPageRequest<'_>,
    ) -> Result<ThreadMessagesPage, String>;
}

pub struct AgentHistoryService {
    adapters: HashMap<ExternalRuntimeKind, Arc<dyn HistoryAdapter>>,
}

impl AgentHistoryService {
    pub fn new(
        threads: Arc<ThreadManager>,
        codex: Arc<CodexAppServerManager>,
        opencode: Arc<OpenCodeAcpManager>,
        dsh: Arc<DeepSeekHarnessManager>,
    ) -> Self {
        Self::try_from_adapters(builtin_adapters(threads, codex, opencode, dsh))
            .expect("built-in history adapters must have unique runtime keys")
    }

    fn try_from_adapters(
        adapters: impl IntoIterator<Item = Arc<dyn HistoryAdapter>>,
    ) -> Result<Self, String> {
        let mut registry = HashMap::new();
        for adapter in adapters {
            let runtime = adapter.runtime();
            if registry.insert(runtime, adapter).is_some() {
                return Err(format!(
                    "history adapter is registered more than once for {}",
                    runtime.key()
                ));
            }
        }
        Ok(Self { adapters: registry })
    }

    pub fn policy(&self, runtime: ExternalRuntimeKind) -> Result<HistoryPolicy, String> {
        Ok(self.adapter(runtime)?.policy())
    }

    pub async fn list_threads(
        &self,
        runtime: ExternalRuntimeKind,
    ) -> Result<Vec<ThreadInfo>, String> {
        self.adapter(runtime)?.list_threads().await
    }

    pub async fn read_page(
        &self,
        runtime: ExternalRuntimeKind,
        thread_id: &str,
        before_sequence: Option<i64>,
        snapshot_sequence: Option<i64>,
        limit: i64,
    ) -> Result<ThreadMessagesPage, String> {
        self.adapter(runtime)?
            .read_page(HistoryPageRequest {
                thread_id,
                before_sequence,
                snapshot_sequence,
                limit,
            })
            .await
    }

    pub async fn read_all(
        &self,
        runtime: ExternalRuntimeKind,
        thread_id: &str,
    ) -> Result<Vec<ChatMessage>, String> {
        let adapter = self.adapter(runtime)?;
        let mut snapshot_sequence = None;
        let mut page = adapter
            .read_page(HistoryPageRequest {
                thread_id,
                before_sequence: None,
                snapshot_sequence,
                limit: 50,
            })
            .await?;
        snapshot_sequence = page.snapshot_sequence;
        let mut messages = page.messages;
        let mut previous_cursor = None;

        while page.has_more {
            let before = page.oldest_sequence.ok_or_else(|| {
                format!(
                    "{} history reported more pages without a cursor",
                    runtime.key()
                )
            })?;
            if previous_cursor == Some(before) {
                return Err(format!(
                    "{} history cursor did not advance at {before}",
                    runtime.key()
                ));
            }
            previous_cursor = Some(before);
            page = adapter
                .read_page(HistoryPageRequest {
                    thread_id,
                    before_sequence: Some(before),
                    snapshot_sequence,
                    limit: 50,
                })
                .await?;
            let mut older = page.messages;
            older.extend(messages);
            messages = older;
        }
        Ok(messages)
    }

    fn adapter(&self, runtime: ExternalRuntimeKind) -> Result<&Arc<dyn HistoryAdapter>, String> {
        self.adapters
            .get(&runtime)
            .ok_or_else(|| format!("history adapter is not registered for {}", runtime.key()))
    }
}

pub(super) const fn provider_policy() -> HistoryPolicy {
    HistoryPolicy {
        authority: HistoryAuthority::Provider,
        legacy_fallback: false,
    }
}

pub(super) const fn journal_policy() -> HistoryPolicy {
    HistoryPolicy {
        authority: HistoryAuthority::Journal,
        legacy_fallback: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct FakeAdapter {
        runtime: ExternalRuntimeKind,
        policy: HistoryPolicy,
        pages: Mutex<Vec<ThreadMessagesPage>>,
    }

    #[async_trait]
    impl HistoryAdapter for FakeAdapter {
        fn runtime(&self) -> ExternalRuntimeKind {
            self.runtime
        }
        fn policy(&self) -> HistoryPolicy {
            self.policy
        }
        async fn list_threads(&self) -> Result<Vec<ThreadInfo>, String> {
            Ok(Vec::new())
        }
        async fn read_page(
            &self,
            _request: HistoryPageRequest<'_>,
        ) -> Result<ThreadMessagesPage, String> {
            let mut pages = self.pages.lock().unwrap();
            if pages.is_empty() {
                return Err("unexpected history page request".to_string());
            }
            Ok(pages.remove(0))
        }
    }

    fn empty_page(oldest_sequence: Option<i64>, has_more: bool) -> ThreadMessagesPage {
        ThreadMessagesPage {
            messages: Vec::new(),
            oldest_sequence,
            has_more,
            snapshot_sequence: None,
            complete_turn_ids: None,
        }
    }

    #[test]
    fn adapters_expose_history_policy_through_the_registry() {
        let adapter = Arc::new(FakeAdapter {
            runtime: ExternalRuntimeKind::Claude,
            policy: journal_policy(),
            pages: Mutex::new(Vec::new()),
        }) as Arc<dyn HistoryAdapter>;
        let service = AgentHistoryService::try_from_adapters([adapter]).unwrap();
        assert_eq!(
            service.policy(ExternalRuntimeKind::Claude).unwrap(),
            journal_policy()
        );
        assert!(service.policy(ExternalRuntimeKind::Codex).is_err());
    }

    #[tokio::test]
    async fn read_all_rejects_a_non_advancing_cursor() {
        let adapter = Arc::new(FakeAdapter {
            runtime: ExternalRuntimeKind::Codex,
            policy: provider_policy(),
            pages: Mutex::new(vec![empty_page(Some(10), true), empty_page(Some(10), true)]),
        }) as Arc<dyn HistoryAdapter>;
        let service = AgentHistoryService::try_from_adapters([adapter]).unwrap();
        let error = match service
            .read_all(ExternalRuntimeKind::Codex, "thread-1")
            .await
        {
            Ok(_) => panic!("non-advancing cursor should fail"),
            Err(error) => error,
        };
        assert!(error.contains("cursor did not advance"));
    }

    #[tokio::test]
    async fn missing_adapter_fails_explicitly() {
        let service = AgentHistoryService::try_from_adapters([]).unwrap();
        let error = match service
            .read_page(ExternalRuntimeKind::Hermes, "thread-1", None, None, 50)
            .await
        {
            Ok(_) => panic!("missing adapter should fail"),
            Err(error) => error,
        };
        assert!(error.contains("not registered"));
    }

    #[test]
    fn duplicate_runtime_registration_is_rejected() {
        let first = Arc::new(FakeAdapter {
            runtime: ExternalRuntimeKind::Codex,
            policy: provider_policy(),
            pages: Mutex::new(Vec::new()),
        }) as Arc<dyn HistoryAdapter>;
        let second = Arc::new(FakeAdapter {
            runtime: ExternalRuntimeKind::Codex,
            policy: provider_policy(),
            pages: Mutex::new(Vec::new()),
        }) as Arc<dyn HistoryAdapter>;

        let error = match AgentHistoryService::try_from_adapters([first, second]) {
            Ok(_) => panic!("duplicate runtime registration should fail"),
            Err(error) => error,
        };
        assert!(error.contains("more than once"));
    }
}
