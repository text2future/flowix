use std::collections::HashMap;
#[cfg(test)]
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::io::{AsyncWriteExt, BufReader};

pub(crate) use super::binary::resolve_codex_binary;
use super::command::{build_codex_command, preflight_codex, resolve_codex_cwd};
#[cfg(test)]
use super::command::{
    is_executable_file, latest_versioned_subdir, normalized_codex_model,
    normalized_permission_mode, normalized_reasoning_effort, parse_node_version,
    resolve_node_binary, which_codex,
};
use super::history::is_codex_session_id;
use super::runtime::{diagnostics_enabled, emit_chunk_with_run_id, resolve_run_id};
use super::stream::read_codex_stdout;
use super::{truncate_for_log, AGENT_TYPE};
use crate::agent::{AgentChunk, AgentUserMessage};
use crate::external_runtime::{
    emit_stream_end_once, kill_child_tree, persist_watchdog_finalized_run_state,
    read_stderr_to_string, select_external_session_for_runtime, ExternalRunRegistry,
    USER_STOPPED_REASON,
};
use crate::runtime_log;
use crate::session::ThreadManager;

pub struct CodexCliManager {
    thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>,
    runs: ExternalRunRegistry,
}

impl CodexCliManager {
    pub fn new(thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>) -> Self {
        Self {
            thread_manager,
            runs: ExternalRunRegistry::new(AGENT_TYPE, AGENT_TYPE),
        }
    }

