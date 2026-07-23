use std::collections::HashMap;
#[cfg(test)]
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::io::{AsyncWriteExt, BufReader};

pub(crate) use super::binary::resolve_codex_binary;
#[cfg(test)]
use super::command::{
    build_codex_command, is_executable_file, latest_versioned_subdir, normalized_codex_model,
    normalized_permission_mode, normalized_reasoning_effort, parse_node_version,
    resolve_node_binary, which_codex,
};
use super::command::{build_codex_command_with_images, resolve_codex_cwd};
pub(crate) use super::command::{build_codex_entrypoint, preflight_codex};
use super::history::is_codex_session_id;
use super::runtime::{
    diagnostics_enabled, persist_and_emit_codex_chunk, persist_codex_chunk, resolve_run_id,
};
use super::stream::read_codex_stdout;
use super::{truncate_for_log, AGENT_TYPE};
use crate::agent_external::{
    emit_stream_end_once, kill_child_tree, read_stderr_to_string,
    select_external_session_for_runtime, ExternalRunRegistry, USER_STOPPED_REASON,
};
use crate::agent_flowix::{AgentChunk, AgentUserMessage};
use crate::agent_session::ThreadManager;
use crate::runtime_log;

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
        // 鍏变韩鐨?StreamEnd 宸茬粡 emit 鍑哄幓娌?鏍囧織 鈹€鈹€ `stop_chat` 鍜屾祦寮忎换鍔?        // 閮芥寔鏈変竴浠?Arc, 璋佸厛 CAS(false鈫抰rue) 璋佽礋璐ｅ彂; 鍙︿竴涓垎鏀湅鍒?        // 鏍囧織涓?true 鐩存帴 skip, 淇濊瘉鍓嶇鍙敹涓€鏉?StreamEnd銆?
        let stream_end_emitted = Arc::new(AtomicBool::new(false));

        // Reap any zombie child (kill/oom/broken pipe leaves the registry
        // entry behind until the watchdog sweeps it) and refuse overlapping
        // runs BEFORE we emit StreamStart 鈥?otherwise the UI flashes
        // loading for ~ms and then bounces to an error.
        if let Some(reason) = self.runs.reap_stale(&thread_id).await {
            return Err(reason);
        }

        tokio::spawn(async move {
            // 閫氱敤 metadata 鍗忚 鈹€鈹€ StreamStart 鎼哄甫璇?run 閿佸畾鐨?            // model / reasoning_effort, 鍓嶇 hover card 绛夌粍浠跺彲璇汇€?
            let model = message.model_for_runtime("codex").map(str::to_string);
            let reasoning_effort = message
                .reasoning_effort_for_runtime("codex")
                .map(str::to_string);
            persist_and_emit_codex_chunk(
                &app_handle,
                &manager.thread_manager,
                &AgentChunk::StreamStart {
                    thread_id: thread_id.clone(),
                    model,
                    reasoning_effort,
                },
                &run_id,
                None,
            )
            .await;

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
                    persist_and_emit_codex_chunk(
                        &app_handle,
                        &manager.thread_manager,
                        &AgentChunk::Error {
                            thread_id: thread_id.clone(),
                            message: err.clone(),
                        },
                        &run_id,
                        None,
                    )
                    .await;
                    Some(err)
                }
            };

            // 鍏滃簳 emit: 鑻?stop_chat / watchdog 杩樻病鏇挎垜浠彂杩?StreamEnd,
            // 鐢辨湰璺緞琛ュ彂; 鍚﹀垯 CAS 澶辫触, 璺宠繃閬垮厤閲嶅銆傝瑙?            // `shared::emit_stream_end_once`銆?
            let stream_end = AgentChunk::StreamEnd {
                thread_id: thread_id.clone(),
                reason,
            };
            if emit_stream_end_once(
                &app_handle,
                &thread_id,
                &run_id,
                AGENT_TYPE,
                match &stream_end {
                    AgentChunk::StreamEnd { reason, .. } => reason.clone(),
                    _ => None,
                },
                &stream_end_emitted,
            ) {
                persist_codex_chunk(&manager.thread_manager, &stream_end, &run_id, None).await;
            }
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

        // 涓嶇瓑娴佸紡浠诲姟鑷繁閱掓潵 鈹€鈹€ 鐢ㄦ埛鍋滄鍚庣珛鍒诲彂 StreamEnd銆傚叡浜?flag 璁?        // task body 鏈熬鐨勫厹搴?emit 鑷姩璺宠繃 (閬垮厤閲嶅浜嬩欢)銆?
        let run_id_for_chunk = running.run_id.as_deref().unwrap_or(thread_id).to_string();
        let stream_end = AgentChunk::StreamEnd {
            thread_id: thread_id.to_string(),
            reason: Some(USER_STOPPED_REASON.to_string()),
        };
        if emit_stream_end_once(
            app_handle,
            thread_id,
            &run_id_for_chunk,
            AGENT_TYPE,
            Some(USER_STOPPED_REASON.to_string()),
            &running.stream_end_emitted,
        ) {
            persist_codex_chunk(&self.thread_manager, &stream_end, &run_id_for_chunk, None).await;
        }
        true
    }

    pub async fn running_threads(&self) -> HashMap<String, crate::agent_flowix::RunInfo> {
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
            // CAS 宸插湪 `reap_inactive` 閿佸唴鎶㈣繃 鈹€鈹€ 杩欓噷鐨?run 閮芥槸 watchdog 璧㈠緱
            // slot 鐨? 鐩存帴鍙?Error + StreamEnd + persist, 涓嶄細鍙屽彂銆?
            let run_id = run.run_id.as_deref().unwrap_or(run.thread_id.as_str());
            if let Some(reason) = run.reason.clone() {
                persist_and_emit_codex_chunk(
                    app_handle,
                    &self.thread_manager,
                    &AgentChunk::Error {
                        thread_id: run.thread_id.clone(),
                        message: reason.clone(),
                    },
                    run_id,
                    None,
                )
                .await;
            }
            persist_and_emit_codex_chunk(
                app_handle,
                &self.thread_manager,
                &AgentChunk::StreamEnd {
                    thread_id: run.thread_id.clone(),
                    reason: run.reason.clone(),
                },
                run_id,
                None,
            )
            .await;
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
        let image_paths = message.image_paths.clone();
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
                "image_count": image_paths.len(),
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

        let mut child = build_codex_command_with_images(
            session_id.as_deref(),
            &cwd,
            &workspace_paths,
            permission_mode.as_deref(),
            codex_model.as_deref(),
            reasoning_effort.as_deref(),
            &image_paths,
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
                stream_end_emitted.clone(),
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
            stream_end_emitted.clone(),
        );
        let stderr_task =
            read_stderr_to_string(thread_id, Some(run_id), &self.runs, BufReader::new(stderr));

        let (stdout_result, stderr_text) = tokio::join!(stdout_task, stderr_task);
        // read_codex_stdout 鍙紶鎾鍙栭敊璇?鈹€鈹€ Codex 鐨?task_complete 浠呮爣璁?terminal
        // turn, StreamEnd 缁熶竴鐢?tail / stop_chat / watchdog 缁?`stream_end_emitted`
        // CAS 鍙? 涓嶅啀浠庤鍙栬矾寰勮繑鍥?宸插彂"淇″彿銆?
        stdout_result?;

        let mut child = self.runs.remove_if_run_id(thread_id, Some(run_id)).await;
        let status = if let Some(running) = child.as_mut() {
            running.child.wait().await.map_err(|e| e.to_string())?
        } else {
            // child 宸茶 stop_chat 鎴?watchdog 绉昏蛋 鈹€鈹€ 浜岃€呴兘宸?CAS 鎶㈠彂杩?
            // StreamEnd, 杩欓噷鐩存帴杩斿洖, tail 鐨?CAS 浼氬け璐ヨ€?skip, 涓嶅弻鍙戙€?
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
            return Err(format_codex_failure(&status.to_string(), &stderr_text));
        }
        if !stderr_text.trim().is_empty() {
            tracing::info!("[CodexCli] stderr: {}", stderr_text.trim());
        }
        Ok(())
    }
}

