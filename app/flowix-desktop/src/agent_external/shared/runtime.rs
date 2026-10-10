use super::*;

/// Add the extra Flowix workspace roots to runtimes that do not expose a
/// stable `--add-dir`-style CLI flag. The process already runs in `cwd`; this
/// note makes every other authorized root discoverable to the agent without
/// altering the user message persisted in Flowix history.
pub fn append_workspace_context(prompt: &str, cwd: &Path, workspace_paths: &[String]) -> String {
    let cwd = cwd
        .to_string_lossy()
        .trim_end_matches(['/', '\\'])
        .to_string();
    let mut seen = std::collections::HashSet::new();
    let additional: Vec<String> = workspace_paths
        .iter()
        .map(|path| path.trim().trim_end_matches(['/', '\\']).to_string())
        .filter(|path| !path.is_empty() && path != &cwd && Path::new(path).is_dir())
        .filter(|path| seen.insert(path.clone()))
        .collect();

    if additional.is_empty() {
        return prompt.to_string();
    }

    format!(
        "{prompt}\n\n<## CONTEXT PROMPT ##>\nThe user has selected these additional local workspace directories. Read and search them when relevant to the request; whether changes are allowed is controlled by the active runtime permission mode:\n{}",
        additional
            .iter()
            .map(|path| format!("- {path}"))
            .collect::<Vec<_>>()
            .join("\n")
    )
}

/// One live external-agent child process per `thread_id`.
///
/// Codex / Claude Code all fall under this shape: a long-lived
/// process whose stdout is line-streamed as JSON events. Consolidating the
/// state here makes run-id / kill / stdout-cap semantics single-sourced.
#[derive(Clone)]
pub struct ExternalRunRegistry {
    pub(super) agent_type: &'static str,
    pub(super) current_tool: &'static str,
    pub(super) children: Arc<Mutex<HashMap<String, ExternalRunningChild>>>,
    starting: Arc<Mutex<HashMap<String, ExternalStartingRun>>>,
    pub(super) stopping: Arc<Mutex<HashMap<String, ExternalStoppingRun>>>,
}

struct ExternalStartingRun {
    run_id: String,
    started_at: i64,
    cancelled: bool,
}

pub(super) struct ExternalStoppingRun {
    pub(super) run_id: String,
    pub(super) started_at: i64,
}

pub struct ExternalRunningChild {
    pub child: Child,
    pub started_at: i64,
    pub last_event_at: i64,
    pub run_id: Option<String>,
    pub session_id: Option<String>,
    /// Shared one-shot flag between the streaming task that spawned this child
    /// and anyone that may end the run out-of-band (`stop_chat`, the idle
    /// watchdog). Whoever wins the `compare_exchange(false 鈫?true)` race is
    /// the sole emitter of `AgentChunk::StreamEnd`; every other path sees the
    /// flag set and skips. This is the *only* "StreamEnd already emitted"
    /// mechanism 鈹€鈹€ there is no parallel bool. It lets `stop_chat` /
    /// watchdog converge the UI immediately instead of waiting on the
    /// streaming task to notice the child died (which can hang when
    /// grandchildren still hold the stdout write end).
    pub stream_end_emitted: Arc<AtomicBool>,
}

/// State shared by the streaming tail, `stop_chat`, and the idle watchdog for
/// one external CLI invocation. Creating it in the registry keeps run-id
/// normalization and the one-shot `StreamEnd` flag identical across vendors.
pub struct ExternalRunStart {
    pub run_id: String,
    pub stream_end_emitted: Arc<AtomicBool>,
}

/// Minimal terminal state returned after the registry has claimed and killed
/// a child. Runtime-specific managers still decide how terminal events are
/// persisted; the process lifecycle itself is single-sourced here.
pub struct ExternalStoppedRun {
    pub run_id: String,
    pub stream_end_emitted: Arc<AtomicBool>,
}

#[derive(Debug)]
pub struct StopUnconfirmed {
    pub run_id: String,
}

#[derive(Clone, Debug)]
pub struct ExternalWatchdogFinalizedRun {
    pub thread_id: String,
    pub run_id: Option<String>,
    pub reason: Option<String>,
}

