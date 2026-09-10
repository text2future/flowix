//! Long-lived Codex app-server runtime.
//!
//! The app-server protocol is JSON-RPC over JSONL on stdio. A single server
//! owns many Codex threads and turns, so Flowix keeps the process connection
//! separately from the per-thread run registry.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex};

use super::command::{build_codex_entrypoint, preflight_codex, resolve_codex_cwd};
use super::AGENT_TYPE;
use crate::agent_external::lifecycle::ExternalLifecycleEmitter;
use crate::agent_external::{
    emit_chunk_with_run_id, emit_chunk_with_run_id_and_metadata,
    select_external_session_for_runtime, AgentChunkMetadata, USER_STOPPED_REASON,
};
use crate::agent_session::{ChatMessage, ThreadInfo, ThreadManager, ThreadMessagesPage};
use crate::agent_types::AgentId;
use crate::agent_wire::{AgentChunk, AgentUserMessage, RunInfo};

const INITIALIZE_METHOD: &str = "initialize";
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
const CONTEXT_COMPACTION_MESSAGE_TYPE: &str = "context-compaction";
const MIN_PAGINATED_CODEX_VERSION: &str = "0.150.0";

fn is_image_attachment(path: &str) -> bool {
    matches!(
        std::path::Path::new(path)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp" | "gif")
    )
}

struct Connection {
    _child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
}

struct ActiveTurn {
    flowix_thread_id: String,
    run_id: String,
    codex_thread_id: String,
    codex_turn_id: String,
    app_handle: tauri::AppHandle,
    started_at: i64,
    last_event_at: i64,
    stream_end_emitted: Arc<AtomicBool>,
}

struct Inner {
    thread_manager: Arc<ThreadManager>,
    connection: Mutex<Option<Connection>>,
    // Serialize the first connection attempt. `ensure_connection` is called
    // by thread, history, and model APIs and those calls can arrive
    // concurrently during startup; checking `connection` alone is not enough
    // to prevent spawning one app-server per caller.
    connection_start_lock: Mutex<()>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    pending_approvals: Mutex<HashSet<String>>,
    app_handle: Mutex<Option<tauri::AppHandle>>,
    active_turns: Mutex<HashMap<String, ActiveTurn>>,
    latest_usage: Mutex<HashMap<String, crate::agent_types::UsageInfo>>,
    next_request_id: AtomicU64,
}

pub struct CodexAppServerManager {
    inner: Arc<Inner>,
}

impl CodexAppServerManager {
    pub fn new(thread_manager: Arc<ThreadManager>) -> Self {
        Self {
            inner: Arc::new(Inner {
                thread_manager,
                connection: Mutex::new(None),
                connection_start_lock: Mutex::new(()),
                pending: Mutex::new(HashMap::new()),
                pending_approvals: Mutex::new(HashSet::new()),
                app_handle: Mutex::new(None),
                active_turns: Mutex::new(HashMap::new()),
                latest_usage: Mutex::new(HashMap::new()),
                next_request_id: AtomicU64::new(1),
            }),
        }
    }

    async fn ensure_connection(&self) -> Result<(), String> {
        if self.inner.connection.lock().await.is_some() {
            return Ok(());
        }

        // Re-check after taking the startup lock: another caller may have
        // completed the connection while this caller was waiting.
        let _startup = self.inner.connection_start_lock.lock().await;
        if self.inner.connection.lock().await.is_some() {
            return Ok(());
        }

        preflight_codex()?;
        verify_paginated_codex_version().await?;
        let mut command = build_codex_entrypoint();
        command
            .args(["app-server", "--listen", "stdio://"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::process_window::hide_command_window(&mut command);
        crate::agent_external::shared::configure_unix_process_group(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start Codex app-server: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Codex app-server stdin is unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Codex app-server stdout is unavailable".to_string())?;
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !line.trim().is_empty() {
                        tracing::debug!("[CodexAppServer] stderr: {line}");
                    }
                }
            });
        }

        let stdin = Arc::new(Mutex::new(stdin));
        let reader_inner = self.inner.clone();
        let reader_stdin = stdin.clone();
        tokio::spawn(async move {
            read_loop(reader_inner, reader_stdin, BufReader::new(stdout)).await;
        });
        *self.inner.connection.lock().await = Some(Connection {
            _child: child,
            stdin,
        });

        self.request(
            INITIALIZE_METHOD,
            json!({
                "clientInfo": {
                    "name": "flowix",
                    "title": "Flowix",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": { "experimentalApi": true }
            }),
        )
        .await?;
        self.notify("initialized", json!({})).await
    }

