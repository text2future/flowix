//! 连接层：一条 stdio JSON-RPC 通道。
//!
//! 这里是唯一知道「怎么和 app-server 说话」的地方 —— 进程启停、请求/响应对号、
//! 通知分发的入口。上层方法只调 `request` / `notify`，不碰 stdin。

use super::*;

use super::super::command::{build_codex_entrypoint, preflight_codex};
use crate::agent_session::ThreadManager;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;

impl CodexAppServerManager {
    pub fn new(thread_manager: Arc<ThreadManager>) -> Self {
        Self {
            inner: Arc::new(Inner {
                thread_manager,
                connection: Mutex::new(None),
                connection_start_lock: Mutex::new(()),
                pending: Mutex::new(HashMap::new()),
                pending_approvals: Mutex::new(Vec::new()),
                pending_cancellations: Mutex::new(HashMap::new()),
                app_handle: Mutex::new(None),
                active_turns: Mutex::new(HashMap::new()),
                queued_follow_ups: Mutex::new(HashMap::new()),
                follow_up_operation_locks: Mutex::new(HashMap::new()),
                notification_dispatch: Mutex::new(()),
                latest_usage: Mutex::new(HashMap::new()),
                next_request_id: AtomicU64::new(1),
                next_connection_generation: AtomicU64::new(1),
            }),
        }
    }

    pub(super) async fn ensure_connection(&self) -> Result<(), String> {
        // Hold the startup lock through initialization so other callers never
        // reuse a connection before the handshake has completed.
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
        let generation = self
            .inner
            .next_connection_generation
            .fetch_add(1, Ordering::Relaxed);
        *self.inner.connection.lock().await = Some(Connection {
            _child: child,
            stdin: stdin.clone(),
            generation,
        });
        let reader_inner = self.inner.clone();
        tokio::spawn(async move {
            read_loop(reader_inner, stdin, BufReader::new(stdout), generation).await;
        });

        let initialized = self
            .request(
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
            .await;
        let initialized = match initialized {
            Ok(_) => self.notify("initialized", json!({})).await,
            Err(error) => Err(error),
        };
        if initialized.is_err() {
            close_connection(&self.inner, generation).await;
        }
        initialized
    }

    pub(super) async fn write(&self, message: Value) -> Result<(), String> {
        write_inner(&self.inner, message).await
    }

    pub(super) async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        request_inner(&self.inner, method, params).await
    }

    pub(super) async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write(json!({ "method": method, "params": params }))
            .await
    }

    pub(super) async fn request_all_pages(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
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
}