impl ExternalRunRegistry {
    pub fn new(agent_type: &'static str, current_tool: &'static str) -> Self {
        Self {
            agent_type,
            current_tool,
            children: Arc::new(Mutex::new(HashMap::new())),
            starting: Arc::new(Mutex::new(HashMap::new())),
            stopping: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    #[cfg(test)]
    pub(super) async fn insert(
        &self,
        thread_id: String,
        child: Child,
        run_id: Option<String>,
        stream_end_emitted: Arc<AtomicBool>,
    ) {
        let mut children = self.children.lock().await;
        let now = chrono::Utc::now().timestamp_millis();
        children.insert(
            thread_id,
            ExternalRunningChild {
                child,
                started_at: now,
                last_event_at: now,
                run_id,
                session_id: None,
                stream_end_emitted,
            },
        );
    }

    pub async fn try_insert(
        &self,
        thread_id: String,
        child: Child,
        run_id: Option<String>,
        stream_end_emitted: Arc<AtomicBool>,
    ) -> Result<(), Child> {
        let starting = self.starting.lock().await;
        let stopping = self.stopping.lock().await;
        let mut children = self.children.lock().await;
        if starting.contains_key(&thread_id) || stopping.contains_key(&thread_id) || children.contains_key(&thread_id) {
            return Err(child);
        }
        let now = chrono::Utc::now().timestamp_millis();
        children.insert(
            thread_id,
            ExternalRunningChild {
                child,
                started_at: now,
                last_event_at: now,
                run_id,
                session_id: None,
                stream_end_emitted,
            },
        );
        Ok(())
    }

    /// Claim a start before any user/start event or native process is created.
    /// Both locks use starting -> children order throughout the registry.
    pub async fn reserve_start(
        &self,
        thread_id: &str,
        provided_run_id: Option<&str>,
    ) -> Result<ExternalRunStart, String> {
        let mut starting = self.starting.lock().await;
        let mut stopping = self.stopping.lock().await;
        let mut children = self.children.lock().await;
        if stopping.contains_key(thread_id) {
            if children.get_mut(thread_id).is_some_and(|run| matches!(run.child.try_wait(), Ok(Some(_)))) {
                children.remove(thread_id);
                stopping.remove(thread_id);
            } else {
                return Err(format!("{} is stopping for this thread", self.current_tool));
            }
        }
        if starting.contains_key(thread_id) {
            return Err(format!("{} is already starting for this thread", self.current_tool));
        }
        if let Some(running) = children.get_mut(thread_id) {
            match running.child.try_wait() {
                Ok(Some(_)) => { children.remove(thread_id); }
                Ok(None) => return Err(format!("{} is already running for this thread", self.current_tool)),
                Err(_) => return Err(format!("{} child state unknown; refusing to overlap", self.current_tool)),
            }
        }
        let run_id = resolve_run_id(thread_id, provided_run_id);
        starting.insert(thread_id.to_string(), ExternalStartingRun {
            run_id: run_id.clone(),
            started_at: chrono::Utc::now().timestamp_millis(),
            cancelled: false,
        });
        Ok(ExternalRunStart {
            run_id,
            stream_end_emitted: Arc::new(AtomicBool::new(false)),
        })
    }

    pub async fn cancel_start(&self, thread_id: &str, expected_run_id: Option<&str>) -> bool {
        let mut starting = self.starting.lock().await;
        let Some(start) = starting.get_mut(thread_id) else { return false; };
        if expected_run_id.is_some() && expected_run_id != Some(start.run_id.as_str()) {
            return false;
        }
        start.cancelled = true;
        true
    }

    pub async fn start_cancelled(&self, thread_id: &str, run_id: &str) -> bool {
        let starting = self.starting.lock().await;
        starting.get(thread_id).is_some_and(|start| start.run_id == run_id && start.cancelled)
    }

    pub async fn release_start(&self, thread_id: &str, run_id: &str) {
        let mut starting = self.starting.lock().await;
        if starting.get(thread_id).is_some_and(|start| start.run_id == run_id) {
            starting.remove(thread_id);
        }
    }

    /// Transfer the same reservation to the child registry. A stop during
    /// startup marks the reservation cancelled, so the late child is refused.
    pub async fn insert_reserved(
        &self,
        thread_id: String,
        child: Child,
        run_id: &str,
        stream_end_emitted: Arc<AtomicBool>,
    ) -> Result<(), Child> {
        let mut starting = self.starting.lock().await;
        let stopping = self.stopping.lock().await;
        let mut children = self.children.lock().await;
        if !starting.get(&thread_id).is_some_and(|start| start.run_id == run_id && !start.cancelled)
            || stopping.contains_key(&thread_id) || children.contains_key(&thread_id)
        {
            return Err(child);
        }
        starting.remove(&thread_id);
        let now = chrono::Utc::now().timestamp_millis();
        children.insert(thread_id, ExternalRunningChild {
            child, started_at: now, last_event_at: now,
            run_id: Some(run_id.to_string()), session_id: None, stream_end_emitted,
        });
        Ok(())
    }

    pub async fn touch(&self, thread_id: &str, expected_run_id: Option<&str>) {
        let mut children = self.children.lock().await;
        let Some(running) = children.get_mut(thread_id) else {
            return;
        };
        if expected_run_id.is_some() && running.run_id.as_deref() != expected_run_id {
            return;
        }
        running.last_event_at = chrono::Utc::now().timestamp_millis();
    }

    pub async fn set_session_id(
        &self,
        thread_id: &str,
        expected_run_id: Option<&str>,
        session_id: String,
    ) {
        let mut children = self.children.lock().await;
        let Some(running) = children.get_mut(thread_id) else {
            return;
        };
        if expected_run_id.is_some() && running.run_id.as_deref() != expected_run_id {
            return;
        }
        running.session_id = Some(session_id);
        running.last_event_at = chrono::Utc::now().timestamp_millis();
    }

    pub async fn remove(&self, thread_id: &str) -> Option<ExternalRunningChild> {
        let stopping = self.stopping.lock().await;
        if stopping.contains_key(thread_id) { return None; }
        let mut children = self.children.lock().await;
        children.remove(thread_id)
    }

    /// Prepare the shared lifecycle state before a runtime emits StreamStart.
    /// A still-live entry is rejected first, so callers never briefly expose a
    /// new loading state for an invocation that cannot start.
    pub async fn prepare_start(
        &self,
        thread_id: &str,
        provided_run_id: Option<&str>,
    ) -> Result<ExternalRunStart, String> {
        if let Some(reason) = self.reap_stale(thread_id).await {
            return Err(reason);
        }
        Ok(ExternalRunStart {
            run_id: resolve_run_id(thread_id, provided_run_id),
            stream_end_emitted: Arc::new(AtomicBool::new(false)),
        })
    }

    #[cfg(test)]
    pub(super) async fn contains(&self, thread_id: &str) -> bool {
        let children = self.children.lock().await;
        children.contains_key(thread_id)
    }

    /// Make room for a new chat on `thread_id`.
    ///
    ///   * No entry, or the previous child has already exited (`try_wait`
    ///     returns `Some(_)`): returns `None`. The entry has been dropped
    ///     in the exited case; the caller can proceed.
    ///   * Previous child is still running, or `try_wait` errored: returns
    ///     `Some(reason)` and restores the entry. The caller should refuse.
    ///
    /// Without this, a child that crashed (SIGKILL / OOM / broken pipe)
    /// leaves a zombie entry that every later `contains`-style guard
    /// reports as "already running" 鈥?the thread is permanently blocked
    /// until the watchdog's 60s+ idle reaper finally sweeps it. Calling
    /// this at `chat_stream` entry keeps the registry honest.
    ///
    /// Implementation note: the entire remove 鈫?try_wait 鈫?maybe-insert
    /// sequence runs under one `children` lock acquisition. `try_wait` is
    /// non-blocking per its docs, so holding the mutex is safe; doing the
    /// operation across two lock acquisitions would let a concurrent
    /// `chat_stream` slip a fresh child into the registry between our
    /// `remove` and `insert`, and our restore would clobber it.
    pub async fn reap_stale(&self, thread_id: &str) -> Option<String> {
        let mut stopping = self.stopping.lock().await;
        let mut children = self.children.lock().await;
        if stopping.contains_key(thread_id) {
            if children.get_mut(thread_id).is_some_and(|run| matches!(run.child.try_wait(), Ok(Some(_)))) {
                children.remove(thread_id);
                stopping.remove(thread_id);
                return None;
            }
            return Some(format!("{} is stopping for this thread", self.current_tool));
        }
        let Some(mut running) = children.remove(thread_id) else {
            return None;
        };
        match running.child.try_wait() {
            Ok(Some(_status)) => {
                tracing::info!(
                    "[{}] reaped stale child for {} before new chat",
                    self.current_tool,
                    thread_id
                );
                None
            }
            Ok(None) => {
                children.insert(thread_id.to_string(), running);
                Some(format!(
                    "{} is already running for this thread",
                    self.current_tool
                ))
            }
            Err(err) => {
                tracing::warn!(
                    "[{}] try_wait failed for {}: {err}; treating as live",
                    self.current_tool,
                    thread_id
                );
                children.insert(thread_id.to_string(), running);
                Some(format!(
                    "{} child state unknown; refusing to overlap",
                    self.current_tool
                ))
            }
        }
    }

    /// Wait for natural process exit without releasing the thread slot. A
    /// concurrent stop can still acquire the child between short polls.
    pub async fn wait_for_exit_and_remove_if_run_id(
        &self,
        thread_id: &str,
        run_id: &str,
    ) -> Result<Option<std::process::ExitStatus>, String> {
        loop {
            let stopping = self.stopping.lock().await;
            if stopping.contains_key(thread_id) { return Ok(None); }
            let mut children = self.children.lock().await;
            let Some(child) = children.get_mut(thread_id) else { return Ok(None); };
            if child.run_id.as_deref() != Some(run_id) { return Ok(None); }
            match child.child.try_wait() {
                Ok(Some(status)) => {
                    children.remove(thread_id);
                    return Ok(Some(status));
                }
                Ok(None) => {}
                Err(error) => return Err(format!("cannot confirm child exit: {error}")),
            }
            drop(children);
            drop(stopping);
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    /// Remove and terminate one run. `lookup_thread_id` is the registry key;
    /// `event_thread_id` is the product thread used by terminal events and as
    /// the run-id fallback. Codex/Claude may retry with a mapped local thread
    /// while keeping the original external-session id as the event target.
    pub async fn stop_run(
        &self,
        lookup_thread_id: &str,
        event_thread_id: &str,
        expected_run_id: Option<&str>,
        process_label: &str,
    ) -> Result<Option<ExternalStoppedRun>, StopUnconfirmed> {
        let mut stopping = self.stopping.lock().await;
        if let Some(stop) = stopping.get(lookup_thread_id) {
            if expected_run_id.is_some() && expected_run_id != Some(stop.run_id.as_str()) {
                return Ok(None);
            }
        }
        let mut children = self.children.lock().await;
        let Some(running) = children.get(lookup_thread_id) else {
            return match stopping.get(lookup_thread_id) {
                Some(stop) => Err(StopUnconfirmed { run_id: stop.run_id.clone() }),
                None => Ok(None),
            };
        };
        if expected_run_id.is_some() && running.run_id.as_deref() != expected_run_id {
            return Ok(None);
        }
        let mut running = children.remove(lookup_thread_id).expect("child was just checked");
        let run_id = running.run_id.clone().unwrap_or_else(|| event_thread_id.to_string());
        stopping.insert(lookup_thread_id.to_string(), ExternalStoppingRun {
            run_id: run_id.clone(), started_at: running.started_at,
        });
        drop(children);
        drop(stopping);
        let termination = async {
            kill_child_tree(&mut running.child, process_label, event_thread_id).await;
            running.child.wait().await
        };
        match tokio::time::timeout(std::time::Duration::from_secs(5), termination).await {
            Ok(Ok(_)) => { self.stopping.lock().await.remove(lookup_thread_id); }
            outcome => {
                tracing::warn!("[{process_label}] stop unconfirmed for {event_thread_id}: {outcome:?}");
                self.children.lock().await.insert(lookup_thread_id.to_string(), running);
                return Err(StopUnconfirmed { run_id });
            }
        }
        Ok(Some(ExternalStoppedRun {
            run_id,
            stream_end_emitted: running.stream_end_emitted,
        }))
    }

    pub async fn kill_all(&self, process_label: &str) -> usize {
        {
            let mut starting = self.starting.lock().await;
            for start in starting.values_mut() { start.cancelled = true; }
        }
        let targets = self.children.lock().await.iter()
            .map(|(thread_id, run)| (thread_id.clone(), run.run_id.clone()))
            .collect::<Vec<_>>();
        let mut confirmed = 0;
        for (thread_id, run_id) in targets {
            match self.stop_run(&thread_id, &thread_id, run_id.as_deref(), process_label).await {
                Ok(Some(_)) => confirmed += 1,
                Err(unconfirmed) => tracing::warn!("[{process_label}] shutdown stop unconfirmed for run {}", unconfirmed.run_id),
                _ => {}
            }
        }
        confirmed
    }

    /// Drain every child during application shutdown while atomically claiming
    /// the terminal-event slot for runs whose streaming tail has not already
    /// finished. The caller persists the returned terminal records after the
    /// children are gone; tails that wake on EOF cannot emit a duplicate end.
    ///
    /// 与 `kill_all` 的区别: 此函数同时返回 `ExternalWatchdogFinalizedRun` 列表,
    /// 供调用方 (e.g. OpenCode ACP manager) 在进程退出前持久化一条 `StreamEnd`,
    /// 让前端能把「被杀掉的活流」正确标记为终止, 而不是孤立成「最后一条 chunk
    /// 之后再无消息」。
    pub async fn kill_all_finalized(
        &self,
        process_label: &str,
        reason: &str,
    ) -> (usize, Vec<ExternalWatchdogFinalizedRun>) {
        {
            let mut starting = self.starting.lock().await;
            for start in starting.values_mut() { start.cancelled = true; }
        }
        let targets = self.children.lock().await.iter()
            .map(|(thread_id, run)| (
                thread_id.clone(), run.run_id.clone(),
                run.session_id.clone().unwrap_or_else(|| thread_id.clone()),
            ))
            .collect::<Vec<_>>();
        let mut confirmed = 0;
        let mut finalized = Vec::with_capacity(targets.len());
        for (thread_id, run_id, event_thread_id) in targets {
            match self.stop_run(&thread_id, &event_thread_id, run_id.as_deref(), process_label).await {
                Ok(Some(stopped)) => {
                    confirmed += 1;
                    if claim_stream_end_once(&stopped.stream_end_emitted) {
                        finalized.push(ExternalWatchdogFinalizedRun {
                            thread_id: event_thread_id,
                            run_id: Some(stopped.run_id),
                            reason: Some(reason.to_string()),
                        });
                    }
                }
                Err(unconfirmed) => tracing::warn!("[{process_label}] shutdown stop unconfirmed for run {}", unconfirmed.run_id),
                _ => {}
            }
        }
        (confirmed, finalized)
    }

    pub async fn reap_inactive(
        &self,
        idle_timeout_ms: i64,
        process_label: &str,
    ) -> Vec<ExternalWatchdogFinalizedRun> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut finalized = Vec::new();
        let mut idle_children = Vec::new();

        {
            let stopping = self.stopping.lock().await;
            let mut children = self.children.lock().await;
            let thread_ids = children.keys().cloned().collect::<Vec<_>>();
            for thread_id in thread_ids {
                if stopping.contains_key(&thread_id) { continue; }
                enum Decision {
                    Keep,
                    Exited(bool, String),
                    InspectFailed(String),
                    Idle,
                    Missing,
                }

                let decision = match children.get_mut(&thread_id) {
                    Some(running) => {
                        let is_idle = idle_timeout_ms > 0
                            && now.saturating_sub(running.last_event_at) >= idle_timeout_ms;
                        if !is_idle {
                            Decision::Keep
                        } else {
                            match running.child.try_wait() {
                                Ok(Some(status)) => {
                                    Decision::Exited(status.success(), status.to_string())
                                }
                                Ok(None) => Decision::Idle,
                                Err(err) => Decision::InspectFailed(err.to_string()),
                            }
                        }
                    }
                    None => Decision::Missing,
                };

                match decision {
                    Decision::Keep | Decision::Missing => {}
                    Decision::Exited(success, status) => {
                        if let Some(running) = children.remove(&thread_id) {
                            // 在锁内、kill 之前�?StreamEnd slot ── �?tail /
                            // stop_chat 已先发过 (Exited: child 已�?, tail �?���?                            // 观察�?EOF �?CAS), 跳过�?run, 不双发也不�?盖�?                            // Idle: child 还活着, tail 必然还阻塞在 read, 这里
                            // �?��性赢, 避免杀进程�?tail 抢赢导致 idle-timeout
                            // reason + persist 丢失�?
                            if !claim_stream_end_once(&running.stream_end_emitted) {
                                continue;
                            }
                            let reason = (!success).then(|| format!("process_exited: {status}"));
                            finalized.push(ExternalWatchdogFinalizedRun {
                                thread_id,
                                run_id: running.run_id,
                                reason,
                            });
                        }
                    }
                    Decision::InspectFailed(err) => {
                        tracing::warn!("[{process_label}] watchdog cannot inspect {thread_id}: {err}");
                    }
                    Decision::Idle => {
                        idle_children.push((thread_id.clone(), children.get(&thread_id).and_then(|run| run.run_id.clone())));
                    }
                }
            }
        }

        for (thread_id, run_id) in idle_children {
            match self.stop_run(&thread_id, &thread_id, run_id.as_deref(), process_label).await {
                Ok(Some(stopped)) if claim_stream_end_once(&stopped.stream_end_emitted) => {
                    finalized.push(ExternalWatchdogFinalizedRun {
                        thread_id,
                        run_id: Some(stopped.run_id),
                        reason: Some(format!("watchdog_idle_timeout_ms={idle_timeout_ms}")),
                    });
                }
                Err(unconfirmed) => {
                    tracing::warn!("[{process_label}] watchdog stop unconfirmed for run {}", unconfirmed.run_id);
                }
                _ => {}
            }
        }

        finalized
    }

    pub async fn running_threads(&self) -> HashMap<String, RunInfo> {
        let starting = self.starting.lock().await;
        let stopping = self.stopping.lock().await;
        let children = self.children.lock().await;
        let mut result: HashMap<String, RunInfo> = starting.iter().map(|(thread_id, start)| {
            let mut info = RunInfo::active(
                start.started_at,
                Some(self.current_tool),
                Some(self.agent_type),
                Some(start.run_id.clone()),
                Some(thread_id.clone()),
                None,
            );
            info.phase = Some(if start.cancelled { "stopping" } else { "starting" }.to_string());
            (thread_id.clone(), info)
        }).collect();
        result.extend(children
            .iter()
            .map(|(thread_id, running)| {
                let canonical_thread_id = running
                    .session_id
                    .clone()
                    .unwrap_or_else(|| thread_id.clone());
                (
                    canonical_thread_id,
                    RunInfo::active(
                        running.started_at,
                        Some(self.current_tool),
                        Some(self.agent_type),
                        running.run_id.clone(),
                        Some(thread_id.clone()),
                        running.session_id.clone(),
                    ),
                )
            })
            .collect::<HashMap<_, _>>());
        for (thread_id, stop) in stopping.iter() {
            let mut info = RunInfo::active(stop.started_at, Some(self.current_tool), Some(self.agent_type), Some(stop.run_id.clone()), Some(thread_id.clone()), None);
            info.phase = Some("stopping".to_string());
            result.insert(thread_id.clone(), info);
        }
        result
    }
}