    async fn write(&self, message: Value) -> Result<(), String> {
        let stdin = self
            .inner
            .connection
            .lock()
            .await
            .as_ref()
            .map(|connection| connection.stdin.clone())
            .ok_or_else(|| "Codex app-server is not connected".to_string())?;
        let mut stdin = stdin.lock().await;
        let encoded = serde_json::to_string(&message).map_err(|error| error.to_string())?;
        stdin
            .write_all(encoded.as_bytes())
            .await
            .map_err(|error| format!("failed to write to Codex app-server: {error}"))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|error| format!("failed to delimit Codex app-server message: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("failed to flush Codex app-server input: {error}"))
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.inner.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.inner.pending.lock().await.insert(id, sender);
        if let Err(error) = self
            .write(json!({ "id": id, "method": method, "params": params }))
            .await
        {
            self.inner.pending.lock().await.remove(&id);
            return Err(error);
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(format!(
                "Codex app-server closed before responding to {method}"
            )),
            Err(_) => {
                self.inner.pending.lock().await.remove(&id);
                Err(format!("Codex app-server timed out responding to {method}"))
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write(json!({ "method": method, "params": params }))
            .await
    }

    async fn request_all_pages(&self, method: &str, params: Value) -> Result<Value, String> {
        let mut cursor: Option<String> = None;
        let mut seen_cursors = HashSet::new();
        let mut data = Vec::new();
        const MAX_PAGES: usize = 100;
        for _ in 0..MAX_PAGES {
            let mut page_params = params.clone();
            if let Some(object) = page_params.as_object_mut() {
                object.insert("cursor".to_string(), json!(cursor));
            }
            let page = self.request(method, page_params).await?;
            data.extend(
                page.get("data")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .cloned(),
            );
            cursor = page
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_string);
            let Some(next_cursor) = cursor.as_ref() else {
                return Ok(json!({ "data": data }));
            };
            if !seen_cursors.insert(next_cursor.clone()) {
                return Err(format!(
                    "Codex app-server returned a repeated cursor for {method}"
                ));
            }
        }
        Err(format!(
            "Codex app-server pagination exceeded {MAX_PAGES} pages for {method}"
        ))
    }

    /// Read the Codex capabilities that are effective for one project root.
    /// This is a metadata-only operation: it does not create a thread or spend
    /// model tokens. Keep the cwd explicit so project-local config and skills
    /// cannot leak across notebooks in the preferences UI.
    pub async fn project_capabilities(
        &self,
        cwd: &std::path::Path,
        force_reload: bool,
    ) -> Result<Value, String> {
        self.ensure_connection().await?;
        let cwd = cwd.to_string_lossy().to_string();

        let (
            skills,
            config,
            requirements,
            models,
            mcp,
            plugins,
            plugin_catalog,
            agents,
            experiments,
        ) = tokio::join!(
            self.request(
                "skills/list",
                json!({ "cwds": [cwd.clone()], "forceReload": force_reload }),
            ),
            self.request("config/read", json!({ "cwd": cwd.clone() })),
            self.request("configRequirements/read", json!({})),
            self.request_all_pages("model/list", json!({ "limit": 100 })),
            self.request_all_pages(
                "mcpServerStatus/list",
                json!({ "limit": 100, "detail": "full" }),
            ),
            self.request("plugin/installed", json!({ "cwds": [cwd.clone()] }),),
            self.request(
                "plugin/list",
                json!({ "cwds": [cwd.clone()], "forceRefetch": force_reload }),
            ),
            // Descendant threads are Codex's durable representation of
            // spawned sub-agents. Filtering by cwd keeps this repo-scoped.
            self.request_all_pages(
                "thread/list",
                json!({
                    "cwd": cwd.clone(),
                    "limit": 100,
                    "sortKey": "recency_at",
                    "sortDirection": "desc",
                    "sourceKinds": [
                        "subAgent",
                        "subAgentReview",
                        "subAgentCompact",
                        "subAgentThreadSpawn",
                        "subAgentOther"
                    ]
                }),
            ),
            self.request_all_pages("experimentalFeature/list", json!({ "limit": 100 })),
        );

        fn result_or_error(result: Result<Value, String>) -> Value {
            match result {
                Ok(value) => json!({ "ok": true, "value": value }),
                Err(error) => json!({ "ok": false, "error": error }),
            }
        }

        Ok(json!({
            "cwd": cwd,
            "skills": result_or_error(skills),
            "config": result_or_error(config),
            "requirements": result_or_error(requirements),
            "models": result_or_error(models),
            "mcp": result_or_error(mcp),
            "plugins": result_or_error(plugins),
            "pluginCatalog": result_or_error(plugin_catalog),
            "agents": result_or_error(agents),
            "experiments": result_or_error(experiments),
            "projectConfigPath": std::path::Path::new(&cwd).join(".codex").join("config.toml"),
            "refreshedAt": chrono::Utc::now().timestamp_millis(),
        }))
    }

    pub async fn write_project_config(
        &self,
        cwd: &std::path::Path,
        edits: Value,
        expected_version: Option<String>,
    ) -> Result<Value, String> {
        self.ensure_connection().await?;
        let edits = edits
            .as_array()
            .ok_or_else(|| "config edits must be an array".to_string())?;
        if edits.is_empty() || edits.len() > 20 {
            return Err("config write requires between 1 and 20 edits".to_string());
        }
        const ALLOWED_KEYS: &[&str] = &[
            "model",
            "model_reasoning_effort",
            "model_reasoning_summary",
            "model_verbosity",
            "review_model",
            "service_tier",
            "approval_policy",
            "approvals_reviewer",
            "sandbox_mode",
            "sandbox_workspace_write.network_access",
            "web_search",
            "instructions",
            "developer_instructions",
        ];
        for edit in edits {
            let key = edit
                .get("keyPath")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !ALLOWED_KEYS.contains(&key) {
                return Err(format!("Codex setting is not editable from Flowix: {key}"));
            }
            if edit.get("mergeStrategy").and_then(Value::as_str) != Some("replace") {
                return Err("Codex settings UI only supports replace writes".to_string());
            }
            let value = edit.get("value").unwrap_or(&Value::Null);
            let valid = match key {
                "sandbox_workspace_write.network_access" => value.is_boolean(),
                "model_reasoning_effort" => {
                    matches!(value.as_str(), Some("low" | "medium" | "high" | "xhigh"))
                }
                "model_verbosity" => matches!(value.as_str(), Some("low" | "medium" | "high")),
                "service_tier" => matches!(
                    value.as_str(),
                    Some("auto" | "default" | "flex" | "priority")
                ),
                "approval_policy" => matches!(
                    value.as_str(),
                    Some("untrusted" | "on-failure" | "on-request" | "never")
                ),
                "approvals_reviewer" => matches!(value.as_str(), Some("user" | "auto_review")),
                "sandbox_mode" => matches!(
                    value.as_str(),
                    Some("read-only" | "workspace-write" | "danger-full-access")
                ),
                "web_search" => matches!(
                    value.as_str(),
                    Some("disabled" | "cached" | "indexed" | "live")
                ),
                "instructions" | "developer_instructions" => {
                    value.as_str().is_some_and(|text| text.len() <= 50_000)
                }
                _ => value
                    .as_str()
                    .is_some_and(|text| !text.is_empty() && text.len() <= 200),
            };
            if !valid {
                return Err(format!("Invalid value for Codex setting: {key}"));
            }
        }
        let dot_codex = cwd.join(".codex");
        std::fs::create_dir_all(&dot_codex)
            .map_err(|error| format!("failed to create project Codex config folder: {error}"))?;
        if !crate::config::path_is_inside(&dot_codex, cwd) {
            return Err("project Codex config folder resolves outside the notebook".to_string());
        }
        self.request(
            "config/batchWrite",
            json!({
                "filePath": dot_codex.join("config.toml"),
                "expectedVersion": expected_version,
                "edits": edits,
                "reloadUserConfig": true
            }),
        )
        .await
    }

    pub async fn set_skill_enabled(&self, name: &str, enabled: bool) -> Result<Value, String> {
        self.ensure_connection().await?;
        self.request(
            "skills/config/write",
            json!({ "name": name, "enabled": enabled }),
        )
        .await
    }

    pub async fn set_plugin_installed(
        &self,
        plugin_id: &str,
        installed: bool,
    ) -> Result<Value, String> {
        self.ensure_connection().await?;
        let (method, params) = if installed {
            ("plugin/install", json!({ "pluginName": plugin_id }))
        } else {
            ("plugin/uninstall", json!({ "pluginId": plugin_id }))
        };
        self.request(method, params).await
    }

    pub async fn reload_mcp_servers(&self) -> Result<Value, String> {
        self.ensure_connection().await?;
        self.request("config/mcpServer/reload", json!({})).await
    }

    pub async fn upsert_project_mcp(
        &self,
        cwd: &std::path::Path,
        name: &str,
        definition: Value,
        expected_version: Option<String>,
    ) -> Result<Value, String> {
        self.ensure_connection().await?;
        if name.is_empty()
            || name.len() > 64
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err("MCP name may only contain letters, numbers, '-' and '_'".to_string());
        }
        let definition = definition
            .as_object()
            .ok_or_else(|| "MCP definition must be an object".to_string())?;
        if definition
            .keys()
            .any(|key| !matches!(key.as_str(), "command" | "args" | "url" | "enabled"))
        {
            return Err("MCP definition contains unsupported fields".to_string());
        }
        let has_command = definition
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty());
        let has_url = definition
            .get("url")
            .and_then(Value::as_str)
            .is_some_and(|v| v.starts_with("http://") || v.starts_with("https://"));
        if has_command == has_url {
            return Err("MCP definition must contain either command or http(s) url".to_string());
        }
        if definition
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(|v| v.len() > 4_096)
            || definition
                .get("url")
                .and_then(Value::as_str)
                .is_some_and(|v| v.len() > 2_048)
            || definition.get("enabled").is_some_and(|v| !v.is_boolean())
        {
            return Err("MCP definition contains an invalid value".to_string());
        }
        if let Some(args) = definition.get("args") {
            let args = args
                .as_array()
                .ok_or_else(|| "MCP args must be an array".to_string())?;
            if args.len() > 100
                || args
                    .iter()
                    .any(|arg| arg.as_str().map_or(true, |v| v.len() > 4_096))
            {
                return Err("MCP args exceed the allowed size".to_string());
            }
        }
        let dot_codex = cwd.join(".codex");
        std::fs::create_dir_all(&dot_codex)
            .map_err(|e| format!("failed to create project Codex config folder: {e}"))?;
        if !crate::config::path_is_inside(&dot_codex, cwd) {
            return Err("project Codex config folder resolves outside the notebook".to_string());
        }
        let result = self.request("config/batchWrite", json!({
            "filePath": dot_codex.join("config.toml"),
            "expectedVersion": expected_version,
            "edits": [{ "keyPath": format!("mcp_servers.{name}"), "value": definition, "mergeStrategy": "replace" }],
            "reloadUserConfig": true
        })).await?;
        self.request("config/mcpServer/reload", json!({})).await?;
        Ok(result)
    }

    async fn resolve_codex_thread(
        &self,
        flowix_thread_id: &str,
        message: &AgentUserMessage,
    ) -> Result<(String, PathBuf), String> {
        let stored = self
            .inner
            .thread_manager
            .get_external_session(flowix_thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;
        let session_id = select_external_session_for_runtime(stored, None);
        let cwd = self
            .resolve_codex_cwd_for_next_turn(flowix_thread_id, message)
            .await?;
        if let Some(codex_thread_id) = session_id {
            self.request("thread/resume", json!({ "threadId": codex_thread_id }))
                .await?;
            return Ok((codex_thread_id, cwd));
        }

        // Writable threads use the interactive server-request approval path;
        // unsupported server requests remain fail-closed in read_loop.
        let approval = app_server_approval_policy(message.permission_mode_for_runtime(AGENT_TYPE));
        let workspace_roots = message.workspace_paths_for_runtime(AGENT_TYPE);
        let result = self
            .request(
                "thread/start",
                json!({
                    "cwd": cwd,
                    "model": message.codex_model_for_runtime(),
                    // `thread/start` still uses the legacy string field.
                    // The object-form `sandboxPolicy` is for turn/start and
                    // thread/settings/update; passing it here is accepted by
                    // some server versions but silently leaves the thread
                    // read-only.
                    "sandbox": app_server_legacy_sandbox(message.permission_mode_for_runtime(AGENT_TYPE)),
                    "approvalPolicy": approval,
                    "approvalsReviewer": "user",
                    // Persist the paginated transcript so thread/read and
                    // thread/turns/list can return command/tool items after
                    // the live stream has completed. Without this, Codex
                    // still emits item/* notifications but the legacy
                    // history view drops those items on reload.
                    "historyMode": "paginated",
                    "runtimeWorkspaceRoots": workspace_roots,
                    "serviceName": "flowix"
                }),
            )
            .await?;
        let codex_thread_id = result
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| "Codex app-server did not return a thread id".to_string())?
            .to_string();
        self.inner
            .thread_manager
            .upsert_external_session(flowix_thread_id, AGENT_TYPE, &codex_thread_id, Some(result))
            .await
            .map_err(|error| error.to_string())?;
        Ok((codex_thread_id, cwd))
    }

