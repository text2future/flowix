//! Pi 会话进程的生命周期。
//!
//! 一个会话 = 一个 Pi 子进程 + 一份 RPC 通道。`ensure_session` 是唯一的创建入口，
//! 并发调用由 `session_start_locks` 串起来；删除类函数都带 `_if_same` 后缀，因为
//! 异步清理期间可能已经有新会话占用了同一个 thread id，盲删会关掉刚建的进程。

use super::*;

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tokio::io::BufReader;
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot, Mutex, OwnedMutexGuard};
use tokio::time::Duration;

use super::super::shell;
use super::super::skill_resources;
use super::super::AGENT_TYPE;

impl PiRpcManager {

    pub async fn delete_session(&self, thread_id: &str) -> Result<bool, String> {
        self.history_snapshots
            .lock()
            .await
            .retain(|(id, _)| id != thread_id);
        let session = self.sessions.lock().await.remove(thread_id);
        if let Some(session) = session {
            session.shutdown(thread_id).await;
        }
        let mut deleted = false;
        match std::fs::remove_dir_all(pi_session_dir(thread_id)?) {
            Ok(()) => deleted = true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("could not delete Pi conversation session: {error}"));
            }
        }
        Ok(deleted)
    }


    pub(super) async fn ensure_session(
        &self,
        app: &tauri::AppHandle,
        thread_id: &str,
        config: PiSessionConfig,
        history_read: bool,
    ) -> Result<Arc<PiSession>, String> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("Pi runtime is shutting down".into());
        }
        // Serialize startup/replacement per Flowix thread. The global session
        // map is only held for lookups and inserts, never while waiting for a
        // process response or another session's operation.
        let start_lock = {
            let mut locks = self.session_start_locks.lock().await;
            locks
                .entry(thread_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _start_guard = start_lock.lock_owned().await;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("Pi runtime is shutting down".into());
        }
        let existing = self.sessions.lock().await.get(thread_id).cloned();
        if let Some(existing) = existing {
            if existing.is_alive().await && (history_read || existing.config == config) {
                return Ok(existing);
            }
            let operation = existing.lock_operation().await;
            let removed = {
                let mut sessions = self.sessions.lock().await;
                if sessions
                    .get(thread_id)
                    .is_some_and(|current| Arc::ptr_eq(current, &existing))
                {
                    sessions.remove(thread_id)
                } else {
                    None
                }
            };
            drop(operation);
            if let Some(removed) = removed {
                removed.shutdown(thread_id).await;
            }
        }

        let session_dir = resolve_pi_session_dir(thread_id, true)?;
        let expected_id = self
            .thread_manager
            .get_external_session(thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;
        let config_dir = pi_config_dir()?;
        std::fs::create_dir_all(&config_dir)
            .map_err(|error| format!("cannot create Pi config directory: {error}"))?;
        // Make the packages vendored into the bundle available in the user's
        // Pi agent directory before any process reads it. Best-effort: a
        // failed seed must not block launching Pi.
        super::super::package_seed::seed_bundled_packages(app);

        let mut command = Command::new(resolve_pi_binary(app)?);
        // The bash tool reads its environment from this process, so the PATH
        // resolved from the user's login shell has to be injected here.
        shell::apply_child_path(&mut command, shell::child_path().await.as_deref());
        let mut tools = config
            .tools
            .split(',')
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if config.code_mode {
            tools.push("codemode".into());
        }
        if config.tool_search {
            tools.push("tool_search".into());
        }
        let tools = tools.join(",");
        command
            .args(["--mode", "rpc", "--session-dir"])
            .arg(&session_dir)
            .arg("--tools")
            .arg(&tools)
            .args(if config.code_mode {
                vec!["--extension", "builtin:codemode"]
            } else {
                Vec::new()
            })
            .args(if config.tool_search {
                vec!["--extension", "builtin:tool-search"]
            } else {
                Vec::new()
            })
            .current_dir(&config.cwd)
            .env("PI_CODING_AGENT_DIR", &config_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // RPC cannot ask for project trust. Explicitly load the exact notebook
        // skills represented by this session's startup-resource fingerprint.
        for skill_directory in &config.startup_resources.skill_directories {
            command.arg("--skill").arg(skill_directory);
        }
        if let Some(session_id) = expected_id.as_deref() {
            command.arg("--session").arg(session_id);
        } else {
            command.arg("--continue");
        }
        if let Some(provider) = config.provider.as_deref() {
            command.args(["--provider", provider]);
        }
        if let Some(model) = config.model.as_deref() {
            command.args(["--model", model]);
        }
        if let Some(thinking) = config.thinking.as_deref() {
            command.args(["--thinking", thinking]);
        }
        crate::agent_external::shared::configure_unix_process_group(&mut command);
        crate::process_window::hide_command_window(&mut command);

        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start Pi v1.1.0 RPC: {error}"))?;
        let stdin = Arc::new(Mutex::new(
            child.stdin.take().ok_or("Pi stdin unavailable")?,
        ));
        let stdout = child.stdout.take().ok_or("Pi stdout unavailable")?;
        let stderr_pipe = child.stderr.take().ok_or("Pi stderr unavailable")?;
        let (record_tx, record_rx) = mpsc::unbounded_channel();
        let response_waiters =
            Arc::new(Mutex::new(HashMap::<String, oneshot::Sender<Value>>::new()));
        let response_routes = response_waiters.clone();
        let stdout_task = tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                let record = match read_pi_rpc_record(&mut reader).await {
                    Ok(Some(record)) => Ok(record),
                    Ok(None) => {
                        let _ = record_tx.send(Err("Pi RPC process exited".into()));
                        break;
                    }
                    Err(error) => Err(error),
                };
                let fatal = record.is_err();
                if let Ok(value) = record.as_ref() {
                    if value.get("type").and_then(Value::as_str) == Some("response") {
                        if let Some(id) = value.get("id").and_then(Value::as_str) {
                            if let Some(waiter) = response_routes.lock().await.remove(id) {
                                let _ = waiter.send(value.clone());
                                continue;
                            }
                        }
                    }
                }
                if record_tx.send(record).is_err() || fatal {
                    break;
                }
            }
        });
        let stderr = Arc::new(Mutex::new(String::new()));
        let stderr_capture = stderr.clone();
        tokio::spawn(async move {
            let _ = capture_pi_stderr(stderr_pipe, stderr_capture).await;
        });

        let session = Arc::new(PiSession {
            session_id: Mutex::new(String::new()),
            config: config.clone(),
            stdin,
            records: Mutex::new(record_rx),
            response_waiters,
            entries_cache: Mutex::new(PiEntriesCache::default()),
            child: Mutex::new(child),
            stdout_task: Mutex::new(Some(stdout_task)),
            stderr,
            operation: Arc::new(Mutex::new(())),
            invalidated: AtomicBool::new(false),
            last_used_at: AtomicI64::new(chrono::Utc::now().timestamp_millis()),
        });
        {
            let mut starting = self.starting_sessions.lock().await;
            if self.shutting_down.load(Ordering::Acquire) {
                drop(starting);
                session.shutdown(thread_id).await;
                return Err("Pi runtime is shutting down".into());
            }
            starting.insert(thread_id.to_string(), session.clone());
        }
        let state = match request_pi_state(&session).await {
            Ok(state) => state,
            Err(error) => {
                self.remove_starting_session_if_same(thread_id, &session)
                    .await;
                session.shutdown(thread_id).await;
                return Err(error);
            }
        };
        if self.shutting_down.load(Ordering::Acquire) {
            self.remove_starting_session_if_same(thread_id, &session)
                .await;
            session.shutdown(thread_id).await;
            return Err("Pi runtime is shutting down".into());
        }
        let Some(session_id) = state
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
        else {
            self.remove_starting_session_if_same(thread_id, &session)
                .await;
            session.shutdown(thread_id).await;
            return Err("Pi did not report a sessionId for this conversation".into());
        };
        if let Some(expected_id) = expected_id {
            if expected_id != session_id {
                self.remove_starting_session_if_same(thread_id, &session)
                    .await;
                session.shutdown(thread_id).await;
                return Err(format!(
                    "Pi opened session {session_id}, but Flowix expected {expected_id}"
                ));
            }
        }
        *session.session_id.lock().await = session_id;
        let persisted_session_id = session.session_id.lock().await.clone();
        if let Err(error) = self
            .thread_manager
            .upsert_external_session(
                thread_id,
                AGENT_TYPE,
                &persisted_session_id,
                Some(serde_json::json!({
                    "sessionFile": state.get("sessionFile").and_then(Value::as_str),
                    "cwd": config.cwd.to_string_lossy(),
                })),
            )
            .await
        {
            self.remove_starting_session_if_same(thread_id, &session)
                .await;
            session.shutdown(thread_id).await;
            return Err(error.to_string());
        }
        let mut sessions = self.sessions.lock().await;
        let mut starting = self.starting_sessions.lock().await;
        if self.shutting_down.load(Ordering::Acquire)
            || !starting
                .get(thread_id)
                .is_some_and(|current| Arc::ptr_eq(current, &session))
        {
            if starting
                .get(thread_id)
                .is_some_and(|current| Arc::ptr_eq(current, &session))
            {
                starting.remove(thread_id);
            }
            drop(starting);
            drop(sessions);
            session.shutdown(thread_id).await;
            return Err("Pi runtime is shutting down".into());
        }
        starting.remove(thread_id);
        sessions.insert(thread_id.to_string(), session.clone());
        Ok(session)
    }


    pub(super) async fn remove_starting_session_if_same(&self, thread_id: &str, session: &Arc<PiSession>) {
        let mut starting = self.starting_sessions.lock().await;
        if starting
            .get(thread_id)
            .is_some_and(|current| Arc::ptr_eq(current, session))
        {
            starting.remove(thread_id);
        }
    }


    pub(super) async fn remove_session_if_same(&self, thread_id: &str, session: &Arc<PiSession>) {
        let removed = {
            let mut sessions = self.sessions.lock().await;
            if sessions
                .get(thread_id)
                .is_some_and(|current| Arc::ptr_eq(current, session))
            {
                sessions.remove(thread_id)
            } else {
                None
            }
        };
        if let Some(removed) = removed {
            removed.shutdown(thread_id).await;
        }
    }


    pub(super) async fn shutdown_and_remove_session_if_same(&self, thread_id: &str, session: &Arc<PiSession>) {
        // Mark it unusable before releasing the operation guard. A concurrent
        // prompt will wait for that guard, then fail validation instead of
        // writing to a process whose abort did not settle.
        session.invalidated.store(true, Ordering::Release);
        session.shutdown(thread_id).await;
        let mut sessions = self.sessions.lock().await;
        if sessions
            .get(thread_id)
            .is_some_and(|current| Arc::ptr_eq(current, session))
        {
            sessions.remove(thread_id);
        }
    }


    pub(super) async fn remove_idle_session_if_same(&self, thread_id: &str, session: &Arc<PiSession>) {
        let mut sessions = self.sessions.lock().await;
        let Some(current) = sessions.get(thread_id) else {
            return;
        };
        if !Arc::ptr_eq(current, session) {
            return;
        }
        // Reaping is best-effort. Never hold the manager map while awaiting a
        // prompt to settle; a busy session will be checked on the next pass.
        let Ok(operation) = session.operation.try_lock() else {
            return;
        };
        // A new run can start after the reaper snapshots idle sessions but
        // before this removal. Hold the run map while removing so a
        // concurrently arriving prompt either prevents reaping or starts
        // against a fresh process afterward.
        let active_runs = self.active_runs.lock().await;
        if active_runs.contains_key(thread_id) {
            drop(active_runs);
            drop(operation);
            return;
        }
        let removed = sessions.remove(thread_id);
        drop(active_runs);
        drop(sessions);
        drop(operation);
        if let Some(removed) = removed {
            removed.shutdown(thread_id).await;
        }
    }


    pub(super) async fn lock_session_operation(
        &self,
        thread_id: &str,
        session: &Arc<PiSession>,
    ) -> Result<OwnedMutexGuard<()>, String> {
        let operation = session.lock_operation().await;
        let sessions = self.sessions.lock().await;
        let current = sessions
            .get(thread_id)
            .ok_or_else(|| "Pi session was closed before the operation started".to_string())?;
        if !Arc::ptr_eq(current, session) {
            return Err("Pi session changed before the operation started".into());
        }
        if session.invalidated.load(Ordering::Acquire) {
            return Err("Pi session was closed before the operation started".into());
        }
        drop(sessions);
        Ok(operation)
    }


    pub async fn fork_session(
        &self,
        app: &tauri::AppHandle,
        source_thread_id: &str,
        entry_id: &str,
        child_thread_id: &str,
        cwd: &std::path::Path,
    ) -> Result<String, String> {
        if entry_id.is_empty()
            || !entry_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err("Pi fork entry ID is invalid".into());
        }
        let expected_source_id = self
            .thread_manager
            .get_external_session(source_thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?
            .ok_or("Pi source conversation has not started yet")?;
        // The source process holds its operation lock for the whole turn. Read
        // its persisted session through an independent Pi process instead.
        let source_file = self
            .thread_manager
            .get_pi_session_file(source_thread_id)
            .await
            .map_err(|error| error.to_string())?
            .ok_or("Pi source session file is unavailable")?;
        if !source_file.is_file() {
            return Err("Pi source session has no persisted conversation to fork".into());
        }

        let child_dir = pi_session_dir(child_thread_id)?;
        if child_dir.exists() {
            return Err("Pi fork destination already exists".into());
        }
        std::fs::create_dir_all(&child_dir)
            .map_err(|error| format!("could not create Pi fork directory: {error}"))?;
        let result = run_pi_fork_extension(
            app,
            &expected_source_id,
            &source_file,
            &child_dir,
            cwd,
            entry_id,
        )
        .await;
        let fork = match result {
            Ok(value) => value,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&child_dir);
                return Err(error);
            }
        };
        self.thread_manager
            .upsert_external_session(
                child_thread_id,
                AGENT_TYPE,
                &fork.session_id,
                Some(serde_json::json!({
                    "sessionFile": fork.session_file,
                    "cwd": cwd.to_string_lossy(),
                    "parentThreadId": source_thread_id,
                    "parentSessionId": expected_source_id,
                    "forkEntryId": entry_id,
                })),
            )
            .await
            .map_err(|error| {
                let _ = std::fs::remove_dir_all(&child_dir);
                error.to_string()
            })?;
        Ok(fork.session_id)
    }


    /// Read history and native identities through Pi RPC. Flowix never opens
    /// or parses Pi's session JSONL files.
    pub async fn get_session_page(
        &self,
        app: &tauri::AppHandle,
        thread_id: &str,
        before: Option<&str>,
        limit: usize,
        revision: Option<PiHistoryRevision>,
    ) -> Result<PiHistoryPage, String> {
        if before.is_some() && revision.is_none() {
            return Err("Pi history pagination requires a native snapshot revision".into());
        }
        let mut cached = None;
        if let Some(expected) = &revision {
            let mut snapshots = self.history_snapshots.lock().await;
            if let Some(index) = snapshots
                .iter()
                .position(|(id, snapshot)| id == thread_id && &snapshot.revision == expected)
            {
                let entry = snapshots.remove(index).unwrap();
                cached = Some(Arc::clone(&entry.1));
                snapshots.push_back(entry);
            }
        }
        let snapshot = match cached {
            Some(snapshot) => snapshot,
            None => {
                let snapshot = Arc::new(self.get_session_snapshot(app, thread_id).await?);
                if revision
                    .as_ref()
                    .is_some_and(|expected| expected != &snapshot.revision)
                {
                    return Err("HistoryChanged:pi_branch".into());
                }
                let mut snapshots = self.history_snapshots.lock().await;
                snapshots.retain(|(id, previous)| {
                    id != thread_id || previous.revision != snapshot.revision
                });
                snapshots.push_back((thread_id.to_owned(), Arc::clone(&snapshot)));
                while snapshots.len() > 16 {
                    snapshots.pop_front();
                }
                snapshot
            }
        };
        page_pi_snapshot(&snapshot, before, limit)
    }


    pub async fn get_session_messages(
        &self,
        app: &tauri::AppHandle,
        thread_id: &str,
    ) -> Result<Vec<Value>, String> {
        Ok(self.get_session_snapshot(app, thread_id).await?.messages)
    }


    pub async fn get_session_snapshot(
        &self,
        app: &tauri::AppHandle,
        thread_id: &str,
    ) -> Result<PiSessionSnapshot, String> {
        let mapped_session = self
            .thread_manager
            .get_external_session(thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;
        let active_run = self.active_runs.lock().await.get(thread_id).cloned();
        let has_session = mapped_session.is_some()
            || self.sessions.lock().await.contains_key(thread_id)
            || active_run.is_some();
        if !has_session {
            return Ok(empty_pi_session_snapshot());
        }
        let cwd = self
            .thread_manager
            .read_frozen_cwd(thread_id)
            .await
            .map_err(|error| error.to_string())?
            .filter(|cwd| cwd.is_dir())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let config = PiSessionConfig {
            cwd: cwd.clone(),
            tools: "read".into(),
            code_mode: false,
            tool_search: false,
            provider: None,
            model: None,
            cloud_auth_generation: None,
            thinking: None,
            startup_resources: skill_resources::capture(
                &cwd,
                &pi_config_dir()?,
                &resolve_pi_session_dir(thread_id, true)?,
            )?,
        };
        let session = if let Some(active_run) = active_run.as_ref() {
            let active_session =
                tokio::time::timeout(PI_RPC_REQUEST_TIMEOUT, active_run.wait_for_session())
                    .await
                    .map_err(|_| {
                        "Pi session initialization timed out while reading history".to_string()
                    })?;
            if let Some(session) = active_session {
                session
            } else if let Some(session) = self.sessions.lock().await.get(thread_id).cloned() {
                session
            } else {
                let mapped_session = self
                    .thread_manager
                    .get_external_session(thread_id, AGENT_TYPE)
                    .await
                    .map_err(|error| error.to_string())?;
                if mapped_session.is_some() {
                    self.ensure_session(app, thread_id, config, true).await?
                } else {
                    return Ok(empty_pi_session_snapshot());
                }
            }
        } else {
            self.ensure_session(app, thread_id, config, true).await?
        };
        session.touch();
        // Pi keeps the operation lock for the whole prompt. History reads use
        // correlated RPC waiters and a small revision fence instead, matching
        // the behavior of Codex's concurrent live-turn/history reads.
        let active_at_start = self.active_runs.lock().await.contains_key(thread_id);
        let mut last_read = None;
        let mut stable_revision_seen = false;
        for attempt in 0..3 {
            let (before_entries, before_leaf) = session.session_entries().await?;
            let messages = session.session_messages().await?;
            let (entries, leaf_id) = session.session_entries().await?;
            let before_cursor = before_entries
                .last()
                .and_then(|entry| entry.get("id"))
                .and_then(Value::as_str);
            let after_cursor = entries
                .last()
                .and_then(|entry| entry.get("id"))
                .and_then(Value::as_str);
            let revision_matches = before_cursor == after_cursor && before_leaf == leaf_id;
            last_read = Some((messages, entries, leaf_id));
            if revision_matches {
                stable_revision_seen = true;
                break;
            }
            if attempt < 2 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
        let (mut messages, entries, leaf_id) =
            last_read.ok_or_else(|| "Pi history read did not return a snapshot".to_string())?;
        let active_during_read =
            active_at_start || self.active_runs.lock().await.contains_key(thread_id);
        attach_pi_session_message_ids_with_pending_tail(
            &mut messages,
            &entries,
            leaf_id.as_deref(),
            active_during_read || !stable_revision_seen,
        )?;
        // Keep original Pi block positions even when thinking is hidden.
        for (sequence, message) in messages.iter_mut().enumerate() {
            if let Some(object) = message.as_object_mut() {
                object.insert("_pi_history_sequence".into(), serde_json::json!(sequence));
            }
            if let Some(blocks) = message.get_mut("content").and_then(Value::as_array_mut) {
                for (index, block) in blocks.iter_mut().enumerate() {
                    if let Some(object) = block.as_object_mut() {
                        object.insert("_pi_content_index".into(), serde_json::json!(index));
                    }
                }
            }
        }
        if !pi_forward_thinking_enabled() {
            for message in &mut messages {
                if message.get("role").and_then(Value::as_str) != Some("assistant") {
                    continue;
                }
                if let Some(blocks) = message.get_mut("content").and_then(Value::as_array_mut) {
                    blocks.retain(|block| {
                        block.get("type").and_then(Value::as_str) != Some("thinking")
                    });
                }
            }
        }
        let native_session_id = session.session_id.lock().await.clone();
        session.touch();
        Ok(PiSessionSnapshot {
            messages,
            revision: PiHistoryRevision {
                session_id: native_session_id,
                append_cursor: entries
                    .last()
                    .and_then(|entry| entry.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                leaf_id,
            },
        })
    }

}