fn format_codex_failure(status: &str, detail: &str) -> String {
    let detail = detail.trim();
    if detail.is_empty() {
        return format!("Codex CLI exited with status {status}");
    }

    let mut message = format!("Codex CLI exited with status {status}: {detail}");
    if detail.contains("Missing optional dependency") {
        message.push_str(concat!(
            " Codex's native platform dependency is missing or was installed for a different ",
            "Node.js architecture. Reinstall with `npm install -g @openai/codex@latest ",
            "--force --include=optional`, or set CODEX_NODE_PATH to a matching Node.js runtime.",
        ));
    }
    message
}

#[cfg(test)]
mod tests {
    //! Tests in this module read or write process-global env vars
    //! (`PATH`, `CODEX_CLI_PATH`, `CODEX_NODE_PATH`, 鈥?. These
    //! mutations are process-wide and are visible to every other test
    //! in the binary, so the tests must hold the shared external-agent
    //! environment lock for the entire duration of the env access.
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
    use crate::agent_external::acquire_test_env_lock as acquire_env_lock;

    #[test]
    fn formats_missing_native_dependency_with_repair_guidance() {
        let message = format_codex_failure(
            "exit status: 1",
            "Error: Missing optional dependency @openai/codex-darwin-x64",
        );

        assert!(message.contains("@openai/codex-darwin-x64"));
        assert!(message.contains("npm install -g @openai/codex@latest --force --include=optional"));
        assert!(message.contains("CODEX_NODE_PATH"));
    }