    pub async fn chat_stream(
        self: &Arc<Self>,
        thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<String, String> {
        let thread_id = thread_id.to_string();
        let app_handle = app_handle.clone();
        let manager = self.clone();
        let run_id = resolve_run_id(&thread_id, message.run_id.as_deref());
        // 共享的"StreamEnd 已经 emit 出去没"标志 ── `stop_chat` 和流式任务
        // 都持有一份 Arc, 谁先 CAS(false→true) 谁负责发; 另一个分支看到
        // 标志为 true 直接 skip, 保证前端只收一条 StreamEnd。
        let stream_end_emitted = Arc::new(AtomicBool::new(false));

        // Reap any zombie child (kill/oom/broken pipe leaves the registry
        // entry behind until the watchdog sweeps it) and refuse overlapping
        // runs BEFORE we emit StreamStart — otherwise the UI flashes
        // loading for ~ms and then bounces to an error.
        if let Some(reason) = self.runs.reap_stale(&thread_id).await {
            return Err(reason);
        }

        tokio::spawn(async move {
            // 通用 metadata 协议 ── StreamStart 携带该 run 锁定的
            // model / reasoning_effort, 前端 hover card 等组件可读。
            let model = message.model_for_runtime("codex").map(str::to_string);
            let reasoning_effort = message
                .reasoning_effort_for_runtime("codex")
                .map(str::to_string);
            emit_chunk_with_run_id(
                &app_handle,
                &AgentChunk::StreamStart {
                    thread_id: thread_id.clone(),
                    model,
                    reasoning_effort,
                },
                AGENT_TYPE,
                &run_id,
            );

            let reason = match manager
                .run_codex(
                    &thread_id,
                    &run_id,
                    message,
                    &app_handle,
                    stream_end_emitted.clone(),
                )
                .await
            {
                Ok(()) => None,
                Err(err) => {
                    emit_chunk_with_run_id(
                        &app_handle,
                        &AgentChunk::Error {
                            thread_id: thread_id.clone(),
                            message: err.clone(),
                        },
                        AGENT_TYPE,
                        &run_id,
                    );
                    Some(err)
                }
            };

            // 兜底 emit: 若 stop_chat / watchdog 还没替我们发过 StreamEnd,
            // 由本路径补发; 否则 CAS 失败, 跳过避免重复。详见
            // `shared::emit_stream_end_once`。
            emit_stream_end_once(
                &app_handle,
                &thread_id,
                &run_id,
                AGENT_TYPE,
                reason,
                &stream_end_emitted,
            );
        });

        Ok(String::new())
    }

    pub async fn stop_chat(
        &self,
        thread_id: &str,
        run_id: Option<&str>,
        app_handle: &tauri::AppHandle,
    ) -> bool {
        let mut running = match run_id {
            Some(rid) => self.runs.remove_if_run_id(thread_id, Some(rid)).await,
            None => self.runs.remove(thread_id).await,
        };
        if running.is_none() {
            let mapped_thread_id = {
                let manager = self.thread_manager.read().await;
                manager
                    .find_thread_by_external_session(thread_id, AGENT_TYPE)
                    .await
                    .ok()
                    .flatten()
            };
            if let Some(mapped_thread_id) = mapped_thread_id {
                if mapped_thread_id != thread_id {
                    running = match run_id {
                        Some(rid) => {
                            self.runs
                                .remove_if_run_id(&mapped_thread_id, Some(rid))
                                .await
                        }
                        None => self.runs.remove(&mapped_thread_id).await,
                    };
                }
            }
        }
        let Some(mut running) = running else {
            return false;
        };
        kill_child_tree(&mut running.child, "CodexCli", thread_id).await;

        // 不等流式任务自己醒来 ── 用户停止后立刻发 StreamEnd。共享 flag 让
        // task body 末尾的兜底 emit 自动跳过 (避免重复事件)。
        let run_id_for_chunk = running.run_id.as_deref().unwrap_or(thread_id).to_string();
        emit_stream_end_once(
            app_handle,
            thread_id,
            &run_id_for_chunk,
            AGENT_TYPE,
            Some(USER_STOPPED_REASON.to_string()),
            &running.stream_end_emitted,
        );
        true
    }

    pub async fn running_threads(&self) -> HashMap<String, crate::agent::RunInfo> {
        self.runs.running_threads().await
    }

    pub async fn stop_all(&self) -> usize {
        self.runs.kill_all("CodexCli").await
    }

    pub async fn reap_inactive_runs(
        &self,
        app_handle: &tauri::AppHandle,
        idle_timeout_ms: i64,
    ) -> usize {
        let finalized = self.runs.reap_inactive(idle_timeout_ms, "CodexCli").await;
        for run in &finalized {
            // CAS 已在 `reap_inactive` 锁内抢过 ── 这里的 run 都是 watchdog 赢得
            // slot 的, 直接发 Error + StreamEnd + persist, 不会双发。
            let run_id = run.run_id.as_deref().unwrap_or(run.thread_id.as_str());
            if let Some(reason) = run.reason.clone() {
                emit_chunk_with_run_id(
                    app_handle,
                    &AgentChunk::Error {
                        thread_id: run.thread_id.clone(),
                        message: reason.clone(),
                    },
                    AGENT_TYPE,
                    run_id,
                );
            }
            emit_chunk_with_run_id(
                app_handle,
                &AgentChunk::StreamEnd {
                    thread_id: run.thread_id.clone(),
                    reason: run.reason.clone(),
                },
                AGENT_TYPE,
                run_id,
            );
            persist_watchdog_finalized_run_state(&self.thread_manager, run, "CodexCli").await;
        }
        finalized.len()
    }

    async fn run_codex(
        &self,
        thread_id: &str,
        run_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
        stream_end_emitted: Arc<AtomicBool>,
    ) -> Result<(), String> {
        let mapped_session_id = {
            let manager = self.thread_manager.read().await;
            manager
                .get_external_session(thread_id, AGENT_TYPE)
                .await
                .map_err(|e| e.to_string())?
        };
        let hint = is_codex_session_id(thread_id).then(|| thread_id.to_string());
        let session_id = select_external_session_for_runtime(mapped_session_id, hint);
        let cwd = resolve_codex_cwd(&message, session_id.as_deref());
        let workspace_paths = message.workspace_paths_for_runtime(AGENT_TYPE);
        let permission_mode = message
            .permission_mode_for_runtime(AGENT_TYPE)
            .map(str::to_string);
        let codex_model = message.codex_model_for_runtime().map(str::to_string);
        let reasoning_effort = message
            .codex_reasoning_effort_for_runtime()
            .map(str::to_string);
        let prompt = message.llm_content.unwrap_or(message.content);
        runtime_log::record_agent_event(
            "info",
            "codex_process",
            "codex.spawn_start",
            "Starting Codex CLI",
            Some(thread_id),
            Some(AGENT_TYPE),
            Some(serde_json::json!({
                "session_mode": if session_id.is_some() { "resume" } else { "new" },
                "session_id": session_id,
                "cwd": cwd.display().to_string(),
                "workspace_paths": workspace_paths,
                "permission_mode": permission_mode,
                "codex_model": codex_model,
                "reasoning_effort": reasoning_effort,
                "prompt_chars": prompt.chars().count(),
            })),
        );
        if diagnostics_enabled() {
            runtime_log::record_agent_event(
                "info",
                "codex_diagnostics",
                "codex.diagnostics",
                "Codex diagnostic snapshot",
                Some(thread_id),
                Some(AGENT_TYPE),
                Some(serde_json::json!({
                    "run_id": run_id,
                    "binary": resolve_codex_binary().display().to_string(),
                    "cwd": cwd.display().to_string(),
                    "workspace_paths": workspace_paths,
                    "permission_mode": permission_mode,
                    "codex_model": codex_model,
                    "reasoning_effort": reasoning_effort,
                    "session_mode": if session_id.is_some() { "resume" } else { "new" },
                    "session_id": session_id,
                })),
            );
        }

        preflight_codex()?;

        let mut child = build_codex_command(
            session_id.as_deref(),
            &cwd,
            &workspace_paths,
            permission_mode.as_deref(),
            codex_model.as_deref(),
            reasoning_effort.as_deref(),
        )
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start Codex CLI: {e}"))?;
        let child_pid = child.id();
        runtime_log::record_agent_event(
            "info",
            "codex_process",
            "codex.spawn_ok",
            "Codex CLI process started",
            Some(thread_id),
            Some(AGENT_TYPE),
            Some(serde_json::json!({
                "child_pid": child_pid,
            })),
        );

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(prompt.as_bytes())
                .await
                .map_err(|e| format!("failed to write Codex prompt: {e}"))?;
            stdin
                .shutdown()
                .await
                .map_err(|e| format!("failed to close Codex stdin: {e}"))?;
        }

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture Codex stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "failed to capture Codex stderr".to_string())?;