    /// `turn/start` accepts `cwd`, so Codex can deliberately apply a workspace
    /// selection made while a previous turn was running. Keep Flowix's stored
    /// cwd in sync for session metadata, but do not let that historical value
    /// override the directory selected for this next turn.
    async fn resolve_codex_cwd_for_next_turn(
        &self,
        flowix_thread_id: &str,
        message: &AgentUserMessage,
    ) -> Result<PathBuf, String> {
        let cwd = resolve_codex_cwd(message, None).ok_or_else(|| {
            "Agent working directory unavailable; open a notebook or pick a folder".to_string()
        })?;
        if self
            .inner
            .thread_manager
            .read_frozen_cwd(flowix_thread_id)
            .await
            .ok()
            .flatten()
            .as_ref()
            != Some(&cwd)
        {
            if let Err(error) = self
                .inner
                .thread_manager
                .upsert_frozen_cwd(flowix_thread_id, &cwd)
                .await
            {
                tracing::warn!(
                    "failed to persist Codex working directory for {flowix_thread_id}: {error}"
                );
            }
        }
        Ok(cwd)
    }

    pub async fn chat_stream(
        self: &Arc<Self>,
        flowix_thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<String, String> {
        *self.inner.app_handle.lock().await = Some(app_handle.clone());
        self.ensure_connection().await?;
        let flowix_thread_id = flowix_thread_id.to_string();
        let run_id = message
            .run_id
            .clone()
            .unwrap_or_else(|| crate::agent_external::resolve_run_id(&flowix_thread_id, None));
        if self
            .inner
            .active_turns
            .lock()
            .await
            .contains_key(&flowix_thread_id)
        {
            return Err("Codex already has an active turn for this thread".to_string());
        }
        // The web projection inserts the user row optimistically before this
        // request reaches the runtime. Codex's own userMessage item is the
        // acknowledgement/history source; emitting another synthetic user
        // event here creates a second visible row and has no provider id.
        self.emit_stream_start(app_handle, &flowix_thread_id, &message, &run_id)
            .await;

        let started = async {
            let (codex_thread_id, cwd) = self.resolve_codex_thread(&flowix_thread_id, &message).await?;
            let approval = app_server_approval_policy(message.permission_mode_for_runtime(AGENT_TYPE));
            let sandbox = app_server_sandbox(message.permission_mode_for_runtime(AGENT_TYPE));
            let mut input = vec![json!({ "type": "text", "text": message.llm_content.clone().unwrap_or_else(|| message.content.clone()) })];
            let mut attached_files = Vec::new();
            for path in message.image_paths.iter().filter(|path| std::path::Path::new(path).is_file()) {
                if is_image_attachment(path) {
                    input.push(json!({ "type": "localImage", "path": path }));
                } else {
                    attached_files.push(path.as_str());
                }
            }
            if !attached_files.is_empty() {
                let paths = attached_files.iter().map(|path| format!("- {path}")).collect::<Vec<_>>().join("\n");
                input.push(json!({ "type": "text", "text": format!("\n<attached_files>\n{paths}\n</attached_files>") }));
            }
            let result = self.request("turn/start", json!({
                "threadId": codex_thread_id,
                "input": input,
                "cwd": cwd,
                "model": message.codex_model_for_runtime(),
                "effort": message.codex_reasoning_effort_for_runtime(),
                "approvalPolicy": approval,
                "sandboxPolicy": sandbox
            })).await?;
            let codex_turn_id = result.pointer("/turn/id").and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| "Codex app-server did not return a turn id".to_string())?.to_string();
            self.inner.active_turns.lock().await.insert(flowix_thread_id.clone(), ActiveTurn {
                flowix_thread_id: flowix_thread_id.clone(), run_id: run_id.clone(), codex_thread_id,
                codex_turn_id, app_handle: app_handle.clone(), started_at: chrono::Utc::now().timestamp_millis(),
                last_event_at: chrono::Utc::now().timestamp_millis(), stream_end_emitted: Arc::new(AtomicBool::new(false)),
            });
            Ok::<(), String>(())
        }.await;
        if let Err(error) = started {
            self.emit_run_error(app_handle, &flowix_thread_id, error.clone(), &run_id)
                .await;
            self.emit_stream_end(
                app_handle,
                &flowix_thread_id,
                &run_id,
                Some(error),
                &Arc::new(AtomicBool::new(false)),
            )
            .await;
        }
        Ok(String::new())
    }

    pub async fn steer_chat(
        &self,
        flowix_thread_id: &str,
        message: AgentUserMessage,
        client_user_message_id: String,
        app_handle: &tauri::AppHandle,
    ) -> Result<(), String> {
        self.ensure_connection().await?;
        let active = self
            .inner
            .active_turns
            .lock()
            .await
            .get(flowix_thread_id)
            .map(|turn| (turn.codex_thread_id.clone(), turn.codex_turn_id.clone()))
            .ok_or_else(|| "Codex has no steerable active turn".to_string())?;
        let mut input = vec![json!({
            "type": "text",
            "text": message.llm_content.unwrap_or(message.content),
        })];
        input.extend(
            message
                .image_paths
                .iter()
                .filter(|path| std::path::Path::new(path).is_file())
                .filter(|path| is_image_attachment(path))
                .map(|path| json!({ "type": "localImage", "path": path })),
        );
        let attached_files = message
            .image_paths
            .iter()
            .filter(|path| std::path::Path::new(path).is_file())
            .filter(|path| !is_image_attachment(path))
            .map(|path| format!("- {path}"))
            .collect::<Vec<_>>();
        if !attached_files.is_empty() {
            input.push(json!({ "type": "text", "text": format!("\n<attached_files>\n{}\n</attached_files>", attached_files.join("\n")) }));
        }
        self.request(
            "turn/steer",
            json!({
                "threadId": active.0,
                "expectedTurnId": active.1,
                "clientUserMessageId": client_user_message_id,
                "input": input,
            }),
        )
        .await?;
        let _ = app_handle;
        Ok(())
    }

    pub async fn stop_chat(
        &self,
        thread_id: &str,
        _run_id: Option<&str>,
        app_handle: &tauri::AppHandle,
    ) -> bool {
        let active = self.inner.active_turns.lock().await.remove(thread_id);
        let Some(active) = active else {
            return false;
        };
        let _ = self
            .request(
                "turn/interrupt",
                json!({ "threadId": active.codex_thread_id, "turnId": active.codex_turn_id }),
            )
            .await;
        self.emit_stream_end(
            app_handle,
            &active.flowix_thread_id,
            &active.run_id,
            Some(USER_STOPPED_REASON.to_string()),
            &active.stream_end_emitted,
        )
        .await;
        true
    }

