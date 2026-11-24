//! 线程与历史的读取、分叉与归档。
//!
//! 历史投影本身在 `history_projection`；这里只负责把 provider 的线程列表/消息页
//! 取回来并落到 Flowix 的线程存储。

use super::*;

use super::super::AGENT_TYPE;
use crate::agent_external::select_external_session_for_runtime;
use crate::agent_session::{ChatMessage, ThreadInfo, ThreadMessagesPage};
use serde_json::{json, Value};

impl CodexAppServerManager {
    pub async fn list_threads(&self) -> Result<Vec<ThreadInfo>, String> {
        self.ensure_connection().await?;
        let mut cursor = None;
        let mut threads = Vec::new();
        loop {
            let result = self
                .request(
                    "thread/list",
                    json!({
                        "cursor": cursor,
                        "limit": 100,
                        "sortKey": "recency_at",
                        "sourceKinds": ["cli", "vscode", "appServer"]
                    }),
                )
                .await?;
            threads.extend(
                result
                    .get("data")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(app_server_thread_info),
            );
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }

        // The App Server owns provider session ids, while Flowix owns the
        // product thread ids used by conversation instances and titles.  The
        // UI must receive the product id for every known binding; otherwise
        // a title lookup compares `threads.title` against a provider id and
        // falls back to a runtime-wide title slot.
        let bindings = self
            .inner
            .thread_manager
            .list_external_session_bindings(AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;
        for thread in &mut threads {
            let Some(product_thread_id) = bindings.get(&thread.thread_id) else {
                continue;
            };
            if let Some(product_info) = self
                .inner
                .thread_manager
                .get_thread_info(product_thread_id)
                .await
                .map_err(|error| error.to_string())?
            {
                *thread = product_info;
            } else {
                thread.thread_id = product_thread_id.clone();
            }
        }
        Ok(threads)
    }

    pub async fn get_thread_messages(&self, thread_id: &str) -> Result<Vec<ChatMessage>, String> {
        let mut page = self
            .get_thread_messages_page(thread_id, None, None, 1000)
            .await?;
        let snapshot_sequence = page.snapshot_sequence;
        let mut messages = page.messages;
        while page.has_more {
            page = self
                .get_thread_messages_page(thread_id, page.oldest_sequence, snapshot_sequence, 1000)
                .await?;
            let mut older = page.messages;
            older.append(&mut messages);
            messages = older;
        }
        Ok(messages)
    }

    pub async fn get_thread_messages_page(
        &self,
        thread_id: &str,
        before_sequence: Option<i64>,
        snapshot_sequence: Option<i64>,
        limit: i64,
    ) -> Result<ThreadMessagesPage, String> {
        self.ensure_connection().await?;
        // `thread/turns/list(itemsView: "full")` is the authoritative
        // persisted transcript shape: it preserves the server's turn and item
        // ordering, includes command/tool items, and keeps terminal status on
        // its owning turn. Do not flatten `thread/items/list` and reconstruct
        // that relationship from timestamps: every item in a turn commonly
        // shares `startedAt`, which makes a later history/live merge able to
        // reorder tool rows.
        let mut cursor: Option<String> = None;
        let mut turns = Vec::new();
        loop {
            let result = self
                .request(
                    "thread/turns/list",
                    json!({
                        "threadId": thread_id,
                        "cursor": cursor,
                        "limit": 100,
                        "sortDirection": "asc",
                        "itemsView": "full"
                    }),
                )
                .await
                .map_err(|error| {
                    format!(
                        "Codex paginated history requires Codex CLI {MIN_PAGINATED_CODEX_VERSION} or newer. Update with `npm install -g @openai/codex@latest --force --include=optional`. App Server error: {error}"
                    )
                })?;
            turns.extend(
                result
                    .get("data")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .cloned(),
            );
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        // Codex deliberately omits a native goal command (and its hidden
        // context) from `thread/turns/list`. Read the current provider-owned
        // goal state only to restore the latest goal row; no Flowix message
        // history is written or consulted here.
        if let Ok(goal) = self
            .request("thread/goal/get", json!({ "threadId": thread_id }))
            .await
        {
            annotate_goal_turn(&mut turns, &goal);
        }
        Ok(paginate_app_server_turns(
            &turns,
            before_sequence,
            snapshot_sequence,
            limit,
        ))
    }

    /// Fork a persisted Codex thread at the requested completed Turn and bind
    /// the new Codex session to a new Flowix product thread.
    pub async fn fork_thread(
        &self,
        flowix_thread_id: &str,
        last_turn_id: &str,
        new_flowix_thread_id: &str,
    ) -> Result<String, String> {
        self.ensure_connection().await?;
        let stored = self
            .inner
            .thread_manager
            .get_external_session(flowix_thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;
        let source_codex_thread_id = select_external_session_for_runtime(stored, None)
            .ok_or_else(|| "Codex thread has not been started".to_string())?;
        let result = self
            .request(
                "thread/fork",
                json!({
                    "threadId": source_codex_thread_id,
                    "lastTurnId": last_turn_id,
                    "historyMode": "paginated"
                }),
            )
            .await?;
        let new_codex_thread_id = result
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| "Codex app-server did not return a forked thread id".to_string())?
            .to_string();
        self.inner
            .thread_manager
            .upsert_external_session(
                new_flowix_thread_id,
                AGENT_TYPE,
                &new_codex_thread_id,
                Some(result),
            )
            .await
            .map_err(|error| error.to_string())?;
        Ok(new_codex_thread_id)
    }

    /// Archive the provider-side Codex thread: the rollout moves into Codex's
    /// archived sessions directory, so `thread/list` stops returning it. The
    /// rollout stays recoverable through `thread/unarchive`.
    pub async fn archive_thread(&self, codex_thread_id: &str) -> Result<(), String> {
        self.provider_thread_lifecycle("thread/archive", codex_thread_id)
            .await
    }

    /// Hard-delete the provider-side Codex thread together with any spawned
    /// descendant threads. Rollout files and metadata are removed permanently;
    /// missing rollouts are treated as already deleted by the app-server.
    pub async fn delete_thread(&self, codex_thread_id: &str) -> Result<(), String> {
        self.provider_thread_lifecycle("thread/delete", codex_thread_id)
            .await
    }

    pub(super) async fn provider_thread_lifecycle(
        &self,
        method: &str,
        codex_thread_id: &str,
    ) -> Result<(), String> {
        self.ensure_connection().await?;
        self.request(method, json!({ "threadId": codex_thread_id }))
            .await?;
        Ok(())
    }
}
