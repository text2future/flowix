//! 运行态与能力查询：谁在跑、能跑什么、怎么停。
//!
//! 这一组只读或只影响进程生命周期，不改变会话内容。`reap_inactive_runs` 是唯一
//! 的周期性清理入口，由上层定时调用。

use super::*;

use std::collections::HashMap;
use serde_json::{Value, json};
use super::super::AGENT_TYPE;
use crate::agent_external::select_external_session_for_runtime;
use crate::agent_wire::RunInfo;

impl CodexAppServerManager {
    pub async fn stop_chat(
        &self,
        thread_id: &str,
        run_id: Option<&str>,
        app_handle: &tauri::AppHandle,
    ) -> bool {
        let active = {
            let mut active_turns = self.inner.active_turns.lock().await;
            if let Some(expected) = run_id.filter(|id| !id.trim().is_empty()) {
                if active_turns
                    .get(thread_id)
                    .is_some_and(|active| active.run_id != expected)
                {
                    return false;
                }
            }
            match active_turns.get_mut(thread_id) {
                Some(active) if active.stopping => return false,
                Some(active) if active.codex_turn_id.is_empty() => {
                    // The command/turn RPC may still be in flight. Do not
                    // remove the entry yet: a later turn/started notification
                    // is the only reliable place to learn the turn id that
                    // must receive turn/interrupt.
                    active.cancel_requested = true;
                    active.stopping = true;
                    active.clone()
                }
                Some(active) => {
                    active.stopping = true;
                    active.clone()
                }
                None => {
                    // Ordinary chat and slash commands can both be stopped
                    // before registering a native turn. Hold active_turns until
                    // the scoped cancellation is visible to the startup path.
                    if let Some(run_id) = run_id.filter(|id| !id.trim().is_empty()) {
                        self.inner
                            .pending_cancellations
                            .lock()
                            .await
                            .insert(thread_id.to_string(), run_id.to_string());
                        return true;
                    }
                    return false;
                }
            }
        };
        if !active.codex_turn_id.is_empty() {
            if let Err(error) = self
                .request(
                    "turn/interrupt",
                    json!({ "threadId": active.codex_thread_id, "turnId": active.codex_turn_id }),
                )
                .await
            {
                tracing::warn!("[Codex] StopUnconfirmed for run {}: {error}", active.run_id);
                return false;
            }
        }
        let confirmed = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let still_active = self
                    .inner
                    .active_turns
                    .lock()
                    .await
                    .get(thread_id)
                    .is_some_and(|current| current.run_id == active.run_id);
                if !still_active {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await
        .is_ok();
        if !confirmed {
            tracing::warn!("[Codex] StopUnconfirmed for run {}", active.run_id);
        }
        let _ = app_handle;
        confirmed
    }


    pub async fn running_threads(&self) -> HashMap<String, RunInfo> {
        self.inner
            .active_turns
            .lock()
            .await
            .iter()
            .map(|(id, active)| {
                let mut info = RunInfo::active(
                    active.started_at,
                    None,
                    Some(AGENT_TYPE),
                    Some(active.run_id.clone()),
                    Some(active.flowix_thread_id.clone()),
                    Some(active.codex_thread_id.clone()),
                );
                if active.stopping {
                    info.phase = Some("stopping".to_string());
                }
                (id.clone(), info)
            })
            .collect()
    }


    /// Return Codex's background terminal processes for a product thread.
    /// The app-server response is intentionally kept as JSON: the protocol is
    /// experimental and its terminal fields have changed between Codex builds.
    pub async fn list_background_terminals(&self, flowix_thread_id: &str) -> Result<Value, String> {
        self.ensure_connection().await?;
        let stored = self
            .inner
            .thread_manager
            .get_external_session(flowix_thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;
        let Some(codex_thread_id) = select_external_session_for_runtime(stored, None) else {
            return Ok(json!({ "data": [] }));
        };
        self.request(
            "thread/backgroundTerminals/list",
            json!({ "threadId": codex_thread_id }),
        )
        .await
    }


    pub async fn stop_all(&self) -> usize {
        let active = {
            let mut turns = self.inner.active_turns.lock().await;
            for turn in turns.values_mut() {
                turn.stopping = true;
                turn.cancel_requested = true;
            }
            turns.values().cloned().collect::<Vec<_>>()
        };
        let count = active.len();
        for turn in active {
            if !turn.codex_turn_id.is_empty() {
                let _ = self
                    .request(
                        "turn/interrupt",
                        json!({ "threadId": turn.codex_thread_id, "turnId": turn.codex_turn_id }),
                    )
                    .await;
            }
        }

        // The app-server is shared by all Codex threads and is not owned by
        // any single turn. Explicitly terminate it during application
        // shutdown; dropping `tokio::process::Child` alone does not guarantee
        // that the child process exits.
        let generation = self
            .inner
            .connection
            .lock()
            .await
            .as_ref()
            .map(|connection| connection.generation);
        if let Some(generation) = generation {
            close_connection(&self.inner, generation).await;
        }
        count
    }


    pub async fn reap_inactive_runs(
        &self,
        app_handle: &tauri::AppHandle,
        idle_timeout_ms: i64,
    ) -> usize {
        let now = chrono::Utc::now().timestamp_millis();
        let stale = self
            .inner
            .active_turns
            .lock()
            .await
            .iter()
            .filter_map(|(id, active)| {
                ((now - active.last_event_at) > idle_timeout_ms).then_some(id.clone())
            })
            .collect::<Vec<_>>();
        let mut count = 0;
        for id in stale {
            if self.stop_chat(&id, None, app_handle).await {
                count += 1;
            }
        }
        count
    }


    pub async fn supported_model_catalog(&self) -> Result<Vec<Value>, String> {
        self.ensure_connection().await?;
        let result = self.request("model/list", json!({ "limit": 100 })).await?;
        let mut seen = std::collections::HashSet::new();
        Ok(result
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|model| {
                let id = model
                    .get("model")
                    .or_else(|| model.get("id"))
                    .or_else(|| model.get("slug"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|id| !id.is_empty() && !id.eq_ignore_ascii_case("inherit"))?;
                let source_efforts = model
                    .get("supportedReasoningEfforts")
                    .or_else(|| model.get("supported_reasoning_efforts"))
                    .or_else(|| model.get("supported_reasoning_levels"));
                let reasoning_efforts = source_efforts
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|effort| {
                        effort
                            .as_str()
                            .or_else(|| {
                                effort
                                    .get("reasoningEffort")
                                    .or_else(|| effort.get("effort"))
                                    .or_else(|| effort.get("reasoning_effort"))
                                    .and_then(Value::as_str)
                            })
                    })
                    .map(str::to_ascii_lowercase)
                    .filter(|effort| {
                        matches!(effort.as_str(), "low" | "medium" | "high" | "xhigh" | "max" | "ultra")
                    })
                    .collect::<Vec<_>>();
                Some((id.to_string(), reasoning_efforts))
            })
            .filter(|(id, _)| seen.insert(id.clone()))
            .map(|(id, reasoning_efforts)| json!({ "id": id, "reasoningEfforts": reasoning_efforts }))
            .collect())
    }


    pub async fn supported_models(&self) -> Result<Vec<String>, String> {
        Ok(self
            .supported_model_catalog()
            .await?
            .into_iter()
            .filter_map(|model| model.get("id").and_then(Value::as_str).map(str::to_string))
            .collect())
    }


    /// Read the account snapshot used by the Codex badge popover. Rate limits
    /// are deliberately returned as raw JSON because the app-server schema is
    /// experimental and has added buckets over time.
    pub async fn runtime_info(&self, thread_id: Option<&str>) -> Result<Value, String> {
        self.ensure_connection().await?;
        let account = self
            .request("account/read", json!({ "refreshToken": false }))
            .await
            .unwrap_or(Value::Null);
        let rate_limits = self
            .request("account/rateLimits/read", json!({}))
            .await
            .unwrap_or(Value::Null);
        let usage = match thread_id {
            Some(id) => self.inner.latest_usage.lock().await.get(id).cloned(),
            None => None,
        };
        Ok(json!({
            "account": account.get("account").cloned().unwrap_or(Value::Null),
            "rateLimits": rate_limits,
            "usage": usage,
        }))
    }

}