        if let Err(mut duplicate_child) = self
            .runs
            .try_insert(
                thread_id.to_string(),
                child,
                Some(run_id.to_string()),
                stream_end_emitted,
            )
            .await
        {
            let _ = duplicate_child.kill().await;
            return Err("Codex CLI is already running for this thread".to_string());
        }

        let stdout_task = read_codex_stdout(
            thread_id.to_string(),
            run_id.to_string(),
            app_handle.clone(),
            self.thread_manager.clone(),
            self.runs.clone(),
            BufReader::new(stdout),
        );
        let stderr_task =
            read_stderr_to_string(thread_id, Some(run_id), &self.runs, BufReader::new(stderr));

        let (stdout_result, stderr_text) = tokio::join!(stdout_task, stderr_task);
        // read_codex_stdout 只传播读取错误 ── Codex 的 task_complete 仅标记 terminal
        // turn, StreamEnd 统一由 tail / stop_chat / watchdog 经 `stream_end_emitted`
        // CAS 发, 不再从读取路径返回"已发"信号。
        stdout_result?;

        let mut child = self.runs.remove_if_run_id(thread_id, Some(run_id)).await;
        let status = if let Some(running) = child.as_mut() {
            running.child.wait().await.map_err(|e| e.to_string())?
        } else {
            // child 已被 stop_chat 或 watchdog 移走 ── 二者都已 CAS 抢发过
            // StreamEnd, 这里直接返回, tail 的 CAS 会失败而 skip, 不双发。
            runtime_log::record_agent_event(
                "warn",
                "codex_process",
                "codex.child_missing_after_run",
                "Codex child was removed before wait; likely stopped by user or watchdog",
                Some(thread_id),
                Some(AGENT_TYPE),
                Some(serde_json::json!({ "child_pid": child_pid })),
            );
            return Ok(());
        };

