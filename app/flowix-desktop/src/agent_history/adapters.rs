//! Built-in runtime history adapters.
//!
//! Provider-owned runtimes read their native history APIs. Product-owned
//! runtimes read the Flowix event journal first and only use transcript readers
//! as a compatibility fallback.

use std::sync::Arc;

use async_trait::async_trait;

use super::{
    ExternalRuntimeKind, HistoryAdapter, HistoryPageRequest, HistoryPolicy, journal_policy,
    provider_policy,
};
use crate::agent_external::{
    codex::CodexAppServerManager, deepseek_harness::DeepSeekHarnessManager,
    opencode::OpenCodeAcpManager,
};
use crate::agent_session::{ThreadInfo, ThreadManager, ThreadMessagesPage};

pub(super) fn builtin_adapters(
    threads: Arc<ThreadManager>,
    codex: Arc<CodexAppServerManager>,
    opencode: Arc<OpenCodeAcpManager>,
    dsh: Arc<DeepSeekHarnessManager>,
) -> [Arc<dyn HistoryAdapter>; 5] {
    [
        Arc::new(CodexHistoryAdapter {
            threads: threads.clone(),
            client: codex,
        }),
        Arc::new(DshHistoryAdapter { client: dsh }),
        Arc::new(OpenCodeHistoryAdapter { client: opencode }),
        Arc::new(ClaudeHistoryAdapter {
            threads: threads.clone(),
        }),
        Arc::new(HermesHistoryAdapter { threads }),
    ]
}

struct CodexHistoryAdapter {
    threads: Arc<ThreadManager>,
    client: Arc<CodexAppServerManager>,
}

#[async_trait]
impl HistoryAdapter for CodexHistoryAdapter {
    fn runtime(&self) -> ExternalRuntimeKind {
        ExternalRuntimeKind::Codex
    }
    fn policy(&self) -> HistoryPolicy {
        provider_policy()
    }
    async fn list_threads(&self) -> Result<Vec<ThreadInfo>, String> {
        self.client.list_threads().await
    }
    async fn read_page(
        &self,
        request: HistoryPageRequest<'_>,
    ) -> Result<ThreadMessagesPage, String> {
        let session_id = self
            .threads
            .get_external_session(request.thread_id, self.runtime().key())
            .await
            .map_err(|error| error.to_string())?
            .unwrap_or_else(|| request.thread_id.to_string());
        self.client
            .get_thread_messages_page(
                &session_id,
                request.before_sequence,
                request.snapshot_sequence,
                request.limit,
            )
            .await
    }
}

struct DshHistoryAdapter {
    client: Arc<DeepSeekHarnessManager>,
}

#[async_trait]
impl HistoryAdapter for DshHistoryAdapter {
    fn runtime(&self) -> ExternalRuntimeKind {
        ExternalRuntimeKind::DeepSeekHarness
    }
    fn policy(&self) -> HistoryPolicy {
        provider_policy()
    }
    async fn list_threads(&self) -> Result<Vec<ThreadInfo>, String> {
        self.client.list_threads().await
    }
    async fn read_page(
        &self,
        request: HistoryPageRequest<'_>,
    ) -> Result<ThreadMessagesPage, String> {
        self.client
            .session_history_page(
                request.thread_id,
                request.before_sequence,
                request.snapshot_sequence,
                request.limit,
            )
            .await
    }
}

struct OpenCodeHistoryAdapter {
    client: Arc<OpenCodeAcpManager>,
}

#[async_trait]
impl HistoryAdapter for OpenCodeHistoryAdapter {
    fn runtime(&self) -> ExternalRuntimeKind {
        ExternalRuntimeKind::OpenCode
    }
    fn policy(&self) -> HistoryPolicy {
        provider_policy()
    }
    async fn list_threads(&self) -> Result<Vec<ThreadInfo>, String> {
        self.client.list_threads().await
    }
    async fn read_page(
        &self,
        request: HistoryPageRequest<'_>,
    ) -> Result<ThreadMessagesPage, String> {
        self.client
            .get_thread_messages_page(request.thread_id, request.before_sequence, request.limit)
            .await
    }
}

struct ClaudeHistoryAdapter {
    threads: Arc<ThreadManager>,
}

#[async_trait]
impl HistoryAdapter for ClaudeHistoryAdapter {
    fn runtime(&self) -> ExternalRuntimeKind {
        ExternalRuntimeKind::Claude
    }
    fn policy(&self) -> HistoryPolicy {
        journal_policy()
    }
    async fn list_threads(&self) -> Result<Vec<ThreadInfo>, String> {
        self.threads
            .list_external_threads(self.runtime().key())
            .await
            .map_err(|error| error.to_string())
    }
    async fn read_page(
        &self,
        request: HistoryPageRequest<'_>,
    ) -> Result<ThreadMessagesPage, String> {
        if let Some(page) = self
            .threads
            .get_claude_event_messages_page(
                request.thread_id,
                request.before_sequence,
                request.limit,
            )
            .await
            .map_err(|error| error.to_string())?
        {
            return Ok(page);
        }
        crate::agent_external::claude::get_session_page(
            request.thread_id,
            request.before_sequence,
            request.limit,
        )
        .await
    }
}

struct HermesHistoryAdapter {
    threads: Arc<ThreadManager>,
}

#[async_trait]
impl HistoryAdapter for HermesHistoryAdapter {
    fn runtime(&self) -> ExternalRuntimeKind {
        ExternalRuntimeKind::Hermes
    }
    fn policy(&self) -> HistoryPolicy {
        journal_policy()
    }
    async fn list_threads(&self) -> Result<Vec<ThreadInfo>, String> {
        self.threads
            .list_external_threads(self.runtime().key())
            .await
            .map_err(|error| error.to_string())
    }
    async fn read_page(
        &self,
        request: HistoryPageRequest<'_>,
    ) -> Result<ThreadMessagesPage, String> {
        if let Some(page) = self
            .threads
            .get_external_event_messages_page(
                self.runtime().key(),
                request.thread_id,
                request.before_sequence,
                request.limit,
            )
            .await
            .map_err(|error| error.to_string())?
        {
            return Ok(page);
        }
        crate::agent_external::hermes::get_session_page(
            request.thread_id,
            request.before_sequence,
            request.limit,
        )
        .await
    }
}