    pub async fn running_threads(&self) -> HashMap<String, RunInfo> {
        self.inner
            .active_turns
            .lock()
            .await
            .iter()
            .map(|(id, active)| {
                (
                    id.clone(),
                    RunInfo::active(
                        active.started_at,
                        None,
                        Some(AGENT_TYPE),
                        Some(active.run_id.clone()),
                        Some(active.flowix_thread_id.clone()),
                        Some(active.codex_thread_id.clone()),
                    ),
                )
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
        let active = std::mem::take(&mut *self.inner.active_turns.lock().await);
        let count = active.len();
        for (_, turn) in active {
            let _ = self
                .request(
                    "turn/interrupt",
                    json!({ "threadId": turn.codex_thread_id, "turnId": turn.codex_turn_id }),
                )
                .await;
            self.emit_stream_end(
                &turn.app_handle,
                &turn.flowix_thread_id,
                &turn.run_id,
                Some(USER_STOPPED_REASON.to_string()),
                &turn.stream_end_emitted,
            )
            .await;
        }

        // The app-server is shared by all Codex threads and is not owned by
        // any single turn. Explicitly terminate it during application
        // shutdown; dropping `tokio::process::Child` alone does not guarantee
        // that the child process exits.
        if let Some(mut connection) = self.inner.connection.lock().await.take() {
            let _ = connection._child.kill().await;
            let _ = connection._child.wait().await;
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

    pub async fn supported_models(&self) -> Result<Vec<String>, String> {
        self.ensure_connection().await?;
        let result = self.request("model/list", json!({ "limit": 100 })).await?;
        let mut seen = std::collections::HashSet::new();
        Ok(result
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|model| {
                model
                    .get("model")
                    .or_else(|| model.get("id"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|model| !model.is_empty())
            })
            .filter(|model| seen.insert((*model).to_string()))
            .map(str::to_string)
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

    async fn provider_thread_lifecycle(
        &self,
        method: &str,
        codex_thread_id: &str,
    ) -> Result<(), String> {
        self.ensure_connection().await?;
        self.request(method, json!({ "threadId": codex_thread_id }))
            .await?;
        Ok(())
    }

    /// Reply to a server-initiated JSON-RPC request with its original id.
    /// RequestId is kept as JSON text for compatibility with numeric and
    /// string ids emitted by different app-server versions.
    pub async fn respond_to_server_request(
        &self,
        request_id: &str,
        result: Value,
    ) -> Result<(), String> {
        if !self.inner.pending_approvals.lock().await.remove(request_id) {
            return Err("Codex approval request is no longer pending".to_string());
        }
        let id = serde_json::from_str::<Value>(request_id)
            .map_err(|_| "Invalid Codex approval request id".to_string())?;
        self.write(json!({ "id": id, "result": result })).await
    }

    /// Apply settings to an existing Codex thread. These settings affect the
    /// next turn and preserve the conversation history.
    pub async fn update_thread_settings(
        &self,
        flowix_thread_id: &str,
        model: Option<&str>,
        reasoning_effort: Option<&str>,
        permission_mode: Option<&str>,
    ) -> Result<(), String> {
        self.ensure_connection().await?;
        let stored = self
            .inner
            .thread_manager
            .get_external_session(flowix_thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;
        let codex_thread_id = select_external_session_for_runtime(stored, None)
            .ok_or_else(|| "Codex thread has not been started".to_string())?;
        let mut settings = serde_json::Map::new();
        if let Some(model) = model.filter(|value| !value.trim().is_empty() && *value != "inherit") {
            settings.insert("model".into(), json!(model));
        }
        if let Some(effort) =
            reasoning_effort.filter(|value| !value.trim().is_empty() && *value != "inherit")
        {
            settings.insert("reasoningEffort".into(), json!(effort));
        }
        if let Some(permission) = permission_mode {
            settings.insert("sandboxPolicy".into(), app_server_sandbox(Some(permission)));
        }
        if settings.is_empty() {
            return Ok(());
        }
        settings.insert("threadId".into(), json!(codex_thread_id));
        self.request("thread/settings/update", Value::Object(settings).into())
            .await?;
        Ok(())
    }
}

async fn verify_paginated_codex_version() -> Result<(), String> {
    let output = build_codex_entrypoint()
        .arg("--version")
        .output()
        .await
        .map_err(|error| format!("Unable to read Codex CLI version: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = if stdout.trim().is_empty() {
        stderr.trim()
    } else {
        stdout.trim()
    };
    let version = text
        .split_whitespace()
        .find_map(|part| parse_codex_version(part.trim_start_matches('v')))
        .ok_or_else(|| format!("Unable to parse Codex CLI version from `{text}`"))?;
    let minimum = parse_codex_version(MIN_PAGINATED_CODEX_VERSION)
        .expect("minimum Codex version must be valid");
    if version < minimum {
        return Err(format!(
            "Flowix paginated history requires Codex CLI {MIN_PAGINATED_CODEX_VERSION} or newer (installed: {text}). Update with `npm install -g @openai/codex@latest --force --include=optional`."
        ));
    }
    Ok(())
}

fn parse_codex_version(value: &str) -> Option<(u64, u64, u64)> {
    let stable = value.split('-').next()?;
    let mut parts = stable.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    Some((major, minor, patch))
}

#[async_trait::async_trait]
impl ExternalLifecycleEmitter for CodexAppServerManager {
    fn lifecycle_agent_type(&self) -> &'static str {
        AGENT_TYPE
    }
    async fn emit_and_persist_lifecycle_chunk(
        &self,
        app: &tauri::AppHandle,
        chunk: &AgentChunk,
        run_id: &str,
    ) {
        emit_chunk_with_run_id(app, chunk, AGENT_TYPE, run_id);
    }
}

async fn read_loop(
    inner: Arc<Inner>,
    stdin: Arc<Mutex<ChildStdin>>,
    mut reader: BufReader<tokio::process::ChildStdout>,
) {
    let mut line = String::new();
    loop {
        line.clear();
        let Ok(bytes) = reader.read_line(&mut line).await else {
            break;
        };
        if bytes == 0 {
            break;
        }
        let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if let Some(id) = message.get("id") {
            if let Some(id_number) = id.as_u64() {
                if let Some(sender) = inner.pending.lock().await.remove(&id_number) {
                    let result = message
                        .get("error")
                        .map(|error| {
                            Err(error
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("Codex app-server request failed")
                                .to_string())
                        })
                        .unwrap_or_else(|| {
                            Ok(message.get("result").cloned().unwrap_or(Value::Null))
                        });
                    let _ = sender.send(result);
                    continue;
                }
            }
            if let Some(method) = message.get("method").and_then(Value::as_str) {
                if is_user_decision_request(method) {
                    let request_id = id.to_string();
                    inner
                        .pending_approvals
                        .lock()
                        .await
                        .insert(request_id.clone());
                    let params = message.get("params").cloned().unwrap_or(Value::Null);
                    let request = CodexApprovalRequest {
                        request_id,
                        method: method.to_string(),
                        thread_id: request_context(&params, "threadId"),
                        turn_id: request_context(&params, "turnId"),
                        item_id: request_context(&params, "itemId"),
                        params,
                    };
                    if let Some(app) = inner.app_handle.lock().await.clone() {
                        if let Err(error) = app.emit("codex-approval-request", request) {
                            tracing::warn!("failed to emit Codex approval request: {error}");
                        }
                    } else {
                        inner
                            .pending_approvals
                            .lock()
                            .await
                            .remove(&request.request_id);
                        write_server_response(&stdin, id, server_decline_result(method)).await;
                    }
                } else {
                    write_server_response(&stdin, id, json!("decline")).await;
                }
            }
            continue;
        }
        dispatch_notification(&inner, &message).await;
    }
    for (_, sender) in inner.pending.lock().await.drain() {
        let _ = sender.send(Err("Codex app-server connection closed".to_string()));
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexApprovalRequest {
    pub request_id: String,
    pub method: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub params: Value,
}

fn is_user_decision_request(method: &str) -> bool {
    matches!(
        method,
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
    )
}

fn server_decline_result(method: &str) -> Value {
    if method == "item/permissions/requestApproval" {
        json!({ "permissions": {}, "scope": "turn", "strictAutoReview": null })
    } else {
        json!({ "decision": "decline" })
    }
}

fn request_context(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(Value::as_str).map(str::to_string)
}

async fn write_server_response(stdin: &Arc<Mutex<ChildStdin>>, id: &Value, result: Value) {
    let reply = json!({ "id": id, "result": result });
    if let Ok(encoded) = serde_json::to_string(&reply) {
        let mut writer = stdin.lock().await;
        let _ = writer.write_all(format!("{encoded}\n").as_bytes()).await;
        let _ = writer.flush().await;
    }
}

async fn dispatch_notification(inner: &Arc<Inner>, message: &Value) {
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return;
    };
    let params = message.get("params").unwrap_or(&Value::Null);
    if method == "thread/settings/updated" {
        // Forward the authoritative App Server settings to the UI. The
        // notification can arrive outside an active turn, so it must not be
        // routed through the turn event path below.
        if let Some(app) = inner.app_handle.lock().await.clone() {
            let _ = app.emit("codex-thread-settings-updated", params.clone());
        }
        return;
    }
    if method == "thread/tokenUsage/updated" {
        if let (Some(thread_id), Some(usage)) = (
            params.get("threadId").and_then(Value::as_str),
            codex_usage_info(params.get("tokenUsage").unwrap_or(&Value::Null)),
        ) {
            inner
                .latest_usage
                .lock()
                .await
                .insert(thread_id.to_string(), usage);
        }
    }
    let thread_id = params
        .get("threadId")
        .and_then(Value::as_str)
        .or_else(|| params.pointer("/turn/threadId").and_then(Value::as_str));
    let turn_id = params
        .get("turnId")
        .and_then(Value::as_str)
        .or_else(|| params.pointer("/turn/id").and_then(Value::as_str));
    let active = {
        let mut turns = inner.active_turns.lock().await;
        // Item lifecycle notifications are turn-scoped. Never fall back to
        // the currently active turn when `turnId` is absent: a late item from
        // the previous turn would otherwise be attributed to the new run on
        // the same Codex thread.
        let requires_exact_turn = turn_scoped_notification(method);
        let found = (thread_id.is_some() || turn_id.is_some())
            && (!requires_exact_turn || (thread_id.is_some() && turn_id.is_some()));
        let found = found
            .then(|| {
                turns.values_mut().find(|active| {
                    thread_id
                        .map(|id| id == active.codex_thread_id)
                        .unwrap_or(true)
                        && turn_id.map(|id| id == active.codex_turn_id).unwrap_or(true)
                })
            })
            .flatten();
        found.map(|active| {
            active.last_event_at = chrono::Utc::now().timestamp_millis();
            (
                active.flowix_thread_id.clone(),
                active.run_id.clone(),
                active.app_handle.clone(),
                active.stream_end_emitted.clone(),
            )
        })
    };
    let Some((flowix_thread_id, run_id, app, ended)) = active else {
        return;
    };
    match method {
        "thread/tokenUsage/updated" => {
            let token_usage = params.get("tokenUsage").unwrap_or(&Value::Null);
            let last = token_usage
                .get("last")
                .or_else(|| token_usage.get("lastTokenUsage"))
                .and_then(codex_usage_info);
            if let Some(usage) = last {
                emit_notification_chunk(
                    inner,
                    &flowix_thread_id,
                    &run_id,
                    &app,
                    AgentChunk::Usage {
                        thread_id: flowix_thread_id.clone(),
                        model_id: None,
                        last_run_at: None,
                        usage: Some(usage),
                        status_info: None,
                    },
                )
                .await;
            }
        }
        "item/agentMessage/delta" => {
            if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                emit_notification_chunk_with_metadata(
                    inner,
                    &flowix_thread_id,
                    &run_id,
                    &app,
                    AgentChunk::Text {
                        thread_id: flowix_thread_id.clone(),
                        text: delta.to_string(),
                    },
                    with_turn_id(item_delta_metadata(params), turn_id.as_deref()),
                )
                .await;
            }
        }
        "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
            if let Some(delta) = params
                .get("delta")
                .and_then(Value::as_str)
                .filter(|delta| has_visible_text(delta))
            {
                emit_notification_chunk_with_metadata(
                    inner,
                    &flowix_thread_id,
                    &run_id,
                    &app,
                    AgentChunk::Reasoning {
                        thread_id: flowix_thread_id.clone(),
                        text: delta.to_string(),
                    },
                    with_turn_id(item_delta_metadata(params), turn_id.as_deref()),
                )
                .await;
            }
        }
        "item/started" => {
            if let Some(item) = params.get("item") {
                if let Some((id, name)) = tool_identity(item) {
                    emit_notification_chunk_with_metadata(
                        inner,
                        &flowix_thread_id,
                        &run_id,
                        &app,
                        AgentChunk::ToolCall {
                            thread_id: flowix_thread_id.clone(),
                            id,
                            name,
                            input: item.clone(),
                        },
                        item_metadata(item),
                    )
                    .await;
                }
            }
        }
        "item/completed" => {
            if let Some(item) = params.get("item") {
                if let Some((chunk, metadata)) =
                    completed_message_chunk(&flowix_thread_id, item, turn_id.as_deref())
                {
                    emit_notification_chunk_with_metadata(
                        inner,
                        &flowix_thread_id,
                        &run_id,
                        &app,
                        chunk,
                        metadata,
                    )
                    .await;
                } else if let Some((id, name)) = tool_identity(item) {
                    emit_notification_chunk_with_metadata(
                        inner,
                        &flowix_thread_id,
                        &run_id,
                        &app,
                        AgentChunk::ToolResult {
                            thread_id: flowix_thread_id.clone(),
                            id,
                            name,
                            result: item.clone(),
                        },
                        item_metadata(item),
                    )
                    .await;
                }
            }
        }
        "turn/completed" => {
            let status = params
                .pointer("/turn/status")
                .and_then(Value::as_str)
                .unwrap_or("failed");
            let reason = match status {
                "completed" => None,
                "interrupted" => Some(USER_STOPPED_REASON.to_string()),
                _ => Some(
                    params
                        .pointer("/turn/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("Codex turn failed")
                        .to_string(),
                ),
            };
            if ended
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                // App Server normally finalizes messages through item/completed.
                // The completed turn also carries the final agent message, so
                // project it as an idempotent fallback before ending the stream.
                if let Some(item) = params
                    .pointer("/turn/items")
                    .and_then(Value::as_array)
                    .and_then(|items| {
                        items.iter().rev().find(|item| {
                            item.get("type").and_then(Value::as_str) == Some("agentMessage")
                        })
                    })
                {
                    if let Some((chunk, metadata)) =
                        completed_message_chunk(&flowix_thread_id, item, turn_id.as_deref())
                    {
                        emit_notification_chunk_with_metadata(
                            inner,
                            &flowix_thread_id,
                            &run_id,
                            &app,
                            chunk,
                            metadata,
                        )
                        .await;
                    }
                }
                if let Some(reason) = &reason {
                    emit_notification_chunk(
                        inner,
                        &flowix_thread_id,
                        &run_id,
                        &app,
                        AgentChunk::Error {
                            thread_id: flowix_thread_id.clone(),
                            message: reason.clone(),
                            error_details: Some(crate::agent_external::classify_agent_error(
                                reason,
                                "app-server",
                            )),
                        },
                    )
                    .await;
                }
                emit_notification_chunk(
                    inner,
                    &flowix_thread_id,
                    &run_id,
                    &app,
                    AgentChunk::StreamEnd {
                        thread_id: flowix_thread_id.clone(),
                        reason,
                        duration_ms: params.pointer("/turn/durationMs").and_then(Value::as_u64),
                    },
                )
                .await;
            }
            inner.active_turns.lock().await.remove(&flowix_thread_id);
        }
        _ => {}
    }
}

fn codex_usage_info(value: &Value) -> Option<crate::agent_types::UsageInfo> {
    let source = value
        .get("total")
        .or_else(|| value.get("totalTokenUsage"))
        .unwrap_or(value);
    let number = |key: &str| {
        source
            .get(key)
            .and_then(Value::as_u64)
            .map(|n| n.min(u32::MAX as u64) as u32)
    };
    let context = value
        .get("modelContextWindow")
        .or_else(|| value.get("model_context_window"))
        .and_then(Value::as_u64)
        .map(|n| n.min(u32::MAX as u64) as u32);
    if number("inputTokens").is_none()
        && number("input_tokens").is_none()
        && number("outputTokens").is_none()
        && number("output_tokens").is_none()
        && context.is_none()
    {
        return None;
    }
    Some(crate::agent_types::UsageInfo {
        input_tokens: number("inputTokens").or_else(|| number("input_tokens")),
        cached_input_tokens: number("cachedInputTokens").or_else(|| number("cached_input_tokens")),
        output_tokens: number("outputTokens").or_else(|| number("output_tokens")),
        reasoning_output_tokens: number("reasoningOutputTokens")
            .or_else(|| number("reasoning_output_tokens")),
        total_tokens: number("totalTokens").or_else(|| number("total_tokens")),
        model_context_window: context,
        context_used_tokens: None,
    })
}

fn turn_scoped_notification(method: &str) -> bool {
    matches!(
        method,
        "item/agentMessage/delta"
            | "item/reasoning/summaryTextDelta"
            | "item/reasoning/textDelta"
            | "item/started"
            | "item/completed"
            | "turn/completed"
    )
}

async fn emit_notification_chunk(
    _inner: &Arc<Inner>,
    _flowix_thread_id: &str,
    run_id: &str,
    app: &tauri::AppHandle,
    chunk: AgentChunk,
) {
    emit_chunk_with_run_id(app, &chunk, AGENT_TYPE, run_id);
}

async fn emit_notification_chunk_with_metadata(
    _inner: &Arc<Inner>,
    _flowix_thread_id: &str,
    run_id: &str,
    app: &tauri::AppHandle,
    chunk: AgentChunk,
    metadata: AgentChunkMetadata,
) {
    emit_chunk_with_run_id_and_metadata(app, &chunk, AGENT_TYPE, run_id, &metadata);
}

fn item_delta_metadata(params: &Value) -> AgentChunkMetadata {
    let item_id = params
        .get("itemId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string);
    item_metadata_from_id(item_id)
}

fn item_metadata(item: &Value) -> AgentChunkMetadata {
    let item_id = item
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string);
    let mut metadata = item_metadata_from_id(item_id);
    metadata.codex_turn_id = item
        .get("turnId")
        .and_then(Value::as_str)
        .map(str::to_string);
    metadata.client_user_message_id = item
        .get("clientId")
        .and_then(Value::as_str)
        .map(str::to_string);
    metadata
}

fn item_metadata_from_id(item_id: Option<String>) -> AgentChunkMetadata {
    AgentChunkMetadata {
        message_id: item_id.clone(),
        source_message_id: item_id,
        ..AgentChunkMetadata::default()
    }
}

fn with_turn_id(mut metadata: AgentChunkMetadata, turn_id: Option<&str>) -> AgentChunkMetadata {
    metadata.codex_turn_id = turn_id.map(str::to_string);
    metadata
}

fn completed_message_chunk(
    thread_id: &str,
    item: &Value,
    turn_id: Option<&str>,
) -> Option<(AgentChunk, AgentChunkMetadata)> {
    let kind = item.get("type").and_then(Value::as_str)?;
    if kind == "contextCompaction" {
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .unwrap_or("codex-context-compaction")
            .to_string();
        let mut metadata = item_metadata(item);
        metadata.codex_turn_id = turn_id.map(str::to_string);
        metadata.message_phase = Some("completed");
        metadata.content_mode = Some("snapshot");
        return Some((
            AgentChunk::ContextCompaction {
                thread_id: thread_id.to_string(),
                id,
            },
            metadata,
        ));
    }

    let text = match kind {
        // Relay every completed userMessage item, not just steers. The
        // provider item id turns the optimistic `user-<run>` row into a
        // history-stable identity mid-turn (the frontend adopts it in
        // place), so completion reconciliation can anchor by id instead of
        // content fingerprints. Steer items additionally carry clientId so
        // the frontend can reconcile the pending composer row.
        "userMessage" => app_server_content_text(item.get("content")),
        "agentMessage" => item
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        "reasoning" => {
            let summary = app_server_content_text(item.get("summary"));
            if summary.is_empty() {
                app_server_content_text(item.get("content"))
            } else {
                summary
            }
        }
        _ => return None,
    };
    if !has_visible_text(&text) {
        return None;
    }
    let chunk = if kind == "userMessage" {
        AgentChunk::UserMessage {
            thread_id: thread_id.to_string(),
            id: item
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("codex-user")
                .to_string(),
            text,
            timestamp: chrono::Utc::now().timestamp_millis(),
        }
    } else if kind == "agentMessage" {
        AgentChunk::Text {
            thread_id: thread_id.to_string(),
            text,
        }
    } else {
        AgentChunk::Reasoning {
            thread_id: thread_id.to_string(),
            text,
        }
    };
    let mut metadata = item_metadata(item);
    metadata.codex_turn_id = turn_id.map(str::to_string);
    // Completed item notifications do not repeat turnId in the item. The
    // caller fills it from the notification context before emitting.
    metadata.message_phase = Some("completed");
    metadata.content_mode = Some("snapshot");
    Some((chunk, metadata))
}

fn tool_identity(item: &Value) -> Option<(String, String)> {
    let kind = item.get("type").and_then(Value::as_str)?;
    let name = canonical_codex_tool_name(kind)?;
    let id = item.get("id").and_then(Value::as_str)?.to_string();
    Some((id, name.to_string()))
}

fn canonical_codex_tool_name(kind: &str) -> Option<&'static str> {
    match kind {
        "commandExecution" => Some("command_execution"),
        "fileChange" => Some("file_change"),
        "mcpToolCall" => Some("mcp_tool_call"),
        "dynamicToolCall" => Some("dynamic_tool_call"),
        // `collabToolCall` is current; retain the older spelling as an alias.
        "collabToolCall" | "collabAgentToolCall" => Some("collab_agent_tool_call"),
        "webSearch" => Some("web_search"),
        "imageView" | "imageGeneration" => Some("image_generation"),
        _ => None,
    }
}

/// Translate Flowix permission names into the App Server sandbox object.
/// Keep this separate from the App Server v2 `permissions` profile API.
fn app_server_sandbox(permission: Option<&str>) -> Value {
    match permission.map(str::trim) {
        Some("read-only") => json!({ "type": "readOnly" }),
        Some("danger-full-access" | "yolo") => json!({ "type": "dangerFullAccess" }),
        None | Some("workspace-write") => json!({
            "type": "workspaceWrite",
            "writableRoots": [],
            "networkAccess": false
        }),
        _ => json!({ "type": "readOnly" }),
    }
}

/// `thread/start` uses the legacy kebab-case sandbox field. Keep this mapping
/// separate from the object form used by `turn/start` and settings updates.
fn app_server_legacy_sandbox(permission: Option<&str>) -> &'static str {
    match permission.map(str::trim) {
        Some("read-only") => "read-only",
        Some("danger-full-access" | "yolo") => "danger-full-access",
        None | Some("workspace-write") => "workspace-write",
        _ => "read-only",
    }
}

fn app_server_approval_policy(permission: Option<&str>) -> &'static str {
    match permission.map(str::trim) {
        None | Some("workspace-write") => "on-request",
        _ => "never",
    }
}

fn app_server_thread_info(thread: &Value) -> Option<ThreadInfo> {
    let thread_id = thread.get("id")?.as_str()?.trim();
    if thread_id.is_empty() {
        return None;
    }
    let created_at = app_server_timestamp_millis(thread.get("createdAt").and_then(Value::as_i64));
    let updated_at = app_server_timestamp_millis(
        thread
            .get("updatedAt")
            .or_else(|| thread.get("recencyAt"))
            .and_then(Value::as_i64),
    )
    .max(created_at);
    Some(ThreadInfo {
        thread_id: thread_id.to_string(),
        agent_id: AgentId::new(AGENT_TYPE),
        title: thread
            .get("name")
            .or_else(|| thread.get("preview"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .unwrap_or("Codex Session")
            .to_string(),
        created_at,
        updated_at,
    })
}

fn app_server_turn_messages(turns: &[Value]) -> Vec<ChatMessage> {
    let mut messages = Vec::new();
    for (turn_index, turn) in turns.iter().enumerate() {
        let turn_id = turn.get("id").and_then(Value::as_str).map(str::to_string);
        let turn_duration_ms = app_server_turn_duration_ms(turn);
        let turn_message_start = messages.len();
        let timestamp = app_server_timestamp_string(
            turn.get("startedAt")
                .or_else(|| turn.get("createdAt"))
                .and_then(Value::as_i64),
        );
        for (item_index, item) in turn
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            if let Some(message) = app_server_item_message(
                item,
                &timestamp,
                turn_index,
                item_index,
                turn_id.as_deref(),
            ) {
                messages.push(message);
            }
        }
        if let Some(message) = app_server_turn_error_message(turn, &timestamp, turn_index) {
            messages.push(message);
        }
        if let Some(duration_ms) = turn_duration_ms {
            if let Some(message) = messages[turn_message_start..]
                .iter_mut()
                .rev()
                .find(|message| message.role == "assistant")
            {
                message.turn_duration_ms = Some(duration_ms);
            }
        }
    }
    messages
}

fn app_server_turn_duration_ms(turn: &Value) -> Option<u64> {
    turn.get("durationMs").and_then(Value::as_u64)
}

fn app_server_turn_error_message(
    turn: &Value,
    timestamp: &str,
    turn_index: usize,
) -> Option<ChatMessage> {
    let status = turn
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let error = turn.get("error");
    let error_text = error.and_then(|value| {
        value
            .as_str()
            .or_else(|| value.get("message").and_then(Value::as_str))
    });
    let text = match (status, error_text) {
        ("failed", Some(message)) | ("interrupted", Some(message)) => message.to_string(),
        ("failed", None) => "Codex turn failed".to_string(),
        ("interrupted", None) => "Codex turn interrupted".to_string(),
        _ => return None,
    };
    let id = turn
        .get("id")
        .and_then(Value::as_str)
        .map(|id| format!("codex-turn-error-{id}"))
        .unwrap_or_else(|| format!("codex-turn-error-{turn_index}"));
    let mut message = app_server_base_message(id, timestamp);
    message.role = "assistant".to_string();
    message.content = text.clone();
    message.is_completed = Some(true);
    message.error_details = Some(crate::agent_external::classify_agent_error(
        &text,
        "app-server",
    ));
    Some(message)
}

fn app_server_item_message(
    item: &Value,
    timestamp: &str,
    turn_index: usize,
    item_index: usize,
    turn_id: Option<&str>,
) -> Option<ChatMessage> {
    let kind = item.get("type")?.as_str()?;
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("codex-{turn_index}-{item_index}"));
    let mut message = app_server_base_message(id, timestamp);
    message.codex_turn_id = turn_id.map(str::to_string);
    match kind {
        "userMessage" => {
            message.role = "user".to_string();
            message.content = app_server_content_text(item.get("content"));
        }
        "agentMessage" => {
            message.role = "assistant".to_string();
            message.content = item
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
        }
        "reasoning" => {
            let content = app_server_content_text(item.get("summary"));
            message.role = "reasoning".to_string();
            message.content = if content.is_empty() {
                app_server_content_text(item.get("content"))
            } else {
                content
            };
            if !has_visible_text(&message.content) {
                return None;
            }
            // Persisted reasoning items are terminal. Live rows set
            // isCompleted=true on the item/completed snapshot; matching it
            // here keeps render-equivalence (and the collapsed default)
            // stable across live/history reconciliation.
            message.is_completed = Some(true);
            message.reasoning = Some(message.content.clone());
        }
        "contextCompaction" => {
            message.role = "system".to_string();
            message.message_type = Some(CONTEXT_COMPACTION_MESSAGE_TYPE.to_string());
        }
        "commandExecution"
        | "fileChange"
        | "mcpToolCall"
        | "dynamicToolCall"
        | "collabToolCall"
        | "collabAgentToolCall"
        | "webSearch"
        | "imageView"
        | "imageGeneration" => {
            message.role = "tool".to_string();
            message.tool_call_id = item.get("id").and_then(Value::as_str).map(str::to_string);
            message.tool_name = Some(app_server_tool_name(kind, item));
            message.tool_input = Some(item.clone());
            message.tool_data = serde_json::to_string(item).ok();
            message.content = app_server_tool_content(kind, item);
            message.is_completed = item
                .get("status")
                .and_then(Value::as_str)
                .map(|status| status != "inProgress");
        }
        _ => return None,
    }
    Some(message)
}

fn has_visible_text(text: &str) -> bool {
    !text.trim().is_empty()
}

fn app_server_base_message(id: String, timestamp: &str) -> ChatMessage {
    ChatMessage {
        id,
        role: String::new(),
        message_type: None,
        content: String::new(),
        llm_content: None,
        system_reminder_directory: None,
        timestamp: timestamp.to_string(),
        is_loading: None,
        tool_call_id: None,
        tool_name: None,
        tool_data: None,
        tool_input: None,
        tool_call: None,
        tool_result: None,
        tool_calls: None,
        reasoning: None,
        is_completed: None,
        error_details: None,
        is_collapsed: None,
        codex_turn_id: None,
        turn_duration_ms: None,
        source_sequence: None,
    }
}

fn app_server_content_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.to_string(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| match part {
                Value::String(text) => Some(text.as_str()),
                _ => part
                    .get("text")
                    .or_else(|| part.get("content"))
                    .and_then(Value::as_str),
            })
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn app_server_tool_name(kind: &str, _item: &Value) -> String {
    // Keep history projection in lockstep with `tool_identity`, which is used
    // by live item/* notifications. The command itself is input data, not the
    // tool name: using `/bin/zsh -lc pwd` here makes history choose a different
    // formatter from the live `command_execution` row.
    canonical_codex_tool_name(kind).unwrap_or(kind).to_string()
}

fn app_server_tool_content(kind: &str, item: &Value) -> String {
    match kind {
        "commandExecution" => item
            .get("aggregatedOutput")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        "mcpToolCall"
        | "dynamicToolCall"
        | "collabToolCall"
        | "collabAgentToolCall"
        | "imageView"
        | "imageGeneration" => item
            .get("result")
            .map(Value::to_string)
            .or_else(|| item.get("error").map(Value::to_string))
            .unwrap_or_default(),
        _ => item
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or(kind)
            .to_string(),
    }
}

fn app_server_timestamp_millis(value: Option<i64>) -> i64 {
    let value = value.unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
    if value.unsigned_abs() < 10_000_000_000 {
        value.saturating_mul(1000)
    } else {
        value
    }
}

fn app_server_timestamp_string(value: Option<i64>) -> String {
    let millis = app_server_timestamp_millis(value);
    chrono::DateTime::from_timestamp_millis(millis)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339()
}

fn paginate_app_server_turns(
    turns: &[Value],
    before_sequence: Option<i64>,
    snapshot_sequence: Option<i64>,
    limit: i64,
) -> ThreadMessagesPage {
    let limit = limit.clamp(1, 1000) as usize;
    // A page cursor represents a turn boundary, never a flattened message
    // offset. This keeps user/reasoning/tool/final rows from one turn atomic.
    // snapshot_sequence pins later pages to the turn count seen by page one;
    // newly appended turns cannot shift an older-page cursor.
    let snapshot_end = snapshot_sequence
        .map(|sequence| sequence.max(0) as usize)
        .unwrap_or(turns.len())
        .min(turns.len());
    let end = before_sequence
        .map(|sequence| sequence.max(0) as usize)
        .unwrap_or(snapshot_end)
        .min(snapshot_end);
    let start = end.saturating_sub(limit);
    ThreadMessagesPage {
        messages: app_server_turn_messages(&turns[start..end]),
        oldest_sequence: (start > 0).then_some(start as i64),
        has_more: start > 0,
        snapshot_sequence: Some(snapshot_end as i64),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_codex_cli_versions_numerically() {
        let minimum = parse_codex_version(MIN_PAGINATED_CODEX_VERSION).unwrap();
        assert!(parse_codex_version("0.150.0").unwrap() >= minimum);
        assert!(parse_codex_version("0.152.0").unwrap() > minimum);
        assert!(parse_codex_version("0.149.99").unwrap() < minimum);
        assert_eq!(parse_codex_version("0.150.0-beta.1").unwrap(), minimum);
        assert!(parse_codex_version("not-a-version").is_none());
    }

    #[test]
    fn projects_known_tool_items_to_stable_flowix_names() {
        let item = json!({
            "id": "item-1",
            "type": "commandExecution",
            "command": "git status --short"
        });
        assert_eq!(
            tool_identity(&item),
            Some(("item-1".to_string(), "command_execution".to_string()))
        );
    }

    #[test]
    fn accepts_current_app_server_tool_item_names() {
        let collab = json!({ "id": "item-c", "type": "collabToolCall", "tool": "spawn_agent" });
        let image = json!({ "id": "item-i", "type": "imageView", "path": "/tmp/image.png" });

        assert_eq!(
            tool_identity(&collab),
            Some(("item-c".to_string(), "collab_agent_tool_call".to_string()))
        );
        assert_eq!(
            tool_identity(&image),
            Some(("item-i".to_string(), "image_generation".to_string()))
        );
    }

    #[test]
    fn serializes_app_server_sandbox_objects() {
        assert_eq!(
            app_server_sandbox(Some("unknown-mode")),
            json!({ "type": "readOnly" })
        );
        assert_eq!(app_server_approval_policy(Some("unknown-mode")), "never");
        assert_eq!(
            app_server_sandbox(Some("read-only")),
            json!({ "type": "readOnly" })
        );
        assert_eq!(
            app_server_sandbox(Some("danger-full-access")),
            json!({ "type": "dangerFullAccess" })
        );
        assert_eq!(
            app_server_sandbox(Some("yolo")),
            json!({ "type": "dangerFullAccess" })
        );
        assert_eq!(
            app_server_sandbox(None),
            json!({
                "type": "workspaceWrite",
                "writableRoots": [],
                "networkAccess": false
            })
        );
    }

    #[test]
    fn serializes_legacy_thread_start_sandbox_values() {
        assert_eq!(app_server_legacy_sandbox(Some("unknown-mode")), "read-only");
        assert_eq!(app_server_legacy_sandbox(Some("read-only")), "read-only");
        assert_eq!(
            app_server_legacy_sandbox(Some("workspace-write")),
            "workspace-write"
        );
        assert_eq!(app_server_legacy_sandbox(None), "workspace-write");
        assert_eq!(
            app_server_legacy_sandbox(Some("danger-full-access")),
            "danger-full-access"
        );
        assert_eq!(
            app_server_legacy_sandbox(Some("yolo")),
            "danger-full-access"
        );
    }

    #[test]
    fn enables_interactive_approval_only_for_writable_threads() {
        assert_eq!(
            app_server_approval_policy(Some("workspace-write")),
            "on-request"
        );
        assert_eq!(app_server_approval_policy(None), "on-request");
        assert_eq!(app_server_approval_policy(Some("read-only")), "never");
        assert_eq!(
            app_server_approval_policy(Some("danger-full-access")),
            "never"
        );
    }

    #[test]
    fn uses_current_codex_review_decision_wire_values() {
        assert_eq!(
            server_decline_result("item/commandExecution/requestApproval"),
            json!({ "decision": "decline" })
        );
        assert_eq!(
            server_decline_result("item/permissions/requestApproval"),
            json!({ "permissions": {}, "scope": "turn", "strictAutoReview": null })
        );
    }

    #[test]
    fn ignores_non_tool_items() {
        assert_eq!(
            tool_identity(&json!({ "id": "message-1", "type": "agentMessage" })),
            None
        );
    }

    #[test]
    fn ignores_empty_reasoning_items() {
        let message = app_server_item_message(
            &json!({
                "id": "reasoning-empty",
                "type": "reasoning",
                "summary": [" ", "\n"]
            }),
            "2026-01-01T00:00:00Z",
            0,
            0,
            None,
        );
        assert!(message.is_none());
        assert!(!has_visible_text(" \n\t"));
        assert!(has_visible_text("plan"));
    }

    #[test]
    fn projects_context_compaction_as_a_system_message() {
        let message = app_server_item_message(
            &json!({
                "id": "compaction-1",
                "type": "contextCompaction"
            }),
            "2026-01-01T00:00:00Z",
            0,
            0,
            Some("turn-1"),
        )
        .expect("context compaction");

        assert_eq!(message.role, "system");
        assert_eq!(
            message.message_type.as_deref(),
            Some(CONTEXT_COMPACTION_MESSAGE_TYPE)
        );
        assert_eq!(message.codex_turn_id.as_deref(), Some("turn-1"));
    }

    #[test]
    fn gives_tool_lifecycle_events_the_provider_item_identity() {
        let metadata = item_metadata(&json!({
            "id": "call-1",
            "type": "commandExecution"
        }));
        assert_eq!(metadata.message_id.as_deref(), Some("call-1"));
        assert_eq!(metadata.source_message_id.as_deref(), Some("call-1"));
    }

    #[test]
    fn projects_completed_agent_message_as_authoritative_snapshot() {
        let (chunk, metadata) = completed_message_chunk(
            "thread-1",
            &json!({ "id": "message-1", "type": "agentMessage", "text": "Final answer" }),
            None,
        )
        .expect("completed agent message");

        assert!(matches!(
            chunk,
            AgentChunk::Text { thread_id, text }
                if thread_id == "thread-1" && text == "Final answer"
        ));
        assert_eq!(metadata.message_id.as_deref(), Some("message-1"));
        assert_eq!(metadata.source_message_id.as_deref(), Some("message-1"));
        assert_eq!(metadata.message_phase.as_deref(), Some("completed"));
        assert_eq!(metadata.content_mode.as_deref(), Some("snapshot"));
    }

    #[test]
    fn projects_completed_context_compaction_with_stable_identity() {
        let (chunk, metadata) = completed_message_chunk(
            "thread-1",
            &json!({ "id": "compaction-1", "type": "contextCompaction" }),
            Some("turn-1"),
        )
        .expect("completed context compaction");

        assert!(matches!(
            chunk,
            AgentChunk::ContextCompaction { thread_id, id }
                if thread_id == "thread-1" && id == "compaction-1"
        ));
        assert_eq!(metadata.message_id.as_deref(), Some("compaction-1"));
        assert_eq!(metadata.codex_turn_id.as_deref(), Some("turn-1"));
        assert_eq!(metadata.message_phase.as_deref(), Some("completed"));
    }

    #[test]
    fn projects_completed_reasoning_summary_as_authoritative_snapshot() {
        let (chunk, metadata) = completed_message_chunk(
            "thread-1",
            &json!({
                "id": "reasoning-1",
                "type": "reasoning",
                "summary": [{ "type": "text", "text": "Final reasoning" }],
                "content": [{ "type": "text", "text": "Hidden detail" }]
            }),
            None,
        )
        .expect("completed reasoning");

        assert!(matches!(
            chunk,
            AgentChunk::Reasoning { thread_id, text }
                if thread_id == "thread-1" && text == "Final reasoning"
        ));
        assert_eq!(metadata.message_phase.as_deref(), Some("completed"));
        assert_eq!(metadata.content_mode.as_deref(), Some("snapshot"));
    }

    #[test]
    fn turn_scoped_notifications_require_turn_id() {
        assert!(turn_scoped_notification("item/started"));
        assert!(turn_scoped_notification("item/completed"));
        assert!(turn_scoped_notification("turn/completed"));
        assert!(!turn_scoped_notification("thread/status/changed"));
    }

    #[test]
    fn client_messages_omit_the_optional_jsonrpc_header() {
        let message = json!({
            "id": 1,
            "method": "initialize",
            "params": { "clientInfo": { "name": "flowix", "version": "1" } }
        });
        assert!(message.get("jsonrpc").is_none());
    }

    #[test]
    fn projects_app_server_history_without_persisting_it() {
        let thread = json!({
            "turns": [{
                "id": "turn-1",
                "startedAt": 1_730_910_000,
                "durationMs": 69078,
                "items": [
                    { "id": "u1", "type": "userMessage", "content": [{ "type": "text", "text": "Hello" }] },
                    { "id": "a1", "type": "agentMessage", "text": "Hi" },
                    { "id": "r1", "type": "reasoning", "summary": ["Plan"] },
                    { "id": "c1", "type": "commandExecution", "command": "git status", "status": "completed", "aggregatedOutput": "clean" }
                ]
            }]
        });

        let messages = app_server_turn_messages(
            thread
                .get("turns")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default(),
        );
        assert_eq!(messages.len(), 4);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, "Hello");
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].turn_duration_ms, Some(69078));
        assert_eq!(messages[2].reasoning.as_deref(), Some("Plan"));
        assert_eq!(messages[3].tool_name.as_deref(), Some("command_execution"));
        assert_eq!(
            messages[3]
                .tool_input
                .as_ref()
                .and_then(|input| input.get("command")),
            Some(&json!("git status")),
        );
        assert!(messages[3].tool_data.is_some());
    }

    #[test]
    fn preserves_interleaved_app_server_item_order() {
        let thread = json!({
            "turns": [{
                "startedAt": 1_730_910_000,
                "items": [
                    { "id": "a1", "type": "agentMessage", "text": "I will inspect this." },
                    { "id": "c1", "type": "commandExecution", "command": "pwd", "status": "completed" },
                    { "id": "a2", "type": "agentMessage", "text": "The result is ..." }
                ]
            }]
        });

        let messages = app_server_turn_messages(
            thread
                .get("turns")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default(),
        );

        assert_eq!(
            messages
                .iter()
                .map(|message| message.role.as_str())
                .collect::<Vec<_>>(),
            ["assistant", "tool", "assistant"],
        );
        assert_eq!(messages[1].id, "c1");
    }

    #[test]
    fn projects_failed_turn_errors_from_app_server_history() {
        let turns = vec![json!({
            "id": "turn-1",
            "startedAt": 1_730_910_000,
            "status": "failed",
            "error": { "message": "rate limit exceeded" },
            "items": [{ "id": "u1", "type": "userMessage", "content": [{ "type": "text", "text": "Hello" }] }]
        })];

        let messages = app_server_turn_messages(&turns);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].content, "rate limit exceeded");
        assert_eq!(messages[1].id, "codex-turn-error-turn-1");
        assert!(messages[1].error_details.is_some());
    }

    #[test]
    fn keeps_tool_items_and_interruption_with_their_own_turn() {
        let turns = vec![
            json!({
                "id": "turn-1",
                "startedAt": 1_730_910_000,
                "status": "interrupted",
                "items": [
                    { "id": "u1", "type": "userMessage", "content": [{ "type": "text", "text": "Inspect it" }] },
                    { "id": "a1", "type": "agentMessage", "text": "Checking." },
                    { "id": "tool-1", "type": "commandExecution", "command": "pwd", "status": "completed", "aggregatedOutput": "/workspace" }
                ]
            }),
            json!({
                "id": "turn-2",
                "startedAt": 1_730_911_000,
                "status": "completed",
                "items": [
                    { "id": "u2", "type": "userMessage", "content": [{ "type": "text", "text": "Next" }] },
                    { "id": "a2", "type": "agentMessage", "text": "Done." }
                ]
            }),
        ];

        let messages = app_server_turn_messages(&turns);
        assert_eq!(
            messages
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            ["u1", "a1", "tool-1", "codex-turn-error-turn-1", "u2", "a2"],
        );
        assert_eq!(messages[2].role, "tool");
        assert_eq!(messages[3].content, "Codex turn interrupted");
    }

    #[test]
    fn pages_projected_history_on_complete_turn_boundaries() {
        let turns = (0..3)
            .map(|index| json!({
                "id": format!("turn-{index}"),
                "startedAt": 1_730_911_000 + index,
                "status": "completed",
                "items": [
                    { "id": format!("u{index}"), "type": "userMessage", "content": format!("Q{index}") },
                    { "id": format!("a{index}"), "type": "agentMessage", "text": format!("A{index}") }
                ]
            }))
            .collect::<Vec<_>>();
        let page = paginate_app_server_turns(&turns, None, None, 2);
        assert_eq!(page.messages.len(), 4);
        assert_eq!(page.messages[0].id, "u1");
        assert_eq!(page.oldest_sequence, Some(1));
        assert_eq!(page.snapshot_sequence, Some(3));
        assert!(page.has_more);

        let older = paginate_app_server_turns(
            &[
                turns,
                vec![json!({
                    "id": "turn-3",
                    "startedAt": 1_730_911_003,
                    "status": "completed",
                    "items": [{ "id": "u3", "type": "userMessage", "content": "new" }]
                })],
            ]
            .concat(),
            page.oldest_sequence,
            page.snapshot_sequence,
            2,
        );
        assert_eq!(
            older
                .messages
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            ["u0", "a0"]
        );
        assert_eq!(older.snapshot_sequence, Some(3));
    }
}