        let stderr_text = stderr_text.unwrap_or_default();
        runtime_log::record_agent_event(
            if status.success() { "info" } else { "error" },
            "codex_process",
            "codex.exit",
            "Codex CLI process exited",
            Some(thread_id),
            Some(AGENT_TYPE),
            Some(serde_json::json!({
                "child_pid": child_pid,
                "success": status.success(),
                "code": status.code(),
                "stderr_chars": stderr_text.chars().count(),
                "stderr_preview": truncate_for_log(stderr_text.trim()),
            })),
        );
        if !status.success() {
            let detail = stderr_text.trim();
            return Err(if detail.is_empty() {
                format!("Codex CLI exited with status {status}")
            } else {
                format!("Codex CLI exited with status {status}: {detail}")
            });
        }
        if !stderr_text.trim().is_empty() {
            tracing::info!("[CodexCli] stderr: {}", stderr_text.trim());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    //! Tests in this module read or write process-global env vars
    //! (`PATH`, `CODEX_CLI_PATH`, `CODEX_NODE_PATH`, …). These
    //! mutations are process-wide and are visible to every other test
    //! in the module, so the tests must hold the same [`ENV_LOCK`] for
    //! the entire duration of the env access.
    //!
    //! **Convention:** any test that calls `std::env::var*` /
    //! `std::env::set_var` / `std::env::remove_var` (or transitively
    //! calls a helper that does) must start with
    //!
    //! ```ignore
    //! let _guard = acquire_env_lock();
    //! ```
    //!
    //! and hold `_guard` for the whole test body. Pure-function tests
    //! (e.g. parsers, sort helpers) don't need the lock.
    use super::*;

    /// Process-global mutex serialising tests that mutate `std::env::*`.
    /// Acquire via [`acquire_env_lock`]; never lock it directly outside
    /// that helper so the convention remains greppable.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Acquire the test-environment lock. See the module-level docs.
    ///
    /// `unwrap_or_else(|e| e.into_inner())` lets a poisoned mutex recover
    /// by handing back the inner value; tests that panicked partway
    /// through env mutation shouldn't take down every later test in the
    /// binary.
    fn acquire_env_lock() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn normalizes_supported_permission_modes() {
        assert_eq!(
            normalized_permission_mode(Some("read-only")),
            Some("read-only")
        );
        assert_eq!(
            normalized_permission_mode(Some("workspace-write")),
            Some("workspace-write")
        );
        assert_eq!(
            normalized_permission_mode(Some("danger-full-access")),
            Some("danger-full-access")
        );
        assert_eq!(normalized_permission_mode(Some("inherit")), None);
        assert_eq!(normalized_permission_mode(Some("unknown")), None);
        assert_eq!(normalized_permission_mode(None), None);
    }

    #[test]
    fn normalizes_codex_model_override() {
        assert_eq!(
            normalized_codex_model(Some("gpt-5.5")).as_deref(),
            Some("gpt-5.5")
        );
        assert_eq!(normalized_codex_model(Some(" inherit ")), None);
        assert_eq!(normalized_codex_model(Some("")), None);
        assert_eq!(normalized_codex_model(None), None);
    }

    #[test]
    fn normalizes_reasoning_effort_override() {
        assert_eq!(normalized_reasoning_effort(Some("low")), Some("low"));
        assert_eq!(normalized_reasoning_effort(Some("medium")), Some("medium"));
        assert_eq!(normalized_reasoning_effort(Some("high")), Some("high"));
        assert_eq!(normalized_reasoning_effort(Some("xhigh")), Some("xhigh"));
        assert_eq!(normalized_reasoning_effort(Some(" extra-high ")), None);
        assert_eq!(normalized_reasoning_effort(None), None);
    }

    /// 构造一个隔离的临时目录，里面放一个 fake `codex` 可执行文件。
    /// 用 pid + 一个测试名后缀避免并行测试互相串扰。
    #[test]
    fn select_session_prefers_hint_over_mapping() {
        let mapped = Some("019f0000-0000-7000-8000-000000000000".to_string());
        // thread_id 本身就是 UUID 形式 → hint 胜出，无视 SQLite 映射。
        let session_id = "019f0000-0000-7000-8000-000000000001";
        assert_eq!(
            select_external_session_for_runtime(mapped.clone(), Some(session_id.to_string()))
                .as_deref(),
            Some(session_id)
        );
    }

    #[test]
    fn select_session_falls_back_to_mapping_when_no_hint() {
        let mapped = Some("019f0000-0000-7000-8000-000000000000".to_string());
        // thread_id 不是 UUID 形式 → 用 SQLite 里的映射 (cwd / workspace
        // 一致与否不再参与决策，UI 在首条消息锁定)。
        assert_eq!(
            select_external_session_for_runtime(mapped.clone(), None),
            mapped
        );
    }

    #[test]
    fn select_session_returns_none_for_brand_new_thread() {
        // 全新 thread：既没映射，thread_id 也不是 UUID → 新建 session。
        assert_eq!(select_external_session_for_runtime(None, None), None);
    }

    #[test]
    fn new_codex_session_adds_enabled_workspace_dirs() {
        let root = std::env::temp_dir().join(format!(
            "flowix-codex-workspace-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
        ));
        let cwd = root.join("primary");
        let secondary = root.join("secondary");
        let third = root.join("third");
        std::fs::create_dir_all(&cwd).expect("create primary dir");
        std::fs::create_dir_all(&secondary).expect("create secondary dir");
        std::fs::create_dir_all(&third).expect("create third dir");

        let workspace_paths = vec![
            cwd.to_string_lossy().to_string(),
            secondary.to_string_lossy().to_string(),
            secondary.to_string_lossy().to_string(),
            root.join("missing").to_string_lossy().to_string(),
            third.to_string_lossy().to_string(),
        ];
        let cmd = build_codex_command(None, &cwd, &workspace_paths, None, None, None);
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();

        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-C" && pair[1] == cwd.to_string_lossy()));
        assert_eq!(
            args.windows(2)
                .filter(|pair| pair[0] == "--add-dir")
                .map(|pair| pair[1].clone())
                .collect::<Vec<_>>(),
            vec![
                secondary.to_string_lossy().to_string(),
                third.to_string_lossy().to_string()
            ]
        );

        cleanup(&root);
    }

    #[test]
    fn new_codex_session_reads_prompt_from_stdin_without_dash_argument() {
        let cwd = std::env::temp_dir();
        let workspace_paths = Vec::new();
        let cmd = build_codex_command(None, &cwd, &workspace_paths, None, None, None);
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();

        assert!(!args.iter().any(|arg| arg == "-"));
        assert!(args.iter().any(|arg| arg == "exec"));
        assert!(args.iter().any(|arg| arg == "--json"));
    }

    #[test]
    fn resumed_codex_session_does_not_add_workspace_dirs() {
        let root = std::env::temp_dir().join(format!(
            "flowix-codex-resume-workspace-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
        ));
        let cwd = root.join("primary");
        let secondary = root.join("secondary");
        std::fs::create_dir_all(&cwd).expect("create primary dir");
        std::fs::create_dir_all(&secondary).expect("create secondary dir");

        let workspace_paths = vec![secondary.to_string_lossy().to_string()];
        let cmd = build_codex_command(
            Some("019f0000-0000-7000-8000-000000000000"),
            &cwd,
            &workspace_paths,
            None,
            None,
            None,
        );
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();

        assert!(!args.iter().any(|arg| arg == "-C"));
        assert!(!args.iter().any(|arg| arg == "--add-dir"));

        cleanup(&root);
    }

    #[test]
    fn resumed_codex_session_does_not_emit_sandbox_flag() {
        // `codex exec resume` 拒绝 `--sandbox`（exit 2: unexpected argument）。
        // 即便用户在 UI 上配了 permission_mode，resume argv 也必须不带这个标志，
        // 让 CLI 从 session 状态里恢复首次会话时已持久化的 sandbox 配置。
        let root = std::env::temp_dir().join(format!(
            "flowix-codex-resume-sandbox-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
        ));
        std::fs::create_dir_all(&root).expect("create temp dir");

        let cmd = build_codex_command(
            Some("019f0000-0000-7000-8000-000000000000"),
            &root,
            &[],
            Some("workspace-write"),
            None,
            None,
        );
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();

        assert!(
            !args.iter().any(|arg| arg == "--sandbox"),
            "resume argv must not contain --sandbox, got: {:?}",
            args
        );

        cleanup(&root);
    }

    #[test]
    fn codex_command_adds_reasoning_effort_override() {
        let cwd = std::env::temp_dir();
        let workspace_paths = Vec::new();
        let cmd = build_codex_command(None, &cwd, &workspace_paths, None, None, Some("xhigh"));
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();

        assert!(args
            .windows(2)
            .any(|pair| { pair[0] == "-c" && pair[1] == "model_reasoning_effort=\"xhigh\"" }));
    }

    #[test]
    fn codex_command_uses_documented_sandbox_flag() {
        let cwd = std::env::temp_dir();
        let workspace_paths = Vec::new();
        let cmd = build_codex_command(
            None,
            &cwd,
            &workspace_paths,
            Some("workspace-write"),
            None,
            None,
        );
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();

        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--sandbox" && pair[1] == "workspace-write"));
    }

    #[test]
    fn latest_versioned_subdir_prefers_high_major_over_lexicographic() {
        // Older Node left over from a long-ago install. A pure lexicographic
        // sort would compare '8' > '1' and wrongly resolve `swap_remove(last)`
        // to this old v8 directory. The semver-aware sort must pick v20.10.0.
        let parent = std::env::temp_dir().join(format!(
            "flowix-codex-cli-test-semver-major-{}",
            std::process::id(),
        ));
        std::fs::create_dir_all(&parent).expect("create temp dir");
        let v8 = parent.join("v8.17.0");
        let v18 = parent.join("v18.19.0");
        let v20 = parent.join("v20.10.0");
        for d in [&v8, &v18, &v20] {
            std::fs::create_dir_all(d).expect("create version dir");
        }
        // Non-version siblings must not poison the result.
        std::fs::create_dir_all(parent.join("latest")).expect("create latest dir");
        std::fs::create_dir_all(parent.join("current")).expect("create current dir");
        std::fs::write(parent.join("README.md"), "# readme").expect("write readme");

        let picked = latest_versioned_subdir(&parent);

        cleanup(&parent);

        assert_eq!(
            picked,
            Some(v20),
            "expected highest semver v20.10.0; got {:?} (lexicographic sort \
             would wrongly pick v8.17.0 since '8' > '1')",
            picked,
        );
    }

    #[test]
    fn parse_node_version_handles_nvm_fnm_and_asdf_shapes() {
        // nvm / fnm use the `v`-prefixed shape.
        assert_eq!(parse_node_version("v20.10.0"), Some((20, 10, 0)));
        assert_eq!(parse_node_version("v18.19.0"), Some((18, 19, 0)));
        // asdf installs use the unprefixed shape.
        assert_eq!(parse_node_version("18.19.0"), Some((18, 19, 0)));
        // Pre-release suffix is truncated before parsing the leading triple.
        assert_eq!(parse_node_version("v20.0.0-rc.1"), Some((20, 0, 0)),);
        // Junk / non-semver / over-segmented names return None, not garbage.
        assert_eq!(parse_node_version("latest"), None);
        assert_eq!(parse_node_version("current"), None);
        assert_eq!(parse_node_version("v18"), None);
        assert_eq!(parse_node_version("18.19.0.foo"), None);
    }

    fn make_fake_codex_dir(suffix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "flowix-codex-cli-test-{}-{}-{}",
            std::process::id(),
            suffix,
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let fake = dir.join("codex");
        std::fs::write(&fake, "#!/bin/sh\nexit 0\n").expect("write fake codex");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&fake).expect("stat fake").permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&fake, perms).expect("chmod fake");
        }
        dir
    }

    fn cleanup(dir: &PathBuf) {
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn resolve_codex_binary_prefers_codex_cli_path_env() {
        let _guard = acquire_env_lock();
        let dir = make_fake_codex_dir("env-override");
        let fake = dir.join("my-codex");
        std::fs::write(&fake, "#!/bin/sh\nexit 0\n").expect("write fake");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&fake).expect("stat fake").permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&fake, perms).expect("chmod fake");
        }

        let original = std::env::var_os("CODEX_CLI_PATH");
        std::env::set_var("CODEX_CLI_PATH", &fake);
        let resolved = resolve_codex_binary();
        match original {
            Some(v) => std::env::set_var("CODEX_CLI_PATH", v),
            None => std::env::remove_var("CODEX_CLI_PATH"),
        }
        cleanup(&dir);

        assert_eq!(resolved, fake);
    }

    #[test]
    fn resolve_codex_binary_ignores_missing_codex_cli_path() {
        let _guard = acquire_env_lock();
        let original = std::env::var_os("CODEX_CLI_PATH");
        std::env::set_var(
            "CODEX_CLI_PATH",
            std::env::temp_dir().join("flowix-nonexistent-codex-cli-path"),
        );
        let resolved = resolve_codex_binary();
        match original {
            Some(v) => std::env::set_var("CODEX_CLI_PATH", v),
            None => std::env::remove_var("CODEX_CLI_PATH"),
        }
        assert_ne!(
            resolved,
            std::env::temp_dir().join("flowix-nonexistent-codex-cli-path")
        );
    }

    #[test]
    fn which_codex_finds_binary_in_path() {
        let _guard = acquire_env_lock();
        let dir = make_fake_codex_dir("which-hit");
        let original = std::env::var_os("PATH");
        let sep = if cfg!(windows) { ';' } else { ':' };
        let joined = match &original {
            Some(p) => format!("{}{}{}", dir.display(), sep, p.to_string_lossy()),
            None => dir.display().to_string(),
        };
        std::env::set_var("PATH", joined);
        let result = which_codex();
        match original {
            Some(v) => std::env::set_var("PATH", v),
            None => std::env::remove_var("PATH"),
        }
        cleanup(&dir);

        let found = result.expect("expected to find fake codex in PATH");
        // `which_codex` 直接拼 `dir.join("codex")` 返回，不走符号链接解析；
        // 直接比路径即可，避开 macOS 上 `/var` ↔ `/private/var` 跨链接 canonicalize 抽风。
        assert_eq!(found, dir.join("codex"));
    }

    #[test]
    fn which_codex_returns_err_when_path_empty() {
        let _guard = acquire_env_lock();
        let original = std::env::var_os("PATH");
        std::env::set_var("PATH", "");
        let result = which_codex();
        match original {
            Some(v) => std::env::set_var("PATH", v),
            None => std::env::remove_var("PATH"),
        }
        assert!(result.is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn codex_candidate_paths_include_chatgpt_app_bundle_cli() {
        assert!(super::super::binary::codex_candidate_paths()
            .iter()
            .any(|path| {
                path == &PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex")
            }));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn resolve_codex_binary_falls_back_to_chatgpt_app_bundle_cli() {
        let _guard = acquire_env_lock();
        let bundled = PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex");
        if !bundled.is_file() {
            return;
        }
        let earlier_executable_candidate = super::super::binary::codex_candidate_paths()
            .into_iter()
            .take_while(|path| path != &bundled)
            .any(|path| is_executable_file(&path));
        if earlier_executable_candidate {
            return;
        }

        let original_path = std::env::var_os("PATH");
        let original_cli_env = std::env::var_os("CODEX_CLI_PATH");
        std::env::set_var("PATH", "");
        std::env::remove_var("CODEX_CLI_PATH");

        let resolved = resolve_codex_binary();

        match original_path {
            Some(v) => std::env::set_var("PATH", v),
            None => std::env::remove_var("PATH"),
        }
        match original_cli_env {
            Some(v) => std::env::set_var("CODEX_CLI_PATH", v),
            None => std::env::remove_var("CODEX_CLI_PATH"),
        }

        assert_eq!(resolved, bundled);
    }

    fn make_fake_node_dir(suffix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "flowix-codex-node-test-{}-{}-{}",
            std::process::id(),
            suffix,
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let fake = dir.join("node");
        std::fs::write(&fake, "#!/bin/sh\nexit 0\n").expect("write fake node");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&fake).expect("stat fake").permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&fake, perms).expect("chmod fake");
        }
        dir
    }

    #[test]
    fn resolve_node_binary_prefers_codex_node_path_env() {
        let _guard = acquire_env_lock();
        let dir = make_fake_node_dir("env-override");
        let fake = dir.join("node");

        let original = std::env::var_os("CODEX_NODE_PATH");
        std::env::set_var("CODEX_NODE_PATH", &fake);
        let resolved = resolve_node_binary();
        match original {
            Some(v) => std::env::set_var("CODEX_NODE_PATH", v),
            None => std::env::remove_var("CODEX_NODE_PATH"),
        }
        cleanup(&dir);

        assert_eq!(resolved, Some(fake));
    }

    #[test]
    fn resolve_node_binary_finds_node_in_path() {
        let _guard = acquire_env_lock();
        let dir = make_fake_node_dir("path-hit");

        let original_path = std::env::var_os("PATH");
        let original_node_env = std::env::var_os("CODEX_NODE_PATH");
        std::env::remove_var("CODEX_NODE_PATH");
        let sep = if cfg!(windows) { ';' } else { ':' };
        let joined = match &original_path {
            Some(p) => format!("{}{}{}", dir.display(), sep, p.to_string_lossy()),
            None => dir.display().to_string(),
        };
        std::env::set_var("PATH", joined);

        let resolved = resolve_node_binary();

        match original_path {
            Some(v) => std::env::set_var("PATH", v),
            None => std::env::remove_var("PATH"),
        }
        match original_node_env {
            Some(v) => std::env::set_var("CODEX_NODE_PATH", v),
            None => std::env::remove_var("CODEX_NODE_PATH"),
        }
        cleanup(&dir);

        assert_eq!(resolved, Some(dir.join("node")));
    }

    #[test]
    fn resolve_node_binary_falls_back_to_homebrew_path_when_path_empty() {
        let _guard = acquire_env_lock();
        // 只在 macOS / Linux 且文件确实存在的 CI 上验证；开发机一般命中
        #[cfg(unix)]
        {
            let original_path = std::env::var_os("PATH");
            let original_node_env = std::env::var_os("CODEX_NODE_PATH");
            std::env::remove_var("CODEX_NODE_PATH");
            std::env::set_var("PATH", "");

            let resolved = resolve_node_binary();

            match original_path {
                Some(v) => std::env::set_var("PATH", v),
                None => std::env::remove_var("PATH"),
            }
            match original_node_env {
                Some(v) => std::env::set_var("CODEX_NODE_PATH", v),
                None => std::env::remove_var("CODEX_NODE_PATH"),
            }

            // 命中 /opt/homebrew/bin/node 或 /usr/local/bin/node 或 /usr/bin/node 之一即可
            if let Some(p) = &resolved {
                assert!(
                    p.starts_with("/opt/homebrew/bin/node")
                        || p.starts_with("/usr/local/bin/node")
                        || p.starts_with("/usr/bin/node"),
                    "unexpected fallback path: {}",
                    p.display()
                );
            }
        }
        #[cfg(not(unix))]
        {
            // Windows 上 `node` 通常已经在 PATH，不强制
        }
    }

    #[test]
    fn preflight_codex_returns_friendly_error_when_no_node() {
        let _guard = acquire_env_lock();
        let original_path = std::env::var_os("PATH");
        let original_node_env = std::env::var_os("CODEX_NODE_PATH");
        let original_cli_env = std::env::var_os("CODEX_CLI_PATH");
        std::env::remove_var("CODEX_NODE_PATH");
        std::env::set_var("PATH", "");
        // 把 codex 指向一个根本不存在的 .js，让 needs_node=true 但 node 找不到
        std::env::set_var(
            "CODEX_CLI_PATH",
            std::env::temp_dir().join("flowix-preflight-nonexistent-codex.js"),
        );

        let result = preflight_codex();

        match original_path {
            Some(v) => std::env::set_var("PATH", v),
            None => std::env::remove_var("PATH"),
        }
        match original_node_env {
            Some(v) => std::env::set_var("CODEX_NODE_PATH", v),
            None => std::env::remove_var("CODEX_NODE_PATH"),
        }
        match original_cli_env {
            Some(v) => std::env::set_var("CODEX_CLI_PATH", v),
            None => std::env::remove_var("CODEX_CLI_PATH"),
        }

        // 在装了 node 的开发机上（包括 CI）会通过；这里只断言"错误信息包含指引"或"通过"
        if let Err(msg) = result {
            assert!(
                msg.contains("Node.js"),
                "error should mention Node.js, got: {msg}"
            );
            assert!(
                msg.contains("CODEX_NODE_PATH") || msg.contains("nodejs.org"),
                "error should point to a fix path, got: {msg}"
            );
        }
    }
}