    #[test]
    fn formats_empty_codex_failure_without_trailing_separator() {
        assert_eq!(
            format_codex_failure("exit status: 1", "  "),
            "Codex CLI exited with status exit status: 1"
        );
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
        assert_eq!(normalized_permission_mode(Some("yolo")), Some("yolo"));
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

    /// 鏋勯€犱竴涓殧绂荤殑涓存椂鐩綍锛岄噷闈㈡斁涓€涓?fake `codex` 鍙墽琛屾枃浠躲€?    /// 鐢?pid + 涓€涓祴璇曞悕鍚庣紑閬垮厤骞惰娴嬭瘯浜掔浉涓叉壈銆?
    #[test]
    fn select_session_prefers_hint_over_mapping() {
        let mapped = Some("019f0000-0000-7000-8000-000000000000".to_string());
        // thread_id 鏈韩灏辨槸 UUID 褰㈠紡 鈫?hint 鑳滃嚭锛屾棤瑙?SQLite 鏄犲皠銆?
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
        // thread_id 涓嶆槸 UUID 褰㈠紡 鈫?鐢?SQLite 閲岀殑鏄犲皠 (cwd / workspace
        // 涓€鑷翠笌鍚︿笉鍐嶅弬涓庡喅绛栵紝UI 鍦ㄩ鏉℃秷鎭攣瀹?銆?
        assert_eq!(
            select_external_session_for_runtime(mapped.clone(), None),
            mapped
        );
    }

    #[test]
    fn select_session_returns_none_for_brand_new_thread() {
        // 鍏ㄦ柊 thread锛氭棦娌℃槧灏勶紝thread_id 涔熶笉鏄?UUID 鈫?鏂板缓 session銆?
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
    fn codex_command_enables_web_search_for_new_and_resumed_sessions() {
        let cwd = std::env::temp_dir();
        for session_id in [None, Some("019f0000-0000-7000-8000-000000000000")] {
            let cmd = build_codex_command(session_id, &cwd, &[], None, None, None);
            let args: Vec<String> = cmd
                .as_std()
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            let search_index = args
                .iter()
                .position(|arg| arg == "--search")
                .expect("Codex command must enable web search");
            let exec_index = args
                .iter()
                .position(|arg| arg == "exec")
                .expect("Codex command must contain exec");
            assert!(
                search_index < exec_index,
                "--search is a top-level option and must precede exec: {args:?}"
            );
        }
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
    fn resumed_codex_session_uses_config_override_instead_of_sandbox_flag() {
        // `codex exec resume` 鎷掔粷 `--sandbox`锛坋xit 2: unexpected argument锛夈€?        // resume 鏄柊鐨?CLI invocation锛屽繀椤荤敤瀹冩敮鎸佺殑 config override 閲嶆柊
        // 搴旂敤 thread card 鐨勬潈闄愬揩鐓э紝涓嶈兘鍋囧畾棣栨 turn 鐨?sandbox 浼氳鎭㈠銆?
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
        assert!(args
            .windows(2)
            .any(|pair| { pair[0] == "-c" && pair[1] == "sandbox_mode=\"workspace-write\"" }));

        cleanup(&root);
    }

    #[test]
    fn resumed_codex_session_reapplies_yolo_permission_mode() {
        let root = std::env::temp_dir().join(format!(
            "flowix-codex-resume-yolo-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
        ));
        std::fs::create_dir_all(&root).expect("create temp dir");

        let cmd = build_codex_command(
            Some("019f0000-0000-7000-8000-000000000000"),
            &root,
            &[],
            Some("yolo"),
            None,
            None,
        );
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();

        assert!(args.iter().any(|arg| arg == "--yolo"));
        assert!(!args.iter().any(|arg| arg == "--sandbox"));
        assert!(!args.iter().any(|arg| arg.starts_with("sandbox_mode=")));

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
    fn codex_command_uses_yolo_flag_for_yolo_permission_mode() {
        let cwd = std::env::temp_dir();
        let workspace_paths = Vec::new();
        let cmd = build_codex_command(None, &cwd, &workspace_paths, Some("yolo"), None, None);
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();

        assert!(args.iter().any(|arg| arg == "--yolo"));
        assert!(!args.iter().any(|arg| arg == "--sandbox"));
    }

    #[test]
    fn codex_command_attaches_images_for_new_and_resumed_sessions() {
        let root =
            std::env::temp_dir().join(format!("flowix-codex-image-test-{}", std::process::id(),));
        std::fs::create_dir_all(&root).expect("create image test dir");
        let image = root.join("pasted.png");
        std::fs::write(&image, b"png").expect("create image");
        let images = vec![image.to_string_lossy().into_owned()];

        for session_id in [None, Some("019f0000-0000-7000-8000-000000000000")] {
            let cmd =
                build_codex_command_with_images(session_id, &root, &[], None, None, None, &images);
            let args: Vec<String> = cmd
                .as_std()
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            assert!(args
                .windows(2)
                .any(|pair| pair[0] == "--image" && pair[1] == images[0]));
        }
        cleanup(&root);
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
        // `which_codex` 鐩存帴鎷?`dir.join("codex")` 杩斿洖锛屼笉璧扮鍙烽摼鎺ヨВ鏋愶紱
        // 鐩存帴姣旇矾寰勫嵆鍙紝閬垮紑 macOS 涓?`/var` 鈫?`/private/var` 璺ㄩ摼鎺?canonicalize 鎶介銆?        assert_eq!(found, dir.join("codex"));
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
        // 鍙湪 macOS / Linux 涓旀枃浠剁‘瀹炲瓨鍦ㄧ殑 CI 涓婇獙璇侊紱寮€鍙戞満涓€鑸懡涓?
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

            // 鍛戒腑 /opt/homebrew/bin/node 鎴?/usr/local/bin/node 鎴?/usr/bin/node 涔嬩竴鍗冲彲
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
            // Windows 涓?`node` 閫氬父宸茬粡鍦?PATH锛屼笉寮哄埗
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
        // 鎶?codex 鎸囧悜涓€涓牴鏈笉瀛樺湪鐨?.js锛岃 needs_node=true 浣?node 鎵句笉鍒?
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

        // 鍦ㄨ浜?node 鐨勫紑鍙戞満涓婏紙鍖呮嫭 CI锛変細閫氳繃锛涜繖閲屽彧鏂█"閿欒淇℃伅鍖呭惈鎸囧紩"鎴?閫氳繃"
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
